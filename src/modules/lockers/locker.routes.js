import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { nextSeq, financialYear } from '../../utils/counter.js';
import { addDays, startOfDay, dayjs, tz, dmy, ymd } from '../../utils/dates.js';
import { Member } from '../members/member.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { audit } from '../audit/audit.model.js';
import { Locker, LockerAllotment, LOCKER_SECTIONS } from './locker.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const paise = z.number().int().min(0).max(100000000);
const MODES = ['cash', 'upi', 'card', 'bank'];
const receiptNo = async () => `LKR/${financialYear()}/${String(await nextSeq(`locker:${financialYear()}`)).padStart(5, '0')}`;
/** Last day of a rent period of `months` starting on `from`. */
const periodEnd = (from, months) => addDays(dayjs(from).tz(tz).add(months, 'month').toDate(), -1);

/* ---------------- Lockers ---------------- */
router.get('/', permit('lockers.read'), async (req, res) => {
  const q = req.query;
  const bf = branchFilter(req);
  const today = startOfDay();
  const filter = { ...bf };
  if (q.section && LOCKER_SECTIONS.includes(q.section)) filter.section = q.section;
  const lockers = await Locker.find(filter)
    .populate({ path: 'allotmentId', select: 'memberId startDate endDate deposit', populate: { path: 'memberId', select: 'name memberCode phone' } })
    .lean();
  // Natural order: L2 before L10.
  lockers.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const items = lockers.map((l) => ({ ...l, overdue: Boolean(l.allotmentId && new Date(l.allotmentId.endDate) < today) }));
  const counts = { available: 0, occupied: 0, maintenance: 0, overdue: 0 };
  for (const l of items) {
    counts[l.status] += 1;
    if (l.overdue) counts.overdue += 1;
  }
  const shown = q.status === 'overdue' ? items.filter((l) => l.overdue) : q.status ? items.filter((l) => l.status === q.status) : items;
  res.json({ success: true, data: { items: shown, counts } });
});

// Add many lockers at once: prefix "L", 1..50 -> L1..L50 (existing numbers are skipped).
router.post(
  '/bulk',
  permit('lockers.manage'),
  validate({
    body: z
      .object({
        branchId: objectId,
        prefix: z.string().trim().max(6).default(''),
        from: z.number().int().min(0).max(9999),
        to: z.number().int().min(0).max(9999),
        section: z.enum(LOCKER_SECTIONS).optional(),
        monthlyFee: paise.optional(),
      })
      .refine((b) => b.to >= b.from && b.to - b.from < 500, 'Up to 500 lockers at a time, "to" must not be less than "from"'),
  }),
  async (req, res) => {
    const { branchId, prefix, from, to, section, monthlyFee } = req.body;
    assertBranchAccess(req, branchId);
    const ops = [];
    for (let n = from; n <= to; n += 1) {
      const doc = { branchId, number: `${prefix}${n}`, section: section || 'common', monthlyFee: monthlyFee || 0, status: 'available' };
      ops.push({ updateOne: { filter: { branchId, number: doc.number }, update: { $setOnInsert: doc }, upsert: true } });
    }
    const r = await Locker.bulkWrite(ops, { ordered: false });
    await audit(req, 'locker.bulk', { entity: 'Locker', branchId, details: { prefix, from, to, added: r.upsertedCount } });
    res.status(201).json({ success: true, data: { added: r.upsertedCount, skipped: ops.length - r.upsertedCount } });
  },
);

