import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { startOfDay, addDays, parseDay } from '../../utils/dates.js';
import { ClassType, ClassSchedule, ClassSession, Booking } from './class.model.js';
import { Member } from '../members/member.model.js';
import { ensureSessions, bookClass, cancelBooking, cancelSession, markAttendance, CANCEL_CUTOFF_MIN } from './class.service.js';
import { audit } from '../audit/audit.model.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

function range(q, days = 7) {
  const from = q.from ? parseDay(String(q.from)) : startOfDay();
  const to = q.to ? addDays(parseDay(String(q.to)), 1) : addDays(from, days);
  if (to - from > 31 * 86400000) throw ApiError.badRequest('Choose at most 31 days');
  return { from, to };
}

/* ======================= Staff: /api/v1/classes ======================= */
export const classRouter = Router();
classRouter.use(requireStaff);

// Class types
const typeBody = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().max(300).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  durationMin: z.number().int().min(10).max(240).optional(),
  defaultCapacity: z.number().int().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
});
classRouter.get('/types', permit('classes.read'), async (_req, res) => {
  res.json({ success: true, data: await ClassType.find().sort({ name: 1 }).lean() });
});
classRouter.post('/types', permit('classes.write'), validate({ body: typeBody }), async (req, res) => {
  res.status(201).json({ success: true, data: await ClassType.create(req.body) });
});
classRouter.put('/types/:id', permit('classes.write'), validate({ body: typeBody.partial() }), async (req, res) => {
  const t = await ClassType.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!t) throw ApiError.notFound('Class type not found');
  res.json({ success: true, data: t });
});

