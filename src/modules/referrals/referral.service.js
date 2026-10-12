import crypto from 'node:crypto';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../config/logger.js';
import { addDays, dayjs, dmy, startOfDay, tz, ymd } from '../../utils/dates.js';
import { Referral } from './referral.model.js';
import { Member } from '../members/member.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Payment } from '../payments/payment.model.js';
import { getGym } from '../settings/gym.model.js';
import { phoneMatcher } from '../trials/trial.service.js';
import { extendMembership } from '../subscriptions/subscription.service.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { audit } from '../audit/audit.model.js';

export const REFERRAL_DEFAULTS = { enabled: true, rewardDays: 15, newMemberDiscountPercent: 0, maxPerYear: 12 };
export const referralSettings = (settings = {}) => ({ ...REFERRAL_DEFAULTS, ...(settings.referral || {}) });

const REVOKE_WINDOW_DAYS = 7;
// No 0/O or 1/I: codes are read out loud and typed on phones.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const firstName = (name = '') => String(name).trim().split(/\s+/)[0] || '';
/** "Rahul S." - enough for a friend to recognise who invited them. */
export const shortName = (name = '') => {
  const [a, b] = String(name).trim().split(/\s+/);
  return b ? `${a} ${b[0].toUpperCase()}.` : a || '';
};

/** The member's own referral code, created on first use (existing members get one the first time they need it). */
export async function ensureReferralCode(member) {
  if (member.referralCode) return member.referralCode;
  if (member.isTrial || member.isDeleted) return null;
  for (let i = 0; i < 8; i += 1) {
    const code = Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
    try {
      const r = await Member.updateOne({ _id: member._id, referralCode: null }, { $set: { referralCode: code } });
      if (r.modifiedCount) return code;
      const now = await Member.findById(member._id).select('referralCode').lean();
      if (now?.referralCode) return now.referralCode; // set at the same moment by another request
    } catch (err) {
      if (err?.code !== 11000) throw err; // taken: try another code
    }
  }
  throw new Error('Could not create a referral code');
}

/**
 * Finds and checks the referrer for a new member (by member id or code). Throws a clear message when not allowed.
 * `phone` / `memberId` are the new member's, to refuse self-referral.
 */
export async function resolveReferrer({ code, referrerId, phone, memberId, settings }) {
  if (!referralSettings(settings).enabled) throw ApiError.badRequest('Referrals are switched off');
  let referrer;
  if (referrerId) referrer = await Member.findOne({ _id: referrerId, isDeleted: false }).lean();
  else {
    const c = normalizeCode(code);
    if (!c) throw ApiError.badRequest('Enter a referral code');
    referrer = await Member.findOne({ referralCode: c, isDeleted: false }).lean();
  }
  if (!referrer) throw ApiError.badRequest('Referral code not found');
  if (referrer.isTrial) throw ApiError.badRequest('Trial visitors cannot refer friends yet');
  if (memberId && String(referrer._id) === String(memberId)) throw ApiError.badRequest('A member cannot refer themselves');
  if (phone && phoneMatcher(phone).test(String(referrer.phone || '').replace(/\D/g, ''))) {
    throw ApiError.badRequest('The referrer has the same phone number');
  }
  return referrer;
}

/** Links a new member to their referrer. Only before the member's first membership. */
export async function attachReferral({ member, referrer, source = 'desk', user, settings }) {
  if (member.referredBy) throw ApiError.conflict('This member already has a referrer');
  if (member.isTrial) throw ApiError.badRequest('Convert the trial visitor to a member first');
  if (String(referrer._id) === String(member._id)) throw ApiError.badRequest('A member cannot refer themselves');
  if (phoneMatcher(member.phone).test(String(referrer.phone || '').replace(/\D/g, ''))) throw ApiError.badRequest('The referrer has the same phone number');
  if (await Subscription.exists({ memberId: member._id })) throw ApiError.badRequest('A referral can be added only before the first membership');
  settings = settings || (await getGym()).settings;
  await Member.updateOne({ _id: member._id }, { referredBy: referrer._id });
  member.referredBy = referrer._id;
  return Referral.create({
    referrerId: referrer._id,
    referredId: member._id,
    branchId: member.branchId,
    code: referrer.referralCode,
    source,
    rewardDays: referralSettings(settings).rewardDays,
    createdBy: user?._id,
  });
}

/** The referrer's running membership, else the next upcoming one. */
async function rewardTarget(memberId) {
  const today = ymd(new Date());
  const subs = await Subscription.find({ memberId, status: 'active', endDate: { $gte: startOfDay() } }).sort({ startDate: 1 }).lean();
  return subs.find((s) => ymd(s.startDate) <= today) || subs[0] || null;
}

/**
 * Gives the referrer their free days for one referral (claimed from `from` so it can never run twice).
 * Ends as rewarded, waiting (no membership to extend), capped or skipped.
 */
