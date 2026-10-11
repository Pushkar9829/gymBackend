/**
 * SMS / WhatsApp providers. Chosen by env:
 *   SMS_PROVIDER      = log | msg91 | twilio
 *   WHATSAPP_PROVIDER = log | interakt | twilio
 * "log" (default) only records the message, which is what local development and tests use.
 */
import { logger } from '../../config/logger.js';

const env = (k) => process.env[k];

/** In-memory log of messages sent with the "log" provider (useful in dev and tests). */
export const devOutbox = [];

const indianNumber = (phone) => {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
};

const parseMap = (k) => {
  try {
    return JSON.parse(env(k) || '{}');
  } catch {
    return {};
  }
};

async function post(url, { headers, json, form }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text;
}

function logProvider(channel) {
  return async ({ to, template, text }) => {
    devOutbox.push({ channel, to, template, text, at: new Date() });
    if (devOutbox.length > 500) devOutbox.shift();
    logger.info({ channel, to, template, text }, `[${channel}:dev] not sent (provider = log)`);
    return { skipped: true };
  };
}

const twilio = (channel) => async ({ to, text }) => {
  const sid = env('TWILIO_ACCOUNT_SID');
  const from = channel === 'whatsapp' ? `whatsapp:${env('TWILIO_WHATSAPP_FROM')}` : env('TWILIO_SMS_FROM');
  const dest = `${channel === 'whatsapp' ? 'whatsapp:' : ''}+${indianNumber(to)}`;
  await post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64')}` },
    form: { To: dest, From: from, Body: text },
  });
  return { sent: true };
};

// MSG91 Flow API (DLT-approved templates). MSG91_TEMPLATES = {"otp":"<flow id>", "renewal_reminder":"<flow id>", ...}
async function msg91({ to, template, params }) {
  const flowId = parseMap('MSG91_TEMPLATES')[template];
  if (!flowId) throw new Error(`No MSG91 template mapped for "${template}"`);
  const recipient = { mobiles: indianNumber(to) };
  params.forEach((p, i) => (recipient[`var${i + 1}`] = p));
  await post('https://control.msg91.com/api/v5/flow/', {
    headers: { authkey: env('MSG91_AUTH_KEY') },
    json: { template_id: flowId, short_url: '0', recipients: [recipient] },
  });
  return { sent: true };
}

// Interakt WhatsApp templates. INTERAKT_TEMPLATES = {"renewal_reminder":"renewal_reminder_v1", ...}
async function interakt({ to, template, params }) {
  const name = parseMap('INTERAKT_TEMPLATES')[template];
  if (!name) throw new Error(`No WhatsApp template mapped for "${template}"`);
  await post('https://api.interakt.ai/v1/public/message/', {
    headers: { Authorization: `Basic ${env('INTERAKT_API_KEY')}` },
    json: {
      countryCode: '+91',
      phoneNumber: indianNumber(to).slice(-10),
      type: 'Template',
      template: { name, languageCode: 'en', bodyValues: params },
    },
  });
  return { sent: true };
}

export function smsProvider() {
  switch (env('SMS_PROVIDER')) {
    case 'msg91':
      return msg91;
    case 'twilio':
      return twilio('sms');
    default:
      return logProvider('sms');
  }
}

export function whatsappProvider() {
  switch (env('WHATSAPP_PROVIDER')) {
    case 'interakt':
      return interakt;
    case 'twilio':
      return twilio('whatsapp');
    default:
      return logProvider('whatsapp');
  }
}
