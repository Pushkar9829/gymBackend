import { Router } from 'express';
import mongoose from 'mongoose';
import { requireStaff } from '../../middlewares/auth.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { ymd, dayjs, tz } from '../../utils/dates.js';
import { StaffAttendance } from './staff.model.js';
import { recordStaffPunch } from './staff.service.js';

const router = Router();
router.use(requireStaff);

const canSeeAll = (req) => can(req.user.role, 'users.read');
const scope = (req) => {
  if (!canSeeAll(req)) return { userId: req.user._id };
  if (req.allowedBranchIds === null) return {};
  return { branchId: { $in: req.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } };
};

router.get('/me/today', async (req, res) => {
  res.json({ success: true, data: await StaffAttendance.findOne({ userId: req.user._id, day: ymd(new Date()) }).lean() });
});

router.post('/clock-in', async (req, res) => {
  const existing = await StaffAttendance.findOne({ userId: req.user._id, day: ymd(new Date()) });
  if (existing) throw ApiError.conflict('Already clocked in today');
  res.status(201).json({ success: true, data: await recordStaffPunch({ user: req.user, method: 'manual' }) });
});

router.post('/clock-out', async (req, res) => {
  const row = await StaffAttendance.findOne({ userId: req.user._id, day: ymd(new Date()) });
  if (!row) throw ApiError.badRequest('Clock in first');
  row.checkOutAt = new Date();
  await row.save();
  res.json({ success: true, data: row });
});

router.get('/', async (req, res) => {
  const q = req.query;
  const filter = { ...scope(req) };
  if (q.userId && mongoose.isValidObjectId(q.userId) && canSeeAll(req)) filter.userId = q.userId;
  if (q.from || q.to) {
    filter.day = {};
    if (q.from) filter.day.$gte = String(q.from);
    if (q.to) filter.day.$lte = String(q.to);
  }
  res.json({ success: true, data: await paginate(StaffAttendance, filter, q, { sort: { checkInAt: -1 }, populate: { path: 'userId', select: 'name role' } }) });
});

/** Monthly summary per staff member: days present and hours worked. ?month=YYYY-MM */
router.get('/summary', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : dayjs().tz(tz).format('YYYY-MM');
  const from = `${month}-01`;
  const to = ymd(dayjs.tz(`${from}T00:00:00`, tz).endOf('month').toDate());
  const rows = await StaffAttendance.aggregate([
    { $match: { ...scope(req), day: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$userId',
        daysPresent: { $sum: 1 },
        minutes: { $sum: { $cond: [{ $gt: ['$checkOutAt', null] }, { $divide: [{ $subtract: ['$checkOutAt', '$checkInAt'] }, 60000] }, 0] } },
        missingCheckOut: { $sum: { $cond: [{ $gt: ['$checkOutAt', null] }, 0, 1] } },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $project: { name: { $arrayElemAt: ['$u.name', 0] }, role: { $arrayElemAt: ['$u.role', 0] }, daysPresent: 1, hours: { $round: [{ $divide: ['$minutes', 60] }, 1] }, missingCheckOut: 1 } },
    { $sort: { name: 1 } },
  ]);
  res.json({ success: true, data: { month, from, to, rows } });
});

export default router;
