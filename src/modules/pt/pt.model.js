import mongoose from 'mongoose';

/** PT package template, e.g. "12 sessions in 60 days". */
const ptPackageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sessions: { type: Number, required: true, min: 1 },
    validityDays: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 }, // paise, pre-tax
    taxPercent: { type: Number, min: 0, max: 50 },
    description: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const PtPackage = mongoose.model('PtPackage', ptPackageSchema);

/** A package sold to a member, with its own billing (same fields as a membership). */
const ptPurchaseSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'PtPackage', required: true },
    package: { name: String, sessions: Number, validityDays: Number, price: Number },
    sessionsTotal: { type: Number, required: true },
    sessionsUsed: { type: Number, default: 0 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true }, // last valid day
    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    cancelReason: String,

    price: Number,
    discount: { type: Number, default: 0 },
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
ptPurchaseSchema.index({ memberId: 1, createdAt: -1 });
ptPurchaseSchema.index({ trainerId: 1, status: 1 });
export const PtPurchase = mongoose.model('PtPurchase', ptPurchaseSchema);

/** One training session taken from a purchase. */
const ptSessionSchema = new mongoose.Schema(
  {
    ptPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PtPurchase', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    at: { type: Date, required: true },
    status: { type: String, enum: ['done', 'no-show'], default: 'done' }, // both consume a session
    notes: String,
    // Trainer's share for this session (paise), fixed at the time it was logged.
    commission: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
ptSessionSchema.index({ trainerId: 1, at: -1 });
ptSessionSchema.index({ ptPurchaseId: 1, at: -1 });
export const PtSession = mongoose.model('PtSession', ptSessionSchema);
