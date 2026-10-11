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
