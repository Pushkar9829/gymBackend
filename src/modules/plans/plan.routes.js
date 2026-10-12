import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { Plan } from './plan.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const paise = z.number().int().min(0);

const body = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().max(500).optional(),
  durationValue: z.number().int().min(1).max(60),
  durationUnit: z.enum(['day', 'month']),
  price: paise,
  joiningFee: paise.optional(),
  taxPercent: z.number().min(0).max(50).nullable().optional(),
  freezeDaysAllowed: z.number().int().min(0).max(365).optional(),
  accessStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').nullable().optional(),
  accessEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').nullable().optional(),
  deviceTimezoneId: z.number().int().min(1).max(50).optional(),
  maxMembers: z.number().int().min(1).max(10).optional(),
  maxFreezes: z.number().int().min(0).max(12).optional(),
  branchIds: z.array(objectId).optional(),
  isActive: z.boolean().optional(),
  sellOnline: z.boolean().optional(),
});

router.get('/', permit('plans.read'), async (req, res) => {
  const filter = { isDeleted: false };
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
    filter.$or = [{ branchIds: { $size: 0 } }, { branchIds: req.query.branchId }];
  }
  res.json({ success: true, data: await Plan.find(filter).sort({ durationUnit: 1, durationValue: 1, price: 1 }).lean() });
});

const slotOk = (b) => !b.accessStart === !b.accessEnd && (!b.accessStart || b.accessStart < b.accessEnd);

router.post('/', permit('plans.write'), validate({ body }), async (req, res) => {
  if (!slotOk(req.body)) throw ApiError.badRequest('Set both entry start and end time (start before end)');
  const plan = await Plan.create(req.body);
  await audit(req, 'plan.create', { entity: 'Plan', entityId: plan._id });
  res.status(201).json({ success: true, data: plan });
});

router.put('/:id', permit('plans.write'), validate({ body: body.partial() }), async (req, res) => {
  // Safe: existing memberships keep their own plan snapshot.
  const plan = await Plan.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, req.body, { returnDocument: 'after', runValidators: true });
  if (!plan) throw ApiError.notFound('Plan not found');
  await audit(req, 'plan.update', { entity: 'Plan', entityId: plan._id, details: req.body });
  res.json({ success: true, data: plan });
});

router.delete('/:id', permit('plans.write'), async (req, res) => {
  const plan = await Plan.findOneAndUpdate({ _id: req.params.id }, { isDeleted: true, isActive: false }, { returnDocument: 'after' });
  if (!plan) throw ApiError.notFound('Plan not found');
  await audit(req, 'plan.delete', { entity: 'Plan', entityId: plan._id });
  res.json({ success: true });
});

export default router;
