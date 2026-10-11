import mongoose from 'mongoose';
import { ROLE_NAMES } from '../../config/permissions.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_NAMES, required: true },
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
    isActive: { type: Boolean, default: true },
    // Trainers: share of the PT package price earned per session (percent).
    ptCommissionPercent: { type: Number, default: 0, min: 0, max: 100 },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
