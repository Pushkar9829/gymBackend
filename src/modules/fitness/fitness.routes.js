import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { Exercise, WorkoutPlan, DietPlan, Measurement, MUSCLE_GROUPS } from './fitness.model.js';
import { DEFAULT_EXERCISES } from './exercises.defaults.js';
import { loadAccessibleMember } from '../members/trainerScope.js';
import { asGymDay, isFutureDay } from '../../utils/dates.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const num = (max) => z.number().min(0).max(max).nullable().optional();

/* ---------------- Exercise library ---------------- */
const exerciseBody = z.object({
  name: z.string().trim().min(2).max(80),
  muscleGroup: z.enum(MUSCLE_GROUPS),
  equipment: z.string().trim().max(40).optional(),
  instructions: z.string().max(1000).optional(),
  videoUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
});
router.get('/exercises', permit('fitness.read'), async (req, res) => {
  const filter = req.query.all === 'true' ? {} : { isActive: true };
  if (req.query.muscleGroup) filter.muscleGroup = String(req.query.muscleGroup);
  res.json({ success: true, data: await Exercise.find(filter).sort({ muscleGroup: 1, name: 1 }).lean() });
});
router.post('/exercises', permit('fitness.write'), validate({ body: exerciseBody }), async (req, res) => {
  res.status(201).json({ success: true, data: await Exercise.create(req.body) });
});
router.put('/exercises/:id', permit('fitness.write'), validate({ body: exerciseBody.partial() }), async (req, res) => {
  const ex = await Exercise.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!ex) throw ApiError.notFound('Exercise not found');
  res.json({ success: true, data: ex });
});
router.post('/exercises/defaults', permit('fitness.write'), async (_req, res) => {
  let added = 0;
  for (const e of DEFAULT_EXERCISES) {
    const r = await Exercise.updateOne({ name: e.name }, { $setOnInsert: e }, { upsert: true });
    added += r.upsertedCount;
  }
  res.json({ success: true, data: { added } });
});

