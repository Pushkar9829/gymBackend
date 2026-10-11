import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { ymd, parseDay, addDays } from '../../utils/dates.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { Attendance } from './attendance.model.js';
import { AccessLog } from '../access/accessLog.model.js';
import { Member } from '../members/member.model.js';
import { parseQr } from '../access/qr.js';
import { staffCheckIn } from './attendance.service.js';

const router = Router();
router.use(requireStaff);

const memberProjection = 'name memberCode phone photoUrl membershipStatus membershipEnd currentPlanName dueAmount isBlocked branchId';

router.post(
  '/check-in',
  permit('attendance.write'),
  validate({
    body: z
      .object({
        qr: z.string().max(200).optional(),
        memberId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id').optional(),
        memberCode: z.number().int().optional(),
        cardNo: z.string().trim().regex(/^\d{4,20}$/).optional(),
      })
      .refine((b) => b.qr || b.memberId || b.memberCode || b.cardNo, 'Scan a QR code, tap a card or choose a member'),
  }),
  async (req, res) => {
    let filter;
    let method = 'manual';
    if (req.body.qr) {
      const code = parseQr(req.body.qr);
      if (!code) throw ApiError.badRequest('Invalid or fake QR code');
      filter = { memberCode: code };
      method = 'qr';
    } else if (req.body.cardNo) {
      filter = { cardNo: req.body.cardNo };
      method = 'manual';
    } else if (req.body.memberId) filter = { _id: req.body.memberId };
    else filter = { memberCode: req.body.memberCode };

    const member = await Member.findOne({ ...filter, isDeleted: false }).lean();
    if (!member) throw ApiError.notFound(req.body.cardNo ? 'Unknown card' : 'Member not found');
    assertBranchAccess(req, member.branchId);
    const result = await staffCheckIn({ member, method, user: req.user });
    res.json({
      success: true,
      data: {
        allowed: result.allowed,
        code: result.access.code,
        reason: result.access.reason,
        daysLeft: result.access.daysLeft,
        dueAmount: result.access.dueAmount,
        member: { _id: member._id, name: member.name, memberCode: member.memberCode, photoUrl: member.photoUrl, phone: member.phone },
        attendance: result.attendance,
      },
    });
  },
);

router.post('/:id/check-out', permit('attendance.write'), async (req, res) => {
  const row = await findInBranch(req, Attendance, req.params.id, { notFound: 'Attendance not found' });
  if (row.checkOutAt) throw ApiError.badRequest('Already checked out');
  row.checkOutAt = new Date();
  await row.save();
  res.json({ success: true, data: row });
});

/** Members currently in the gym: checked in today, not checked out, last punch within 3 hours. */
router.get('/live', permit('attendance.read'), async (req, res) => {
  const since = new Date(Date.now() - 3 * 3600 * 1000);
  const rows = await Attendance.find({ ...branchFilter(req), day: ymd(new Date()), checkOutAt: null, lastPunchAt: { $gte: since } })
    .sort({ checkInAt: -1 })
    .populate('memberId', memberProjection)
    .lean();
  res.json({ success: true, data: { count: rows.length, items: rows } });
});

router.get('/', permit('attendance.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.date) filter.day = String(q.date);
  if (q.from || q.to) {
    filter.checkInAt = {};
    if (q.from) filter.checkInAt.$gte = parseDay(String(q.from));
    if (q.to) filter.checkInAt.$lt = addDays(parseDay(String(q.to)), 1);
  }
  if (q.method) filter.method = String(q.method);
  if (isExport(q)) {
    const rows = await Attendance.find(filter).sort({ checkInAt: -1 }).limit(50000).populate('memberId', 'name memberCode').lean();
    return sendExport(res, req.query.export, 'attendance', rows, [
      { label: 'Date', key: 'day' },
      { label: 'Member', value: (r) => r.memberId?.name },
      { label: 'Code', value: (r) => r.memberId?.memberCode },
      { label: 'Check-in', value: (r) => r.checkInAt },
      { label: 'Check-out', value: (r) => r.checkOutAt },
      { label: 'Method', key: 'method' },
    ]);
  }
  const data = await paginate(Attendance, filter, q, {
    sort: { checkInAt: -1 },
    populate: [{ path: 'memberId', select: memberProjection }, { path: 'deviceId', select: 'name' }],
  });
  res.json({ success: true, data });
});

router.get('/access-logs', permit('attendance.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.result === 'allow' || q.result === 'deny') filter.result = q.result;
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.deviceId && mongoose.isValidObjectId(q.deviceId)) filter.deviceId = q.deviceId;
  if (q.source) filter.source = String(q.source);
  if (q.code) filter.code = String(q.code);
  if (q.date) filter.at = { $gte: parseDay(String(q.date)), $lt: addDays(parseDay(String(q.date)), 1) };
  if (q.branchId) assertBranchAccess(req, q.branchId);
  const data = await paginate(AccessLog, filter, q, {
    sort: { at: -1 },
    populate: [
      { path: 'memberId', select: 'name memberCode photoUrl' },
      { path: 'deviceId', select: 'name' },
      { path: 'byUser', select: 'name' },
    ],
  });
  res.json({ success: true, data });
});

export default router;
