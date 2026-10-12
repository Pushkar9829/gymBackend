import { Member } from '../modules/members/member.model.js';
import { Subscription } from '../modules/subscriptions/subscription.model.js';
import { Lead } from '../modules/leads/lead.model.js';
import { User } from '../modules/users/user.model.js';
import { Payment } from '../modules/payments/payment.model.js';
import { Attendance } from '../modules/attendance/attendance.model.js';
import { AccessLog } from '../modules/access/accessLog.model.js';
import { DeviceCommand } from '../modules/devices/device.model.js';
import { Branch } from '../modules/branches/branch.model.js';
import { CashClosing } from '../modules/cash/cash.model.js';
import { DiscountApproval } from '../modules/approvals/approval.model.js';
import { getGym } from '../modules/settings/gym.model.js';
import { refreshMember } from '../modules/members/member.state.js';
import { sendMemberEmail, createAlert } from '../modules/notifications/notification.service.js';
import { sendEmail } from '../modules/notifications/mailer.js';
import { notifyMember } from '../modules/messaging/messaging.service.js';
import { sendClassReminders } from '../modules/classes/class.service.js';
import { sendPtReminders } from '../modules/pt/ptBooking.service.js';
import { PrivateFile } from '../modules/uploads/privateFile.model.js';
import { equipmentServiceAlerts } from '../modules/equipment/equipment.routes.js';
import { lockerAlerts } from '../modules/lockers/locker.routes.js';
import { OnlinePayment } from '../modules/online/onlinePayment.model.js';
import { startOfDay, addDays, ymd, dmy, dayjs, tz } from '../utils/dates.js';
import { formatINR } from '../utils/money.js';
import { logger } from '../config/logger.js';

/**
 * Runs once a day (Render Cron Job, ~00:05 IST). Safe to run more than once:
 * every step is idempotent (dedupe keys / state hashes).
 */
export async function runDailyJob({ now = new Date() } = {}) {
  const gym = await getGym();
  const settings = gym.settings || {};
  const today = startOfDay(now);
  const report = { members: 0, devicesQueued: 0, reminders: 0, expiredEmails: 0, birthdays: 0, followUpAlerts: 0 };

  // 1. Re-evaluate every member: status (active -> expired, freeze start/end) + device enable/disable.
  for await (const m of Member.find({ isDeleted: false }).lean().cursor()) {
    try {
      await refreshMember(m, { now, settings });
      report.members += 1;
    } catch (err) {
      logger.error({ err, memberId: m._id }, 'daily: member refresh failed');
    }
  }

  const emailsOn = settings.sendEmails !== false;
  // Email (if enabled) + SMS/WhatsApp (channels switched on in settings). Returns true if anything was sent.
  const tell = async ({ member, email, message }) => {
    const mail = emailsOn ? await sendMemberEmail({ member, ...email }) : null;
    const msgs = await notifyMember({ member, gym, ...message });
    return Boolean(mail || msgs.length);
  };

  // 2. Renewal reminders (e.g. 7 / 3 / 1 days before the end date), skipped if already renewed.
  for (const d of settings.reminderDays || []) {
    const target = addDays(today, d);
    const subs = await Subscription.find({ status: 'active', endDate: { $gte: target, $lt: addDays(target, 1) } }).lean();
    for (const s of subs) {
      const renewed = await Subscription.exists({ memberId: s.memberId, status: 'active', startDate: { $gt: s.startDate } });
      if (renewed) continue;
      const member = await Member.findOne({ _id: s.memberId, isDeleted: false }).lean();
      if (!member) continue;
      const key = `renewal-${d}:${s._id}`;
      const sent = await tell({
        member,
        email: {
          template: 'renewal-reminder',
          dedupeKey: key,
          subject: `${gym.name}: your membership ends on ${dmy(s.endDate)}`,
          text: `Hi ${member.name},\n\nYour ${s.plan.name} membership ends on ${dmy(s.endDate)}${d === 0 ? ' (today)' : ` (in ${d} day(s))`}. After that, entry at the gym will not be allowed.\nPlease renew at the reception or in the member app to continue without a break.\n\n${gym.name}`,
        },
        message: { template: 'renewal_reminder', vars: { plan: s.plan.name, date: dmy(s.endDate) }, dedupeKey: key },
      });
      if (sent) report.reminders += 1;
    }
  }

  // 3. "Membership expired" message the day after the end date (only when not renewed).
  const yesterday = addDays(today, -1);
  const ended = await Subscription.find({ status: 'active', endDate: { $gte: yesterday, $lt: today } }).lean();
  for (const s of ended) {
    const renewed = await Subscription.exists({ memberId: s.memberId, status: 'active', startDate: { $gt: s.startDate } });
    if (renewed) continue;
    const member = await Member.findOne({ _id: s.memberId, isDeleted: false }).lean();
    if (!member) continue;
    const key = `expired:${s._id}`;
    const sent = await tell({
      member,
      email: {
        template: 'membership-expired',
        dedupeKey: key,
        subject: `${gym.name}: your membership has expired`,
        text: `Hi ${member.name},\n\nYour ${s.plan.name} membership ended on ${dmy(s.endDate)}. Gym entry is now disabled.\nRenew at the reception or in the member app to get access back immediately.\n\n${gym.name}`,
      },
      message: { template: 'membership_expired', vars: { date: dmy(s.endDate) }, dedupeKey: key },
    });
    if (sent) report.expiredEmails += 1;
  }

  // 4. Birthday wishes
  const md = dayjs(today).tz(tz).format('MM-DD');
  const bdays = await Member.aggregate([
    { $match: { isDeleted: false, isTrial: { $ne: true }, dob: { $ne: null }, membershipStatus: { $in: ['active', 'frozen'] } } },
    { $match: { $expr: { $eq: [{ $dateToString: { format: '%m-%d', date: '$dob', timezone: tz } }, md] } } },
  ]);
  for (const member of bdays) {
    const key = `bday:${member._id}:${dayjs(today).tz(tz).year()}`;
    const sent = await tell({
      member,
      email: {
        template: 'birthday',
        dedupeKey: key,
        subject: `Happy Birthday from ${gym.name}!`,
        text: `Hi ${member.name},\n\nWishing you a very happy birthday and a strong year ahead!\n\n${gym.name}`,
      },
      message: { template: 'birthday', dedupeKey: key },
    });
    if (sent) report.birthdays += 1;
  }

  // 4b. Reminders for today's booked classes (SMS/WhatsApp when switched on)
  report.classReminders = await sendClassReminders({ now, gym });
  report.ptReminders = await sendPtReminders({ now, gym });
  report.equipmentAlerts = await equipmentServiceAlerts({ now });
  report.lockers = await lockerAlerts({ now });

  // 5. Follow-up alert per branch
  const due = await Lead.aggregate([
    { $match: { isDeleted: false, status: { $in: ['new', 'contacted', 'trial'] }, nextFollowUpAt: { $lt: addDays(today, 1) } } },
    { $group: { _id: '$branchId', n: { $sum: 1 } } },
  ]);
  for (const b of due) {
    const a = await createAlert({
      branchId: b._id,
      template: 'follow-ups',
      subject: `${b.n} lead follow-up(s) due today`,
      body: 'Open Leads > Follow-ups due',
      dedupeKey: `followups:${b._id}:${ymd(today)}`,
    });
    if (a) report.followUpAlerts += 1;
  }

  // 6. Housekeeping: unpaid online-join orders, old finished device commands
  const expired = await OnlinePayment.updateMany({ kind: 'join', status: 'created', expiresAt: { $lt: now } }, { status: 'expired' });
  report.joinOrdersExpired = expired.modifiedCount;
  await DeviceCommand.deleteMany({ status: { $in: ['done', 'superseded'] }, updatedAt: { $lt: addDays(today, -30) } });
  // Progress photos uploaded but never saved with a note.
  await PrivateFile.deleteMany({ attached: false, createdAt: { $lt: addDays(now, -1) } });

  // 7. Owner summary email for yesterday
  if (emailsOn) await sendOwnerSummary(gym, yesterday, today);

  logger.info({ report }, 'daily job finished');
  return report;
}

