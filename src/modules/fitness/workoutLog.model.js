import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const entrySchema = new mongoose.Schema(
  {
    exerciseId: { type: ObjectId, ref: 'Exercise' },
    name: { type: String, required: true },
    done: { type: Boolean, default: false },
    // What the member actually did
    sets: Number,
    reps: String,
    weight: String,
    // What the plan asked for (snapshot)
    planned: { sets: Number, reps: String, weight: String },
  },
  { _id: false },
);

/** A workout the member finished in the app (one plan day). */
const workoutLogSchema = new mongoose.Schema(
  {
    memberId: { type: ObjectId, ref: 'Member', required: true },
    branchId: { type: ObjectId, ref: 'Branch' },
    day: { type: String, required: true }, // YYYY-MM-DD in gym time
    planId: { type: ObjectId, ref: 'WorkoutPlan' },
    planName: String,
    dayIndex: Number,
    dayName: String,
    entries: [entrySchema],
    durationMin: Number,
    note: String,
  },
  { timestamps: true },
);
workoutLogSchema.index({ memberId: 1, day: -1 });

export const WorkoutLog = mongoose.model('WorkoutLog', workoutLogSchema);
