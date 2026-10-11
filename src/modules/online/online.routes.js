import express, { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { logger } from '../../config/logger.js';
import { OnlinePayment } from './onlinePayment.model.js';
import { razorpayEnabled, verifyCheckoutSignature, verifyWebhookSignature } from './razorpay.client.js';
import { startDuePayment, startRenewal, createDueLink, completeOnlinePayment } from './online.service.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Plan } from '../plans/plan.model.js';
import { getGym } from '../settings/gym.model.js';
import { quoteSubscription } from '../subscriptions/subscription.service.js';
import { audit } from '../audit/audit.model.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const checkoutPayload = (op, member, gym) => ({
  onlinePaymentId: op._id,
  keyId: process.env.RAZORPAY_KEY_ID,
  orderId: op.orderId,
  amount: op.amount,
  currency: 'INR',
  name: gym.name,
  prefill: { name: member.name, contact: member.phone, email: member.email },
});

/* ---------------- Member portal (/api/v1/me/...) ---------------- */
export const portalPayRouter = Router();
portalPayRouter.use(requireMember);

portalPayRouter.get('/pay/config', (_req, res) => res.json({ success: true, data: { enabled: razorpayEnabled(), keyId: process.env.RAZORPAY_KEY_ID || null } }));

portalPayRouter.get('/plans', async (req, res) => {
  const plans = await Plan.find({
    isDeleted: false,
    isActive: true,
    $or: [{ branchIds: { $size: 0 } }, { branchIds: req.member.branchId }],
  })
    .select('name description durationValue durationUnit price joiningFee taxPercent accessStart accessEnd')
    .sort({ durationUnit: 1, durationValue: 1 })
    .lean();
  res.json({ success: true, data: plans });
});

portalPayRouter.post('/quote', validate({ body: z.object({ planId: objectId, couponCode: z.string().trim().max(20).optional() }) }), async (req, res) => {
  const plan = await Plan.findOne({ _id: req.body.planId, isDeleted: false, isActive: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not available');
  const q = await quoteSubscription({ member: req.member, plan, couponCode: req.body.couponCode || undefined });
  res.json({ success: true, data: { ...q, coupon: q.coupon ? { code: q.coupon.code } : null } });
});

portalPayRouter.post('/pay/due', validate({ body: z.object({ subscriptionId: objectId }) }), async (req, res) => {
  const op = await startDuePayment({ member: req.member, subscriptionId: req.body.subscriptionId });
  res.status(201).json({ success: true, data: checkoutPayload(op, req.member, await getGym()) });
});

portalPayRouter.post(
  '/pay/renew',
  validate({ body: z.object({ planId: objectId, couponCode: z.string().trim().max(20).optional() }) }),
  async (req, res) => {
    const { op } = await startRenewal({ member: req.member, planId: req.body.planId, couponCode: req.body.couponCode || undefined });
    res.status(201).json({ success: true, data: checkoutPayload(op, req.member, await getGym()) });
  },
);

portalPayRouter.post(
  '/pay/verify',
  validate({ body: z.object({ orderId: z.string().min(5), paymentId: z.string().min(5), signature: z.string().min(10) }) }),
  async (req, res) => {
    const { orderId, paymentId, signature } = req.body;
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) throw ApiError.badRequest('Payment verification failed');
    const op = await OnlinePayment.findOne({ orderId, memberId: req.member._id });
    if (!op) throw ApiError.notFound('Payment not found');
    const done = await completeOnlinePayment({ op, gatewayPaymentId: paymentId });
    res.json({ success: true, data: { status: done.status, subscriptionId: done.resultSubscriptionId } });
  },
);

/* ---------------- Staff (/api/v1/online-payments) ---------------- */
export const staffOnlineRouter = Router();
staffOnlineRouter.use(requireStaff);

staffOnlineRouter.get('/', permit('payments.read'), async (req, res) => {
  const filter = { ...branchFilter(req) };
  if (req.query.status) filter.status = String(req.query.status);
  const data = await paginate(OnlinePayment, filter, req.query, { sort: { createdAt: -1 }, populate: { path: 'memberId', select: 'name memberCode' } });
  res.json({ success: true, data });
});

staffOnlineRouter.post('/link', permit('payments.create'), validate({ body: z.object({ subscriptionId: objectId }) }), async (req, res) => {
  const sub = await findInBranch(req, Subscription, req.body.subscriptionId, { notFound: 'Membership not found' });
  const op = await createDueLink({ subscription: sub, user: req.user });
  await audit(req, 'payment.link', { entity: 'Subscription', entityId: sub._id, branchId: sub.branchId, details: { amount: op.amount } });
  res.status(201).json({ success: true, data: { shortUrl: op.shortUrl, amount: op.amount, onlinePaymentId: op._id } });
});

/* ---------------- Razorpay webhook (/api/webhooks/razorpay) — raw body ---------------- */
export const webhookRouter = Router();
webhookRouter.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    logger.warn('razorpay webhook with bad signature');
    return res.status(400).json({ success: false });
  }
  const evt = JSON.parse(raw);
  const payment = evt.payload?.payment?.entity;
  try {
    if (evt.event === 'payment.captured' && payment?.order_id) {
      const op = await OnlinePayment.findOne({ orderId: payment.order_id });
      if (op) await completeOnlinePayment({ op, gatewayPaymentId: payment.id, amount: payment.amount });
    } else if (evt.event === 'payment_link.paid') {
      const link = evt.payload?.payment_link?.entity;
      const op = link && (await OnlinePayment.findOne({ paymentLinkId: link.id }));
      if (op) await completeOnlinePayment({ op, gatewayPaymentId: payment?.id || `link_${link.id}`, amount: payment?.amount ?? link.amount_paid });
    } else if (evt.event === 'payment_link.expired' || evt.event === 'payment_link.cancelled') {
      const link = evt.payload?.payment_link?.entity;
      if (link) await OnlinePayment.updateOne({ paymentLinkId: link.id, status: 'created' }, { status: 'expired' });
    }
  } catch (err) {
    logger.error({ err, event: evt.event }, 'razorpay webhook handling failed');
    // 200 anyway: failure is recorded + alerted; retries would hit the same error.
  }
  res.json({ success: true });
});
