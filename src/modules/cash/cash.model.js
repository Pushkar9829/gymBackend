import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const CASH_MODES = ['cash', 'upi', 'card', 'bank', 'online'];
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10];

const modeTotal = new mongoose.Schema({ in: { type: Number, default: 0 }, out: { type: Number, default: 0 }, count: { type: Number, default: 0 } }, { _id: false });

/** End-of-day cash count for one branch and one day. Closed = locked until an owner/manager reopens it. */
const cashClosingSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD gym time
    status: { type: String, enum: ['closed', 'reopened'], default: 'closed' },
    openingFloat: { type: Number, default: 0, min: 0 }, // paise in the drawer at the start of the day
    // What the system recorded, frozen at closing time (paise).
    system: {
      byMode: { cash: modeTotal, upi: modeTotal, card: modeTotal, bank: modeTotal, online: modeTotal },
      sources: [{ _id: false, key: String, label: String, mode: String, in: Number, out: Number, count: Number }],
    },
    cashIn: { type: Number, default: 0 },
    cashOut: { type: Number, default: 0 },
    expectedCash: { type: Number, default: 0 },
    countedCash: { type: Number, required: true, min: 0 },
    // Notes / coins counted: { n500: 3, n200: 0, ..., coins: 1500 (paise) }
    denominations: { n500: Number, n200: Number, n100: Number, n50: Number, n20: Number, n10: Number, coins: Number },
    difference: { type: Number, default: 0 }, // counted - expected; negative = short
    floatKept: { type: Number, default: 0, min: 0 }, // left in the drawer for tomorrow
    note: String,
    // Totals as per the bank / UPI / card statement, entered for matching (paise).
    statement: { upi: Number, card: Number, bank: Number, online: Number },
    closedBy: { type: ObjectId, ref: 'User' },
    closedAt: Date,
    closeCount: { type: Number, default: 1 },
    reopens: [{ _id: false, at: Date, by: { type: ObjectId, ref: 'User' }, byName: String, reason: String }],
    shortAlerted: { type: Boolean, default: false },
  },
  { timestamps: true },
);
cashClosingSchema.index({ branchId: 1, day: 1 }, { unique: true });
cashClosingSchema.index({ day: -1 });

export const CashClosing = mongoose.model('CashClosing', cashClosingSchema);
