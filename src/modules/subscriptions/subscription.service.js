import { ApiError } from '../../utils/ApiError.js';
import { calcTax } from '../../utils/money.js';
import { nextSeq, financialYear } from '../../utils/counter.js';
import { addDays, dayjs, diffDays, parseDay, startOfDay, tz, ymd } from '../../utils/dates.js';
import { Subscription } from './subscription.model.js';
import { Plan } from '../plans/plan.model.js';
import { Member } from '../members/member.model.js';
import { Branch } from '../branches/branch.model.js';
import { Invoice } from '../invoices/invoice.model.js';
import { Payment } from '../payments/payment.model.js';
import { getGym } from '../settings/gym.model.js';
import { refreshMember } from '../members/member.state.js';
import { inBackground, sendWelcomeEmail, sendInvoiceEmail } from '../notifications/emails.js';
import { evaluateCoupon, consumeCoupon } from '../coupons/coupon.service.js';
import { Coupon } from '../coupons/coupon.model.js';

/** Last valid day (inclusive) for a plan starting on `start`. */
export function computeEndDate(start, plan) {
  const s = dayjs(parseDay(start)).tz(tz);
  const end = plan.durationUnit === 'month' ? s.add(plan.durationValue, 'month') : s.add(plan.durationValue, 'day');
  return parseDay(end.subtract(1, 'day').toDate());
}

const liveSubs = (memberId) => Subscription.find({ memberId, status: 'active' }).sort({ startDate: 1 });

function assertNoOverlap(subs, start, end, ignoreId) {
  const clash = subs.find(
    (s) => String(s._id) !== String(ignoreId) && ymd(s.startDate) <= ymd(end) && ymd(start) <= ymd(s.endDate),
  );
  if (clash) {
    throw ApiError.conflict(
      `Dates overlap with ${clash.plan.name} (${ymd(clash.startDate)} to ${ymd(clash.endDate)}). Choose a start date after ${ymd(clash.endDate)}.`,
    );
  }
}

export async function nextInvoiceNo(gym, at = new Date()) {
  const fy = financialYear(at);
  const seq = await nextSeq(`invoice:${fy}`);
  return `${gym.invoicePrefix}/${fy}/${String(seq).padStart(5, '0')}`;
}

export async function nextReceiptNo(gym, at = new Date()) {
  const fy = financialYear(at);
  const seq = await nextSeq(`receipt:${fy}`);
  return `${gym.receiptPrefix}/${fy}/${String(seq).padStart(5, '0')}`;
}

async function createInvoice({ gym, member, sub, items }) {
  const branch = await Branch.findById(member.branchId).lean();
  return Invoice.create({
    invoiceNo: await nextInvoiceNo(gym),
    memberId: member._id,
    branchId: member.branchId,
    subscriptionId: sub._id,
    items,
    subTotal: sub.price + sub.joiningFee,
    discount: sub.discount,
    taxPercent: sub.taxPercent,
    taxAmount: sub.taxAmount,
    total: sub.totalAmount,
    billedTo: { name: member.name, phone: member.phone, email: member.email, memberCode: member.memberCode, address: member.address },
    seller: {
      name: gym.name,
      gstin: gym.gstin,
      address: branch?.address || gym.address,
      phone: branch?.phone || gym.phone,
      email: gym.email,
      branchName: branch?.name,
    },
  });
}

/**
 * Applies a payment to a subscription atomically (never lets paid exceed total).
 */
