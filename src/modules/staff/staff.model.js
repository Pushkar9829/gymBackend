import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/** One row per staff member per day: first punch = in, last punch = out. */
const staffAttendanceSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    branchId: { type: ObjectId, ref: 'Branch' },
    day: { type: String, required: true }, // YYYY-MM-DD gym time
    checkInAt: { type: Date, required: true },
    checkOutAt: Date,
    method: { type: String, enum: ['biometric', 'manual'], required: true },
    deviceId: { type: ObjectId, ref: 'Device' },
  },
  { timestamps: true },
);
staffAttendanceSchema.index({ userId: 1, day: 1 }, { unique: true });
staffAttendanceSchema.index({ branchId: 1, day: 1 });
export const StaffAttendance = mongoose.model('StaffAttendance', staffAttendanceSchema);

/** What the server believes each device has for a staff member (staff are always allowed in while active). */
const deviceStaffSchema = new mongoose.Schema(
  {
    deviceId: { type: ObjectId, ref: 'Device', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    pin: { type: String, required: true },
    enabled: Boolean,
    stateHash: String,
    lastQueuedAt: Date,
  },
  { timestamps: true },
);
deviceStaffSchema.index({ deviceId: 1, userId: 1 }, { unique: true });
export const DeviceStaff = mongoose.model('DeviceStaff', deviceStaffSchema);
