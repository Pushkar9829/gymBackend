import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { ROLE_NAMES, can } from '../../config/permissions.js';
import { User } from './user.model.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';
import { audit } from '../audit/audit.model.js';
import { syncStaffToDevices } from '../staff/staff.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

/** Non-owners only see/manage staff of their own branches and can never touch owners. */
function scopeFilter(req) {
  if (req.allowedBranchIds === null) return {};
  return { role: { $ne: 'owner' }, branchIds: { $in: req.allowedBranchIds } };
}

function assertCanAssign(req, { role, branchIds }) {
  if (req.user.role === 'owner') return;
  if (role === 'owner' || role === 'manager') throw ApiError.forbidden('Only the owner can create owners or managers');
  if (branchIds && branchIds.some((b) => !req.allowedBranchIds.includes(String(b)))) {
    throw ApiError.forbidden('Cannot assign branches you do not manage');
  }
}

router.get('/', permit('users.read'), async (req, res) => {
  const filter = { ...scopeFilter(req) };
  if (req.query.role) filter.role = String(req.query.role);
  const users = await User.find(filter).select(can(req.user.role, 'payroll.manage') ? '' : '-salary').sort({ name: 1 }).lean();
  res.json({ success: true, data: users });
});

// Lightweight list for dropdowns (e.g. assign trainer) — any staff.
router.get('/trainers', async (req, res) => {
  const filter = { role: 'trainer', isActive: true };
  if (req.allowedBranchIds !== null) filter.branchIds = { $in: req.allowedBranchIds };
  res.json({ success: true, data: await User.find(filter).select('name phone branchIds').sort({ name: 1 }).lean() });
});

const createBody = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  phone: z.string().trim().min(6).max(15).optional(),
  password: z.string().min(8).max(100),
  role: z.enum(ROLE_NAMES),
  branchIds: z.array(objectId).default([]),
  ptCommissionPercent: z.number().min(0).max(100).optional(),
  salary: z.object({ type: z.enum(['monthly', 'per-day']), amount: z.number().int().min(0) }).optional(),
});

router.post('/', permit('users.write'), validate({ body: createBody }), async (req, res) => {
  assertCanAssign(req, req.body);
  if (req.body.salary && !can(req.user.role, 'payroll.manage')) throw ApiError.forbidden('Only payroll managers can set salaries');
  if (req.body.role !== 'owner' && !req.body.branchIds.length) throw ApiError.badRequest('Assign at least one branch');
  const { password, ...rest } = req.body;
  const user = await User.create({ ...rest, passwordHash: await hashPassword(password) });
  await audit(req, 'user.create', { entity: 'User', entityId: user._id, details: { role: user.role } });
  await syncStaffToDevices(user.toObject());
  res.status(201).json({ success: true, data: user });
});

const updateBody = createBody.omit({ password: true }).partial().extend({
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(100).optional(),
});

router.put('/:id', permit('users.write'), validate({ body: updateBody }), async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...scopeFilter(req) });
  if (!user) throw ApiError.notFound('User not found');
  if (String(user._id) === String(req.user._id) && (req.body.isActive === false || req.body.role)) {
    throw ApiError.badRequest('You cannot change your own role or deactivate yourself');
  }
  assertCanAssign(req, { role: req.body.role, branchIds: req.body.branchIds });
  if (req.body.salary && !can(req.user.role, 'payroll.manage')) throw ApiError.forbidden('Only payroll managers can set salaries');
  const { password, ...rest } = req.body;
  Object.assign(user, rest);
  if (password) user.passwordHash = await hashPassword(password);
  await user.save();
  if (password || req.body.isActive === false) await revokeAllSessions(user._id);
  await syncStaffToDevices(user.toObject());
  await audit(req, 'user.update', { entity: 'User', entityId: user._id, details: { ...rest, password: password ? 'changed' : undefined } });
  res.json({ success: true, data: user });
});

export default router;
