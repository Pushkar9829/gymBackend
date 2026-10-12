/**
 * Join online from the public Join page: phone verified by OTP -> Razorpay order -> member + membership
 * created only after a verified payment (checkout callback or webhook, whichever comes first, applied once).
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { nextSeq } from '../../utils/counter.js';
import { formatINR } from '../../utils/money.js';
import { addDays, dmy, ymd } from '../../utils/dates.js';
import { razorpayEnabled, createOrder } from './razorpay.client.js';
import { OnlinePayment } from './onlinePayment.model.js';
import { Member } from '../members/member.model.js';
import { Plan } from '../plans/plan.model.js';
import { Branch } from '../branches/branch.model.js';
import { getGym } from '../settings/gym.model.js';
import { sendMessage } from '../messaging/messaging.service.js';
import { quoteSubscription, createSubscription } from '../subscriptions/subscription.service.js';
import { phoneMatcher, convertTrial } from '../trials/trial.service.js';
import { removeMemberFromDevices } from '../devices/device.sync.js';
import { resolveReferrer, attachReferral, referralSettings } from '../referrals/referral.service.js';
import { createAlert } from '../notifications/notification.service.js';
import { audit } from '../audit/audit.model.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const ORDER_TTL_MS = 30 * 60 * 1000;
const START_WITHIN_DAYS = 30;

const joinOtpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true },
);
joinOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const JoinOtp = mongoose.model('JoinOtp', joinOtpSchema);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Online joining needs Razorpay keys; without them the Join page shows only the enquiry form. */
export const onlineJoinEnabled = () => razorpayEnabled();
export function assertJoinEnabled() {
  if (!onlineJoinEnabled()) throw new ApiError(503, 'Joining online is not available. Please leave your number and we will call you.');
}

/** Indian numbers are kept as 10 digits (+91 / 91 prefix removed). */
export function cleanPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
}

const findMember = (phone) => Member.findOne({ phone: phoneMatcher(phone), isDeleted: false, isTrial: { $ne: true } }).select('name memberCode').lean();
const findTrial = (phone) => Member.findOne({ phone: phoneMatcher(phone), isDeleted: false, isTrial: true }).sort({ 'trial.issuedAt': -1 });

export async function sendJoinOtp(phone) {
  assertJoinEnabled();
  const recent = await JoinOtp.findOne({ phone, usedAt: null, createdAt: { $gt: new Date(Date.now() - RESEND_AFTER_MS) } });
  if (recent) throw new ApiError(429, 'Please wait 30 seconds before asking for another code');
  const otp = String(crypto.randomInt(100000, 1000000));
  await JoinOtp.deleteMany({ phone });
  await JoinOtp.create({ phone, otpHash: sha(`join:${phone}:${otp}`), expiresAt: new Date(Date.now() + OTP_TTL_MS) });
  const gym = await getGym();
  // Same rule as the member login code: WhatsApp when only WhatsApp is on, else SMS (logged in development).
  const channel = gym.settings?.channels?.whatsapp && !gym.settings?.channels?.sms ? 'whatsapp' : 'sms';
  await sendMessage({ to: phone, channel, template: 'otp', vars: { otp, gym: gym.name } });
  return { sent: true };
}

/**
 * Checks the code. Existing members are sent to the member app (no duplicate member);
 * new visitors and trial visitors get a short-lived token to place the order.
 */
export async function verifyJoinOtp(phone, otp) {
  assertJoinEnabled();
  const rec = await JoinOtp.findOne({ phone, usedAt: null });
  if (!rec || rec.expiresAt < new Date() || rec.attempts >= 5) throw ApiError.badRequest('Invalid or expired code');
  if (rec.otpHash !== sha(`join:${phone}:${otp}`)) {
    rec.attempts += 1;
    await rec.save();
    throw ApiError.badRequest('Invalid or expired code');
  }
  rec.usedAt = new Date();
  await rec.save();
  if (await findMember(phone)) return { status: 'member' };
  const trial = await findTrial(phone);
  const token = jwt.sign({ typ: 'join', phone }, env.jwtAccessSecret, { expiresIn: '30m' });
  return { status: trial ? 'trial' : 'new', token, name: trial?.name, email: trial?.email };
}

