import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, parseDay, startOfDay, dayjs, tz } from '../../utils/dates.js';
import { PtPackage, PtPurchase, PtSession } from './pt.model.js';
import { Member } from '../members/member.model.js';
import { PAYMENT_MODES } from '../payments/payment.model.js';
import { recordPayment } from '../subscriptions/subscription.service.js';
import { inBackground, sendReceiptEmail } from '../notifications/emails.js';
import { sellPackage, logSession, undoSession } from './pt.service.js';
import { audit } from '../audit/audit.model.js';
import { withDiscountGuard } from '../approvals/approval.service.js';
import { PtBooking } from './ptBooking.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const paymentBody = z.object({ amount: z.number().int().min(1), mode: z.enum(PAYMENT_MODES), reference: z.string().trim().max(100).optional() });

/** Trainers see only their own clients' packages and sessions. */
const trainerScope = (req) => (req.user.role === 'trainer' ? { trainerId: req.user._id } : {});

/* ---------- Packages (templates) ---------- */
const pkgBody = z.object({
  name: z.string().trim().min(2).max(60),
  sessions: z.number().int().min(1).max(500),
  validityDays: z.number().int().min(1).max(730),
  price: z.number().int().min(0),
  taxPercent: z.number().min(0).max(50).nullable().optional(),
  description: z.string().max(300).optional(),
  isActive: z.boolean().optional(),
});
router.get('/packages', permit('pt.read'), async (req, res) => {
  const filter = req.query.active === 'true' ? { isActive: true } : {};
  res.json({ success: true, data: await PtPackage.find(filter).sort({ sessions: 1 }).lean() });
});
router.post('/packages', permit('pt.manage'), validate({ body: pkgBody }), async (req, res) => {
  const pkg = await PtPackage.create(req.body);
  await audit(req, 'pt.package.create', { entity: 'PtPackage', entityId: pkg._id });
  res.status(201).json({ success: true, data: pkg });
});
router.put('/packages/:id', permit('pt.manage'), validate({ body: pkgBody.partial() }), async (req, res) => {
  const pkg = await PtPackage.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!pkg) throw ApiError.notFound('Package not found');
  res.json({ success: true, data: pkg });
});

/* ---------- Purchases ---------- */
router.get('/purchases', permit('pt.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req), ...trainerScope(req) };
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.trainerId && mongoose.isValidObjectId(q.trainerId) && req.user.role !== 'trainer') filter.trainerId = q.trainerId;
  if (q.state === 'active') {
    filter.status = 'active';
    filter.validTo = { $gte: startOfDay() };
    filter.$expr = { $lt: ['$sessionsUsed', '$sessionsTotal'] };
  }
  if (q.due === 'true') filter.dueAmount = { $gt: 0 };
  const data = await paginate(PtPurchase, filter, q, {
    sort: { createdAt: -1 },
    populate: [{ path: 'memberId', select: 'name memberCode phone photoUrl' }, { path: 'trainerId', select: 'name' }],
  });
  res.json({ success: true, data });
});

router.post(
  '/purchases',
  permit('pt.sell'),
  validate({
    body: z.object({
      memberId: objectId,
      packageId: objectId,
      trainerId: objectId,
      startDate: day.optional(),
      discount: z.number().int().min(0).default(0),
      payment: paymentBody.optional(),
      approvalId: objectId.optional(),
    }),
  }),
  async (req, res) => {
    const member = await findInBranch(req, Member, req.body.memberId, { notFound: 'Member not found', extra: { isDeleted: false, isTrial: { $ne: true } } });
    const { approvalId, ...body } = req.body;
    const { result: r, done } = await withDiscountGuard(
      req,
      { kind: 'pt', branchId: member.branchId, memberId: member._id, discount: body.discount, approvalId, packageId: body.packageId },
      (approval) => sellPackage({ ...body, approvalId: approval?._id, user: req.user }),
      'PtPurchase',
    );
    await done(r.purchase._id);
    await audit(req, 'pt.sell', { entity: 'PtPurchase', entityId: r.purchase._id, branchId: r.purchase.branchId, details: { packageId: req.body.packageId } });
    res.status(201).json({ success: true, data: r });
  },
);

