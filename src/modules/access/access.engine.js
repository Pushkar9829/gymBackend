import { addDays, dmy, ymd, diffDays, parseDay, dayjs, tz } from '../../utils/dates.js';
import { waiverBlocksEntry } from '../waivers/waiver.rules.js';

/**
 * Single source of truth for "may this member enter?".
 * Used by biometric device sync, device punches, QR and manual check-in.
 *
 * Pure function: give it the member, ALL of their subscriptions and gym settings.
 *
 * Returns:
 *  allowed            - may enter right now
 *  code / reason      - why (reason is shown to staff and in access logs)
 *  membershipStatus   - none | upcoming | active | frozen | expired | cancelled
 *  current            - subscription covering today (or null)
 *  window             - { from, to } contiguous validity (to includes grace days) or null
 *  device             - { enabled, validFrom, validTo } desired state on the biometric device
 *  daysLeft           - days until membership end (0 = last day)
 */
export function computeAccess({ member, subscriptions = [], settings = {}, now = new Date() }) {
  const result = membershipAccess({ member, subscriptions, settings, now });
  // Signed waiver required (Settings > Waiver): checked last, so a membership problem is shown first.
  if (!waiverBlocksEntry(member, settings)) return result;
  const device = { ...result.device, enabled: false };
  if (!result.allowed) return { ...result, device };
  return { ...result, allowed: false, code: 'WAIVER_REQUIRED', reason: 'Waiver not signed - sign it in the member app or at reception', daysLeft: null, device };
}

function membershipAccess({ member, subscriptions, settings, now }) {
  const graceDays = Number(settings.graceDays || 0);
  const today = ymd(now);

  const subs = subscriptions
    .filter((s) => s.status !== 'cancelled')
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  const hasCancelledOnly = subs.length === 0 && subscriptions.some((s) => s.status === 'cancelled');

  // Subscription that covers today (ignoring grace first, then with grace).
  let current = subs.find((s) => ymd(s.startDate) <= today && today <= ymd(s.endDate)) || null;
  let inGrace = false;
  if (!current && graceDays > 0) {
    current = subs.find((s) => ymd(s.endDate) < today && today <= ymd(addDays(s.endDate, graceDays))) || null;
    inGrace = Boolean(current);
  }
  const upcoming = current ? null : subs.find((s) => ymd(s.startDate) > today) || null;

  const window = buildWindow(subs, current || upcoming, graceDays);
  const chain = window ? subs.filter((s) => ymd(s.startDate) >= ymd(window.from) && ymd(s.startDate) <= ymd(window.to)) : [];
  const chainDue = chain.reduce((sum, s) => sum + (s.dueAmount || 0), 0);

  const frozen = current ? activeFreeze(current, today) : null;

  let membershipStatus = 'none';
  if (current) membershipStatus = frozen ? 'frozen' : 'active';
  else if (upcoming) membershipStatus = 'upcoming';
  else if (subs.length) membershipStatus = 'expired';
  else if (hasCancelledOnly) membershipStatus = 'cancelled';

  const base = { membershipStatus, current, window, inGrace, dueAmount: chainDue };
  const slotPlan = (current || upcoming)?.plan;
  const timezoneId = slotPlan?.deviceTimezoneId || 1;
  const deny = (code, reason, deviceEnabled = false) => ({
    ...base,
    allowed: false,
    code,
    reason,
    daysLeft: null,
    device: deviceState(deviceEnabled, window, timezoneId),
  });

  if (member?.isBlocked) {
    return deny('BLOCKED', `Access blocked${member.blockReason ? `: ${member.blockReason}` : ''} - contact reception`);
  }
  if (member?.isTrial) return trialAccess(member, now);
  if (membershipStatus === 'none') return deny('NO_MEMBERSHIP', 'No active membership');
  if (membershipStatus === 'cancelled') return deny('CANCELLED', 'Membership cancelled');
  if (membershipStatus === 'expired') {
    const last = subs[subs.length - 1];
    return deny('EXPIRED', `Membership expired on ${dmy(last.endDate)}`);
  }
  const duesBlocked = settings.blockOnDues && chainDue > 0;
  if (membershipStatus === 'upcoming') {
    // Device stays enabled with a future start date, so it opens automatically on day one.
    return deny('NOT_STARTED', `Membership starts on ${dmy(upcoming.startDate)}`, !duesBlocked);
  }
  if (frozen) return deny('FROZEN', `Membership frozen until ${dmy(frozen.to)}`);
  if (duesBlocked) return deny('DUES', `Payment due Rs. ${(chainDue / 100).toFixed(2)}`);
  if (slotPlan?.accessStart && slotPlan?.accessEnd) {
    const t = dayjs(now).tz(tz).format('HH:mm');
    // Device stays enabled: it enforces the slot through its access time-zone.
    if (t < slotPlan.accessStart || t >= slotPlan.accessEnd) return deny('OUTSIDE_HOURS', `Your plan allows entry ${slotPlan.accessStart}-${slotPlan.accessEnd}`, true);
  }

  const lastDay = addDays(window.to, -graceDays);
  const daysLeft = Math.max(0, diffDays(now, lastDay));
  return {
    ...base,
    allowed: true,
    code: inGrace ? 'GRACE' : 'OK',
    reason: inGrace
      ? `Grace period - membership ended on ${dmy(lastDay)}`
      : `Welcome! ${daysLeft === 0 ? 'Membership ends today' : `${daysLeft} day(s) left`}`,
    daysLeft,
    device: deviceState(true, window, timezoneId),
  };
}

