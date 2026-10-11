import mongoose from 'mongoose';

export const EXPENSE_CATEGORIES = [
  'rent', 'electricity', 'salary', 'maintenance', 'equipment', 'marketing', 'water', 'internet', 'cleaning', 'other',
];

const expenseSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 1 }, // paise
    date: { type: Date, required: true },
    mode: { type: String, enum: ['cash', 'upi', 'card', 'bank'], default: 'cash' },
    note: String,
    billUrl: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

expenseSchema.index({ branchId: 1, date: -1 });

export const Expense = mongoose.model('Expense', expenseSchema);
