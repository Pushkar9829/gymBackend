import { Member } from '../members/member.model.js';
import { Lead } from '../leads/lead.model.js';
import { refreshMember } from '../members/member.state.js';
import { escapeRegex } from '../../utils/pagination.js';
import { addDays, startOfDay, ymd } from '../../utils/dates.js';

export const TRIAL_DEFAULTS = { enabled: true, defaultDays: 1, maxDays: 3, repeatDays: 90 };
export const trialSettings = (settings = {}) => ({ ...TRIAL_DEFAULTS, ...(settings.trial || {}) });

/** Matches a phone number on its last 10 digits, so "+91 98765 43210" and "9876543210" are the same person. */
export function phoneMatcher(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return new RegExp(`${escapeRegex(digits.slice(-10))}$`);
}

/** upcoming | active | ended | converted */
export function trialStatus(member, now = new Date()) {
  const t = member.trial || {};
  if (!member.isTrial) return t.convertedAt ? 'converted' : null;
  const today = ymd(now);
  if (t.endedAt || !t.to || ymd(t.to) < today) return 'ended';
  return ymd(t.from) > today ? 'upcoming' : 'active';
}

/** Mongo filter for a trial list tab. */
export function trialStatusFilter(status, now = new Date()) {
  const today = startOfDay(now);
  switch (status) {
    case 'active':
      return { isTrial: true, 'trial.endedAt': null, 'trial.from': { $lte: today }, 'trial.to': { $gte: today } };
    case 'upcoming':
      return { isTrial: true, 'trial.endedAt': null, 'trial.from': { $gt: today } };
    case 'ended':
      return { isTrial: true, $or: [{ 'trial.endedAt': { $ne: null } }, { 'trial.to': { $lt: today } }] };
    case 'converted':
      return { isTrial: { $ne: true }, 'trial.convertedAt': { $ne: null } };
    default:
      return { $or: [{ isTrial: true }, { 'trial.convertedAt': { $ne: null } }] };
  }
}

/** When was a trial last given to this phone number (deleted records count too, so deleting does not reset the rule)? */
export async function lastTrialFor(phone) {
  const prev = await Member.findOne({ phone: phoneMatcher(phone), 'trial.issuedAt': { $ne: null } }).sort({ 'trial.issuedAt': -1 }).select('trial name memberCode').lean();
  return prev?.trial?.issuedAt ? prev : null;
}

/** Earliest day a new trial may be given after `issuedAt`. */
export const nextTrialDay = (issuedAt, repeatDays) => startOfDay(addDays(issuedAt, repeatDays));

/**
 * Trial visitor becomes a member: same record (code, visits, device user, history), trial closed,
 * linked lead marked converted. A membership is added next from the member screen.
 */
export async function convertTrial(member, user) {
  const now = new Date();
  member.isTrial = false;
  member.trial.convertedAt = now;
  member.trial.convertedBy = user?._id;
  if (!member.trial.endedAt) member.trial.endedAt = now;
  member.joinedAt = now;
  await member.save();
  // Counts as a new member from today, not from the day the trial was issued.
  await Member.collection.updateOne({ _id: member._id }, { $set: { createdAt: now } });
  const leadFilter = member.trial.leadId ? { _id: member.trial.leadId } : { phone: phoneMatcher(member.phone), isDeleted: false, status: { $in: ['new', 'contacted', 'trial'] } };
  const lead = await Lead.findOne(leadFilter).sort({ createdAt: -1 });
  if (lead && lead.status !== 'converted') {
    lead.status = 'converted';
    lead.convertedMemberId = member._id;
    lead.nextFollowUpAt = null;
    await lead.save();
  }
  await refreshMember(member.toObject(), { force: true });
  return { member, lead };
}
