import mongoose from 'mongoose';

const refreshTokenSchema = new mongoose.Schema(
  {
    subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
    subjectType: { type: String, enum: ['user', 'member'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ subjectId: 1 });

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);

const resetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true },
);
resetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = mongoose.model('PasswordReset', resetSchema);
