import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDays, parseDay, startOfDay, ymd, dayjs, tz } from '../../utils/dates.js';
import { PtAvailability, PtBooking, SLOT_LENGTHS } from './ptBooking.model.js';
import { PtPurchase } from './pt.model.js';
import { User } from '../users/user.model.js';
import { getGym } from '../settings/gym.model.js';
import { audit } from '../audit/audit.model.js';
import { ptSettings, trainerSlots, bookableSessions, bookSlot, cancelPtBooking, markPtBooking } from './ptBooking.service.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const POPULATE = [
  { path: 'memberId', select: 'name memberCode phone photoUrl' },
  { path: 'trainerId', select: 'name' },
  { path: 'ptPurchaseId', select: 'package.name sessionsTotal sessionsUsed validTo' },
];

/* ======================= Staff: /api/v1/pt ======================= */
export const ptScheduleRouter = Router();
ptScheduleRouter.use(requireStaff);

const isTrainer = (req) => req.user.role === 'trainer';
// Trainers manage their own hours; owner / manager (pt.manage) can set anyone's.
function trainerIdFor(req, asked) {
  if (isTrainer(req)) return String(req.user._id);
  if (!asked || !mongoose.isValidObjectId(String(asked))) throw ApiError.badRequest('Choose a trainer');
  return String(asked);
}

ptScheduleRouter.get('/availability', permit('pt.read'), async (req, res) => {
  const trainerId = trainerIdFor(req, req.query.trainerId);
  const av = await PtAvailability.findOne({ trainerId }).lean();
  res.json({ success: true, data: av || { trainerId, slotMin: 60, weekly: [], timeOff: [] } });
});

const availabilityBody = z.object({
  trainerId: objectId.optional(),
  slotMin: z.number().refine((v) => SLOT_LENGTHS.includes(v), 'Slot length must be 30, 45, 60 or 90 minutes'),
  weekly: z
    .array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm, branchId: objectId }).refine((r) => r.start < r.end, 'End time must be after the start time'))
    .max(50),
  timeOff: z
    .array(z.object({ from: z.coerce.date(), to: z.coerce.date(), note: z.string().trim().max(100).optional() }).refine((t) => t.to > t.from, 'Time off must end after it starts'))
    .max(100)
    .default([]),
});

