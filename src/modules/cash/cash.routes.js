import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees, formatINR } from '../../utils/money.js';
import { dmy, parseDay } from '../../utils/dates.js';
import { Branch } from '../branches/branch.model.js';
import { getGym } from '../settings/gym.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { audit } from '../audit/audit.model.js';
import { CashClosing, DENOMINATIONS } from './cash.model.js';
import { dayFigures, suggestedFloat, countDenominations, cashMath, statementMatch, todayYmd } from './cash.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const paise = z.number().int().min(0).max(1000000000);
const count = z.number().int().min(0).max(100000);

/** The branch to work on: the one asked for, else the only one the user (or the gym) has. */
async function pickBranch(req, given) {
  if (given) {
    assertBranchAccess(req, given);
    return String(given);
  }
  const ids = req.allowedBranchIds === null ? (await Branch.find().select('_id').lean()).map((b) => String(b._id)) : req.allowedBranchIds;
  if (ids.length === 1) return ids[0];
  throw ApiError.badRequest('Choose a branch');
}

/** Receptionists work on today only; owner/manager may look at and close past days. */
function checkDay(req, d) {
  const today = todayYmd();
  if (d > today) throw ApiError.badRequest('This day has not started yet');
  if (d !== today && !can(req.user.role, 'cash.manage')) throw ApiError.forbidden('You can only see and close today');
}

router.get('/day', permit('cash.close'), async (req, res) => {
  const branchId = await pickBranch(req, req.query.branchId);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? String(req.query.day) : todayYmd();
  checkDay(req, d);
  const [branch, closing, figures, suggested] = await Promise.all([
    Branch.findById(branchId).select('name code').lean(),
    CashClosing.findOne({ branchId, day: d }).populate('closedBy', 'name').lean(),
    dayFigures(branchId, d),
    suggestedFloat(branchId, d),
  ]);
  const openingFloat = closing ? closing.openingFloat : suggested.amount;
  const live = cashMath({ openingFloat, byMode: figures.byMode, countedCash: 0 });
  // Money recorded after the day was closed (late payment, refund...): shown so the owner can reopen and recount.
  let changedSinceClose = null;
  if (closing?.status === 'closed') {
    const snap = closing.system?.byMode || {};
    const delta = Object.fromEntries(
      Object.entries(figures.byMode).map(([m, t]) => [m, (t.in - t.out) - ((snap[m]?.in || 0) - (snap[m]?.out || 0))]),
    );
    if (Object.values(delta).some((v) => v !== 0)) changedSinceClose = delta;
  }
  res.json({
    success: true,
    data: {
      day: d,
      branch,
      closing,
      figures,
      opening: { suggested: suggested.amount, fromDay: suggested.fromDay },
      expectedCash: live.expectedCash,
      cashIn: live.cashIn,
      cashOut: live.cashOut,
      statement: statementMatch(closing?.status === 'closed' ? closing.system.byMode : figures.byMode, closing?.statement),
      changedSinceClose,
      canReopen: can(req.user.role, 'cash.manage'),
      denominations: DENOMINATIONS,
    },
  });
});

router.post(
  '/close',
  permit('cash.close'),
  validate({
    body: z.object({
      branchId: objectId.optional(),
      day: day.optional(),
      openingFloat: paise.default(0),
      countedCash: paise.optional(),
      denominations: z.object({ n500: count, n200: count, n100: count, n50: count, n20: count, n10: count, coins: paise }).partial().optional(),
      floatKept: paise.default(0),
      note: z.string().trim().max(500).optional(),
      statement: z.object({ upi: paise.nullable(), card: paise.nullable(), bank: paise.nullable(), online: paise.nullable() }).partial().optional(),
    }),
  }),
  async (req, res) => {
    const b = req.body;
    const branchId = await pickBranch(req, b.branchId);
    const d = b.day || todayYmd();
    checkDay(req, d);
    const hasNotes = b.denominations && Object.values(b.denominations).some((v) => v);
    const countedCash = hasNotes ? countDenominations(b.denominations) : b.countedCash;
    if (countedCash == null) throw ApiError.badRequest('Enter the cash counted in the drawer');
    if (b.floatKept > countedCash) throw ApiError.badRequest('Float kept cannot be more than the cash counted');

    const figures = await dayFigures(branchId, d);
    const math = cashMath({ openingFloat: b.openingFloat, byMode: figures.byMode, countedCash });
    if (math.difference !== 0 && !b.note) throw ApiError.badRequest(`Cash is ${math.difference < 0 ? 'short' : 'excess'} by ${formatINR(Math.abs(math.difference))}. Add a note explaining the difference.`);

    const statement = Object.fromEntries(Object.entries(b.statement || {}).filter(([, v]) => v != null));
    const doc = {
      openingFloat: b.openingFloat,
      system: figures,
      ...math,
      countedCash,
      denominations: hasNotes ? b.denominations : undefined,
      floatKept: b.floatKept,
      note: b.note,
      statement,
      status: 'closed',
      closedBy: req.user._id,
      closedAt: new Date(),
    };
    let closing = await CashClosing.findOne({ branchId, day: d });
    if (closing?.status === 'closed') throw ApiError.conflict('This day is already closed. Ask the owner or manager to reopen it.');
    if (closing) {
      closing = await CashClosing.findOneAndUpdate({ _id: closing._id, status: 'reopened' }, { $set: doc, $inc: { closeCount: 1 } }, { returnDocument: 'after' });
      if (!closing) throw ApiError.conflict('This day was just closed by someone else');
    } else {
      try {
        closing = await CashClosing.create({ branchId, day: d, ...doc });
      } catch (err) {
        if (err?.code === 11000) throw ApiError.conflict('This day was just closed by someone else');
        throw err;
      }
    }

    const gym = await getGym();
    const limit = gym.settings?.cashShortAlert ?? 10000;
    if (math.difference < 0 && -math.difference > limit) {
      const branch = await Branch.findById(branchId).select('name').lean();
      await createAlert({
        branchId,
        template: 'cash-short',
        subject: `Cash short by ${formatINR(-math.difference)} on ${dmy(parseDay(d))}${branch ? ` (${branch.name})` : ''}`,
        body: `Closed by ${req.user.name}: ${b.note}`,
        dedupeKey: `cash-short:${branchId}:${d}:${closing.closeCount}`,
      });
      closing.shortAlerted = true;
      await CashClosing.updateOne({ _id: closing._id }, { shortAlerted: true });
    }
    await audit(req, 'cash.close', { entity: 'CashClosing', entityId: closing._id, branchId, details: { day: d, expected: math.expectedCash, counted: countedCash, difference: math.difference } });
    res.status(201).json({ success: true, data: closing });
  },
);

