/**
 * Public "Join online" (no login): /api/v1/public/join/...
 * Phone OTP -> quote -> Razorpay order -> verified payment creates the member and membership.
 */
import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { OnlinePayment } from '../online/onlinePayment.model.js';
import { verifyCheckoutSignature } from '../online/razorpay.client.js';
import { completeOnlinePayment } from '../online/online.service.js';
import { getGym } from '../settings/gym.model.js';
import { sendJoinOtp, verifyJoinOtp, quoteJoin, quoteView, startJoin, joinResult, cleanPhone, assertJoinEnabled } from '../online/join.service.js';

const router = Router();

const skip = () => process.env.NODE_ENV === 'test' || (process.env.DISABLE_RATE_LIMIT === '1' && process.env.NODE_ENV !== 'production');
const limiter = (limit, windowMin, message) =>
  rateLimit({ windowMs: windowMin * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, skip, message: { success: false, message } });
const otpLimiter = limiter(10, 60, 'Too many codes asked from this network. Please try again later.');
const verifyLimiter = limiter(30, 15, 'Too many attempts. Please try again later.');
const orderLimiter = limiter(60, 60, 'Too many attempts. Please try again later.');

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Choose an option');
const phone = z.string().trim().regex(/^\+?[\d\s-]{10,16}$/, 'Enter a valid phone number').transform(cleanPhone).refine((p) => /^\d{10,13}$/.test(p), 'Enter a valid phone number');
const optional = (s) => s.optional().or(z.literal('').transform(() => undefined));
const code = z.string().trim().max(20);

router.post('/otp', otpLimiter, validate({ body: z.object({ phone }) }), async (req, res) => {
  await sendJoinOtp(req.body.phone);
  res.json({ success: true, message: 'Code sent' });
});

router.post('/otp/verify', verifyLimiter, validate({ body: z.object({ phone, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }), async (req, res) => {
  res.json({ success: true, data: await verifyJoinOtp(req.body.phone, req.body.otp) });
});

const quoteBody = z.object({ branchId: objectId, planId: objectId, couponCode: optional(code), referralCode: optional(code) });
router.post('/quote', orderLimiter, validate({ body: quoteBody }), async (req, res) => {
  assertJoinEnabled();
  const { q, referrer } = await quoteJoin(req.body);
  res.json({ success: true, data: { ...quoteView(q), referral: referrer ? { valid: true } : null } });
});

const orderBody = quoteBody.extend({
  token: z.string().min(10),
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  email: optional(z.string().trim().email('Enter a valid email')),
  gender: optional(z.enum(['male', 'female', 'other'])),
  dob: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).transform((v) => (v ? new Date(`${v}T00:00:00Z`) : undefined)),
  startDate: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a start date')),
});
router.post('/order', orderLimiter, validate({ body: orderBody }), async (req, res) => {
  const { token, ...body } = req.body;
  if (body.dob && body.dob > new Date()) throw ApiError.badRequest('Date of birth cannot be in the future');
  const { op, quote, plan } = await startJoin({ token, body });
  const gym = await getGym();
  res.status(201).json({
    success: true,
    data: {
      onlinePaymentId: op._id,
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: op.orderId,
      amount: op.amount,
      currency: 'INR',
      name: gym.name,
      description: `${plan.name} membership`,
      prefill: { name: op.join.name, contact: op.join.phone, email: op.join.email },
      quote: quoteView(quote),
    },
  });
});

// Razorpay Checkout success handler. The webhook may have applied it already (then it is not applied twice).
router.post(
  '/pay/verify',
  orderLimiter,
  validate({ body: z.object({ orderId: z.string().min(5).max(60), paymentId: z.string().min(5).max(60), signature: z.string().min(10).max(200) }) }),
  async (req, res) => {
    const { orderId, paymentId, signature } = req.body;
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) throw ApiError.badRequest('Payment verification failed');
    const op = await OnlinePayment.findOne({ orderId, kind: 'join' });
    if (!op) throw ApiError.notFound('Payment not found');
    let done;
    try {
      done = await completeOnlinePayment({ op, gatewayPaymentId: paymentId });
    } catch {
      throw ApiError.conflict('Your payment was received, but we could not finish joining. The gym has been told and will call you.');
    }
    // The webhook is applying the same payment right now: wait for it briefly.
    for (let i = 0; i < 30 && done?.status === 'processing'; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      done = await OnlinePayment.findById(op._id).lean();
    }
    if (done?.status === 'failed') throw ApiError.conflict('Your payment was received, but we could not finish joining. The gym has been told and will call you.');
    res.json({ success: true, data: await joinResult(done) });
  },
);

export default router;
