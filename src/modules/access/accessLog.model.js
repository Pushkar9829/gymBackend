import mongoose from 'mongoose';

// Every entry attempt (allowed or denied) from any source.
const accessLogSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
    pin: String, // raw device user id (useful when the member is unknown)
    at: { type: Date, required: true },
    result: { type: String, enum: ['allow', 'deny'], required: true },
    code: String, // machine-readable reason, e.g. EXPIRED
    reason: String, // human-readable reason
    source: { type: String, enum: ['biometric', 'qr', 'manual'], required: true },
    deviceEvent: String,
    byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

accessLogSchema.index({ branchId: 1, at: -1 });
accessLogSchema.index({ memberId: 1, at: -1 });
accessLogSchema.index({ result: 1, at: -1 });

export const AccessLog = mongoose.model('AccessLog', accessLogSchema);