export async function recordPayment({ sub, amount, mode, reference, note, paidAt, user, gym, kind = 'subscription' }) {
  gym = gym || (await getGym());
  const { PtPurchase } = await import('../pt/pt.model.js');
  const Model = kind === 'pt' ? PtPurchase : Subscription;
  const updated = await Model.findOneAndUpdate(
    { _id: sub._id, status: 'active', dueAmount: { $gte: amount } },
    { $inc: { paidAmount: amount, dueAmount: -amount } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.badRequest(`Amount is more than the pending due, or the ${kind === 'pt' ? 'PT package' : 'membership'} is cancelled`);
  const payment = await Payment.create({
    receiptNo: await nextReceiptNo(gym),
    memberId: sub.memberId,
    branchId: sub.branchId,
    [kind === 'pt' ? 'ptPurchaseId' : 'subscriptionId']: sub._id,
    invoiceId: sub.invoiceId,
    amount,
    mode,
    reference,
    note,
    paidAt: paidAt || new Date(),
    receivedBy: user?._id,
  });
  return { payment, subscription: updated };
}

/**
 * Price breakdown for a member buying a plan (used by staff, the portal and online payments).
 * Joining fee applies only to a member's first ever membership.
 */
export async function quoteSubscription({ member, plan, discount = 0, waiveJoiningFee = false, couponCode, gym }) {
  gym = gym || (await getGym());
  const everHad = await Subscription.exists({ memberId: member._id });
  const joiningFee = !everHad && !waiveJoiningFee ? plan.joiningFee || 0 : 0;
  const gross = plan.price + joiningFee;
  let couponDiscount = 0;
  let coupon = null;
  if (couponCode) ({ coupon, discount: couponDiscount } = await evaluateCoupon(couponCode, { plan, gross, isNewMember: !everHad }));
  const totalDiscount = discount + couponDiscount;
  if (discount < 0 || totalDiscount > gross) throw ApiError.badRequest('Discount cannot exceed the amount');
  const taxPercent = plan.taxPercent ?? gym.taxPercent ?? 0;
  const taxable = gross - totalDiscount;
  const taxAmount = calcTax(taxable, taxPercent);
  return {
    everHad: Boolean(everHad),
    price: plan.price,
    joiningFee,
    discount: totalDiscount,
    couponDiscount,
    coupon,
    taxPercent,
    taxAmount,
    totalAmount: taxable + taxAmount,
  };
}

/**
 * Creates a new / renewal membership with invoice and an optional first payment.
 */
export async function createSubscription({
  memberId, planId, startDate, discount = 0, waiveJoiningFee = false, couponCode, payment, user, type, allowBackdate = false,
}) {
  const [member, plan, gym] = await Promise.all([
    Member.findOne({ _id: memberId, isDeleted: false }).lean(),
    Plan.findOne({ _id: planId, isDeleted: false, isActive: true }).lean(),
    getGym(),
  ]);
  if (!member) throw ApiError.notFound('Member not found');
  if (!plan) throw ApiError.notFound('Plan not found or inactive');
  if (plan.branchIds?.length && !plan.branchIds.map(String).includes(String(member.branchId))) {
    throw ApiError.badRequest("This plan is not available in the member's branch");
  }

  const existing = await liveSubs(member._id).lean();
  const lastEnd = existing.length ? existing[existing.length - 1].endDate : null;

  // Default start: today, or the day after the current membership ends (renewal).
  let start = startDate ? parseDay(startDate) : startOfDay();
  if (!startDate && lastEnd && ymd(lastEnd) >= ymd(start)) start = addDays(parseDay(lastEnd), 1);
  if (!allowBackdate && ymd(start) < ymd(addDays(new Date(), -30))) throw ApiError.badRequest('Start date cannot be more than 30 days in the past');
  const end = computeEndDate(start, plan);
  assertNoOverlap(existing, start, end);

  const q = await quoteSubscription({ member, plan, discount, waiveJoiningFee, couponCode, gym });
  if (q.coupon) await consumeCoupon(q.coupon._id);

  let sub;
  try {
    sub = await Subscription.create({
      memberId: member._id,
      branchId: member.branchId,
      planId: plan._id,
      plan: {
        name: plan.name,
        durationValue: plan.durationValue,
        durationUnit: plan.durationUnit,
        price: plan.price,
        freezeDaysAllowed: plan.freezeDaysAllowed,
        maxFreezes: plan.maxFreezes,
        accessStart: plan.accessStart,
        accessEnd: plan.accessEnd,
      },
      type: type || (q.everHad ? 'renewal' : 'new'),
      startDate: start,
      endDate: end,
      originalEndDate: end,
      price: q.price,
      joiningFee: q.joiningFee,
      discount: q.discount,
      couponCode: q.coupon?.code,
      taxPercent: q.taxPercent,
      taxAmount: q.taxAmount,
      totalAmount: q.totalAmount,
      paidAmount: 0,
      dueAmount: q.totalAmount,
      createdBy: user?._id,
    });
  } catch (err) {
    if (q.coupon) await Coupon.updateOne({ _id: q.coupon._id }, { $inc: { usedCount: -1 } });
    throw err;
  }

  const items = [{ description: `${plan.name} membership (${ymd(start)} to ${ymd(end)})`, amount: plan.price }];
  if (q.joiningFee) items.push({ description: 'Joining fee', amount: q.joiningFee });
  const invoice = await createInvoice({ gym, member, sub, items });
  sub.invoiceId = invoice._id;
  await sub.save();

  let firstPayment = null;
  if (payment?.amount > 0) {
    ({ payment: firstPayment } = await recordPayment({ sub, ...payment, user, gym }));
  }
  const access = await refreshMember(member._id);
  await inBackground('subscription-emails', async () => {
    if (sub.type === 'new') await sendWelcomeEmail(member._id);
    await sendInvoiceEmail(invoice._id);
  });
  return { subscription: await Subscription.findById(sub._id).lean(), invoice, payment: firstPayment, access };
}

/** Upgrade / change plan now. Unused paid value of the current plan becomes credit. */
export async function changePlan({ subscriptionId, planId, discount = 0, payment, user }) {
  const current = await Subscription.findOne({ _id: subscriptionId, status: 'active' });
  if (!current) throw ApiError.notFound('Active membership not found');
  const today = startOfDay();
  if (!(ymd(current.startDate) <= ymd(today) && ymd(today) <= ymd(current.endDate))) {
    throw ApiError.badRequest('Only the currently running membership can be changed');
  }
  const total = diffDays(current.startDate, current.endDate) + 1;
  const remaining = diffDays(today, current.endDate) + 1;
  const credit = Math.min(current.paidAmount, Math.round((current.paidAmount * remaining) / total));

  const newPlan = await Plan.findOne({ _id: planId, isDeleted: false, isActive: true }).lean();
  if (!newPlan) throw ApiError.notFound('Plan not found or inactive');
  if (credit + discount > newPlan.price) {
    throw ApiError.badRequest(
      `Unused value of the current plan (Rs. ${(credit / 100).toFixed(2)}) is more than the new plan price. ` +
        'Choose a higher plan, or switch to this plan at renewal.',
    );
  }

  // Close the current membership as of yesterday (it ends today if it started today).
  current.status = 'cancelled';
  current.cancelledAt = new Date();
  current.cancelReason = 'Plan changed';
  current.dueAmount = 0;
  await current.save();

  try {
    return {
      credit,
      ...(await createSubscription({
        memberId: current.memberId,
        planId,
        startDate: ymd(today),
        discount: discount + credit,
        waiveJoiningFee: true,
        payment,
        user,
        type: 'upgrade',
      })),
    };
  } catch (err) {
    // Roll back so the member never loses their membership on a failed upgrade.
    await Subscription.updateOne(
      { _id: current._id },
      { $set: { status: 'active', dueAmount: current.totalAmount - current.paidAmount }, $unset: { cancelledAt: 1, cancelReason: 1 } },
    );
    throw err;
  }
}

async function shiftLater(sub, days) {
  if (!days) return;
  const later = await Subscription.find({ memberId: sub.memberId, status: 'active', _id: { $ne: sub._id }, startDate: { $gt: sub.startDate } });
  for (const s of later) {
    s.startDate = addDays(s.startDate, days);
    s.endDate = addDays(s.endDate, days);
    await s.save();
  }
}

export async function freeze({ subscriptionId, from, days, reason, user, override = false }) {
  const sub = await Subscription.findOne({ _id: subscriptionId, status: 'active' });
  if (!sub) throw ApiError.notFound('Active membership not found');
  const start = from ? parseDay(from) : startOfDay();
  if (ymd(start) < ymd(new Date())) throw ApiError.badRequest('Freeze cannot start in the past');
  if (ymd(start) < ymd(sub.startDate) || ymd(start) > ymd(sub.endDate)) {
    throw ApiError.badRequest('Freeze must start within the membership period');
  }
  const to = addDays(start, days - 1);
  const overlaps = sub.freezes.some((f) => {
    const fEnd = f.endedEarlyAt ? addDays(f.endedEarlyAt, -1) : f.to;
    return ymd(f.from) <= ymd(to) && ymd(start) <= ymd(fEnd);
  });
  if (overlaps) throw ApiError.conflict('Overlaps an existing freeze');

  const used = sub.freezes.reduce((sum, f) => sum + f.days, 0);
  const allowedDays = sub.plan.freezeDaysAllowed || 0;
  const allowedCount = sub.plan.maxFreezes ?? 1;
  if (!override) {
    if (used + days > allowedDays) throw ApiError.badRequest(`Freeze limit exceeded: ${allowedDays - used} day(s) left on this plan`);
    if (sub.freezes.length >= allowedCount) throw ApiError.badRequest(`Maximum ${allowedCount} freeze(s) allowed on this plan`);
  }

  sub.freezes.push({ from: start, to, days, reason, by: user?._id });
  sub.endDate = addDays(sub.endDate, days);
  await sub.save();
  await shiftLater(sub, days);
  const access = await refreshMember(sub.memberId);
  return { subscription: sub, access };
}

/** Ends the running freeze today (member is back), or removes a future freeze. */
export async function unfreeze({ subscriptionId, freezeId }) {
  const sub = await Subscription.findOne({ _id: subscriptionId, status: 'active' });
  if (!sub) throw ApiError.notFound('Active membership not found');
  const f = sub.freezes.id(freezeId);
  if (!f || f.endedEarlyAt) throw ApiError.notFound('Freeze not found');
  const today = startOfDay();
  if (ymd(f.to) < ymd(today)) throw ApiError.badRequest('This freeze is already over');

  let giveBack;
  if (ymd(f.from) > ymd(today)) {
    giveBack = f.days;
    f.deleteOne();
  } else {
    giveBack = diffDays(today, f.to) + 1;
    f.endedEarlyAt = today;
    f.days -= giveBack;
  }
  sub.endDate = addDays(sub.endDate, -giveBack);
  await sub.save();
  await shiftLater(sub, -giveBack);
  const access = await refreshMember(sub.memberId);
  return { subscription: sub, access };
}

export async function cancel({ subscriptionId, reason }) {
  const sub = await Subscription.findOne({ _id: subscriptionId, status: 'active' });
  if (!sub) throw ApiError.notFound('Active membership not found');
  sub.status = 'cancelled';
  sub.cancelledAt = new Date();
  sub.cancelReason = reason;
  sub.dueAmount = 0; // pending dues are written off on cancellation
  await sub.save();
  const access = await refreshMember(sub.memberId);
  return { subscription: sub, access };
}