async function sendOwnerSummary(gym, from, to) {
  const owners = await User.find({ role: 'owner', isActive: true }).select('email').lean();
  if (!owners.length) return;
  const [collected, checkins, denied, expiring, branches, closings, pendingApprovals] = await Promise.all([
    Payment.aggregate([{ $match: { type: 'payment', paidAt: { $gte: from, $lt: to } } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
    Attendance.countDocuments({ day: ymd(from), isTrial: { $ne: true } }),
    AccessLog.countDocuments({ result: 'deny', at: { $gte: from, $lt: to } }),
    Member.countDocuments({ isDeleted: false, isTrial: { $ne: true }, membershipStatus: 'active', membershipEnd: { $gte: to, $lt: addDays(to, 7) } }),
    Branch.find({ isActive: { $ne: false } }).select('name').lean(),
    CashClosing.find({ day: ymd(from) }).lean(),
    DiscountApproval.countDocuments({ status: 'pending' }),
  ]);
  const shortLimit = gym.settings?.cashShortAlert ?? 10000;
  // Day closing per branch: shortages above the alert limit are flagged.
  const cashLines = branches.map((b) => {
    const c = closings.find((x) => String(x.branchId) === String(b._id));
    if (!c || c.status !== 'closed') return `  ${b.name}: not closed`;
    if (!c.difference) return `  ${b.name}: closed, cash matched`;
    const flag = c.difference < 0 && -c.difference > shortLimit ? ' (!)' : '';
    return `  ${b.name}: ${c.difference < 0 ? 'SHORT' : 'excess'} ${formatINR(Math.abs(c.difference))}${flag} - ${c.note || ''}`;
  });
  const text = [
    `Daily summary for ${dmy(from)}`,
    '',
    `Collections: ${formatINR(collected[0]?.v || 0)}`,
    `Check-ins: ${checkins}`,
    `Entries denied: ${denied}`,
    `Memberships ending in next 7 days: ${expiring}`,
    `Discount approvals waiting: ${pendingApprovals}`,
    '',
    'Cash closing:',
    ...cashLines,
  ].join('\n');
  for (const o of owners) {
    try {
      await sendEmail({ to: o.email, subject: `${gym.name} - daily summary ${dmy(from)}`, text });
    } catch (err) {
      logger.error({ err }, 'owner summary email failed');
    }
  }
}
