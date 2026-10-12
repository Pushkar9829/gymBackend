import mongoose from 'mongoose';

export const FREEZE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

/** A member asks (in the app) to freeze their membership; reception / a manager approves or rejects it. */
const freezeRequestSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    from: { type: Date, required: true }, // first frozen day
    days: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    status: { type: String, enum: FREEZE_REQUEST_STATUSES, default: 'pending' },
    // = subscriptionId while pending (unique), so a membership has at most one pending request.
    pendingKey: { type: String },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: String,
    // What was actually frozen (staff may move the dates when approving).
    approvedFrom: Date,
    approvedDays: Number,
    cancelledAt: Date,
  },
  { timestamps: true },
);
freezeRequestSchema.index({ pendingKey: 1 }, { unique: true, sparse: true });
freezeRequestSchema.index({ branchId: 1, status: 1, createdAt: -1 });
freezeRequestSchema.index({ memberId: 1, createdAt: -1 });
export const FreezeRequest = mongoose.model('FreezeRequest', freezeRequestSchema);
