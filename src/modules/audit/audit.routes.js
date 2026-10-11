import { Router } from 'express';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { branchFilter } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { AuditLog } from './audit.model.js';

const router = Router();
router.use(requireStaff, permit('audit.read'));

router.get('/', async (req, res) => {
  const q = req.query;
  const filter = {};
  // Branchless entries (settings, users) are visible to the owner only.
  if (req.allowedBranchIds !== null || q.branchId) Object.assign(filter, branchFilter(req));
  if (q.entity) filter.entity = String(q.entity);
  if (q.entityId && mongoose.isValidObjectId(q.entityId)) filter.entityId = q.entityId;
  if (q.action) filter.action = String(q.action);
  if (q.actorId && mongoose.isValidObjectId(q.actorId)) filter.actorId = q.actorId;
  res.json({ success: true, data: await paginate(AuditLog, filter, q, { sort: { createdAt: -1 } }) });
});

export default router;
