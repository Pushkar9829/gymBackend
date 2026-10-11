import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

let transporter;
function getTransporter() {
  if (transporter !== undefined) return transporter;
  transporter = env.mail.host
    ? nodemailer.createTransport({
        host: env.mail.host,
        port: env.mail.port,
        secure: env.mail.port === 465,
        auth: env.mail.user ? { user: env.mail.user, pass: env.mail.pass } : undefined,
      })
    : null;
  return transporter;
}

/** Sends an email. Without SMTP config (local dev/tests) the email is only logged. */
export async function sendEmail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    logger.info({ to, subject, text }, '[mail:dev] email not sent (SMTP not configured)');
    return { skipped: true };
  }
  await t.sendMail({ from: env.mail.from, to, subject, text, html, attachments });
  return { sent: true };
}