ptScheduleRouter.put('/availability', permit('pt.read'), validate({ body: availabilityBody }), async (req, res) => {
  if (!isTrainer(req) && !can(req.user.role, 'pt.manage')) throw ApiError.forbidden('Only the trainer or a manager can change PT hours');
  const trainerId = trainerIdFor(req, req.body.trainerId);
  const trainer = await User.findOne({ _id: trainerId, role: 'trainer', isActive: true }).select('name branchIds').lean();
  if (!trainer) throw ApiError.notFound('Trainer not found');
  const branches = (trainer.branchIds || []).map(String);
  for (const r of req.body.weekly) {
    if (!branches.includes(r.branchId)) throw ApiError.badRequest(`${trainer.name} does not work at the chosen branch`);
  }
  // Old time off is dropped once it is over.
  const timeOff = req.body.timeOff.filter((t) => t.to > startOfDay());
  const av = await PtAvailability.findOneAndUpdate(
    { trainerId },
    { slotMin: req.body.slotMin, weekly: req.body.weekly, timeOff, updatedBy: req.user._id },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  await audit(req, 'pt.availability', { entity: 'PtAvailability', entityId: av._id, details: { trainerId, slotMin: req.body.slotMin, ranges: req.body.weekly.length, timeOff: timeOff.length } });
  res.json({ success: true, data: av });
});

// Slots of a trainer (staff booking on behalf of a member). ?trainerId=&from=YYYY-MM-DD&days=7&branchId=
ptScheduleRouter.get('/slots', permit('pt.read'), async (req, res) => {
  const trainerId = trainerIdFor(req, req.query.trainerId);
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : ymd(new Date());
  const branchId = req.query.branchId && mongoose.isValidObjectId(String(req.query.branchId)) ? String(req.query.branchId) : undefined;
  res.json({ success: true, data: await trainerSlots({ trainerId, from, days, branchId }) });
});

// Day / week schedule. Trainers see only their own bookings.
ptScheduleRouter.get('/bookings', permit('pt.read'), async (req, res) => {
  const q = req.query;
  const from = q.from ? parseDay(String(q.from)) : startOfDay();
  const to = q.to ? addDays(parseDay(String(q.to)), 1) : addDays(from, 1);
  if (to - from > 31 * 86400000) throw ApiError.badRequest('Choose at most 31 days');
  const filter = { ...branchFilter(req), startsAt: { $gte: from, $lt: to } };
  if (isTrainer(req)) filter.trainerId = req.user._id;
  else if (q.trainerId && mongoose.isValidObjectId(String(q.trainerId))) filter.trainerId = q.trainerId;
  if (q.memberId && mongoose.isValidObjectId(String(q.memberId))) filter.memberId = q.memberId;
  if (q.status === 'open') filter.status = 'booked';
  else if (q.status !== 'all') filter.status = { $ne: 'cancelled' };
  const data = await PtBooking.find(filter).sort({ startsAt: 1 }).limit(500).populate(POPULATE).lean();
  res.json({ success: true, data });
});

async function loadPurchase(req, id) {
  const purchase = await findInBranch(req, PtPurchase, id, { notFound: 'PT package not found', extra: isTrainer(req) ? { trainerId: req.user._id } : {} });
  return purchase;
}

ptScheduleRouter.post('/bookings', permit('pt.log'), validate({ body: z.object({ purchaseId: objectId, startsAt: z.coerce.date() }) }), async (req, res) => {
  const purchase = await loadPurchase(req, req.body.purchaseId);
  const booking = await bookSlot({ purchase, startsAt: req.body.startsAt, source: 'staff', user: req.user });
  await audit(req, 'pt.book', { entity: 'PtBooking', entityId: booking._id, branchId: booking.branchId, details: { startsAt: booking.startsAt, memberId: booking.memberId } });
  res.status(201).json({ success: true, data: await booking.populate(POPULATE) });
});

async function loadBooking(req) {
  return findInBranch(req, PtBooking, req.params.id, { notFound: 'Booking not found', extra: isTrainer(req) ? { trainerId: req.user._id } : {} });
}

ptScheduleRouter.post('/bookings/:id/cancel', permit('pt.log'), validate({ body: z.object({ reason: z.string().trim().max(200).optional() }) }), async (req, res) => {
  const booking = await loadBooking(req);
  const r = await cancelPtBooking({ booking, byStaff: true, user: req.user, reason: req.body.reason });
  await audit(req, 'pt.booking.cancel', { entity: 'PtBooking', entityId: booking._id, branchId: booking.branchId, details: { reason: req.body.reason, late: r.lateCancel } });
  res.json({ success: true, data: r });
});

const markBody = z.object({ notes: z.string().trim().max(500).optional() });
for (const [path, status] of [['done', 'done'], ['no-show', 'no-show']]) {
  ptScheduleRouter.post(`/bookings/:id/${path}`, permit('pt.log'), validate({ body: markBody }), async (req, res) => {
    const booking = await loadBooking(req);
    const r = await markPtBooking({ booking, status, notes: req.body.notes, user: req.user });
    await audit(req, `pt.booking.${status}`, { entity: 'PtBooking', entityId: booking._id, branchId: booking.branchId });
    res.json({ success: true, data: r });
  });
}

/* ======================= Member app: /api/v1/me/pt-... ======================= */
export const portalPtRouter = Router();
portalPtRouter.use(requireMember);

const activeFilter = (memberId) => ({ memberId, status: 'active', validTo: { $gte: startOfDay() }, $expr: { $lt: ['$sessionsUsed', '$sessionsTotal'] } });

// Packages the member can book on, with the booking rules.
portalPtRouter.get('/pt-booking', async (req, res) => {
  const gym = await getGym();
  const cfg = ptSettings(gym.settings);
  const purchases = await PtPurchase.find(activeFilter(req.member._id)).populate('trainerId', 'name').select('package sessionsTotal sessionsUsed validFrom validTo trainerId').lean();
  for (const p of purchases) p.bookable = await bookableSessions(p);
  const now = new Date();
  const bookings = await PtBooking.find({ memberId: req.member._id, $or: [{ status: 'booked' }, { startsAt: { $gte: addDays(now, -30) } }] })
    .sort({ startsAt: -1 })
    .limit(30)
    .populate('trainerId', 'name')
    .select('-slotKey -bookedBy -cancelledByUser -markedBy')
    .lean();
  res.json({ success: true, data: { settings: { bookingWindowDays: cfg.bookingWindowDays, cancelHours: cfg.cancelHours, maxPerDay: cfg.maxPerDay }, purchases, bookings } });
});

// Free slots for one package's trainer, inside the booking window and the package validity.
portalPtRouter.get('/pt-booking/slots', validate({ query: z.object({ purchaseId: objectId, from: day.optional() }) }), async (req, res) => {
  const purchase = await PtPurchase.findOne({ _id: req.validQuery.purchaseId, ...activeFilter(req.member._id) }).lean();
  if (!purchase) throw ApiError.notFound('No active PT package');
  const cfg = ptSettings((await getGym()).settings);
  const today = ymd(new Date());
  const first = [today, ymd(purchase.validFrom), req.validQuery.from || today].sort().at(-1);
  const last = [ymd(addDays(new Date(), cfg.bookingWindowDays)), ymd(purchase.validTo)].sort()[0];
  const days = last < first ? 0 : dayjs.tz(last, tz).diff(dayjs.tz(first, tz), 'day') + 1;
  if (!days) return res.json({ success: true, data: { days: [], hasHours: true } });
  const r = await trainerSlots({ trainerId: purchase.trainerId, from: first, days: Math.min(days, 31), branchId: purchase.branchId });
  res.json({ success: true, data: { slotMin: r.slotMin, hasHours: r.hasHours, days: r.days.map((d) => ({ day: d.day, slots: d.slots.filter((s) => s.free).map(({ startsAt, endsAt }) => ({ startsAt, endsAt })) })) } });
});

portalPtRouter.post('/pt-booking', validate({ body: z.object({ purchaseId: objectId, startsAt: z.coerce.date() }) }), async (req, res) => {
  const purchase = await PtPurchase.findOne({ _id: req.body.purchaseId, memberId: req.member._id });
  if (!purchase) throw ApiError.notFound('PT package not found');
  const booking = await bookSlot({ purchase, startsAt: req.body.startsAt, source: 'member' });
  res.status(201).json({ success: true, data: booking });
});

portalPtRouter.post('/pt-booking/:id/cancel', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Booking not found');
  const booking = await PtBooking.findOne({ _id: req.params.id, memberId: req.member._id });
  if (!booking) throw ApiError.notFound('Booking not found');
  res.json({ success: true, data: await cancelPtBooking({ booking, byStaff: false }) });
});
