import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { startOfDay, addDays, parseDay, ymd, dmy, dayjs, tz } from '../../utils/dates.js';
import { sendExport, sendWorkbook } from '../../utils/csv.js';
import { Member } from '../members/member.model.js';
import { Payment } from '../payments/payment.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { PtPurchase, PtSession } from '../pt/pt.model.js';
import { Sale } from '../shop/shop.model.js';
import { Lead } from '../leads/lead.model.js';
import { User } from '../users/user.model.js';
import { ClassSession, Booking } from '../classes/class.model.js';
import { Invoice } from '../invoices/invoice.model.js';
import { LockerAllotment } from '../lockers/locker.model.js';
import { getGym } from '../settings/gym.model.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { audit } from '../audit/audit.model.js';
import { buildSupplies, gstr1, stateOf, posLabel, rs, GYM_SAC } from './gst.js';

const router = Router();
router.use(requireStaff);

const MODES = ['cash', 'upi', 'card', 'bank', 'online'];
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const money = { numFmt: '0.00' };

function range(req, defaultDays = 30) {
  const to = req.query.to ? parseDay(String(req.query.to)) : startOfDay();
  const from = req.query.from ? parseDay(String(req.query.from)) : addDays(to, -(defaultDays - 1));
  return { from, toExclusive: addDays(to, 1), fromDay: ymd(from), toDay: ymd(to) };
}

function monthRange(req) {
  const m = String(req.query.month || '');
  const start = /^\d{4}-\d{2}$/.test(m) ? dayjs.tz(`${m}-01`, tz).startOf('month') : dayjs().tz(tz).startOf('month');
  return { month: start.format('YYYY-MM'), from: start.toDate(), to: start.add(1, 'month').toDate(), label: start.format('MMM YYYY') };
}

