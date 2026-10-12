import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const APPROVAL_KINDS = ['subscription', 'pt', 'shop'];
export const APPROVAL_VALID_HOURS = 24;

/**
 * A receptionist's request to give more discount than the gym allows without approval.
 * Approved = single use, for the same member + item, within 24 hours, up to the approved amount.
 */
const discountApprovalSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    memberId: { type: ObjectId, ref: 'Member' }, // empty for a walk-in shop customer
    customerName: String,
    kind: { type: String, enum: APPROVAL_KINDS, required: true },
    itemKey: { type: String, required: true }, // plan:<id> | pt:<id> | shop:<product>x<qty>,...
    itemLabel: String,
    listPrice: { type: Number, required: true }, // paise, before discount and GST
    requestedDiscount: { type: Number, required: true, min: 1 },
    approvedDiscount: Number,
    reason: { type: String, required: true },
    requestedBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'used'], default: 'pending' },
    decidedBy: { type: ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: String,
    expiresAt: Date,
    usedAt: Date,
    usedBy: { type: ObjectId, ref: 'User' },
    usedOn: { entity: String, id: ObjectId },
  },
  { timestamps: true },
);
discountApprovalSchema.index({ branchId: 1, status: 1, createdAt: -1 });
discountApprovalSchema.index({ memberId: 1, kind: 1, status: 1 });
discountApprovalSchema.index({ requestedBy: 1, createdAt: -1 });

export const DiscountApproval = mongoose.model('DiscountApproval', discountApprovalSchema);
