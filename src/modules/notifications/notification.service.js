import { Notification } from './notification.model.js';
import { sendEmail } from './mailer.js';
import { logger } from '../../config/logger.js';

/** In-app alerts this staff member should see: for everyone, for their role, or addressed to them. */
export const audienceFilter = (req) => ({
  $and: [
    { $or: [{ roles: null }, { roles: { $size: 0 } }, { roles: req.user.role }] },
    { $or: [{ userIds: null }, { userIds: { $size: 0 } }, { userIds: req.user._id }] },
  ],
});

/** Staff dashboard alert. dedupeKey prevents repeats (e.g. one alert per member per day). `roles` / `userIds` limit who sees it. */
export async function createAlert({ branchId, memberId, template, subject, body, dedupeKey, roles, userIds }) {
  try {
    return await Notification.create({
      channel: 'inapp', branchId, memberId, template, subject, body, status: 'sent', sentAt: new Date(), dedupeKey,
      roles: roles?.length ? roles : undefined,
      userIds: userIds?.length ? userIds : undefined,
    });
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/** Queues + sends an email exactly once per dedupeKey. */
export async function sendMemberEmail({ member, template, subject, text, dedupeKey, attachments }) {
  if (!member?.email || member.isTrial) return null;
  let n;
  try {
    n = await Notification.create({ channel: 'email', template, memberId: member._id, branchId: member.branchId, to: member.email, subject, body: text, dedupeKey });
  } catch (err) {
    if (err?.code === 11000) return null; // already sent
    throw err;
  }
  try {
    const r = await sendEmail({ to: member.email, subject, text, attachments });
    n.status = r.skipped ? 'skipped' : 'sent';
    n.sentAt = new Date();
  } catch (err) {
    logger.error({ err, template }, 'email failed');
    n.status = 'failed';
    n.error = String(err.message).slice(0, 300);
  }
  await n.save();
  return n;
}
