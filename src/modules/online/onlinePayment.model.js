import mongoose from 'mongoose';

/**
 * A Razorpay order or payment link and what to do once it is paid.
 * kind:
 *   due     - pay the pending due of an existing membership
 *   renewal - member bought a plan from the portal; the membership is created only after payment
 *   link    - payment link sent by staff for an existing membership's due
 */
const onlinePaymentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['due', 'renewal', 'link'], required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
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
    error: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const OnlinePayment = mongoose.model('OnlinePayment', onlinePaymentSchema);
