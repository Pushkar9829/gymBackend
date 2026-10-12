import { Notification } from '../notifications/notification.model.js';
import { getGym } from '../settings/gym.model.js';
import { logger } from '../../config/logger.js';
import { renderTemplate } from './templates.js';
import { smsProvider, whatsappProvider } from './providers.js';

const PROVIDERS = { sms: smsProvider, whatsapp: whatsappProvider };

/** Sends one SMS / WhatsApp message exactly once per dedupeKey and records it. */
export async function sendMessage({ to, member, channel, template, vars, dedupeKey }) {
  const phone = to || member?.phone;
  if (!phone) return null;
  const { text, params } = renderTemplate(template, vars);
  let n;
  try {
    n = await Notification.create({
      channel,
      template,
      memberId: member?._id,
      branchId: member?.branchId,
      to: phone,
      body: text,
      dedupeKey: dedupeKey ? `${dedupeKey}:${channel}` : undefined,
    });
  } catch (err) {
    if (err?.code === 11000) return null; // already sent
    throw err;
  }
  try {
    const r = await PROVIDERS[channel]()({ to: phone, template, text, params });
    n.status = r.skipped ? 'skipped' : 'sent';
    n.sentAt = new Date();
  } catch (err) {
    logger.error({ err, channel, template }, 'message failed');
    n.status = 'failed';
    n.error = String(err.message).slice(0, 300);
  }
  await n.save();
  return n;
}

/**
 * Sends a template to a member on every SMS / WhatsApp channel the gym has switched on.
 * `gym` may be passed to avoid re-reading settings in loops.
 */
export async function notifyMember({ member, template, vars = {}, dedupeKey, gym, channels }) {
  if (member?.isTrial) return []; // trial visitors are not on member messaging
  gym = gym || (await getGym());
  const on = channels || ['sms', 'whatsapp'].filter((c) => gym.settings?.channels?.[c]);
  const results = [];
  for (const channel of on) {
    results.push(await sendMessage({ member, channel, template, vars: { gym: gym.name, name: member.name, ...vars }, dedupeKey }));
  }
  return results.filter(Boolean);
}
