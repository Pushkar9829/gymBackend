import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, ymd } from '../../utils/dates.js';
import { getGym } from '../settings/gym.model.js';
import { loadAccessibleMember } from '../members/trainerScope.js';
import { WorkoutPlan } from './fitness.model.js';
import { WorkoutLog } from './workoutLog.model.js';
import { progressSummary } from './streaks.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const BACKDATE_DAYS = 7;

/** Next plan day after the last one logged for this plan (plan days in order, then round again). */
async function suggestDay(memberId, plan) {
  if (!plan?.days?.length) return { suggestedDayIndex: 0, last: null };
  const last = await WorkoutLog.findOne({ memberId, planId: plan._id }).sort({ day: -1, createdAt: -1 }).select('day dayIndex dayName').lean();
  const next = last && Number.isInteger(last.dayIndex) ? (last.dayIndex + 1) % plan.days.length : 0;
  return { suggestedDayIndex: next, last };
}

/* ======================= Member app: /api/v1/me/... ======================= */
export const portalWorkoutRouter = Router();
portalWorkoutRouter.use(requireMember);

portalWorkoutRouter.get('/workout', async (req, res) => {
  const plan = await WorkoutPlan.findOne({ memberId: req.member._id, isActive: true }).select('name goal level days notes').lean();
  const { suggestedDayIndex, last } = await suggestDay(req.member._id, plan);
  const today = await WorkoutLog.find({ memberId: req.member._id, day: ymd(new Date()) }).select('dayName createdAt').lean();
  res.json({ success: true, data: { plan, suggestedDayIndex, last, today } });
});

const entry = z.object({
  exerciseId: objectId.optional().nullable(),
  name: z.string().trim().min(1).max(80),
  done: z.boolean(),
  sets: z.number().int().min(0).max(50).optional().nullable(),
  reps: z.string().trim().max(20).optional(),
  weight: z.string().trim().max(30).optional(),
});
const logBody = z.object({
  planId: objectId.optional(),
  dayIndex: z.number().int().min(0).max(13).optional(),
  date: day.optional(),
  entries: z.array(entry).min(1).max(40),
  durationMin: z.number().int().min(1).max(600).optional().nullable(),
  note: z.string().trim().max(500).optional(),
});

portalWorkoutRouter.post('/workout-logs', validate({ body: logBody }), async (req, res) => {
  const b = req.body;
  const today = ymd(new Date());
  const date = b.date || today;
  if (date > today) throw ApiError.badRequest('Date cannot be in the future');
  if (date < ymd(addDays(new Date(), -BACKDATE_DAYS))) throw ApiError.badRequest(`You can log workouts from the last ${BACKDATE_DAYS} days only`);
  if (!b.entries.some((e) => e.done)) throw ApiError.badRequest('Tick at least one exercise you did');

  let plan = null;
  let planDay = null;
  if (b.planId) {
    plan = await WorkoutPlan.findOne({ _id: b.planId, memberId: req.member._id }).lean();
    if (!plan) throw ApiError.notFound('Workout plan not found');
    planDay = plan.days[b.dayIndex ?? 0];
    if (!planDay) throw ApiError.badRequest('Choose a day from your plan');
  }
  const planned = (name) => planDay?.exercises.find((x) => x.name === name);
  const log = await WorkoutLog.create({
    memberId: req.member._id,
    branchId: req.member.branchId,
    day: date,
    planId: plan?._id,
    planName: plan?.name,
    dayIndex: plan ? (b.dayIndex ?? 0) : undefined,
    dayName: planDay?.name,
    entries: b.entries.map((e) => {
      const p = planned(e.name);
      return { ...e, exerciseId: e.exerciseId || p?.exerciseId || undefined, sets: e.sets ?? undefined, planned: p ? { sets: p.sets, reps: p.reps, weight: p.weight } : undefined };
    }),
    durationMin: b.durationMin || undefined,
    note: b.note || undefined,
  });
  res.status(201).json({ success: true, data: log });
});

portalWorkoutRouter.get('/workout-logs', async (req, res) => {
  const data = await paginate(WorkoutLog, { memberId: req.member._id }, req.query, { sort: { day: -1, createdAt: -1 }, select: '-branchId -memberId' });
  res.json({ success: true, data });
});

portalWorkoutRouter.delete('/workout-logs/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Workout not found');
  const r = await WorkoutLog.deleteOne({ _id: req.params.id, memberId: req.member._id });
  if (!r.deletedCount) throw ApiError.notFound('Workout not found');
  res.json({ success: true });
});

portalWorkoutRouter.get('/progress-summary', async (req, res) => {
  const gym = await getGym();
  res.json({ success: true, data: await progressSummary(req.member._id, { settings: gym.settings }) });
});

/* ======================= Staff (read-only): /api/v1/fitness/workout-logs ======================= */
export const staffWorkoutRouter = Router();
staffWorkoutRouter.use(requireStaff);

// Trainers see their own clients only (loadAccessibleMember).
staffWorkoutRouter.get('/', permit('fitness.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.query.memberId);
  const [logs, summary] = await Promise.all([
    WorkoutLog.find({ memberId: member._id }).sort({ day: -1, createdAt: -1 }).limit(50).lean(),
    member.isTrial ? null : getGym().then((g) => progressSummary(member._id, { settings: g.settings })),
  ]);
  res.json({ success: true, data: { logs, summary } });
});