/* ---------------- Plans (workout + diet share the same flow) ---------------- */
const planExercise = z.object({
  exerciseId: objectId.optional().nullable(),
  name: z.string().trim().min(1).max(80),
  sets: z.number().int().min(1).max(20).optional(),
  reps: z.string().trim().max(20).optional(),
  weight: z.string().trim().max(30).optional(),
  restSec: z.number().int().min(0).max(600).optional(),
  notes: z.string().max(200).optional(),
});
const workoutBody = z.object({
  memberId: objectId.optional().nullable(),
  name: z.string().trim().min(2).max(80),
  goal: z.enum(['weight-loss', 'muscle-gain', 'strength', 'endurance', 'general-fitness', 'rehab']).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  days: z.array(z.object({ name: z.string().trim().min(1).max(60), exercises: z.array(planExercise).max(30) })).min(1).max(14),
  notes: z.string().max(1000).optional(),
});
const dietBody = z.object({
  memberId: objectId.optional().nullable(),
  name: z.string().trim().min(2).max(80),
  goal: z.string().max(60).optional(),
  dailyCalories: z.number().int().min(0).max(10000).optional().nullable(),
  proteinGrams: z.number().int().min(0).max(500).optional().nullable(),
  preference: z.enum(['veg', 'non-veg', 'egg', 'vegan']).optional(),
  meals: z
    .array(
      z.object({
        time: z.string().max(10).optional(),
        name: z.string().trim().min(1).max(40),
        items: z.array(z.object({ food: z.string().trim().min(1).max(80), quantity: z.string().max(30).optional(), calories: num(5000), protein: num(300) })).max(20),
        notes: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(10),
  notes: z.string().max(1000).optional(),
});

function planRoutes(path, Model, body) {
  // List: ?memberId=... for a member's plans, ?templates=true for reusable templates.
  router.get(`/${path}`, permit('fitness.read'), async (req, res) => {
    let filter;
    if (req.query.memberId) {
      await loadAccessibleMember(req, req.query.memberId);
      filter = { memberId: req.query.memberId };
    } else filter = { memberId: null, isActive: true };
    res.json({ success: true, data: await Model.find(filter).sort({ isActive: -1, createdAt: -1 }).populate('createdBy', 'name').lean() });
  });

  async function saveForMember(req, data) {
    if (!data.memberId) return { ...data, memberId: null };
    const member = await loadAccessibleMember(req, data.memberId);
    // A member has one active plan of each kind.
    await Model.updateMany({ memberId: member._id, isActive: true }, { isActive: false });
    return { ...data, branchId: member.branchId };
  }

  router.post(`/${path}`, permit('fitness.write'), validate({ body }), async (req, res) => {
    const data = await saveForMember(req, req.body);
    res.status(201).json({ success: true, data: await Model.create({ ...data, createdBy: req.user._id }) });
  });

  router.put(`/${path}/:id`, permit('fitness.write'), validate({ body: body.partial().omit({ memberId: true }) }), async (req, res) => {
    const plan = await Model.findById(req.params.id);
    if (!plan) throw ApiError.notFound('Plan not found');
    if (plan.memberId) await loadAccessibleMember(req, plan.memberId);
    Object.assign(plan, req.body);
    await plan.save();
    res.json({ success: true, data: plan });
  });

  // Copy a template to a member (becomes their active plan).
  router.post(`/${path}/:id/assign`, permit('fitness.write'), validate({ body: z.object({ memberId: objectId }) }), async (req, res) => {
    const tpl = await Model.findOne({ _id: req.params.id, memberId: null }).lean();
    if (!tpl) throw ApiError.notFound('Template not found');
    const { _id, createdAt, updatedAt, __v, ...copy } = tpl; // eslint-disable-line no-unused-vars
    const data = await saveForMember(req, { ...copy, memberId: req.body.memberId, isActive: true });
    res.status(201).json({ success: true, data: await Model.create({ ...data, createdBy: req.user._id }) });
  });

  router.delete(`/${path}/:id`, permit('fitness.write'), async (req, res) => {
    const plan = await Model.findById(req.params.id);
    if (!plan) throw ApiError.notFound('Plan not found');
    if (plan.memberId) await loadAccessibleMember(req, plan.memberId);
    plan.isActive = false;
    await plan.save();
    res.json({ success: true });
  });
}
planRoutes('workout-plans', WorkoutPlan, workoutBody);
planRoutes('diet-plans', DietPlan, dietBody);

/* ---------------- Measurements ---------------- */
export const measurementBody = z.object({
  date: z.coerce.date(),
  weightKg: num(400),
  heightCm: num(260),
  bodyFatPercent: num(80),
  chestCm: num(300),
  waistCm: num(300),
  hipsCm: num(300),
  armsCm: num(100),
  thighsCm: num(150),
  restingHeartRate: num(250),
  notes: z.string().max(300).optional(),
  photos: z.array(z.string().url()).max(4).optional(),
});

router.get('/measurements', permit('fitness.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.query.memberId);
  res.json({ success: true, data: await Measurement.find({ memberId: member._id }).sort({ date: 1 }).lean() });
});
router.post('/measurements', permit('fitness.write'), validate({ body: measurementBody.extend({ memberId: objectId }) }), async (req, res) => {
  const member = await loadAccessibleMember(req, req.body.memberId);
  if (isFutureDay(req.body.date)) throw ApiError.badRequest('Date cannot be in the future');
  res.status(201).json({ success: true, data: await Measurement.create({ ...req.body, date: asGymDay(req.body.date), memberId: member._id, recordedBy: req.user._id }) });
});
router.delete('/measurements/:id', permit('fitness.write'), async (req, res) => {
  const m = await Measurement.findById(req.params.id);
  if (!m) throw ApiError.notFound('Entry not found');
  await loadAccessibleMember(req, m.memberId);
  await m.deleteOne();
  res.json({ success: true });
});

export default router;