/**
 * Trial / guest pass: entry on the pass days only, no grace, no time slot.
 * membershipStatus stays 'none' so membership counts and lists never include trial visitors.
 */
function trialAccess(member, now) {
  const t = member.trial || {};
  const today = ymd(now);
  const window = t.from && t.to ? { from: parseDay(t.from), to: parseDay(t.to) } : null;
  let trialStatus = 'active';
  if (!window || t.endedAt || today > ymd(t.to)) trialStatus = 'ended';
  else if (today < ymd(t.from)) trialStatus = 'upcoming';
  const base = { membershipStatus: 'none', trialStatus, current: null, window, inGrace: false, dueAmount: 0 };
  if (trialStatus === 'ended') {
    const last = t.endedAt && (!t.to || ymd(t.endedAt) <= ymd(t.to)) ? t.endedAt : t.to;
    return { ...base, allowed: false, code: 'TRIAL_ENDED', reason: last ? `Trial ended on ${dmy(last)}` : 'Trial ended', daysLeft: null, device: deviceState(false, window) };
  }
  if (trialStatus === 'upcoming') {
    // Like an upcoming membership: on the device with a future start date.
    return { ...base, allowed: false, code: 'TRIAL_NOT_STARTED', reason: `Trial pass starts on ${dmy(t.from)}`, daysLeft: null, device: deviceState(true, window) };
  }
  const daysLeft = Math.max(0, diffDays(now, window.to));
  return { ...base, allowed: true, code: 'TRIAL', reason: `Trial pass valid till ${dmy(t.to)}`, daysLeft, device: deviceState(true, window) };
}

/** Extends the validity window through back-to-back renewals so the device needs no update on renewal day. */
function buildWindow(subs, anchor, graceDays) {
  if (!anchor) return null;
  const from = parseDay(anchor.startDate);
  let to = parseDay(anchor.endDate);
  for (const s of subs) {
    if (ymd(s.startDate) <= ymd(anchor.startDate)) continue;
    if (ymd(s.startDate) <= ymd(addDays(to, 1))) {
      if (ymd(s.endDate) > ymd(to)) to = parseDay(s.endDate);
    }
  }
  return { from, to: graceDays ? addDays(to, graceDays) : to };
}

function activeFreeze(sub, today) {
  return (
    (sub.freezes || []).find((f) => {
      const end = f.endedEarlyAt ? addDays(f.endedEarlyAt, -1) : f.to;
      return ymd(f.from) <= today && today <= ymd(end);
    }) || null
  );
}

function deviceState(enabled, window, timezoneId = 1) {
  return { enabled: Boolean(enabled && window), validFrom: window?.from || null, validTo: window?.to || null, timezoneId };
}

export const DENY_CODES = ['BLOCKED', 'NO_MEMBERSHIP', 'CANCELLED', 'EXPIRED', 'NOT_STARTED', 'FROZEN', 'DUES', 'OUTSIDE_HOURS', 'TRIAL_ENDED', 'TRIAL_NOT_STARTED', 'WAIVER_REQUIRED'];
