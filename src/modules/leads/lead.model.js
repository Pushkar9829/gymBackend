import mongoose from 'mongoose';

export const LEAD_STATUS = ['new', 'contacted', 'trial', 'converted', 'lost'];
export const LEAD_SOURCES = ['walk-in', 'phone', 'website', 'instagram', 'facebook', 'referral', 'other'];

const leadSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    source: { type: String, enum: LEAD_SOURCES, default: 'walk-in' },
    interestPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    notes: String,
    status: { type: String, enum: LEAD_STATUS, default: 'new' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    nextFollowUpAt: Date,
    followUps: [
      {
        at: { type: Date, default: Date.now },
        note: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    trialFrom: Date,
    trialTo: Date,
    convertedMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    lostReason: String,
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

leadSchema.index({ branchId: 1, status: 1, nextFollowUpAt: 1 });
leadSchema.index({ phone: 1 });

export const Lead = mongoose.model('Lead', leadSchema);
