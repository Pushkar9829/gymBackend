import mongoose from 'mongoose';

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: String,
    durationValue: { type: Number, required: true, min: 1 },
    durationUnit: { type: String, enum: ['day', 'month'], default: 'month' },
    price: { type: Number, required: true, min: 0 }, // paise, pre-tax
    joiningFee: { type: Number, default: 0, min: 0 }, // paise, charged on first membership only
    taxPercent: { type: Number, min: 0, max: 50 }, // empty = gym default
    freezeDaysAllowed: { type: Number, default: 0, min: 0 },
    maxFreezes: { type: Number, default: 1, min: 0 },
    // Time-slot plans (e.g. morning only). Empty = any time the gym is open.
    accessStart: String, // HH:MM
    accessEnd: String, // HH:MM
    // Access time-zone number configured on the biometric device for this slot (1 = 24 hours).
    deviceTimezoneId: { type: Number, default: 1, min: 1, max: 50 },
    // Family / couple plans: one purchase covers up to this many members (1 = individual).
    maxMembers: { type: Number, default: 1, min: 1, max: 10 },
    // Empty = available in all branches
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Plan = mongoose.model('Plan', planSchema);
