import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * One friend referred by a member. The referrer gets free days once, after the friend's first paid membership.
 * status:
 *   pending  - friend has not paid for a membership yet
 *   waiting  - friend paid, but the referrer has no running / upcoming membership: the days go on their next one
 *   rewarded - days added to the referrer's membership
 *   capped   - not rewarded: the referrer already got the most rewards allowed this year
 *   skipped  - not rewarded: referral rewards were switched off (or the referrer left)
 *   revoked  - friend's first membership was cancelled and refunded within 7 days (days taken back)
 */
export const REFERRAL_STATUS = ['pending', 'processing', 'waiting', 'rewarded', 'capped', 'skipped', 'revoked'];

const referralSchema = new mongoose.Schema(
  {
    referrerId: { type: ObjectId, ref: 'Member', required: true },
    referredId: { type: ObjectId, ref: 'Member', required: true, unique: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true }, // the friend's branch
    code: String,
    source: { type: String, enum: ['desk', 'online'], default: 'desk' },
    status: { type: String, enum: REFERRAL_STATUS, default: 'pending' },
    rewardDays: Number,
    qualifiedAt: Date, // first payment on the friend's membership
    qualifyingSubscriptionId: { type: ObjectId, ref: 'Subscription' },
    rewardSubscriptionId: { type: ObjectId, ref: 'Subscription' }, // referrer's membership that got the days
    rewardedAt: Date,
    revokedAt: Date,
    note: String,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
referralSchema.index({ referrerId: 1, status: 1, rewardedAt: -1 });
referralSchema.index({ branchId: 1, createdAt: -1 });
referralSchema.index({ qualifyingSubscriptionId: 1 });

export const Referral = mongoose.model('Referral', referralSchema);
