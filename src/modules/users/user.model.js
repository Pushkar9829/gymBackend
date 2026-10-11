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
