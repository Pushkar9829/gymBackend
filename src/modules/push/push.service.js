/**
 * Web Push for the member app (VAPID). Off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.
 * `pushClient.send` is the only call that reaches a push service; tests replace it.
 */
import mongoose from 'mongoose';
import webpush from 'web-push';
import { logger } from '../../config/logger.js';
import { Notification } from '../notifications/notification.model.js';

const pushSubscriptionSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    ua: String,
    lastSuccessAt: Date,
    failures: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

const cfg = () => ({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || 'mailto:no-reply@example.com',
});

export const pushConfigured = () => Boolean(cfg().publicKey && cfg().privateKey);
export const vapidPublicKey = () => (pushConfigured() ? cfg().publicKey : null);
/** Keys set on the server and the gym's "Push notifications" switch on. */
export const pushOn = (gym) => pushConfigured() && gym?.settings?.channels?.push !== false;

// Browsers' push services only: the server never posts to any other address a client sends.
const PUSH_HOSTS = ['.googleapis.com', '.mozilla.com', '.push.apple.com', '.notify.windows.com'];
export function isPushEndpoint(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => `.${u.hostname}`.endsWith(h));
  } catch {
    return false;
  }
}

export const pushClient = {
  async send(subscription, payload) {
    const { publicKey, privateKey, subject } = cfg();
    return webpush.sendNotification(subscription, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL: 24 * 3600 });
  },
};

// Short title and the app page each message opens.
const PUSH_META = {
  welcome: { title: 'Welcome!', url: '/portal' },
  renewal_reminder: { title: 'Membership ending soon', url: '/portal/renew' },
  membership_expired: { title: 'Membership expired', url: '/portal/renew' },
  payment_received: { title: 'Payment received', url: '/portal/history' },
  birthday: { title: 'Happy birthday!', url: '/portal' },
  class_reminder: { title: 'Class today', url: '/portal/classes' },
  feedback_update: { title: 'Update on your ticket', url: '/portal/feedback' },
  locker_reminder: { title: 'Locker renewal', url: '/portal' },
  pt_reminder: { title: 'PT session today', url: '/portal/pt' },
  freeze_update: { title: 'Freeze request', url: '/portal/freeze' },
  miss_you: { title: 'We miss you!', url: '/portal' },
  referral_reward: { title: 'Free days added', url: '/portal/invite' },
};

/** Sends one message to every device the member turned notifications on for. Once per dedupeKey. */
export async function sendPush({ member, template, text, gym, dedupeKey }) {
  const subs = await PushSubscription.find({ memberId: member._id }).lean();
  if (!subs.length) return null;
  const meta = PUSH_META[template] || { title: gym?.name || 'Gym', url: '/portal' };
  let n;
  try {
    n = await Notification.create({
      channel: 'push',
      template,
      memberId: member._id,
      branchId: member.branchId,
      to: `${subs.length} device(s)`,
      subject: meta.title,
      body: text,
      dedupeKey: dedupeKey ? `${dedupeKey}:push` : undefined,
    });
  } catch (err) {
    if (err?.code === 11000) return null; // already sent
    throw err;
  }
  const payload = JSON.stringify({ title: meta.title, body: text, url: meta.url, tag: template });
  let sent = 0;
  let lastError;
  for (const s of subs) {
    try {
      await pushClient.send({ endpoint: s.endpoint, keys: s.keys }, payload);
      sent += 1;
      await PushSubscription.updateOne({ _id: s._id }, { lastSuccessAt: new Date(), failures: 0 });
    } catch (err) {
      // 404 / 410: the browser dropped this subscription (app removed, permission revoked).
      if ([404, 410].includes(err?.statusCode)) await PushSubscription.deleteOne({ _id: s._id });
      else await PushSubscription.updateOne({ _id: s._id }, { $inc: { failures: 1 } });
      lastError = err;
      logger.warn({ statusCode: err?.statusCode, template }, 'push not delivered');
    }
  }
  n.status = sent ? 'sent' : 'failed';
  n.sentAt = new Date();
  if (!sent && lastError) n.error = String(lastError.body || lastError.message || lastError.statusCode).slice(0, 300);
  await n.save();
  return n;
}
