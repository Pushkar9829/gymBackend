import { Router } from 'express';
import { z } from 'zod';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { Branch } from './branch.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

router.get('/', async (req, res) => {
  const filter = req.allowedBranchIds === null ? {} : { _id: { $in: req.allowedBranchIds } };
  res.json({ success: true, data: await Branch.find(filter).sort({ name: 1 }).lean() });
});

const time = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const body = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2).max(10),
  address: z.string().max(300).optional(),
  phone: z.string().max(20).optional(),
  openingTime: time.optional(),
  closingTime: time.optional(),
  isActive: z.boolean().optional(),
});

router.post('/', permit('branches.write'), validate({ body }), async (req, res) => {
  const branch = await Branch.create(req.body);
  await audit(req, 'branch.create', { entity: 'Branch', entityId: branch._id });
  res.status(201).json({ success: true, data: branch });
});

router.put('/:id', permit('branches.write'), validate({ body: body.partial() }), async (req, res) => {
  const branch = await Branch.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!branch) throw ApiError.notFound('Branch not found');
  await audit(req, 'branch.update', { entity: 'Branch', entityId: branch._id, details: req.body });
  res.json({ success: true, data: branch });
});

export default router;
