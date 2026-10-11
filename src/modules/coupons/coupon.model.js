import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: String,
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 1 }, // percent (1-100) or paise
    maxDiscount: { type: Number, min: 0 }, // paise cap for percent coupons
    validFrom: Date,
    validTo: Date,
    maxUses: { type: Number, min: 1 },
    usedCount: { type: Number, default: 0 },
    planIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Plan' }], // empty = all plans
    newMembersOnly: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Coupon = mongoose.model('Coupon', couponSchema);
