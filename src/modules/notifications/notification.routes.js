import { Router } from 'express';
import { requireStaff } from '../../middlewares/auth.js';
import { branchFilter } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { Notification } from './notification.model.js';

const router = Router();
router.use(requireStaff);

router.get('/', async (req, res) => {
  const filter = { channel: 'inapp', ...branchFilter(req) };
  if (req.query.unread === 'true') filter.readAt = null;
  const [data, unread] = await Promise.all([
    paginate(Notification, filter, req.query, { sort: { createdAt: -1 }, populate: { path: 'memberId', select: 'name memberCode' } }),
    Notification.countDocuments({ channel: 'inapp', readAt: null, ...branchFilter(req) }),
  ]);
  res.json({ success: true, data: { ...data, unread } });
});

router.post('/read-all', async (req, res) => {
  await Notification.updateMany({ channel: 'inapp', readAt: null, ...branchFilter(req) }, { readAt: new Date() });
  res.json({ success: true });
});

router.post('/:id/read', async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, channel: 'inapp', ...branchFilter(req) }, { readAt: new Date() });
  res.json({ success: true });
});

export default router;