async function grantReward(referralId, from) {
  const ref = await Referral.findOneAndUpdate({ _id: referralId, status: from }, { $set: { status: 'processing' } }, { returnDocument: 'after' });
  if (!ref) return null;
  const finish = (status, extra = {}) => Referral.findByIdAndUpdate(ref._id, { status, ...extra }, { returnDocument: 'after' }).lean();
  try {
    const gym = await getGym();
    const cfg = referralSettings(gym.settings);
    const days = ref.rewardDays ?? cfg.rewardDays;
    if (!cfg.enabled || !days) return finish('skipped', { note: 'Referral rewards are switched off' });
    const referrer = await Member.findOne({ _id: ref.referrerId, isDeleted: false }).lean();
    if (!referrer) return finish('skipped', { note: 'The referrer is no longer a member' });

    const yearStart = dayjs().tz(tz).startOf('year').toDate();
    const given = await Referral.countDocuments({ referrerId: referrer._id, status: 'rewarded', rewardedAt: { $gte: yearStart } });
    if (given >= cfg.maxPerYear) return finish('capped', { note: `Limit of ${cfg.maxPerYear} reward(s) a year reached` });

    const target = await rewardTarget(referrer._id);
    if (!target) return finish('waiting', { note: 'Days will be added to their next membership' });

    const friend = await Member.findById(ref.referredId).select('name memberCode').lean();
    const { subscription } = await extendMembership({ subscriptionId: target._id, days, reason: `Referral reward: ${friend?.name || 'friend'} joined`, referralId: ref._id });
    const done = await finish('rewarded', { rewardDays: days, rewardSubscriptionId: target._id, rewardedAt: new Date() });
    await notifyMember({
      member: referrer,
      gym,
      template: 'referral_reward',
      vars: { friend: firstName(friend?.name), days, date: dmy(subscription.endDate) },
      dedupeKey: `referral:${ref._id}`,
    });
    await audit(null, 'referral.reward', { entity: 'Referral', entityId: ref._id, branchId: referrer.branchId, details: { referrerId: referrer._id, referredId: ref.referredId, days, subscriptionId: target._id } });
    return done;
  } catch (err) {
    await Referral.updateOne({ _id: ref._id, status: 'processing' }, { status: from });
    throw err;
  }
}

/** Called when a membership payment is recorded: the friend's first paid membership qualifies the referral. */
export async function onMembershipPaid(sub) {
  if (!sub || sub.groupOf) return null;
  const ref = await Referral.findOneAndUpdate(
    { referredId: sub.memberId, status: 'pending' },
    { $set: { qualifiedAt: new Date(), qualifyingSubscriptionId: sub._id } },
    { returnDocument: 'after' },
  );
  if (!ref) return null;
  return grantReward(ref._id, 'pending');
}

/** A referrer who was owed days (no membership at the time) gets them on their new membership. */
export async function applyWaitingRewards(memberId) {
  const waiting = await Referral.find({ referrerId: memberId, status: 'waiting' }).select('_id').lean();
  const out = [];
  for (const r of waiting) out.push(await grantReward(r._id, 'waiting'));
  return out;
}

/**
 * Takes the reward back when the friend's first membership is cancelled and refunded within 7 days of paying.
 * Called after a cancellation and after a refund (whichever happens second decides).
 */
export async function maybeRevokeReferral(subscriptionId) {
  const ref = await Referral.findOne({ qualifyingSubscriptionId: subscriptionId, status: { $in: ['rewarded', 'waiting'] } }).lean();
  if (!ref) return null;
  const sub = await Subscription.findById(subscriptionId).lean();
  if (!sub || sub.status !== 'cancelled' || !sub.cancelledAt) return null;
  if (sub.cancelledAt > addDays(ref.qualifiedAt, REVOKE_WINDOW_DAYS)) return null;
  if (!(await Payment.exists({ subscriptionId, type: 'refund' }))) return null;

  const claimed = await Referral.findOneAndUpdate(
    { _id: ref._id, status: ref.status },
    { status: 'revoked', revokedAt: new Date(), note: `Friend's first membership was cancelled and refunded within ${REVOKE_WINDOW_DAYS} days` },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) return null;
  if (ref.status === 'rewarded' && ref.rewardSubscriptionId) {
    const target = await Subscription.findOne({ _id: ref.rewardSubscriptionId, status: 'active' }).lean();
    if (target) {
      try {
        await extendMembership({ subscriptionId: target._id, days: -(ref.rewardDays || 0), reason: 'Referral reward taken back (friend cancelled)', referralId: ref._id });
      } catch (err) {
        logger.error({ err, referralId: ref._id }, 'referral reward could not be taken back');
      }
    }
  }
  await audit(null, 'referral.revoke', { entity: 'Referral', entityId: ref._id, branchId: ref.branchId, details: { subscriptionId, days: ref.rewardDays } });
  return claimed;
}
