import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../config/logger.js';
import { addDays } from '../../utils/dates.js';
import { OnlinePayment } from './onlinePayment.model.js';
import { createOrder, createPaymentLink } from './razorpay.client.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Plan } from '../plans/plan.model.js';
import { Member } from '../members/member.model.js';
import { getGym } from '../settings/gym.model.js';
import { createSubscription, quoteSubscription, recordPayment } from '../subscriptions/subscription.service.js';
import { refreshMember } from '../members/member.state.js';
import { createAlert } from '../notifications/notification.service.js';
import { inBackground, sendReceiptEmail } from '../notifications/emails.js';

const receipt = (op) => `op_${String(op._id)}`.slice(0, 40);

/** Member pays the pending due of a membership from the portal. */
export async function startDuePayment({ member, subscriptionId }) {
  const sub = await Subscription.findOne({ _id: subscriptionId, memberId: member._id, status: 'active' });
  if (!sub) throw ApiError.notFound('Membership not found');
  if (sub.dueAmount <= 0) throw ApiError.badRequest('Nothing is due on this membership');
  const op = await OnlinePayment.create({ kind: 'due', memberId: member._id, branchId: sub.branchId, subscriptionId: sub._id, amount: sub.dueAmount });
  const order = await createOrder({ amount: op.amount, receipt: receipt(op), notes: { onlinePaymentId: String(op._id), memberCode: String(member.memberCode) } });
  op.orderId = order.id;
  await op.save();
  return op;
}

/** Member buys / renews a plan from the portal. The membership is created only after payment. */
export async function startRenewal({ member, planId, couponCode }) {
  const plan = await Plan.findOne({ _id: planId, isDeleted: false, isActive: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not available');
  if (plan.branchIds?.length && !plan.branchIds.map(String).includes(String(member.branchId))) {
    throw ApiError.badRequest('This plan is not available at your branch');
  }
  const q = await quoteSubscription({ member, plan, couponCode });
  const op = await OnlinePayment.create({ kind: 'renewal', memberId: member._id, branchId: member.branchId, planId, couponCode: q.coupon?.code, amount: q.totalAmount });
  const order = await createOrder({ amount: op.amount, receipt: receipt(op), notes: { onlinePaymentId: String(op._id), memberCode: String(member.memberCode), plan: plan.name } });
  op.orderId = order.id;
  await op.save();
  return { op, quote: q, plan };
}

/** Staff sends a Razorpay payment link (SMS + email from Razorpay) for a membership due. */
export async function createDueLink({ subscription, user }) {
  if (subscription.status !== 'active' || subscription.dueAmount <= 0) throw ApiError.badRequest('Nothing is due on this membership');
  const member = await Member.findById(subscription.memberId).lean();
  const gym = await getGym();
  const op = await OnlinePayment.create({
    kind: 'link',
    memberId: member._id,
    branchId: subscription.branchId,
    subscriptionId: subscription._id,
    amount: subscription.dueAmount,
    createdBy: user?._id,
  });
  const link = await createPaymentLink({
    amount: op.amount,
    description: `${gym.name} - ${subscription.plan?.name} membership due`,
    customer: { name: member.name, contact: member.phone, ...(member.email ? { email: member.email } : {}) },
    notes: { onlinePaymentId: String(op._id), memberCode: String(member.memberCode) },
    expireBy: addDays(new Date(), 7),
  });
  op.paymentLinkId = link.id;
  op.shortUrl = link.short_url;
  await op.save();
  return op;
}

/**
 * Applies a successful gateway payment exactly once (checkout callback and webhook may both arrive).
 */
export async function completeOnlinePayment({ op, gatewayPaymentId, amount }) {
  const locked = await OnlinePayment.findOneAndUpdate(
    { _id: op._id, status: 'created' },
    { status: 'processing', gatewayPaymentId },
    { returnDocument: 'after' },
  );
  if (!locked) return OnlinePayment.findById(op._id).lean(); // already handled

  const paid = Number(amount ?? locked.amount);
  try {
    let paymentId;
    let resultSubscriptionId;
    if (locked.kind === 'renewal') {
      const r = await createSubscription({
        memberId: locked.memberId,
        planId: locked.planId,
        couponCode: locked.couponCode,
        payment: { amount: paid, mode: 'online', reference: gatewayPaymentId },
      });
      paymentId = r.payment?._id;
      resultSubscriptionId = r.subscription._id;
    } else {
      const sub = await Subscription.findById(locked.subscriptionId);
      const apply = Math.min(paid, sub?.status === 'active' ? sub.dueAmount : 0);
      if (apply > 0) {
        const r = await recordPayment({ sub, amount: apply, mode: 'online', reference: gatewayPaymentId });
        paymentId = r.payment._id;
      }
      if (apply < paid) {
        await createAlert({
          branchId: locked.branchId,
          memberId: locked.memberId,
          template: 'online-overpaid',
          subject: `Online payment higher than due by Rs. ${((paid - apply) / 100).toFixed(2)}`,
          body: `Razorpay ${gatewayPaymentId}. Refund the extra amount from the Razorpay dashboard.`,
        });
      }
      resultSubscriptionId = locked.subscriptionId;
      await refreshMember(locked.memberId);
    }
    const done = await OnlinePayment.findByIdAndUpdate(locked._id, { status: 'paid', paymentId, resultSubscriptionId }, { returnDocument: 'after' }).lean();
    if (paymentId && locked.kind !== 'renewal') await inBackground('receipt-email', () => sendReceiptEmail(paymentId));
    return done;
  } catch (err) {
    // Money was received but could not be applied: never lose it silently.
    logger.error({ err, onlinePaymentId: locked._id }, 'online payment could not be applied');
    await OnlinePayment.updateOne({ _id: locked._id }, { status: 'failed', error: String(err.message).slice(0, 300) });
    await createAlert({
      branchId: locked.branchId,
      memberId: locked.memberId,
      template: 'online-payment-failed',
      subject: 'Online payment received but not applied',
      body: `Razorpay ${gatewayPaymentId}: ${err.message}. Record it manually or refund.`,
    });
    throw err;
  }
}