router.post('/purchases/:id/payments', permit('payments.create'), validate({ body: paymentBody }), async (req, res) => {
  const purchase = await findInBranch(req, PtPurchase, req.params.id, { notFound: 'PT package not found' });
  const r = await recordPayment({ sub: purchase, ...req.body, user: req.user, kind: 'pt' });
  await audit(req, 'payment.create', { entity: 'Payment', entityId: r.payment._id, branchId: purchase.branchId, details: { amount: req.body.amount, pt: true } });
  await inBackground('receipt-email', () => sendReceiptEmail(r.payment._id));
  res.status(201).json({ success: true, data: r });
});

router.post(
  '/purchases/:id/cancel',
  permit('subscriptions.cancel'),
  validate({ body: z.object({ reason: z.string().trim().min(2).max(200) }) }),
  async (req, res) => {
    const purchase = await findInBranch(req, PtPurchase, req.params.id, { notFound: 'PT package not found', extra: { status: 'active' } });
    purchase.status = 'cancelled';
    purchase.cancelReason = req.body.reason;
    purchase.dueAmount = 0;
    await purchase.save();
    await audit(req, 'pt.cancel', { entity: 'PtPurchase', entityId: purchase._id, branchId: purchase.branchId, details: req.body });
    res.json({ success: true, data: purchase });
  },
);

/* ---------- Sessions ---------- */
router.post(
  '/purchases/:id/sessions',
  permit('pt.log'),
  validate({ body: z.object({ at: z.coerce.date().optional(), status: z.enum(['done', 'no-show']).default('done'), notes: z.string().max(500).optional() }) }),
  async (req, res) => {
    const purchase = await findInBranch(req, PtPurchase, req.params.id, { notFound: 'PT package not found', extra: trainerScope(req) });
    if (req.body.at && req.body.at > new Date()) throw ApiError.badRequest('Session time cannot be in the future');
    const r = await logSession({ purchaseId: purchase._id, ...req.body, user: req.user });
    res.status(201).json({ success: true, data: r });
  },
);

router.get('/sessions', permit('pt.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req), ...trainerScope(req) };
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.purchaseId && mongoose.isValidObjectId(q.purchaseId)) filter.ptPurchaseId = q.purchaseId;
  if (q.from || q.to) {
    filter.at = {};
    if (q.from) filter.at.$gte = parseDay(String(q.from));
    if (q.to) filter.at.$lt = addDays(parseDay(String(q.to)), 1);
  }
  const data = await paginate(PtSession, filter, q, {
    sort: { at: -1 },
    populate: [{ path: 'memberId', select: 'name memberCode' }, { path: 'trainerId', select: 'name' }],
  });
  res.json({ success: true, data });
});

router.delete('/sessions/:id', permit('pt.log'), async (req, res) => {
  await findInBranch(req, PtSession, req.params.id, { notFound: 'Session not found', extra: trainerScope(req) });
  await undoSession({ sessionId: req.params.id });
  // A session logged from a booking: the booking is open again.
  await PtBooking.updateOne({ sessionId: req.params.id }, { status: 'booked', $unset: { sessionId: 1, markedAt: 1, markedBy: 1 } });
  res.json({ success: true });
});

/* ---------- Commission report ---------- */
router.get('/commission', permit('pt.read'), async (req, res) => {
  const from = req.query.from ? parseDay(String(req.query.from)) : dayjs().tz(tz).startOf('month').toDate();
  const to = req.query.to ? addDays(parseDay(String(req.query.to)), 1) : addDays(startOfDay(), 1);
  const rows = await PtSession.aggregate([
    { $match: { ...branchFilter(req), ...trainerScope(req), at: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: '$trainerId',
        sessions: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
        noShows: { $sum: { $cond: [{ $eq: ['$status', 'no-show'] }, 1, 0] } },
        clients: { $addToSet: '$memberId' },
        commission: { $sum: '$commission' },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'trainer' } },
    { $project: { trainer: { $arrayElemAt: ['$trainer.name', 0] }, sessions: 1, noShows: 1, clients: { $size: '$clients' }, commission: 1 } },
    { $sort: { sessions: -1 } },
  ]);
  res.json({ success: true, data: rows });
});

export default router;
