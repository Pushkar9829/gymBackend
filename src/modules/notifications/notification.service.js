import { Notification } from './notification.model.js';
import { sendEmail } from './mailer.js';
import { logger } from '../../config/logger.js';

/** Staff dashboard alert. dedupeKey prevents repeats (e.g. one alert per member per day). */
export async function createAlert({ branchId, memberId, template, subject, body, dedupeKey }) {
  try {
    return await Notification.create({ channel: 'inapp', branchId, memberId, template, subject, body, status: 'sent', sentAt: new Date(), dedupeKey });
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/** Queues + sends an email exactly once per dedupeKey. */
export async function sendMemberEmail({ member, template, subject, text, dedupeKey, attachments }) {
  if (!member?.email) return null;
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
