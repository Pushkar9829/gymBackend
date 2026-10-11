import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { formatINR } from '../../utils/money.js';
import { dmy } from '../../utils/dates.js';
import { getGym } from '../settings/gym.model.js';
import { Member } from '../members/member.model.js';
import { Invoice } from '../invoices/invoice.model.js';
import { Payment } from '../payments/payment.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { invoicePdf, receiptPdf } from '../invoices/invoice.pdf.js';
import { sendMemberEmail } from './notification.service.js';

/**
 * Runs email work without delaying the API response. Failures are only logged.
 * In tests it is awaited so results are deterministic.
 */
export async function inBackground(label, fn) {
  const run = () => fn().catch((err) => logger.error({ err, label }, 'background email failed'));
  if (env.isTest) return run();
  setImmediate(run);
}

const fileName = (no) => `${no.replace(/\//g, '-')}.pdf`;

async function enabledGym() {
  const gym = await getGym();
  return gym.settings?.sendEmails === false ? null : gym;
}

export async function sendWelcomeEmail(memberId) {
  const gym = await enabledGym();
  const member = gym && (await Member.findById(memberId).lean());
  if (!member) return;
  await sendMemberEmail({
    member,
    template: 'welcome',
    dedupeKey: `welcome:${member._id}`,
    subject: `Welcome to ${gym.name}!`,
    text: [
      `Hi ${member.name},`,
      '',
      `Welcome to ${gym.name}. Your member code is ${member.memberCode}.`,
      'Use this code at the biometric scanner after your fingerprint/face is enrolled at the reception.',
      'Entry is allowed only while your membership is active, so please renew on time.',
      '',
      `See you at the gym!`,
      gym.name,
    ].join('\n'),
  });
}

export async function sendInvoiceEmail(invoiceId) {
  const gym = await enabledGym();
  const invoice = gym && (await Invoice.findById(invoiceId).lean());
  if (!invoice) return;
  const [member, sub] = await Promise.all([Member.findById(invoice.memberId).lean(), Subscription.findById(invoice.subscriptionId).lean()]);
  if (!member?.email) return;
  const pdf = await invoicePdf(invoice, { paid: sub?.paidAmount || 0, due: sub?.dueAmount || 0 });
  await sendMemberEmail({
    member,
    template: 'invoice',
    dedupeKey: `invoice:${invoice._id}`,
    subject: `${gym.name}: invoice ${invoice.invoiceNo}`,
    text: [
      `Hi ${member.name},`,
      '',
      `Thank you! Your ${sub?.plan?.name || ''} membership is valid from ${dmy(sub.startDate)} to ${dmy(sub.endDate)}.`,
      `Invoice total: ${formatINR(invoice.total)} · Paid: ${formatINR(sub?.paidAmount)} · Due: ${formatINR(sub?.dueAmount)}`,
      '',
      'The invoice is attached.',
      gym.name,
    ].join('\n'),
    attachments: [{ filename: fileName(invoice.invoiceNo), content: pdf }],
  });
}

export async function sendReceiptEmail(paymentId) {
  const gym = await enabledGym();
  const payment = gym && (await Payment.findById(paymentId).populate(['memberId', 'subscriptionId']).lean());
  if (!payment?.memberId?.email) return;
  const isRefund = payment.type === 'refund';
  const pdf = await receiptPdf(payment, gym);
  await sendMemberEmail({
    member: payment.memberId,
    template: isRefund ? 'refund-receipt' : 'receipt',
    dedupeKey: `receipt:${payment._id}`,
    subject: `${gym.name}: ${isRefund ? 'refund' : 'payment'} receipt ${payment.receiptNo}`,
    text: [
      `Hi ${payment.memberId.name},`,
      '',
      isRefund
        ? `We have refunded ${formatINR(payment.amount)} (${payment.mode.toUpperCase()}).`
        : `We have received ${formatINR(payment.amount)} (${payment.mode.toUpperCase()}). Remaining due: ${formatINR(payment.subscriptionId?.dueAmount)}.`,
      '',
      'The receipt is attached.',
      gym.name,
    ].join('\n'),
    attachments: [{ filename: fileName(payment.receiptNo), content: pdf }],
  });
}
