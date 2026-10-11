import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { Coupon } from './coupon.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const base = z.object({
  code: z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only'),
  description: z.string().max(200).optional(),
  type: z.enum(['percent', 'flat']),
  value: z.number().int().min(1),
  maxDiscount: z.number().int().min(0).nullable().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  planIds: z.array(objectId).optional(),
  newMembersOnly: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const percentOk = (b) => b.type !== 'percent' || b.value == null || b.value <= 100;
const body = base.refine(percentOk, { message: 'Percent must be 1-100', path: ['value'] });
const updateBody = base.partial().refine(percentOk, { message: 'Percent must be 1-100', path: ['value'] });

router.get('/', permit('plans.read'), async (_req, res) => {
  res.json({ success: true, data: await Coupon.find().sort({ createdAt: -1 }).lean() });
});

router.post('/', permit('plans.write'), validate({ body }), async (req, res) => {
  const coupon = await Coupon.create(req.body);
  await audit(req, 'coupon.create', { entity: 'Coupon', entityId: coupon._id, details: req.body });
  res.status(201).json({ success: true, data: coupon });
});

router.put('/:id', permit('plans.write'), validate({ body: updateBody }), async (req, res) => {
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!coupon) throw ApiError.notFound('Coupon not found');
  await audit(req, 'coupon.update', { entity: 'Coupon', entityId: coupon._id, details: req.body });
  res.json({ success: true, data: coupon });
});

export default router;
