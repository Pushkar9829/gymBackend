import mongoose from 'mongoose';

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: String, required: true, unique: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    items: [{ description: String, amount: Number }],
    subTotal: Number,
    discount: { type: Number, default: 0 },
    taxPercent: Number,
    taxAmount: Number,
    total: Number,
    issuedAt: { type: Date, default: Date.now },
    // Snapshot of who/what was billed.
    billedTo: { name: String, phone: String, email: String, memberCode: Number, address: String },
    seller: { name: String, gstin: String, address: String, phone: String, email: String, branchName: String },
  },
  { timestamps: true },
);

export const Invoice = mongoose.model('Invoice', invoiceSchema);
