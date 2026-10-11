/**
 * Autopay: Razorpay Subscriptions (UPI AutoPay / card e-mandate).
 * The member authorises once; every successful charge creates the next membership period automatically.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { calcTax } from '../../utils/money.js';
import { logger } from '../../config/logger.js';
import { rzp } from './razorpay.client.js';
import { Plan } from '../plans/plan.model.js';
import { Member } from '../members/member.model.js';
import { Company } from '../companies/company.model.js';
import { getGym } from '../settings/gym.model.js';
import { createSubscription } from '../subscriptions/subscription.service.js';
import { createAlert } from '../notifications/notification.service.js';

const { ObjectId } = mongoose.Schema.Types;

const autopaySchema = new mongoose.Schema(
  {
    memberId: { type: ObjectId, ref: 'Member', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    planId: { type: ObjectId, ref: 'Plan', required: true },
    amount: { type: Number, required: true }, // per charge, paise incl. GST
    rzpPlanId: String,
    rzpSubscriptionId: { type: String, unique: true, sparse: true },
    shortUrl: String,
    status: { type: String, enum: ['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed'], default: 'created' },
    chargedCount: { type: Number, default: 0 },
    lastChargedAt: Date,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
autopaySchema.index({ memberId: 1, status: 1 });
export const Autopay = mongoose.model('Autopay', autopaySchema);

// Each charged payment is applied once (webhooks can repeat).
const chargeSchema = new mongoose.Schema({ paymentId: { type: String, unique: true }, autopayId: ObjectId, subscriptionId: ObjectId }, { timestamps: true });
export const AutopayCharge = mongoose.model('AutopayCharge', chargeSchema);

const LIVE = ['created', 'authenticated', 'active', 'pending'];

/** Recurring amount: plan price, less the member's company discount, plus GST (no joining fee / coupons). */
async function recurringAmount(member, plan) {
  const gym = await getGym();
  const company = member.companyId ? await Company.findOne({ _id: member.companyId, isActive: true }).lean() : null;
  const taxable = plan.price - (company?.discountPercent ? Math.round((plan.price * company.discountPercent) / 100) : 0);
  return taxable + calcTax(taxable, plan.taxPercent ?? gym.taxPercent ?? 0);
}

export async function startAutopay({ member, planId, user }) {
  const plan = await Plan.findOne({ _id: planId, isDeleted: false, isActive: true });
  if (!plan) throw ApiError.notFound('Plan not available');
  if (plan.durationUnit !== 'month') throw ApiError.badRequest('Autopay is available for monthly-based plans only');
  if ((plan.maxMembers || 1) > 1) throw ApiError.badRequest('Autopay is not available for family plans');
  if (await Autopay.exists({ memberId: member._id, status: { $in: LIVE } })) throw ApiError.conflict('Autopay is already set up. Cancel it first to change the plan.');

  const amount = await recurringAmount(member, plan);
  const gym = await getGym();
  // Razorpay plans are fixed-amount: create one per (plan, amount) and remember it.
  let rzpPlanId = plan.razorpayPlans?.find((p) => p.amount === amount)?.id;
  if (!rzpPlanId) {
    const created = await rzp.request('POST', '/plans', {
      period: 'monthly',
      interval: plan.durationValue,
      item: { name: `${gym.name} - ${plan.name}`, amount, currency: 'INR' },
      notes: { planId: String(plan._id) },
    });
    rzpPlanId = created.id;
    await Plan.updateOne({ _id: plan._id }, { $push: { razorpayPlans: { id: rzpPlanId, amount } } });
  }
  const sub = await rzp.request('POST', '/subscriptions', {
    plan_id: rzpPlanId,
    total_count: Math.max(1, Math.floor(120 / plan.durationValue)), // up to 10 years
    customer_notify: 1,
    notes: { memberId: String(member._id), memberCode: String(member.memberCode), planId: String(plan._id) },
  });
  return Autopay.create({
    memberId: member._id,
    branchId: member.branchId,
    planId: plan._id,
    amount,
    rzpPlanId,
    rzpSubscriptionId: sub.id,
    shortUrl: sub.short_url,
    status: 'created',
    createdBy: user?._id,
  });
}

export async function cancelAutopay(autopay) {
  if (![...LIVE, 'halted', 'paused'].includes(autopay.status)) throw ApiError.badRequest('Autopay is not active');
  await rzp.request('POST', `/subscriptions/${autopay.rzpSubscriptionId}/cancel`, { cancel_at_cycle_end: 0 });
  autopay.status = 'cancelled';
  await autopay.save();
  return autopay;
}

/** Webhook handler for subscription.* events. Returns true if the event was handled. */
export async function handleSubscriptionEvent(evt) {
  const entity = evt.payload?.subscription?.entity;
  if (!entity?.id || !evt.event?.startsWith('subscription.')) return false;
  const autopay = await Autopay.findOne({ rzpSubscriptionId: entity.id });
  if (!autopay) return true;

  if (evt.event === 'subscription.charged') {
    const payment = evt.payload?.payment?.entity;
    if (!payment?.id) return true;
    try {
      await AutopayCharge.create({ paymentId: payment.id, autopayId: autopay._id });
    } catch (err) {
      if (err?.code === 11000) return true; // already applied
      throw err;
    }
    try {
      const r = await createSubscription({
        memberId: autopay.memberId,
        planId: autopay.planId,
        waiveJoiningFee: true,
        payment: { amount: Math.min(payment.amount, autopay.amount), mode: 'online', reference: payment.id, note: 'Autopay' },
      });
      await AutopayCharge.updateOne({ paymentId: payment.id }, { subscriptionId: r.subscription._id });
      autopay.status = 'active';
      autopay.chargedCount += 1;
      autopay.lastChargedAt = new Date();
      await autopay.save();
    } catch (err) {
      logger.error({ err, autopayId: autopay._id }, 'autopay charge could not be applied');
      await createAlert({
        branchId: autopay.branchId,
        memberId: autopay.memberId,
        template: 'autopay-failed',
        subject: 'Autopay charge received but membership not created',
        body: `Razorpay ${payment.id}: ${err.message}. Add the membership manually.`,
      });
    }
    return true;
  }

  const map = {
    'subscription.authenticated': 'authenticated',
    'subscription.activated': 'active',
    'subscription.pending': 'pending',
    'subscription.halted': 'halted',
    'subscription.paused': 'paused',
    'subscription.resumed': 'active',
    'subscription.cancelled': 'cancelled',
    'subscription.completed': 'completed',
  };
  if (map[evt.event]) {
    autopay.status = map[evt.event];
    await autopay.save();
    if (['halted', 'pending'].includes(autopay.status)) {
      const member = await Member.findById(autopay.memberId).select('name memberCode').lean();
      await createAlert({
        branchId: autopay.branchId,
        memberId: autopay.memberId,
        template: 'autopay-problem',
        subject: `Autopay ${autopay.status}: ${member?.name} (#${member?.memberCode})`,
        body: 'The bank declined the charge. Ask the member to update the mandate or pay at the desk.',
        dedupeKey: `autopay:${autopay._id}:${autopay.status}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
  return true;
}
