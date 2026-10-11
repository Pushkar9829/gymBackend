import { ApiError } from '../../utils/ApiError.js';
import { Coupon } from './coupon.model.js';

/** Validates a coupon for a plan and returns { coupon, discount } (paise). Does not consume it. */
export async function evaluateCoupon(code, { plan, gross, isNewMember, now = new Date() }) {
  const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() }).lean();
  if (!coupon || !coupon.isActive) throw ApiError.badRequest('Invalid coupon code');
  if (coupon.validFrom && now < coupon.validFrom) throw ApiError.badRequest('This coupon is not active yet');
  if (coupon.validTo && now > coupon.validTo) throw ApiError.badRequest('This coupon has expired');
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) throw ApiError.badRequest('This coupon has been fully used');
  if (coupon.planIds?.length && !coupon.planIds.map(String).includes(String(plan._id))) {
    throw ApiError.badRequest('This coupon is not valid for the selected plan');
  }
  if (coupon.newMembersOnly && !isNewMember) throw ApiError.badRequest('This coupon is for new members only');
  let discount = coupon.type === 'percent' ? Math.round((gross * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  return { coupon, discount: Math.min(discount, gross) };
}

/** Atomically consumes one use (respecting maxUses). */
export async function consumeCoupon(couponId) {
  const updated = await Coupon.findOneAndUpdate(
    { _id: couponId, $or: [{ maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }] },
    { $inc: { usedCount: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.badRequest('This coupon has been fully used');
  return updated;
}
