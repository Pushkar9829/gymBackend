import mongoose from 'mongoose';

export const SLOT_LENGTHS = [30, 45, 60, 90];

/** A trainer's weekly PT hours and time off. One document per trainer. */
const ptAvailabilitySchema = new mongoose.Schema(
  {
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    slotMin: { type: Number, enum: SLOT_LENGTHS, default: 60 },
    weekly: [
      {
        _id: false,
        day: { type: Number, min: 0, max: 6, required: true }, // 0 = Sunday
        start: { type: String, required: true }, // HH:MM gym time
        end: { type: String, required: true },
        branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
      },
    ],
    // Blocked periods (leave, holidays, a dentist visit): no slots overlapping these.
    timeOff: [
      {
        from: { type: Date, required: true },
        to: { type: Date, required: true },
        note: String,
      },
    ],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const PtAvailability = mongoose.model('PtAvailability', ptAvailabilitySchema);

export const PT_BOOKING_STATUSES = ['booked', 'done', 'no-show', 'cancelled'];

/** A PT slot booked against a member's package. "Mark done" logs a PtSession through the normal session logic. */
const ptBookingSchema = new mongoose.Schema(
  {
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    ptPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PtPurchase', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD gym time
    status: { type: String, enum: PT_BOOKING_STATUSES, default: 'booked' },
    source: { type: String, enum: ['member', 'staff'], default: 'member' },
    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // staff who booked on the member's behalf
    // "<trainerId>:<startsAt ISO>" while the booking holds the slot; removed on cancel. Unique: no double booking.
    slotKey: { type: String },
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ['member', 'staff'] },
    cancelledByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelReason: String,
    lateCancel: Boolean, // cancelled by staff after the member's cut-off
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PtSession' },
    markedAt: Date,
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { timestamps: true },
);
ptBookingSchema.index({ slotKey: 1 }, { unique: true, sparse: true });
ptBookingSchema.index({ trainerId: 1, startsAt: 1 });
ptBookingSchema.index({ memberId: 1, day: 1 });
ptBookingSchema.index({ ptPurchaseId: 1, status: 1 });
ptBookingSchema.index({ branchId: 1, startsAt: 1 });
export const PtBooking = mongoose.model('PtBooking', ptBookingSchema);
