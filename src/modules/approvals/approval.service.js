import { ApiError } from '../../utils/ApiError.js';
import { formatINR } from '../../utils/money.js';
import { Plan } from '../plans/plan.model.js';
import { PtPackage } from '../pt/pt.model.js';
import { Product } from '../shop/shop.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { getGym } from '../settings/gym.model.js';
import { audit } from '../audit/audit.model.js';
import { DiscountApproval } from './approval.model.js';

// Owner and manager set prices, so they are never limited.
export const UNLIMITED_ROLES = ['owner', 'manager'];

/** List price (paise, before discount and GST) and a stable key for what is being sold. */
export async function priceFor({ kind, memberId, planId, packageId, items, waiveJoiningFee = false }) {
  if (kind === 'subscription') {
    const plan = await Plan.findOne({ _id: planId, isDeleted: false }).lean();
    if (!plan) throw ApiError.notFound('Plan not found');
    const everHad = memberId ? await Subscription.exists({ memberId }) : null;
    const joining = !everHad && !waiveJoiningFee ? plan.joiningFee || 0 : 0;
    return { listPrice: plan.price + joining, itemKey: `plan:${plan._id}`, itemLabel: `${plan.name} membership${joining ? ' + joining fee' : ''}` };
  }
  if (kind === 'pt') {
    const pkg = await PtPackage.findById(packageId).lean();
    if (!pkg) throw ApiError.notFound('PT package not found');
    return { listPrice: pkg.price, itemKey: `pt:${pkg._id}`, itemLabel: `PT: ${pkg.name}` };
  }
  if (!items?.length) throw ApiError.badRequest('Add at least one product');
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } }).lean();
  const byId = Object.fromEntries(products.map((p) => [String(p._id), p]));
  let listPrice = 0;
  const parts = [];
  for (const i of items) {
    const p = byId[String(i.productId)];
    if (!p) throw ApiError.badRequest('A product in the cart is not available');
    listPrice += p.price * i.qty;
    parts.push({ key: `${p._id}x${i.qty}`, label: `${p.name} x${i.qty}` });
  }
  parts.sort((a, b) => a.key.localeCompare(b.key));
  return { listPrice, itemKey: `shop:${parts.map((x) => x.key).join(',')}`, itemLabel: parts.map((x) => x.label).join(', ') };
}

export async function discountLimitPercent() {
  const gym = await getGym();
  return gym.settings?.discountLimitPercent ?? 10;
}

const isExpired = (a, now = new Date()) => a.status === 'approved' && a.expiresAt && a.expiresAt <= now;
export const approvalState = (a, now = new Date()) => (isExpired(a, now) ? 'expired' : a.status);

/**
 * Checks a manual discount against the receptionist limit. Returns null when allowed as is,
 * or the approval it claimed (single use) when an approval id was given. Throws 403 with
 * code DISCOUNT_APPROVAL_REQUIRED when approval is needed.
 */
export async function guardDiscount(req, { kind, branchId, memberId, discount, approvalId, ...item }) {
  if (!discount || UNLIMITED_ROLES.includes(req.user.role)) return null;
  const { listPrice, itemKey } = await priceFor({ kind, memberId, ...item });
  const limit = await discountLimitPercent();
  if (discount * 100 <= listPrice * limit) return null;
  if (!approvalId) {
    const max = Math.floor((listPrice * limit) / 100);
    throw new ApiError(403, `Discounts above ${limit}% need owner or manager approval (up to ${formatINR(max)} is allowed without it).`, undefined, 'DISCOUNT_APPROVAL_REQUIRED');
  }
  const now = new Date();
  const claimed = await DiscountApproval.findOneAndUpdate(
    { _id: approvalId, status: 'approved', expiresAt: { $gt: now }, kind, itemKey, memberId: memberId || null, branchId, approvedDiscount: { $gte: discount } },
    { status: 'used', usedAt: now, usedBy: req.user._id },
    { returnDocument: 'after' },
  );
  if (claimed) return claimed;
  // Explain why the approval cannot be used.
  const a = await DiscountApproval.findById(approvalId).lean();
  const bad = (msg) => new ApiError(400, msg, undefined, 'APPROVAL_INVALID');
  if (!a || String(a.branchId) !== String(branchId)) throw bad('Approval not found');
  if (a.status === 'used') throw bad('This approval was already used');
  if (a.status === 'pending') throw bad('This approval is still waiting for a decision');
  if (a.status === 'rejected') throw bad('This approval was rejected');
  if (isExpired(a, now)) throw bad('This approval has expired (approvals are valid for 24 hours)');
  if (a.kind !== kind || a.itemKey !== itemKey || String(a.memberId || '') !== String(memberId || '')) throw bad('This approval is for a different member or item');
  throw bad(`The approved discount is up to ${formatINR(a.approvedDiscount)}`);
}

/** The sale failed after claiming the approval: make it usable again. */
export async function releaseApproval(approval) {
  if (!approval) return;
  await DiscountApproval.updateOne({ _id: approval._id, status: 'used' }, { status: 'approved', $unset: { usedAt: 1, usedBy: 1 } });
}

/** Records what the approval was used on. */
export async function markApprovalUsed(req, approval, { entity, id, discount }) {
  if (!approval) return;
  await DiscountApproval.updateOne({ _id: approval._id }, { usedOn: { entity, id } });
  await audit(req, 'discount.use', { entity: 'DiscountApproval', entityId: approval._id, branchId: approval.branchId, details: { on: entity, id, discount } });
}

/** Runs a sale with the discount check: claims the approval first and gives it back if the sale fails. */
export async function withDiscountGuard(req, guardArgs, sell, entity) {
  const approval = await guardDiscount(req, guardArgs);
  let result;
  try {
    result = await sell(approval);
  } catch (err) {
    await releaseApproval(approval);
    throw err;
  }
  return { result, approval, done: (id) => markApprovalUsed(req, approval, { entity, id, discount: guardArgs.discount }) };
}