function readJoinToken(token) {
  try {
    const p = jwt.verify(String(token || ''), env.jwtAccessSecret);
    if (p.typ !== 'join' || !p.phone) throw new Error('wrong token');
    return p.phone;
  } catch {
    throw new ApiError(401, 'Please verify your phone number again');
  }
}

/** Price for a plan bought online (joining fee, coupon, referral discount, GST). */
export async function quoteJoin({ branchId, planId, couponCode, referralCode, phone }) {
  const gym = await getGym();
  const branch = mongoose.isValidObjectId(branchId) ? await Branch.findOne({ _id: branchId, isActive: true }).lean() : null;
  if (!branch) throw ApiError.badRequest('Choose a branch');
  const plan = mongoose.isValidObjectId(planId) ? await Plan.findOne({ _id: planId, isDeleted: false, isActive: true, sellOnline: true }).lean() : null;
  if (!plan) throw ApiError.badRequest('This plan cannot be bought online');
  if (plan.branchIds?.length && !plan.branchIds.map(String).includes(String(branch._id))) throw ApiError.badRequest('This plan is not available at the chosen branch');
  let referrer = null;
  if (referralCode && referralSettings(gym.settings).enabled) referrer = await resolveReferrer({ code: referralCode, phone, settings: gym.settings });
  // A new person: no memberships yet, so the joining fee and "new members only" coupons apply.
  const q = await quoteSubscription({ member: { _id: new mongoose.Types.ObjectId(), referredBy: referrer?._id }, plan, couponCode: couponCode || undefined, gym });
  return { q, plan, branch, referrer, gym };
}

export const quoteView = (q) => ({
  price: q.price,
  joiningFee: q.joiningFee,
  discount: q.discount,
  couponDiscount: q.couponDiscount,
  referralDiscount: q.referralDiscount,
  coupon: q.coupon ? { code: q.coupon.code } : null,
  taxPercent: q.taxPercent,
  taxAmount: q.taxAmount,
  totalAmount: q.totalAmount,
});

/** Creates the Razorpay order. Nothing else is created until the payment is verified. */
export async function startJoin({ token, body }) {
  assertJoinEnabled();
  const phone = readJoinToken(token);
  if (await findMember(phone)) throw new ApiError(409, 'This number is already a member. Log in to the member app to renew.', undefined, 'ALREADY_MEMBER');
  const today = ymd(new Date());
  const startDate = body.startDate || today;
  if (startDate < today) throw ApiError.badRequest('Start date cannot be in the past');
  if (startDate > ymd(addDays(new Date(), START_WITHIN_DAYS))) throw ApiError.badRequest(`Start within the next ${START_WITHIN_DAYS} days`);

  const { q, plan, referrer } = await quoteJoin({ ...body, phone });
  if (q.totalAmount < 100) throw ApiError.badRequest('Nothing to pay online for this plan. Please visit the gym.');
  const trial = await findTrial(phone);
  // A new order replaces this number's earlier unpaid ones.
  await OnlinePayment.updateMany({ kind: 'join', status: 'created', 'join.phone': phone }, { status: 'expired' });
  const op = await OnlinePayment.create({
    kind: 'join',
    branchId: body.branchId,
    planId: plan._id,
    couponCode: q.coupon?.code,
    amount: q.totalAmount,
    join: {
      phone,
      name: body.name,
      email: body.email,
      gender: body.gender,
      dob: body.dob,
      startDate,
      referrerId: referrer?._id,
      trialMemberId: trial?._id,
    },
    expiresAt: new Date(Date.now() + ORDER_TTL_MS),
  });
  const order = await createOrder({ amount: op.amount, receipt: `op_${String(op._id)}`.slice(0, 40), notes: { onlinePaymentId: String(op._id), kind: 'join', plan: plan.name } });
  op.orderId = order.id;
  await op.save();
  return { op, quote: q, plan };
}

