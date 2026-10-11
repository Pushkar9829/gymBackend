import mongoose from 'mongoose';

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank', 'online'];

const paymentSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    type: { type: String, enum: ['payment', 'refund'], default: 'payment' },
    amount: { type: Number, required: true, min: 1 }, // paise, always positive
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    reference: String,
    note: String,
    paidAt: { type: Date, default: Date.now },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    refundOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  },
  { timestamps: true },
);

paymentSchema.index({ branchId: 1, paidAt: -1 });
paymentSchema.index({ memberId: 1, paidAt: -1 });

export const Payment = mongoose.model('Payment', paymentSchema);