router.put(
  '/:id',
  permit('lockers.manage'),
  validate({
    body: z.object({
      number: z.string().trim().min(1).max(12).optional(),
      section: z.enum(LOCKER_SECTIONS).optional(),
      monthlyFee: paise.optional(),
      notes: z.string().max(200).optional(),
      maintenance: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const l = await findInBranch(req, Locker, req.params.id, { notFound: 'Locker not found' });
    const { maintenance, ...rest } = req.body;
    Object.assign(l, rest);
    if (maintenance !== undefined) {
      if (l.status === 'occupied') throw ApiError.badRequest('Release the locker before marking it for maintenance');
      l.status = maintenance ? 'maintenance' : 'available';
    }
    try {
      await l.save();
    } catch (err) {
      if (err?.code === 11000) throw ApiError.conflict('A locker with this number already exists');
      throw err;
    }
    res.json({ success: true, data: l });
  },
);

router.delete('/:id', permit('lockers.manage'), async (req, res) => {
  const l = await findInBranch(req, Locker, req.params.id, { notFound: 'Locker not found' });
  if (l.status === 'occupied') throw ApiError.badRequest('This locker is in use');
  if (await LockerAllotment.exists({ lockerId: l._id })) throw ApiError.badRequest('This locker has history. Mark it for maintenance instead.');
  await l.deleteOne();
  res.json({ success: true });
});

/* ---------------- Allotments ---------------- */
const payBody = { mode: z.enum(MODES).default('cash'), reference: z.string().max(60).optional() };

router.post(
  '/:id/allot',
  permit('lockers.write'),
  validate({
    body: z.object({
      memberId: objectId,
      months: z.number().int().min(1).max(12),
      startDate: z.coerce.date().optional(),
      rent: paise, // total rent for the period
      deposit: paise.default(0),
      ...payBody,
    }),
  }),
  async (req, res) => {
    const locker = await findInBranch(req, Locker, req.params.id, { notFound: 'Locker not found' });
    if (locker.status !== 'available') throw ApiError.badRequest(locker.status === 'occupied' ? 'This locker is already allotted' : 'This locker is under maintenance');
    const member = await Member.findOne({ _id: req.body.memberId, isDeleted: false });
    if (!member) throw ApiError.notFound('Member not found');
    if (!['active', 'frozen', 'upcoming'].includes(member.membershipStatus)) throw ApiError.badRequest(`${member.name} has no active membership`);
    if (String(member.branchId) !== String(locker.branchId)) throw ApiError.badRequest('The member belongs to another branch');
    if (await LockerAllotment.exists({ memberId: member._id, status: 'active' })) throw ApiError.badRequest(`${member.name} already has a locker`);

    const start = startOfDay(req.body.startDate || new Date());
    const end = periodEnd(start, req.body.months);
    const rno = await receiptNo();
    const charges = [];
    if (req.body.rent) charges.push({ kind: 'rent', amount: req.body.rent, mode: req.body.mode, reference: req.body.reference, receiptNo: rno, from: start, to: end, by: req.user._id });
    if (req.body.deposit) charges.push({ kind: 'deposit', amount: req.body.deposit, mode: req.body.mode, reference: req.body.reference, receiptNo: rno, by: req.user._id });
    const a = await LockerAllotment.create({
      lockerId: locker._id, branchId: locker.branchId, memberId: member._id, startDate: start, endDate: end,
      deposit: req.body.deposit, charges, allottedBy: req.user._id,
    });
    // Claim the locker atomically so two desks can't allot it at the same moment.
    const claimed = await Locker.updateOne({ _id: locker._id, status: 'available' }, { status: 'occupied', allotmentId: a._id });
    if (!claimed.modifiedCount) {
      await a.deleteOne();
      throw ApiError.conflict('This locker was just allotted to someone else');
    }
    await audit(req, 'locker.allot', { entity: 'LockerAllotment', entityId: a._id, branchId: a.branchId, details: { locker: locker.number, member: member.memberCode } });
    res.status(201).json({ success: true, data: { allotment: a, receiptNo: charges.length ? rno : null } });
  },
);

const loadAllotment = async (req) => {
  const a = await findInBranch(req, LockerAllotment, req.params.id, { notFound: 'Allotment not found' });
  if (a.status !== 'active') throw ApiError.badRequest('This allotment has ended');
  return a;
};

router.post('/allotments/:id/extend', permit('lockers.write'), validate({ body: z.object({ months: z.number().int().min(1).max(12), rent: paise, ...payBody }) }), async (req, res) => {
  const a = await loadAllotment(req);
  const from = addDays(a.endDate, 1);
  const to = periodEnd(from, req.body.months);
  const rno = req.body.rent ? await receiptNo() : null;
  if (req.body.rent) a.charges.push({ kind: 'rent', amount: req.body.rent, mode: req.body.mode, reference: req.body.reference, receiptNo: rno, from, to, by: req.user._id });
  a.endDate = to;
  await a.save();
  await audit(req, 'locker.extend', { entity: 'LockerAllotment', entityId: a._id, branchId: a.branchId, details: { to: ymd(to) } });
  res.json({ success: true, data: { allotment: a, receiptNo: rno } });
});

router.post(
  '/allotments/:id/release',
  permit('lockers.write'),
  validate({ body: z.object({ depositReturned: paise.default(0), mode: z.enum(MODES).default('cash'), note: z.string().max(200).optional() }) }),
  async (req, res) => {
    const a = await loadAllotment(req);
    if (req.body.depositReturned > a.deposit) throw ApiError.badRequest('Cannot return more than the deposit held');
    if (req.body.depositReturned) a.charges.push({ kind: 'deposit-return', amount: req.body.depositReturned, mode: req.body.mode, by: req.user._id });
    a.status = 'ended';
    a.endedAt = new Date();
    a.endedBy = req.user._id;
    a.endNote = req.body.note || (req.body.depositReturned < a.deposit ? 'Part of the deposit kept' : undefined);
    await a.save();
    await Locker.updateOne({ _id: a.lockerId, allotmentId: a._id }, { status: 'available', $unset: { allotmentId: 1 } });
    await audit(req, 'locker.release', { entity: 'LockerAllotment', entityId: a._id, branchId: a.branchId, details: { depositReturned: req.body.depositReturned } });
    res.json({ success: true, data: a });
  },
);

// History for a member (member page) or a locker.
router.get('/allotments', permit('lockers.read'), async (req, res) => {
  const filter = { ...branchFilter(req) };
  if (req.query.memberId && mongoose.isValidObjectId(req.query.memberId)) filter.memberId = req.query.memberId;
  if (req.query.lockerId && mongoose.isValidObjectId(req.query.lockerId)) filter.lockerId = req.query.lockerId;
  const list = await LockerAllotment.find(filter)
    .sort({ createdAt: -1 })
    .limit(50)
    .populate([{ path: 'lockerId', select: 'number section' }, { path: 'memberId', select: 'name memberCode' }])
    .lean();
  res.json({ success: true, data: list });
});

/* ---------------- Member app (/me/locker) ---------------- */
export const portalLockerRouter = Router();
portalLockerRouter.use(requireMember);
portalLockerRouter.get('/locker', async (req, res) => {
  const a = await LockerAllotment.findOne({ memberId: req.member._id, status: 'active' }).populate('lockerId', 'number section').lean();
  res.json({ success: true, data: a ? { number: a.lockerId?.number, section: a.lockerId?.section, startDate: a.startDate, endDate: a.endDate, deposit: a.deposit } : null });
});

/* ---------------- Daily job ---------------- */
/** Reminder to members 3 days before their locker period ends; one staff alert per branch for overdue lockers. */
export async function lockerAlerts({ now = new Date() } = {}) {
  const today = startOfDay(now);
  let reminders = 0;
  const soon = await LockerAllotment.find({ status: 'active', endDate: { $gte: addDays(today, 3), $lt: addDays(today, 4) } }).populate('lockerId', 'number').lean();
  for (const a of soon) {
    const member = await Member.findOne({ _id: a.memberId, isDeleted: false }).lean();
    if (!member) continue;
    const sent = await notifyMember({ member, template: 'locker_reminder', vars: { locker: a.lockerId?.number, date: dmy(a.endDate) }, dedupeKey: `locker:${a._id}:${ymd(a.endDate)}` });
    if (sent.length) reminders += 1;
  }
  const overdue = await LockerAllotment.aggregate([{ $match: { status: 'active', endDate: { $lt: today } } }, { $group: { _id: '$branchId', n: { $sum: 1 } } }]);
  let alerts = 0;
  for (const b of overdue) {
    const a = await createAlert({
      branchId: b._id,
      template: 'locker-overdue',
      subject: `${b.n} locker(s) past their paid period`,
      body: 'Open Lockers > Overdue to extend or release them.',
      dedupeKey: `locker-overdue:${b._id}:${ymd(today)}`,
    });
    if (a) alerts += 1;
  }
  return { reminders, alerts };
}

export default router;
