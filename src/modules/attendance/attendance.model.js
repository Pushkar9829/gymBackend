import mongoose from 'mongoose';

// One row per member per day. The first punch is check-in, later punches update lastPunchAt.
const attendanceSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD in gym timezone
    checkInAt: { type: Date, required: true },
    checkOutAt: Date,
    lastPunchAt: Date,
    punches: { type: Number, default: 1 },
    method: { type: String, enum: ['biometric', 'qr', 'manual'], required: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isTrial: Boolean, // visit on a trial pass: not counted in member check-in numbers
  },
  { timestamps: true },
);

attendanceSchema.index({ memberId: 1, day: 1 }, { unique: true });
attendanceSchema.index({ branchId: 1, day: 1 });
attendanceSchema.index({ branchId: 1, checkInAt: -1 });

export const Attendance = mongoose.model('Attendance', attendanceSchema);
