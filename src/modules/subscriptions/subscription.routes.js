import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { findInBranch, branchFilter } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { Subscription } from './subscription.model.js';
import { Member } from '../members/member.model.js';
import { PAYMENT_MODES } from '../payments/payment.model.js';
import * as svc from './subscription.service.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const paymentBody = z
  .object({
    amount: z.number().int().min(1),
    mode: z.enum(PAYMENT_MODES),
    reference: z.string().trim().max(100).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .optional();

const clean = (access) => (access ? { ...access, current: undefined } : access);

router.get('/', permit('members.read'), async (req, res) => {
  const filter = { ...branchFilter(req) };
  if (req.query.memberId && mongoose.isValidObjectId(req.query.memberId)) filter.memberId = req.query.memberId;
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.due === 'true') filter.dueAmount = { $gt: 0 };
  const data = await paginate(Subscription, filter, req.query, {
    sort: { startDate: -1 },
    populate: { path: 'memberId', select: 'name phone memberCode' },
  });
  res.json({ success: true, data });
});

router.post(
  '/',
  permit('subscriptions.write'),
  validate({
    body: z.object({
      memberId: objectId,
      planId: objectId,
      startDate: day.optional(),
      discount: z.number().int().min(0).default(0),
      waiveJoiningFee: z.boolean().default(false),
      payment: paymentBody,
    }),
  }),
  async (req, res) => {
    await findInBranch(req, Member, req.body.memberId, { notFound: 'Member not found' });
    const result = await svc.createSubscription({ ...req.body, user: req.user });
    await audit(req, 'subscription.create', {
      entity: 'Subscription',
      entityId: result.subscription._id,
      branchId: result.subscription.branchId,
      details: { planId: req.body.planId, discount: req.body.discount, payment: req.body.payment?.amount },
    });
    res.status(201).json({ success: true, data: { ...result, access: clean(result.access) } });
  },
);

router.post(
  '/:id/change-plan',
  permit('subscriptions.write'),
  validate({ body: z.object({ planId: objectId, discount: z.number().int().min(0).default(0), payment: paymentBody }) }),
  async (req, res) => {
    const sub = await findInBranch(req, Subscription, req.params.id, { notFound: 'Membership not found' });
    const result = await svc.changePlan({ subscriptionId: sub._id, ...req.body, user: req.user });
    await audit(req, 'subscription.changePlan', {
      entity: 'Subscription',
      entityId: sub._id,
      branchId: sub.branchId,
      details: { to: req.body.planId, credit: result.credit },
    });
    res.status(201).json({ success: true, data: { ...result, access: clean(result.access) } });
  },
);

router.post(
  '/:id/freeze',
  permit('subscriptions.write'),
  validate({
    body: z.object({
      from: day.optional(),
      days: z.number().int().min(1).max(180),
      reason: z.string().trim().max(200).optional(),
      override: z.boolean().default(false),
    }),
  }),
  async (req, res) => {
    const sub = await findInBranch(req, Subscription, req.params.id, { notFound: 'Membership not found' });
    const override = req.body.override && ['owner', 'manager'].includes(req.user.role);
    const result = await svc.freeze({ subscriptionId: sub._id, ...req.body, override, user: req.user });
    await audit(req, 'subscription.freeze', { entity: 'Subscription', entityId: sub._id, branchId: sub.branchId, details: req.body });
    res.json({ success: true, data: { ...result, access: clean(result.access) } });
  },
);

router.post('/:id/freezes/:freezeId/end', permit('subscriptions.write'), async (req, res) => {
  const sub = await findInBranch(req, Subscription, req.params.id, { notFound: 'Membership not found' });
  const result = await svc.unfreeze({ subscriptionId: sub._id, freezeId: req.params.freezeId });
  await audit(req, 'subscription.unfreeze', { entity: 'Subscription', entityId: sub._id, branchId: sub.branchId });
  res.json({ success: true, data: { ...result, access: clean(result.access) } });
});

router.post(
  '/:id/cancel',
  permit('subscriptions.cancel'),
  validate({ body: z.object({ reason: z.string().trim().min(2).max(200) }) }),
  async (req, res) => {
    const sub = await findInBranch(req, Subscription, req.params.id, { notFound: 'Membership not found' });
    const result = await svc.cancel({ subscriptionId: sub._id, reason: req.body.reason });
    await audit(req, 'subscription.cancel', { entity: 'Subscription', entityId: sub._id, branchId: sub.branchId, details: req.body });
    res.json({ success: true, data: { ...result, access: clean(result.access) } });
  },
);

export default router;
