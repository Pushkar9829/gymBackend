import mongoose from 'mongoose';

/**
 * A Razorpay order or payment link and what to do once it is paid.
 * kind:
 *   due     - pay the pending due of an existing membership
 *   renewal - member bought a plan from the portal; the membership is created only after payment
 *   link    - payment link sent by staff for an existing membership's due
 *   join    - a visitor joined online from the public Join page; member + membership are created only after payment
 */
const onlinePaymentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['due', 'renewal', 'link', 'join'], required: true },
    // Empty for an online join until the payment is applied (the member does not exist before that).
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: function needsMember() { return this.kind !== 'join'; } },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    couponCode: String,
    amount: { type: Number, required: true }, // paise
    orderId: { type: String, index: { unique: true, sparse: true } },
    paymentLinkId: { type: String, index: { unique: true, sparse: true } },
    shortUrl: String,
    status: { type: String, enum: ['created', 'processing', 'paid', 'failed', 'expired'], default: 'created' },
    gatewayPaymentId: { type: String, index: { unique: true, sparse: true } },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    resultSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
    // Online join: the visitor's details (phone verified by OTP before the order was made).
    join: {
      phone: String,
      name: String,
      email: String,
      gender: String,
      dob: Date,
      startDate: String, // YYYY-MM-DD
      referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
      trialMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' }, // trial pass to convert
    },
    expiresAt: Date, // unpaid join orders are marked expired after this
    error: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
onlinePaymentSchema.index({ kind: 1, status: 1, expiresAt: 1 });

export const OnlinePayment = mongoose.model('OnlinePayment', onlinePaymentSchema);
