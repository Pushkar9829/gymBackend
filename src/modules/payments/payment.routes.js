import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { parseDay, addDays, isFutureDay } from '../../utils/dates.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees } from '../../utils/money.js';
import { Payment, PAYMENT_MODES } from './payment.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { billOf } from './billing.js';
import { recordPayment, nextReceiptNo } from '../subscriptions/subscription.service.js';
import { refreshMember } from '../members/member.state.js';
import { getGym } from '../settings/gym.model.js';
import { receiptPdf } from '../invoices/invoice.pdf.js';
import { audit } from '../audit/audit.model.js';
import { inBackground, sendReceiptEmail } from '../notifications/emails.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

function listFilter(req) {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.mode && PAYMENT_MODES.includes(q.mode)) filter.mode = q.mode;
  if (q.type) filter.type = String(q.type);
  if (q.from || q.to) {
    filter.paidAt = {};
    if (q.from) filter.paidAt.$gte = parseDay(String(q.from));
    if (q.to) filter.paidAt.$lt = addDays(parseDay(String(q.to)), 1);
  }
  return filter;
}

router.get('/', permit('payments.read'), async (req, res) => {
  const filter = listFilter(req);
  if (isExport(req.query)) {
    const rows = await Payment.find(filter).sort({ paidAt: -1 }).limit(20000).populate('memberId', 'name memberCode phone').lean();
    return sendExport(res, req.query.export, 'payments', rows, [
      { label: 'Receipt', key: 'receiptNo' },
      { label: 'Date', value: (r) => r.paidAt },
      { label: 'Member', value: (r) => r.memberId?.name },
      { label: 'Member Code', value: (r) => r.memberId?.memberCode },
      { label: 'Type', key: 'type' },
      { label: 'Mode', key: 'mode' },
      { label: 'Amount (Rs)', value: (r) => (r.type === 'refund' ? -1 : 1) * toRupees(r.amount) },
      { label: 'Reference', key: 'reference' },
    ]);
  }
  const [data, totals] = await Promise.all([
    paginate(Payment, filter, req.query, {
      sort: { paidAt: -1 },
      populate: [{ path: 'memberId', select: 'name memberCode phone' }, { path: 'receivedBy', select: 'name' }],
    }),
    Payment.aggregate([{ $match: filter }, { $group: { _id: '$type', amount: { $sum: '$amount' } } }]),
  ]);
  const sum = Object.fromEntries(totals.map((t) => [t._id, t.amount]));
  res.json({ success: true, data: { ...data, summary: { collected: sum.payment || 0, refunded: sum.refund || 0 } } });
});

router.post(
  '/',
  permit('payments.create'),
  validate({
    body: z.object({
      subscriptionId: objectId,
      amount: z.number().int().min(1),
      mode: z.enum(PAYMENT_MODES),
      reference: z.string().trim().max(100).optional(),
      note: z.string().trim().max(300).optional(),
      paidAt: z.coerce.date().optional(),
    }),
  }),
  async (req, res) => {
    const sub = await findInBranch(req, Subscription, req.body.subscriptionId, { notFound: 'Membership not found' });
    if (req.body.paidAt && isFutureDay(req.body.paidAt)) throw ApiError.badRequest('Payment date cannot be in the future');
    const result = await recordPayment({ sub, ...req.body, user: req.user });
    const access = await refreshMember(sub.memberId);
    await audit(req, 'payment.create', {
      entity: 'Payment',
      entityId: result.payment._id,
      branchId: sub.branchId,
      details: { amount: req.body.amount, mode: req.body.mode },
    });
    await inBackground('receipt-email', () => sendReceiptEmail(result.payment._id));
    res.status(201).json({ success: true, data: { ...result, access: { ...access, current: undefined } } });
  },
);

router.post(
  '/:id/refund',
  permit('payments.refund'),
  validate({
    body: z.object({
      amount: z.number().int().min(1),
      mode: z.enum(PAYMENT_MODES),
      reason: z.string().trim().min(2).max(200),
    }),
  }),
  async (req, res) => {
    const original = await findInBranch(req, Payment, req.params.id, { notFound: 'Payment not found', extra: { type: 'payment' } });
    const refunded = await Payment.aggregate([
      { $match: { refundOf: original._id } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const refundable = original.amount - (refunded[0]?.total || 0);
    if (req.body.amount > refundable) throw ApiError.badRequest(`Maximum refundable is Rs. ${toRupees(refundable)}`);

    const { Model, id, field } = billOf(original);
    const sub = await Model.findById(id);
    // Refund on a running membership / package re-opens the due; on a cancelled one it doesn't.
    const inc = { paidAmount: -req.body.amount, ...(sub.status === 'active' ? { dueAmount: req.body.amount } : {}) };
    await Model.updateOne({ _id: sub._id }, { $inc: inc });

    const gym = await getGym();
    const refund = await Payment.create({
      receiptNo: await nextReceiptNo(gym),
      memberId: original.memberId,
      branchId: original.branchId,
      [field]: id,
      invoiceId: original.invoiceId,
      type: 'refund',
      amount: req.body.amount,
      mode: req.body.mode,
      note: req.body.reason,
      receivedBy: req.user._id,
      refundOf: original._id,
    });
    await refreshMember(original.memberId);
    await audit(req, 'payment.refund', {
      entity: 'Payment',
      entityId: refund._id,
      branchId: original.branchId,
      details: { of: original.receiptNo, amount: req.body.amount, reason: req.body.reason },
    });
    await inBackground('refund-email', () => sendReceiptEmail(refund._id));
    res.status(201).json({ success: true, data: refund });
  },
);

router.get('/:id/receipt.pdf', permit('payments.read'), async (req, res) => {
  const payment = await findInBranch(req, Payment, req.params.id, { notFound: 'Payment not found' });
  await payment.populate(['memberId', 'subscriptionId', 'ptPurchaseId']);
  const pdf = await receiptPdf(payment.toObject(), await getGym());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${payment.receiptNo.replace(/\//g, '-')}.pdf"`);
  res.send(pdf);
});

export default router;