// Weekly schedules
const scheduleBody = z.object({
  branchId: objectId,
  classTypeId: objectId,
  trainerId: objectId.optional().nullable(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: hhmm,
  durationMin: z.number().int().min(10).max(240),
  capacity: z.number().int().min(1).max(500),
  room: z.string().max(40).optional(),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional(),
});
classRouter.get('/schedules', permit('classes.read'), async (req, res) => {
  const data = await ClassSchedule.find(branchFilter(req)).populate('classTypeId', 'name color').populate('trainerId', 'name').sort({ startTime: 1 }).lean();
  res.json({ success: true, data });
});
classRouter.post('/schedules', permit('classes.write'), validate({ body: scheduleBody }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const schedule = await ClassSchedule.create({ ...req.body, validFrom: req.body.validFrom || startOfDay() });
  await audit(req, 'class.schedule.create', { entity: 'ClassSchedule', entityId: schedule._id, branchId: schedule.branchId });
  res.status(201).json({ success: true, data: schedule });
});
// Changes apply to classes generated from now on; already-generated classes keep their details.
classRouter.put('/schedules/:id', permit('classes.write'), validate({ body: scheduleBody.partial() }), async (req, res) => {
  const s = await findInBranch(req, ClassSchedule, req.params.id, { notFound: 'Schedule not found' });
  Object.assign(s, req.body);
  await s.save();
  // Remove future generated classes that nobody has booked, so they regenerate with the new details.
  const future = await ClassSession.find({ scheduleId: s._id, startsAt: { $gt: new Date() }, bookedCount: 0, waitlistCount: 0 }).select('_id').lean();
  await ClassSession.deleteMany({ _id: { $in: future.map((x) => x._id) } });
  res.json({ success: true, data: s });
});

// Sessions (the timetable)
classRouter.get('/sessions', permit('classes.read'), async (req, res) => {
  const { from, to } = range(req.query);
  const bf = branchFilter(req);
  await ensureSessions({ branchFilter: bf, from, to });
  const filter = { ...bf, startsAt: { $gte: from, $lt: to } };
  if (req.user.role === 'trainer' && req.query.mine === 'true') filter.trainerId = req.user._id;
  const data = await ClassSession.find(filter).sort({ startsAt: 1 }).populate('trainerId', 'name').lean();
  res.json({ success: true, data });
});

// One-off class (workshop, special event)
classRouter.post(
  '/sessions',
  permit('classes.write'),
  validate({ body: z.object({ branchId: objectId, classTypeId: objectId, trainerId: objectId.optional(), startsAt: z.coerce.date(), durationMin: z.number().int().min(10).max(480), capacity: z.number().int().min(1).max(500), room: z.string().max(40).optional() }) }),
  async (req, res) => {
    assertBranchAccess(req, req.body.branchId);
    const type = await ClassType.findById(req.body.classTypeId).lean();
    if (!type) throw ApiError.notFound('Class type not found');
    const { durationMin, ...rest } = req.body;
    const s = await ClassSession.create({ ...rest, name: type.name, color: type.color, endsAt: new Date(req.body.startsAt.getTime() + durationMin * 60000) });
    res.status(201).json({ success: true, data: s });
  },
);

classRouter.get('/sessions/:id', permit('classes.read'), async (req, res) => {
  const session = await findInBranch(req, ClassSession, req.params.id, { notFound: 'Class not found' });
  await session.populate('trainerId', 'name');
  const bookings = await Booking.find({ sessionId: session._id, status: { $ne: 'cancelled' } })
    .sort({ status: 1, waitlistedAt: 1, createdAt: 1 })
    .populate('memberId', 'name memberCode phone photoUrl photoFileId')
    .lean();
  res.json({ success: true, data: { session, bookings } });
});

classRouter.post('/sessions/:id/cancel', permit('classes.write'), validate({ body: z.object({ reason: z.string().trim().max(200).optional() }) }), async (req, res) => {
  await findInBranch(req, ClassSession, req.params.id, { notFound: 'Class not found' });
  const r = await cancelSession({ sessionId: req.params.id, reason: req.body.reason });
  await audit(req, 'class.cancel', { entity: 'ClassSession', entityId: r.session._id, branchId: r.session.branchId, details: req.body });
  res.json({ success: true, data: r });
});

// Staff books a member (reception / trainer)
classRouter.post('/sessions/:id/bookings', permit('classes.book'), validate({ body: z.object({ memberId: objectId }) }), async (req, res) => {
  await findInBranch(req, ClassSession, req.params.id, { notFound: 'Class not found' });
  const member = await findInBranch(req, Member, req.body.memberId, { notFound: 'Member not found', extra: { isDeleted: false } });
  const r = await bookClass({ sessionId: req.params.id, member, source: 'staff', user: req.user });
  res.status(201).json({ success: true, data: r });
});

classRouter.post('/bookings/:id/cancel', permit('classes.book'), async (req, res) => {
  await findInBranch(req, Booking, req.params.id, { notFound: 'Booking not found' });
  res.json({ success: true, data: await cancelBooking({ bookingId: req.params.id, byStaff: true }) });
});

classRouter.post('/bookings/:id/attendance', permit('classes.attendance'), validate({ body: z.object({ status: z.enum(['attended', 'no-show']) }) }), async (req, res) => {
  const b = await findInBranch(req, Booking, req.params.id, { notFound: 'Booking not found' });
  if (req.user.role === 'trainer') {
    const s = await ClassSession.findById(b.sessionId).lean();
    if (String(s.trainerId) !== String(req.user._id)) throw ApiError.forbidden('Only the class trainer can mark attendance');
  }
  res.json({ success: true, data: await markAttendance({ bookingId: req.params.id, status: req.body.status }) });
});

// Popularity report
classRouter.get('/report', permit('reports.read'), async (req, res) => {
  const { from, to } = range(req.query, 30);
  const rows = await ClassSession.aggregate([
    { $match: { ...branchFilter(req), startsAt: { $gte: from, $lt: to }, status: 'scheduled' } },
    { $group: { _id: '$name', classes: { $sum: 1 }, capacity: { $sum: '$capacity' }, booked: { $sum: '$bookedCount' } } },
    { $project: { name: '$_id', classes: 1, capacity: 1, booked: 1, fillRate: { $cond: [{ $gt: ['$capacity', 0] }, { $round: [{ $multiply: [{ $divide: ['$booked', '$capacity'] }, 100] }, 0] }, 0] } } },
    { $sort: { fillRate: -1 } },
  ]);
  res.json({ success: true, data: rows });
});

/* ======================= Member portal: /api/v1/me/classes ======================= */
export const portalClassRouter = Router();
portalClassRouter.use(requireMember);

portalClassRouter.get('/classes', async (req, res) => {
  const { from, to } = range(req.query, 7);
  const bf = { branchId: req.member.branchId };
  await ensureSessions({ branchFilter: bf, from, to });
  const sessions = await ClassSession.find({ ...bf, startsAt: { $gte: from, $lt: to } }).sort({ startsAt: 1 }).populate('trainerId', 'name').lean();
  const mine = await Booking.find({ memberId: req.member._id, sessionId: { $in: sessions.map((s) => s._id) }, status: { $ne: 'cancelled' } }).lean();
  const byId = Object.fromEntries(mine.map((b) => [String(b.sessionId), b]));
  res.json({
    success: true,
    data: {
      cancelCutoffMin: CANCEL_CUTOFF_MIN,
      sessions: sessions.map((s) => ({ ...s, myBooking: byId[String(s._id)] ? { _id: byId[String(s._id)]._id, status: byId[String(s._id)].status } : null })),
    },
  });
});

portalClassRouter.post('/classes/:id/book', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Class not found');
  res.status(201).json({ success: true, data: await bookClass({ sessionId: req.params.id, member: req.member }) });
});

portalClassRouter.post('/bookings/:id/cancel', async (req, res) => {
  const b = await Booking.findOne({ _id: req.params.id, memberId: req.member._id });
  if (!b) throw ApiError.notFound('Booking not found');
  res.json({ success: true, data: await cancelBooking({ bookingId: b._id }) });
});

