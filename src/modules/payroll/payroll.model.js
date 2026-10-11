import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

const lineSchema = new mongoose.Schema({ label: { type: String, required: true }, amount: { type: Number, required: true, min: 0 } }, { _id: false });

/** One staff member's pay for one month. Draft -> finalized -> paid. */
const payslipSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    branchId: { type: ObjectId, ref: 'Branch' },
    month: { type: String, required: true }, // YYYY-MM
    salaryType: { type: String, enum: ['monthly', 'per-day'], required: true },
    rate: { type: Number, required: true }, // paise: monthly salary or per-day rate
    workingDays: Number,
    daysPresent: Number,
    paidLeaveDays: { type: Number, default: 0 },
    basePay: { type: Number, required: true }, // after attendance proration
    ptCommission: { type: Number, default: 0 },
    ptSessions: { type: Number, default: 0 },
    additions: [lineSchema], // bonus, overtime...
    deductions: [lineSchema], // advance, PF, ESI, TDS...
    grossPay: Number,
    netPay: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
    paidAt: Date,
    paymentMode: { type: String, enum: ['cash', 'upi', 'bank'] },
    reference: String,
    expenseId: { type: ObjectId, ref: 'Expense' },
    notes: String,
  },
  { timestamps: true },
);
payslipSchema.index({ userId: 1, month: 1 }, { unique: true });
payslipSchema.index({ month: 1, branchId: 1 });

export const Payslip = mongoose.model('Payslip', payslipSchema);
