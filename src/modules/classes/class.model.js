import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const classTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true }, // Yoga, Zumba, HIIT...
    description: String,
    color: { type: String, default: '#0f766e' },
    durationMin: { type: Number, default: 60, min: 10, max: 240 },
    defaultCapacity: { type: Number, default: 20, min: 1, max: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const ClassType = mongoose.model('ClassType', classTypeSchema);

/** Repeating weekly slot, e.g. Yoga every Mon/Wed/Fri 07:00 with trainer X. */
const classScheduleSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    classTypeId: { type: ObjectId, ref: 'ClassType', required: true },
    trainerId: { type: ObjectId, ref: 'User' },
    weekdays: { type: [Number], required: true }, // 0 = Sunday
    startTime: { type: String, required: true }, // HH:MM gym time
    durationMin: { type: Number, required: true },
    capacity: { type: Number, required: true, min: 1 },
    room: String,
    validFrom: { type: Date, required: true },
    validTo: Date, // empty = open-ended
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const ClassSchedule = mongoose.model('ClassSchedule', classScheduleSchema);

/** One concrete class on a date (generated from schedules, or created one-off). */
const classSessionSchema = new mongoose.Schema(
  {
    scheduleId: { type: ObjectId, ref: 'ClassSchedule' },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    classTypeId: { type: ObjectId, ref: 'ClassType', required: true },
    name: String, // snapshot of class type name
    color: String,
    trainerId: { type: ObjectId, ref: 'User' },
    room: String,
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    capacity: { type: Number, required: true, min: 1 },
    bookedCount: { type: Number, default: 0 },
    waitlistCount: { type: Number, default: 0 },
    status: { type: String, enum: ['scheduled', 'cancelled'], default: 'scheduled' },
    cancelReason: String,
  },
  { timestamps: true },
);
classSessionSchema.index({ scheduleId: 1, startsAt: 1 }, { unique: true, partialFilterExpression: { scheduleId: { $type: 'objectId' } } });
classSessionSchema.index({ branchId: 1, startsAt: 1 });
export const ClassSession = mongoose.model('ClassSession', classSessionSchema);

const bookingSchema = new mongoose.Schema(
  {
    sessionId: { type: ObjectId, ref: 'ClassSession', required: true },
    memberId: { type: ObjectId, ref: 'Member', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    status: { type: String, enum: ['booked', 'waitlisted', 'cancelled', 'attended', 'no-show'], required: true },
    waitlistedAt: Date,
    cancelledAt: Date,
    source: { type: String, enum: ['member', 'staff'], default: 'member' },
    bookedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
// A member has at most one live booking per class.
bookingSchema.index(
  { sessionId: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['booked', 'waitlisted', 'attended', 'no-show'] } } },
);
bookingSchema.index({ memberId: 1, createdAt: -1 });
bookingSchema.index({ sessionId: 1, status: 1, waitlistedAt: 1 });
export const Booking = mongoose.model('Booking', bookingSchema);
