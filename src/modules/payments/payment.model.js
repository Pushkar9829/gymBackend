import mongoose from 'mongoose';

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank', 'online'];

const paymentSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // Exactly one of these: what the money is for.
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
    ptPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PtPurchase' },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    trialFee: { type: Boolean, default: undefined }, // fee for a trial pass (no membership / package)
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

paymentSchema.pre('validate', function requireBill() {
  if (this.trialFee) return;
  if (!this.subscriptionId === !this.ptPurchaseId) this.invalidate('subscriptionId', 'Payment must belong to a membership or a PT package');
});

paymentSchema.index({ branchId: 1, paidAt: -1 });
paymentSchema.index({ memberId: 1, paidAt: -1 });

export const Payment = mongoose.model('Payment', paymentSchema);
