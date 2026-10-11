import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const LOCKER_SECTIONS = ['common', 'men', 'women'];

const lockerSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true, trim: true }, // "L12"
    section: { type: String, enum: LOCKER_SECTIONS, default: 'common' },
    monthlyFee: { type: Number, min: 0, default: 0 }, // paise
    // 'occupied' is set while an allotment is active; 'maintenance' blocks allotting.
    status: { type: String, enum: ['available', 'occupied', 'maintenance'], default: 'available' },
    allotmentId: { type: ObjectId, ref: 'LockerAllotment' }, // current one
    notes: String,
  },
  { timestamps: true },
);
lockerSchema.index({ branchId: 1, number: 1 }, { unique: true });
export const Locker = mongoose.model('Locker', lockerSchema);

// Money taken for a locker: rent is income; the deposit is held and returned on release.
const chargeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['rent', 'deposit', 'deposit-return'], required: true },
    amount: { type: Number, required: true, min: 0 }, // paise
    mode: { type: String, enum: ['cash', 'upi', 'card', 'bank'] },
    reference: String,
    receiptNo: String,
    from: Date, // rent period
    to: Date,
    at: { type: Date, default: Date.now },
    by: { type: ObjectId, ref: 'User' },
  },
  { _id: false },
);

const allotmentSchema = new mongoose.Schema(
  {
    lockerId: { type: ObjectId, ref: 'Locker', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    memberId: { type: ObjectId, ref: 'Member', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true }, // last day included
    deposit: { type: Number, default: 0 }, // paise held
    status: { type: String, enum: ['active', 'ended'], default: 'active' },
    charges: [chargeSchema],
    endedAt: Date,
    endedBy: { type: ObjectId, ref: 'User' },
    endNote: String,
    allottedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
allotmentSchema.index({ memberId: 1, status: 1 });
allotmentSchema.index({ branchId: 1, status: 1, endDate: 1 });
allotmentSchema.index({ 'charges.at': 1 });
export const LockerAllotment = mongoose.model('LockerAllotment', allotmentSchema);
