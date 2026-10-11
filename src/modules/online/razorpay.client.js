import crypto from 'node:crypto';
import { ApiError } from '../../utils/ApiError.js';

/**
 * Thin Razorpay REST client (no SDK). `rzp.request` can be replaced in tests.
 * Docs: https://razorpay.com/docs/api/
 */
const cfg = () => ({
  keyId: process.env.RAZORPAY_KEY_ID,
  keySecret: process.env.RAZORPAY_KEY_SECRET,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
});

export const razorpayEnabled = () => Boolean(cfg().keyId && cfg().keySecret);

export const rzp = {
  async request(method, path, body) {
    const { keyId, keySecret } = cfg();
    if (!keyId || !keySecret) throw new ApiError(503, 'Online payments are not configured');
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(502, `Payment gateway error: ${data?.error?.description || res.status}`);
    return data;
  },
};

export const createOrder = ({ amount, receipt, notes }) =>
  rzp.request('POST', '/orders', { amount, currency: 'INR', receipt, notes });

export const createPaymentLink = ({ amount, description, customer, notes, expireBy }) =>
  rzp.request('POST', '/payment_links', {
    amount,
    currency: 'INR',
    description,
    customer,
    notify: { sms: true, email: Boolean(customer.email) },
    reminder_enable: true,
    notes,
    ...(expireBy ? { expire_by: Math.floor(expireBy.getTime() / 1000) } : {}),
  });

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Checkout success handler signature: HMAC(order_id|payment_id, key_secret) */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const { keySecret } = cfg();
  if (!keySecret || !signature) return false;
  return safeEqual(hmac(keySecret, `${orderId}|${paymentId}`), String(signature));
}

/** Webhook signature: HMAC(raw body, webhook secret) */
export function verifyWebhookSignature(rawBody, signature) {
  const { webhookSecret } = cfg();
  if (!webhookSecret || !signature) return false;
  return safeEqual(hmac(webhookSecret, rawBody), String(signature));
}
