import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const MUSCLE_GROUPS = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio', 'full-body', 'mobility'];

const exerciseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    muscleGroup: { type: String, enum: MUSCLE_GROUPS, required: true },
    equipment: { type: String, default: 'none' },
    instructions: String,
    videoUrl: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Exercise = mongoose.model('Exercise', exerciseSchema);

const planExerciseSchema = new mongoose.Schema(
  {
    exerciseId: { type: ObjectId, ref: 'Exercise' },
    name: { type: String, required: true }, // snapshot, so plans survive library edits
    sets: { type: Number, min: 1, max: 20, default: 3 },
    reps: { type: String, default: '10' }, // "8-12", "30s", "AMRAP"
    weight: String, // "20 kg", "bodyweight"
    restSec: { type: Number, min: 0, max: 600, default: 60 },
    notes: String,
  },
  { _id: false },
);

const workoutPlanSchema = new mongoose.Schema(
  {
    memberId: { type: ObjectId, ref: 'Member' }, // empty = reusable template
    branchId: { type: ObjectId, ref: 'Branch' },
    name: { type: String, required: true, trim: true },
    goal: { type: String, enum: ['weight-loss', 'muscle-gain', 'strength', 'endurance', 'general-fitness', 'rehab'], default: 'general-fitness' },
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
    days: [
      {
        name: { type: String, required: true }, // "Day 1 - Chest & Triceps"
        exercises: [planExerciseSchema],
      },
    ],
    notes: String,
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
workoutPlanSchema.index({ memberId: 1, isActive: 1 });
export const WorkoutPlan = mongoose.model('WorkoutPlan', workoutPlanSchema);

const dietPlanSchema = new mongoose.Schema(
  {
    memberId: { type: ObjectId, ref: 'Member' }, // empty = template
    branchId: { type: ObjectId, ref: 'Branch' },
    name: { type: String, required: true, trim: true },
    goal: String,
    dailyCalories: Number,
    proteinGrams: Number,
    preference: { type: String, enum: ['veg', 'non-veg', 'egg', 'vegan'], default: 'veg' },
    meals: [
      {
        time: String, // "07:30"
        name: { type: String, required: true }, // Breakfast
        items: [{ food: { type: String, required: true }, quantity: String, calories: Number, protein: Number, _id: false }],
        notes: String,
      },
    ],
    notes: String,
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
dietPlanSchema.index({ memberId: 1, isActive: 1 });
export const DietPlan = mongoose.model('DietPlan', dietPlanSchema);

const measurementSchema = new mongoose.Schema(
  {
    memberId: { type: ObjectId, ref: 'Member', required: true },
    date: { type: Date, required: true },
    weightKg: Number,
    heightCm: Number,
    bmi: Number,
    bodyFatPercent: Number,
    chestCm: Number,
    waistCm: Number,
    hipsCm: Number,
    armsCm: Number,
    thighsCm: Number,
    restingHeartRate: Number,
    notes: String,
    photos: [String],
    recordedBy: { type: ObjectId, ref: 'User' }, // empty = logged by the member in the app
  },
  { timestamps: true },
);
measurementSchema.pre('validate', function computeBmi() {
  if (this.weightKg && this.heightCm) this.bmi = Math.round((this.weightKg / (this.heightCm / 100) ** 2) * 10) / 10;
});
measurementSchema.index({ memberId: 1, date: -1 });
export const Measurement = mongoose.model('Measurement', measurementSchema);