/** Active staff of the branches in view, by role. */
function staffQuery(req, roles) {
  const filter = { role: { $in: roles }, isActive: true };
  if (req.query.branchId) filter.branchIds = new mongoose.Types.ObjectId(String(req.query.branchId));
  else if (req.allowedBranchIds) filter.branchIds = { $in: req.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  return User.find(filter).select('name role').lean();
}

const key = (id) => (id ? String(id) : 'none');

/* ---------------- Staff performance ---------------- */
// Manual discount on a membership: stored since approvals were added; older records are estimated.
const manualDiscountExpr = {
  $ifNull: [
    '$manualDiscount',
    { $cond: [{ $or: [{ $eq: ['$type', 'upgrade'] }, { $gt: ['$couponCode', null] }] }, 0, { $max: [0, { $subtract: [{ $ifNull: ['$discount', 0] }, { $ifNull: ['$companyDiscount', 0] }] }] }] },
  ],
};

export async function staffPerformance(req) {
  const bf = branchFilter(req);
  const { from, toExclusive, fromDay, toDay } = range(req, 30);
  const inRange = { $gte: from, $lt: toExclusive };
  const today = startOfDay();
  const [pays, subs, pts, sales, leads, sessions, active, ended, classes] = await Promise.all([
    Payment.aggregate([{ $match: { ...bf, type: 'payment', paidAt: inRange } }, { $group: { _id: { u: '$receivedBy', mode: '$mode' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Subscription.aggregate([
      { $match: { ...bf, createdAt: inRange, groupOf: null } },
      { $group: { _id: { u: '$createdBy', type: '$type' }, n: { $sum: 1 }, amount: { $sum: '$totalAmount' }, discount: { $sum: manualDiscountExpr } } },
    ]),
    PtPurchase.aggregate([{ $match: { ...bf, createdAt: inRange } }, { $group: { _id: '$createdBy', n: { $sum: 1 }, amount: { $sum: '$totalAmount' }, discount: { $sum: '$discount' } } }]),
    Sale.aggregate([{ $match: { ...bf, status: 'paid', createdAt: inRange } }, { $group: { _id: '$soldBy', n: { $sum: 1 }, amount: { $sum: '$total' }, discount: { $sum: '$discount' } } }]),
    Lead.aggregate([
      { $match: { ...bf, isDeleted: false, createdAt: inRange } },
      { $group: { _id: '$assignedTo', n: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
    ]),
    PtSession.aggregate([
      { $match: { ...bf, at: inRange } },
      {
        $group: {
          _id: '$trainerId',
          done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
          noShows: { $sum: { $cond: [{ $eq: ['$status', 'no-show'] }, 1, 0] } },
          commission: { $sum: '$commission' },
        },
      },
    ]),
    PtPurchase.aggregate([
      { $match: { ...bf, status: 'active', validTo: { $gte: today }, $expr: { $lt: ['$sessionsUsed', '$sessionsTotal'] } } },
      { $group: { _id: '$trainerId', clients: { $addToSet: '$memberId' } } },
    ]),
    PtPurchase.find({ ...bf, validTo: inRange }).select('memberId trainerId createdAt').lean(),
    ClassSession.find({ ...bf, trainerId: { $ne: null }, status: 'scheduled', startsAt: inRange }).select('trainerId startsAt').limit(5000).lean(),
  ]);

  // PT renewals: a package that ended in the period counts as renewed when the client bought another one from the same trainer.
  const later = ended.length
    ? await PtPurchase.find({ memberId: { $in: [...new Set(ended.map((p) => String(p.memberId)))] }, createdAt: { $gte: from } }).select('memberId trainerId createdAt').lean()
    : [];
  const renewals = {};
  for (const p of ended) {
    const r = (renewals[key(p.trainerId)] ||= { ended: 0, renewed: 0 });
    r.ended += 1;
    if (later.some((x) => String(x.memberId) === String(p.memberId) && String(x.trainerId) === String(p.trainerId) && x.createdAt > p.createdAt && String(x._id) !== String(p._id))) r.renewed += 1;
  }
  // Class attendance: attended / booked for classes that have started.
  const started = classes.filter((c) => c.startsAt <= new Date());
  const bookings = started.length
    ? await Booking.aggregate([{ $match: { sessionId: { $in: started.map((c) => c._id) }, status: { $in: ['booked', 'attended', 'no-show'] } } }, { $group: { _id: { s: '$sessionId', st: '$status' }, n: { $sum: 1 } } }])
    : [];
  const trainerOf = Object.fromEntries(classes.map((c) => [String(c._id), key(c.trainerId)]));
  const att = {};
  for (const b of bookings) {
    const a = (att[trainerOf[String(b._id.s)]] ||= { attended: 0, booked: 0 });
    a.booked += b.n;
    if (b._id.st === 'attended') a.attended += b.n;
  }

  const [staffUsers, trainerUsers] = await Promise.all([staffQuery(req, ['owner', 'manager', 'receptionist']), staffQuery(req, ['trainer'])]);
  const staff = {};
  const row = (id) =>
    (staff[key(id)] ||= {
      userId: id || null,
      payments: { count: 0, amount: 0, byMode: Object.fromEntries(MODES.map((m) => [m, 0])) },
      newMemberships: 0, renewals: 0, membershipAmount: 0, ptSold: 0, ptAmount: 0, shopSales: 0, shopAmount: 0, leads: 0, converted: 0, discounts: 0,
    });
  for (const u of staffUsers) row(u._id);
  for (const p of pays) {
    const r = row(p._id.u);
    r.payments.count += p.n;
    r.payments.amount += p.amount;
    r.payments.byMode[p._id.mode] = (r.payments.byMode[p._id.mode] || 0) + p.amount;
  }
  for (const s of subs) {
    const r = row(s._id.u);
    if (s._id.type === 'new') r.newMemberships += s.n;
    else r.renewals += s.n;
    r.membershipAmount += s.amount;
    r.discounts += s.discount;
  }
  for (const p of pts) Object.assign(row(p._id), { ptSold: row(p._id).ptSold + p.n, ptAmount: row(p._id).ptAmount + p.amount, discounts: row(p._id).discounts + p.discount });
  for (const s of sales) Object.assign(row(s._id), { shopSales: row(s._id).shopSales + s.n, shopAmount: row(s._id).shopAmount + s.amount, discounts: row(s._id).discounts + s.discount });
  for (const l of leads) Object.assign(row(l._id), { leads: row(l._id).leads + l.n, converted: row(l._id).converted + l.converted });

  const trainers = {};
  const trow = (id) => (trainers[key(id)] ||= { userId: id || null, sessions: 0, noShows: 0, activeClients: 0, ptEnded: 0, ptRenewed: 0, classes: 0, attended: 0, booked: 0, commission: 0 });
  for (const u of trainerUsers) trow(u._id);
  for (const s of sessions) Object.assign(trow(s._id), { sessions: s.done, noShows: s.noShows, commission: s.commission });
  for (const a of active) trow(a._id).activeClients = a.clients.length;
  for (const [id, r] of Object.entries(renewals)) if (id !== 'none') Object.assign(trow(id), { ptEnded: r.ended, ptRenewed: r.renewed });
  for (const c of classes) trow(c.trainerId).classes += 1;
  for (const [id, a] of Object.entries(att)) if (id !== 'none') Object.assign(trow(id), a);

  // Names for everyone that appears (someone may have left or moved branch).
  const ids = [...Object.keys(staff), ...Object.keys(trainers)].filter((k) => k !== 'none');
  const users = Object.fromEntries((await User.find({ _id: { $in: ids } }).select('name role isActive').lean()).map((u) => [String(u._id), u]));
  const named = (r) => {
    const u = users[key(r.userId)];
    return { ...r, name: u ? `${u.name}${u.isActive ? '' : ' (inactive)'}` : 'Not recorded', role: u?.role || null };
  };
  const staffRows = Object.values(staff)
    .map((r) => named({ ...r, conversion: pct(r.converted, r.leads) }))
    .filter((r) => r.role !== 'trainer' || r.payments.count || r.shopSales || r.newMemberships)
    .sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1) || b.payments.amount - a.payments.amount);
  const trainerRows = Object.values(trainers)
    .filter((r) => r.userId)
    .map((r) => named({ ...r, renewalRate: pct(r.ptRenewed, r.ptEnded), attendance: pct(r.attended, r.booked) }))
    .sort((a, b) => b.sessions - a.sessions);
  return { from: fromDay, to: toDay, staff: staffRows, trainers: trainerRows };
}

router.get('/staff', permit('reports.read'), async (req, res) => {
  const data = await staffPerformance(req);
  if (req.query.export === 'xlsx') {
    return sendWorkbook(res, `staff-performance-${data.from}-to-${data.to}.xlsx`, [
      {
        name: 'Front desk',
        rows: data.staff,
        columns: [
          { label: 'Staff', key: 'name' },
          { label: 'Role', key: 'role' },
          { label: 'Payments', value: (r) => r.payments.count },
          { label: 'Collected (Rs)', value: (r) => rs(r.payments.amount), ...money },
          ...MODES.map((m) => ({ label: `${m.toUpperCase()} (Rs)`, value: (r) => rs(r.payments.byMode[m]), ...money })),
          { label: 'New memberships', key: 'newMemberships' },
          { label: 'Renewals', key: 'renewals' },
          { label: 'PT packages', key: 'ptSold' },
          { label: 'Shop sales', key: 'shopSales' },
          { label: 'Shop amount (Rs)', value: (r) => rs(r.shopAmount), ...money },
          { label: 'Leads', key: 'leads' },
          { label: 'Converted', key: 'converted' },
          { label: 'Conversion %', value: (r) => r.conversion ?? '' },
          { label: 'Discounts given (Rs)', value: (r) => rs(r.discounts), ...money },
        ],
      },
      {
        name: 'Trainers',
        rows: data.trainers,
        columns: [
          { label: 'Trainer', key: 'name' },
          { label: 'PT sessions', key: 'sessions' },
          { label: 'No-shows', key: 'noShows' },
          { label: 'Active PT clients', key: 'activeClients' },
          { label: 'PT packages ended', key: 'ptEnded' },
          { label: 'Renewed', key: 'ptRenewed' },
          { label: 'Renewal %', value: (r) => r.renewalRate ?? '' },
          { label: 'Classes taken', key: 'classes' },
          { label: 'Class attendance %', value: (r) => r.attendance ?? '' },
          { label: 'Commission (Rs)', value: (r) => rs(r.commission), ...money },
        ],
      },
    ]);
  }
  res.json({ success: true, data });
});

/* ---------------- Retention / churn ---------------- */
export async function retention(req, { months = 6, graceDays = 15, inactiveDays = 14, now = new Date() } = {}) {
  const bf = branchFilter(req);
  const today = startOfDay(now);
  const first = dayjs(now).tz(tz).startOf('month').subtract(months - 1, 'month');
  // Only memberships whose last day has passed (the current month is still running).
  const subs = await Subscription.find({ ...bf, status: 'active', endDate: { $gte: first.toDate(), $lt: today } }).select('memberId startDate endDate').lean();
  const memberIds = [...new Set(subs.map((s) => String(s.memberId)))];
  const others = memberIds.length ? await Subscription.find({ memberId: { $in: memberIds }, startDate: { $gte: first.subtract(1, 'year').toDate() } }).select('memberId startDate').lean() : [];
  const byMember = {};
  for (const o of others) (byMember[String(o.memberId)] ||= []).push(o);

  const rows = [];
  for (let i = 0; i < months; i += 1) {
    const m = first.add(i, 'month');
    const mFrom = m.toDate();
    const mTo = m.add(1, 'month').toDate();
    // Each member once a month: the membership that ended last in the month.
    const last = {};
    for (const s of subs) {
      if (s.endDate < mFrom || s.endDate >= mTo) continue;
      const k = String(s.memberId);
      if (!last[k] || s.endDate > last[k].endDate) last[k] = s;
    }
    let renewed = 0;
    let pending = 0;
    for (const s of Object.values(last)) {
      const deadline = ymd(addDays(s.endDate, graceDays));
      const next = (byMember[String(s.memberId)] || []).some((o) => String(o._id) !== String(s._id) && o.startDate > s.startDate && ymd(o.startDate) <= deadline);
      if (next) renewed += 1;
      else if (ymd(today) <= deadline) pending += 1;
    }
    const ended = Object.keys(last).length;
    const lost = ended - renewed - pending;
    rows.push({ month: m.format('YYYY-MM'), label: m.format('MMM YYYY'), ended, renewed, lost, pending, retention: pct(renewed, renewed + lost), churn: pct(lost, renewed + lost) });
  }

  const cutoff = addDays(today, -inactiveDays);
  const fields = 'name memberCode phone currentPlanName membershipEnd lastVisitAt';
  const [inactive, expiring] = await Promise.all([
    Member.find({ ...bf, isDeleted: false, membershipStatus: 'active', $or: [{ lastVisitAt: { $lt: cutoff } }, { lastVisitAt: null, membershipStart: { $lt: cutoff } }] })
      .sort({ lastVisitAt: 1 })
      .limit(500)
      .select(fields)
      .lean(),
    Member.find({ ...bf, isDeleted: false, membershipStatus: 'active', membershipEnd: { $gte: today, $lt: addDays(today, 8) } }).sort({ membershipEnd: 1 }).limit(500).select(fields).lean(),
  ]);
  const totals = rows.reduce((t, r) => ({ ended: t.ended + r.ended, renewed: t.renewed + r.renewed, lost: t.lost + r.lost, pending: t.pending + r.pending }), { ended: 0, renewed: 0, lost: 0, pending: 0 });
  return {
    graceDays,
    inactiveDays,
    months: rows,
    totals: { ...totals, retention: pct(totals.renewed, totals.renewed + totals.lost), churn: pct(totals.lost, totals.renewed + totals.lost) },
    atRisk: {
      inactive: inactive.map((m) => ({ ...m, reason: 'inactive', daysAway: m.lastVisitAt ? Math.floor((today - startOfDay(m.lastVisitAt)) / 86400000) : null })),
      expiring: expiring.map((m) => ({ ...m, reason: 'expiring' })),
    },
  };
}

router.get('/retention', permit('reports.read'), async (req, res) => {
  const gym = await getGym();
  const months = Math.min(12, Math.max(3, Number(req.query.months) || 6));
  const graceDays = req.query.graceDays != null && req.query.graceDays !== '' ? Math.min(90, Math.max(0, Number(req.query.graceDays) || 0)) : gym.settings?.retentionGraceDays ?? 15;
  const inactiveDays = [7, 14, 30].includes(Number(req.query.inactiveDays)) ? Number(req.query.inactiveDays) : 14;
  const data = await retention(req, { months, graceDays, inactiveDays });
  if (req.query.export === 'xlsx') {
    const risk = [...data.atRisk.inactive, ...data.atRisk.expiring];
    return sendWorkbook(res, 'retention.xlsx', [
      {
        name: 'By month',
        rows: data.months,
        columns: [
          { label: 'Month', key: 'label' },
          { label: 'Memberships ended', key: 'ended' },
          { label: `Renewed within ${graceDays} days`, key: 'renewed' },
          { label: 'Lost', key: 'lost' },
          { label: 'Still in renewal window', key: 'pending' },
          { label: 'Retention %', value: (r) => r.retention ?? '' },
          { label: 'Churn %', value: (r) => r.churn ?? '' },
        ],
      },
      {
        name: 'At risk',
        rows: risk,
        columns: [
          { label: 'Why', value: (r) => (r.reason === 'inactive' ? `No visit in ${inactiveDays}+ days` : 'Expiring in 7 days') },
          { label: 'Member', key: 'name' },
          { label: 'Code', key: 'memberCode' },
          { label: 'Phone', key: 'phone' },
          { label: 'Plan', key: 'currentPlanName' },
          { label: 'End date', value: (r) => (r.membershipEnd ? dmy(r.membershipEnd) : '') },
          { label: 'Last visit', value: (r) => (r.lastVisitAt ? dmy(r.lastVisitAt) : 'Never') },
        ],
      },
    ]);
  }
  res.json({ success: true, data });
});

router.post(
  '/retention/remind',
  permit('reports.read'),
  validate({ body: z.object({ memberId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id'), reason: z.enum(['inactive', 'expiring']) }) }),
  async (req, res) => {
    const member = await findInBranch(req, Member, req.body.memberId, { notFound: 'Member not found', extra: { isDeleted: false } });
    const gym = await getGym();
    const channels = ['sms', 'whatsapp'].filter((c) => gym.settings?.channels?.[c]);
    if (!channels.length) throw new ApiError(400, 'SMS and WhatsApp are switched off. Turn one on in Settings to send reminders.', undefined, 'CHANNELS_OFF');
    const today = startOfDay();
    const m = member.toObject();
    const days = m.lastVisitAt ? Math.floor((today - startOfDay(m.lastVisitAt)) / 86400000) : 30;
    const message =
      req.body.reason === 'inactive'
        ? { template: 'miss_you', vars: { days } }
        : { template: 'renewal_reminder', vars: { plan: m.currentPlanName || 'gym', date: m.membershipEnd ? dmy(m.membershipEnd) : '' } };
    const sent = await notifyMember({ member: m, gym, ...message, dedupeKey: `retention-${req.body.reason}:${m._id}:${ymd(today)}` });
    if (!sent.length) throw ApiError.conflict(`${m.name} was already reminded today`);
    await audit(req, 'retention.remind', { entity: 'Member', entityId: m._id, branchId: m.branchId, details: { reason: req.body.reason, channels } });
    res.json({ success: true, data: { sent: sent.length, channels } });
  },
);

/* ---------------- GST: GSTR-1 and Tally ---------------- */
async function monthSupplies(req) {
  const bf = branchFilter(req);
  const { month, from, to, label } = monthRange(req);
  const gym = await getGym();
  const gymState = stateOf(gym.gstin);
  const [invoices, sales] = await Promise.all([
    Invoice.find({ ...bf, issuedAt: { $gte: from, $lt: to }, total: { $gt: 0 } }).sort({ issuedAt: 1 }).lean(),
    Sale.find({ ...bf, createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).populate('memberId', 'name').lean(),
  ]);
  return { bf, month, from, to, label, gym, gymState, invoices, sales, docs: buildSupplies({ invoices, sales, gymState }) };
}

async function refundsIn(bf, from, to) {
  const [payments, sales] = await Promise.all([
    Payment.find({ ...bf, type: 'refund', paidAt: { $gte: from, $lt: to } }).sort({ paidAt: 1 }).populate([{ path: 'memberId', select: 'name' }, { path: 'refundOf', select: 'receiptNo' }, { path: 'invoiceId', select: 'invoiceNo billedTo' }]).lean(),
    Sale.find({ ...bf, status: 'refunded', refundedAt: { $gte: from, $lt: to } }).sort({ refundedAt: 1 }).populate('memberId', 'name').lean(),
  ]);
  return [
    ...payments.map((p) => ({ date: p.paidAt, no: p.receiptNo, against: p.invoiceId?.invoiceNo || p.refundOf?.receiptNo, party: p.invoiceId?.billedTo?.name || p.memberId?.name, kind: p.ptPurchaseId ? 'Personal training' : 'Membership', amount: p.amount, mode: p.mode, reason: p.note })),
    ...sales.map((s) => ({ date: s.refundedAt, no: s.saleNo, against: s.saleNo, party: s.memberId?.name || s.customerName || 'Walk-in', kind: 'Shop', amount: s.total, mode: s.mode, reason: s.refundReason })),
  ];
}

const gstDate = (d) => dayjs(d).tz(tz).format('DD-MMM-YY');
const NOTES = [
  'Memberships and personal training are reported under SAC 999723. Shop items use the HSN set on each product; items without one are in the "unspecified" row.',
  'Place of supply is the state in the customer GSTIN, otherwise the gym state. Same state: CGST + SGST; other state: IGST.',
  'The app does not issue credit notes. Refunds made in the month are listed in the "refunds" sheet; raise credit notes (cdnr / cdnur) in your accounting software if needed.',
  'Locker rent is collected without GST in this app and is not included in GSTR-1.',
];

router.get('/gstr1', permit('reports.read'), async (req, res) => {
  const s = await monthSupplies(req);
  const r = gstr1(s.docs);
  const refunds = await refundsIn(s.bf, s.from, s.to);
  const refundTotal = refunds.reduce((t, x) => t + x.amount, 0);
  if (req.query.export === 'xlsx') {
    const invNos = s.invoices.map((i) => i.invoiceNo);
    const saleNos = s.sales.map((x) => x.saleNo);
    return sendWorkbook(res, `GSTR1-${s.month}.xlsx`, [
      {
        name: 'summary',
        rows: [
          { k: 'Return period', v: s.label },
          { k: 'GSTIN', v: s.gym.gstin || 'Not set in Settings' },
          { k: 'Gym state', v: posLabel(s.gymState) || 'Unknown (set the GSTIN in Settings)' },
          { k: 'Documents', v: r.totals.documents },
          { k: 'Total invoice value (Rs)', v: rs(r.totals.invoiceValue) },
          { k: 'Taxable value (Rs)', v: rs(r.totals.taxable) },
          { k: 'IGST (Rs)', v: rs(r.totals.igst) },
          { k: 'CGST (Rs)', v: rs(r.totals.cgst) },
          { k: 'SGST (Rs)', v: rs(r.totals.sgst) },
          { k: 'Refunds in the month (Rs)', v: rs(refundTotal) },
          ...NOTES.map((n, i) => ({ k: `Note ${i + 1}`, v: n })),
        ],
        columns: [{ label: 'Item', key: 'k' }, { label: 'Value', key: 'v' }],
      },
      {
        name: 'b2b',
        rows: r.b2b,
        columns: [
          { label: 'GSTIN/UIN of Recipient', key: 'gstin' },
          { label: 'Receiver Name', key: 'party' },
          { label: 'Invoice Number', key: 'no' },
          { label: 'Invoice date', value: (x) => gstDate(x.date) },
          { label: 'Invoice Value', value: (x) => rs(x.value), ...money },
          { label: 'Place Of Supply', value: (x) => posLabel(x.pos) },
          { label: 'Reverse Charge', value: () => 'N' },
          { label: 'Applicable % of Tax Rate', value: () => '' },
          { label: 'Invoice Type', value: () => 'Regular B2B' },
          { label: 'E-Commerce GSTIN', value: () => '' },
          { label: 'Rate', key: 'rate' },
          { label: 'Taxable Value', value: (x) => rs(x.taxable), ...money },
          { label: 'Cess Amount', value: () => 0 },
        ],
      },
      {
        name: 'b2cs',
        rows: r.b2cs,
        columns: [
          { label: 'Type', value: () => 'OE' },
          { label: 'Place Of Supply', value: (x) => posLabel(x.pos) },
          { label: 'Applicable % of Tax Rate', value: () => '' },
          { label: 'Rate', key: 'rate' },
          { label: 'Taxable Value', value: (x) => rs(x.taxable), ...money },
          { label: 'Cess Amount', value: () => 0 },
          { label: 'E-Commerce GSTIN', value: () => '' },
        ],
      },
      {
        name: 'hsn',
        rows: r.hsn,
        columns: [
          { label: 'HSN', value: (x) => x.hsn || 'unspecified' },
          { label: 'Description', key: 'desc' },
          { label: 'UQC', key: 'uqc' },
          { label: 'Total Quantity', key: 'qty' },
          { label: 'Total Value', value: (x) => rs(x.value), ...money },
          { label: 'Rate', key: 'rate' },
          { label: 'Taxable Value', value: (x) => rs(x.taxable), ...money },
          { label: 'Integrated Tax Amount', value: (x) => rs(x.igst), ...money },
          { label: 'Central Tax Amount', value: (x) => rs(x.cgst), ...money },
          { label: 'State/UT Tax Amount', value: (x) => rs(x.sgst), ...money },
          { label: 'Cess Amount', value: () => 0 },
        ],
      },
      {
        name: 'docs',
        rows: [
          ...(invNos.length ? [{ nature: 'Invoices for outward supply', from: invNos[0], to: invNos[invNos.length - 1], n: invNos.length }] : []),
          ...(saleNos.length ? [{ nature: 'Invoices for outward supply', from: saleNos[0], to: saleNos[saleNos.length - 1], n: saleNos.length }] : []),
        ],
        columns: [
          { label: 'Nature of Document', key: 'nature' },
          { label: 'Sr. No. From', key: 'from' },
          { label: 'Sr. No. To', key: 'to' },
          { label: 'Total Number', key: 'n' },
          { label: 'Cancelled', value: () => 0 },
        ],
      },
      {
        name: 'refunds',
        rows: refunds,
        columns: [
          { label: 'Date', value: (x) => dmy(x.date) },
          { label: 'Refund no', key: 'no' },
          { label: 'Original invoice / receipt', key: 'against' },
          { label: 'Party', key: 'party' },
          { label: 'For', key: 'kind' },
          { label: 'Amount incl. GST (Rs)', value: (x) => rs(x.amount), ...money },
          { label: 'Mode', key: 'mode' },
          { label: 'Reason', key: 'reason' },
        ],
      },
    ]);
  }
  res.json({
    success: true,
    data: { month: s.month, label: s.label, gstin: s.gym.gstin || null, gymState: posLabel(s.gymState), totals: r.totals, b2b: r.b2b.length, b2cs: r.b2cs, hsn: r.hsn, refunds: { count: refunds.length, amount: refundTotal }, notes: NOTES, sac: GYM_SAC },
  });
});

router.get('/tally', permit('reports.read'), async (req, res) => {
  const s = await monthSupplies(req);
  const invoiceIds = s.invoices.map((i) => i._id);
  const [invPayments, receipts, lockers] = await Promise.all([
    Payment.aggregate([{ $match: { invoiceId: { $in: invoiceIds }, type: 'payment' } }, { $group: { _id: '$invoiceId', modes: { $addToSet: '$mode' } } }]),
    Payment.find({ ...s.bf, paidAt: { $gte: s.from, $lt: s.to } }).sort({ paidAt: 1 }).populate([{ path: 'memberId', select: 'name' }, { path: 'invoiceId', select: 'invoiceNo' }]).lean(),
    LockerAllotment.aggregate([
      { $match: { ...s.bf, 'charges.at': { $gte: s.from, $lt: s.to } } },
      { $unwind: '$charges' },
      { $match: { 'charges.at': { $gte: s.from, $lt: s.to } } },
      { $lookup: { from: 'members', localField: 'memberId', foreignField: '_id', as: 'm' } },
      { $project: { c: '$charges', party: { $arrayElemAt: ['$m.name', 0] } } },
      { $sort: { 'c.at': 1 } },
    ]),
  ]);
  const modesOf = Object.fromEntries(invPayments.map((p) => [String(p._id), p.modes.join(' / ')]));
  const invById = Object.fromEntries(s.invoices.map((i) => [i.invoiceNo, i]));
  const sales = s.docs.map((d) => ({
    date: d.date,
    no: d.no,
    party: d.party,
    gstin: d.gstin || '',
    ledger: d.ledger,
    taxable: d.lines.reduce((t, l) => t + l.taxable, 0),
    cgst: d.cgst,
    sgst: d.sgst,
    igst: d.igst,
    total: d.total,
    mode: d.kind === 'sale' ? d.mode : modesOf[String(invById[d.no]?._id)] || 'Credit (unpaid)',
  }));
  for (const l of lockers.filter((x) => x.c.kind === 'rent')) {
    sales.push({ date: l.c.at, no: l.c.receiptNo || '', party: l.party, gstin: '', ledger: 'Locker rent', taxable: l.c.amount, cgst: 0, sgst: 0, igst: 0, total: l.c.amount, mode: l.c.mode || 'cash' });
  }
  sales.sort((a, b) => new Date(a.date) - new Date(b.date));
  const receiptRows = [
    ...receipts.map((p) => ({ date: p.paidAt, no: p.receiptNo, party: p.memberId?.name, against: p.invoiceId?.invoiceNo || '', ledger: p.ptPurchaseId ? 'Personal training' : 'Membership', amount: p.type === 'refund' ? -p.amount : p.amount, mode: p.mode, reference: p.reference || '', type: p.type === 'refund' ? 'Refund' : 'Receipt' })),
    ...lockers.map((l) => ({
      date: l.c.at, no: l.c.receiptNo || '', party: l.party, against: '', ledger: l.c.kind === 'rent' ? 'Locker rent' : 'Locker deposit',
      amount: l.c.kind === 'deposit-return' ? -l.c.amount : l.c.amount, mode: l.c.mode || 'cash', reference: l.c.reference || '', type: l.c.kind === 'deposit-return' ? 'Deposit returned' : 'Receipt',
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const salesColumns = [
    { label: 'Date', value: (x) => dmy(x.date) },
    { label: 'Voucher No', key: 'no' },
    { label: 'Party Name', key: 'party' },
    { label: 'Party GSTIN', key: 'gstin' },
    { label: 'Ledger', key: 'ledger' },
    { label: 'Taxable Value', value: (x) => rs(x.taxable), ...money },
    { label: 'CGST', value: (x) => rs(x.cgst), ...money },
    { label: 'SGST', value: (x) => rs(x.sgst), ...money },
    { label: 'IGST', value: (x) => rs(x.igst), ...money },
    { label: 'Total', value: (x) => rs(x.total), ...money },
    { label: 'Payment Mode', key: 'mode' },
  ];
  if (req.query.export === 'csv') return sendExport(res, 'csv', `tally-sales-${s.month}`, sales, salesColumns);
  if (req.query.export === 'xlsx') {
    return sendWorkbook(res, `tally-${s.month}.xlsx`, [
      { name: 'Sales register', rows: sales, columns: salesColumns },
      {
        name: 'Receipts',
        rows: receiptRows,
        columns: [
          { label: 'Date', value: (x) => dmy(x.date) },
          { label: 'Receipt No', key: 'no' },
          { label: 'Party Name', key: 'party' },
          { label: 'Against Invoice', key: 'against' },
          { label: 'Ledger', key: 'ledger' },
          { label: 'Amount', value: (x) => rs(x.amount), ...money },
          { label: 'Payment Mode', key: 'mode' },
          { label: 'Reference', key: 'reference' },
          { label: 'Type', key: 'type' },
        ],
      },
    ]);
  }
  const byLedger = {};
  for (const x of sales) {
    const l = (byLedger[x.ledger] ||= { ledger: x.ledger, count: 0, taxable: 0, tax: 0, total: 0 });
    l.count += 1;
    l.taxable += x.taxable;
    l.tax += x.cgst + x.sgst + x.igst;
    l.total += x.total;
  }
  res.json({ success: true, data: { month: s.month, label: s.label, vouchers: sales.length, receipts: receiptRows.length, byLedger: Object.values(byLedger), received: receiptRows.reduce((t, x) => t + x.amount, 0) } });
});

export default router;