/**
 * Applies a paid online join (called once, from completeOnlinePayment): member (or converted trial),
 * referral, membership with invoice + online payment, device access, welcome + invoice messages, staff alert.
 */
export async function applyJoin(op, { paid, gatewayPaymentId }) {
  const j = op.join || {};
  const existing = await findMember(j.phone);
  if (existing) throw ApiError.conflict(`Phone ${j.phone} already belongs to member #${existing.memberCode}`);

  let member;
  const trial = await findTrial(j.phone);
  if (trial) {
    const oldBranch = String(trial.branchId);
    ({ member } = await convertTrial(trial, null));
    Object.assign(member, { name: j.name || member.name, gender: j.gender || member.gender, dob: j.dob || member.dob, branchId: op.branchId, source: 'online', portalEnabled: true });
    if (j.email) member.email = j.email;
    await member.save();
    if (oldBranch !== String(op.branchId)) await removeMemberFromDevices(member, { branchId: oldBranch });
  } else {
    member = await Member.create({
      branchId: op.branchId,
      memberCode: await nextSeq('memberCode', 1001),
      name: j.name,
      phone: j.phone,
      email: j.email || undefined,
      gender: j.gender || undefined,
      dob: j.dob || undefined,
      source: 'online',
      portalEnabled: true, // logs in to the member app with an OTP
    });
  }

  if (j.referrerId) {
    const referrer = await Member.findOne({ _id: j.referrerId, isDeleted: false, isTrial: { $ne: true } }).lean();
    if (referrer && !member.referredBy) await attachReferral({ member, referrer, source: 'online' });
  }

  const plan = await Plan.findById(op.planId).lean();
  const q = await quoteSubscription({ member: await Member.findById(member._id).lean(), plan, couponCode: op.couponCode });
  const apply = Math.min(paid, q.totalAmount);
  const r = await createSubscription({
    memberId: member._id,
    planId: op.planId,
    startDate: j.startDate,
    couponCode: op.couponCode,
    payment: { amount: apply, mode: 'online', reference: gatewayPaymentId, note: 'Joined online' },
  });
  if (paid > apply) {
    await createAlert({
      branchId: member.branchId,
      memberId: member._id,
      template: 'online-overpaid',
      subject: `Online join paid Rs. ${((paid - apply) / 100).toFixed(2)} more than the price`,
      body: `Razorpay ${gatewayPaymentId}. Refund the extra amount from the Razorpay dashboard.`,
    });
  }
  const s = r.subscription;
  await createAlert({
    branchId: member.branchId,
    memberId: member._id,
    template: 'online-join',
    subject: `New online member: ${member.name} (#${member.memberCode})`,
    body: `${plan.name} ${dmy(s.startDate)} to ${dmy(s.endDate)} · paid ${formatINR(apply)} online${trial ? ' · trial pass converted' : ''}${j.referrerId ? ' · referred' : ''}`,
    dedupeKey: `online-join:${op._id}`,
  });
  await audit(null, 'member.join.online', { entity: 'Member', entityId: member._id, branchId: member.branchId, details: { onlinePaymentId: op._id, planId: op.planId, amount: apply, trial: Boolean(trial) } });
  return { memberId: member._id, paymentId: r.payment?._id, resultSubscriptionId: s._id };
}

/** What the success page shows. */
export async function joinResult(op) {
  const [member, sub] = await Promise.all([
    op.memberId ? Member.findById(op.memberId).select('name memberCode').lean() : null,
    op.resultSubscriptionId ? mongoose.model('Subscription').findById(op.resultSubscriptionId).select('plan.name startDate endDate totalAmount paidAmount').lean() : null,
  ]);
  return {
    status: op.status,
    member: member && { name: member.name, memberCode: member.memberCode },
    membership: sub && { plan: sub.plan?.name, startDate: sub.startDate, endDate: sub.endDate, paid: sub.paidAmount },
    appPath: '/portal/login',
  };
}
