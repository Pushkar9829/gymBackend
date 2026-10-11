import mongoose from 'mongoose';

const freezeSchema = new mongoose.Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true }, // inclusive
    days: { type: Number, required: true },
    reason: String,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    endedEarlyAt: Date,
  },
  { timestamps: true },
);

const subscriptionSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    // Plan snapshot so later plan edits never change this membership or its bill.
    plan: {
      name: String,
      durationValue: Number,
      durationUnit: String,
      price: Number,
      freezeDaysAllowed: Number,
      maxFreezes: Number,
      accessStart: String, // HH:MM, time-slot plans (e.g. morning only)
      accessEnd: String,
      deviceTimezoneId: Number,
    },
    type: { type: String, enum: ['new', 'renewal', 'upgrade'], default: 'new' },
    startDate: { type: Date, required: true }, // start of first day (gym tz)
    endDate: { type: Date, required: true }, // start of last valid day (inclusive)
    originalEndDate: Date,
    freezes: [freezeSchema],
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    cancelledAt: Date,
    cancelReason: String,

    // Billing (paise)
    price: Number,
    joiningFee: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    couponCode: String,
    taxPercent: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    dueAmount: { type: Number, default: 0 },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

subscriptionSchema.index({ memberId: 1, startDate: 1 });
subscriptionSchema.index({ branchId: 1, endDate: 1, status: 1 });
subscriptionSchema.index({ dueAmount: 1 });

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