router.post('/:id/reopen', permit('cash.manage'), validate({ body: z.object({ reason: z.string().trim().min(3).max(300) }) }), async (req, res) => {
  const c = await findInBranch(req, CashClosing, req.params.id, { notFound: 'Closing not found' });
  if (c.status !== 'closed') throw ApiError.badRequest('This day is already open');
  c.status = 'reopened';
  c.reopens.push({ at: new Date(), by: req.user._id, byName: req.user.name, reason: req.body.reason });
  await c.save();
  await audit(req, 'cash.reopen', { entity: 'CashClosing', entityId: c._id, branchId: c.branchId, details: { day: c.day, reason: req.body.reason } });
  res.json({ success: true, data: c });
});

router.get('/closings', permit('cash.manage'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.from || q.to) {
    filter.day = {};
    if (q.from) filter.day.$gte = String(q.from);
    if (q.to) filter.day.$lte = String(q.to);
  }
  if (q.result === 'short') filter.difference = { $lt: 0 };
  if (q.result === 'excess') filter.difference = { $gt: 0 };
  if (q.result === 'matched') filter.difference = 0;
  if (q.status === 'closed' || q.status === 'reopened') filter.status = q.status;
  if (isExport(q)) {
    const rows = await CashClosing.find(filter).sort({ day: -1 }).limit(5000).populate([{ path: 'branchId', select: 'name' }, { path: 'closedBy', select: 'name' }]).lean();
    const m = (r, mode) => toRupees((r.system?.byMode?.[mode]?.in || 0) - (r.system?.byMode?.[mode]?.out || 0));
    return sendExport(res, q.export, 'day-closings', rows, [
      { label: 'Day', key: 'day' },
      { label: 'Branch', value: (r) => r.branchId?.name },
      { label: 'Status', key: 'status' },
      { label: 'Opening float (Rs)', value: (r) => toRupees(r.openingFloat) },
      { label: 'Cash in (Rs)', value: (r) => toRupees(r.cashIn) },
      { label: 'Cash out (Rs)', value: (r) => toRupees(r.cashOut) },
      { label: 'Expected cash (Rs)', value: (r) => toRupees(r.expectedCash) },
      { label: 'Counted cash (Rs)', value: (r) => toRupees(r.countedCash) },
      { label: 'Difference (Rs)', value: (r) => toRupees(r.difference) },
      { label: 'Float kept (Rs)', value: (r) => toRupees(r.floatKept) },
      { label: 'UPI (Rs)', value: (r) => m(r, 'upi') },
      { label: 'Card (Rs)', value: (r) => m(r, 'card') },
      { label: 'Bank (Rs)', value: (r) => m(r, 'bank') },
      { label: 'Online (Rs)', value: (r) => m(r, 'online') },
      { label: 'Closed by', value: (r) => r.closedBy?.name },
      { label: 'Note', key: 'note' },
      { label: 'Reopened', value: (r) => r.reopens?.map((x) => `${x.byName}: ${x.reason}`).join('; ') },
    ]);
  }
  const [data, totals] = await Promise.all([
    paginate(CashClosing, filter, q, { sort: { day: -1, createdAt: -1 }, populate: [{ path: 'branchId', select: 'name' }, { path: 'closedBy', select: 'name' }] }),
    CashClosing.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          short: { $sum: { $cond: [{ $lt: ['$difference', 0] }, '$difference', 0] } },
          excess: { $sum: { $cond: [{ $gt: ['$difference', 0] }, '$difference', 0] } },
          shortDays: { $sum: { $cond: [{ $lt: ['$difference', 0] }, 1, 0] } },
        },
      },
    ]),
  ]);
  res.json({ success: true, data: { ...data, summary: totals[0] || { short: 0, excess: 0, shortDays: 0 } } });
});

export default router;
