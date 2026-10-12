/**
 * Message templates for SMS and WhatsApp.
 * - `text` is used for providers that accept free text (Twilio SMS, dev log).
 * - `vars` is the ordered variable list for DLT SMS (MSG91) and WhatsApp template providers (Interakt);
 *   create templates with the same variable order in the provider dashboard and map their IDs/names in env.
 */
export const TEMPLATES = {
  otp: {
    vars: (v) => [v.otp],
    text: (v) => `${v.otp} is your ${v.gym} login code. It expires in 5 minutes. Do not share it.`,
  },
  welcome: {
    vars: (v) => [v.name, v.gym, v.memberCode],
    text: (v) => `Hi ${v.name}, welcome to ${v.gym}! Your member code is ${v.memberCode}.`,
  },
  renewal_reminder: {
    vars: (v) => [v.name, v.plan, v.date, v.gym],
    text: (v) => `Hi ${v.name}, your ${v.plan} membership at ${v.gym} ends on ${v.date}. Renew to keep gym access.`,
  },
  membership_expired: {
    vars: (v) => [v.name, v.date, v.gym],
    text: (v) => `Hi ${v.name}, your ${v.gym} membership ended on ${v.date}. Gym entry is disabled until you renew.`,
  },
  payment_received: {
    vars: (v) => [v.name, v.amount, v.receipt, v.gym],
    text: (v) => `Hi ${v.name}, we received ${v.amount} (receipt ${v.receipt}). Thank you - ${v.gym}`,
  },
  birthday: {
    vars: (v) => [v.name, v.gym],
    text: (v) => `Happy birthday ${v.name}! Wishing you a strong year ahead - ${v.gym}`,
  },
  class_reminder: {
    vars: (v) => [v.name, v.className, v.time, v.gym],
    text: (v) => `Hi ${v.name}, reminder: ${v.className} at ${v.time} today - ${v.gym}`,
  },
  feedback_update: {
    vars: (v) => [v.name, v.ticket, v.status, v.gym],
    text: (v) => `Hi ${v.name}, your ${v.gym} ticket ${v.ticket} ${v.status}. Open the member app to see it.`,
  },
  locker_reminder: {
    vars: (v) => [v.name, v.locker, v.date, v.gym],
    text: (v) => `Hi ${v.name}, your locker ${v.locker} at ${v.gym} is paid till ${v.date}. Please renew at the desk or empty it.`,
  },
  pt_reminder: {
    vars: (v) => [v.name, v.trainer, v.time, v.gym],
    text: (v) => `Hi ${v.name}, reminder: personal training with ${v.trainer} at ${v.time} today - ${v.gym}`,
  },
  freeze_update: {
    vars: (v) => [v.name, v.dates, v.status, v.gym],
    text: (v) => `Hi ${v.name}, your ${v.gym} freeze request for ${v.dates} ${v.status}. Open the member app to see it.`,
  },
  miss_you: {
    vars: (v) => [v.name, v.days, v.gym],
    text: (v) => `Hi ${v.name}, we have not seen you at ${v.gym} for ${v.days} days. Your membership is active - come back and keep your streak going!`,
  },
  announcement: {
    vars: (v) => [v.name, v.text],
    text: (v) => v.text,
  },
};

export function renderTemplate(name, vars) {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`Unknown message template ${name}`);
  return { text: t.text(vars), params: t.vars(vars).map((x) => String(x ?? '')) };
}
