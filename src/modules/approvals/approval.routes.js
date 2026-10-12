import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { formatINR } from '../../utils/money.js';
import { Member } from '../members/member.model.js';
import { User } from '../users/user.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { audit } from '../audit/audit.model.js';
import { DiscountApproval, APPROVAL_KINDS, APPROVAL_VALID_HOURS } from './approval.model.js';
import { priceFor, approvalState } from './approval.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const SELL_PERM = { subscription: 'subscriptions.write', pt: 'pt.sell', shop: 'shop.sell' };
const POPULATE = [
  { path: 'memberId', select: 'name memberCode phone' },
  { path: 'requestedBy', select: 'name role' },
  { path: 'decidedBy', select: 'name' },
];
const shape = (a) => ({ ...a, state: approvalState(a) });

router.post(
  '/',
  validate({
    body: z.object({
      kind: z.enum(APPROVAL_KINDS),
      branchId: objectId.optional(),
      memberId: objectId.optional().nullable(),
      customerName: z.string().trim().max(80).optional(),
      planId: objectId.optional(),
      packageId: objectId.optional(),
      waiveJoiningFee: z.boolean().optional(),
      items: z.array(z.object({ productId: objectId, qty: z.number().int().min(1).max(500) })).max(50).optional(),
      discount: z.number().int().min(1),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  async (req, res) => {
    const b = req.body;
    if (!can(req.user.role, SELL_PERM[b.kind])) throw ApiError.forbidden();
    let member = null;
    let branchId = b.branchId;
    if (b.kind !== 'shop' && !b.memberId) throw ApiError.badRequest('Choose the member');
    if (b.memberId) {
      member = await findInBranch(req, Member, b.memberId, { notFound: 'Member not found', extra: { isDeleted: false } });
      branchId = branchId || String(member.branchId);
    }
    if (b.kind === 'subscription' && !b.planId) throw ApiError.badRequest('Choose the plan');
    if (b.kind === 'pt' && !b.packageId) throw ApiError.badRequest('Choose the PT package');
    if (!branchId) throw ApiError.badRequest('Choose a branch');
    assertBranchAccess(req, branchId);
    const price = await priceFor({ kind: b.kind, memberId: member?._id, planId: b.planId, packageId: b.packageId, items: b.items, waiveJoiningFee: b.waiveJoiningFee });
    if (b.discount > price.listPrice) throw ApiError.badRequest('Discount cannot exceed the price');
    const a = await DiscountApproval.create({
      branchId,
      memberId: member?._id,
      customerName: member ? member.name : b.customerName,
      kind: b.kind,
      ...price,
      requestedDiscount: b.discount,
      reason: b.reason,
      requestedBy: req.user._id,
    });
    const who = member ? `${member.name} #${member.memberCode}` : b.customerName || 'walk-in customer';
    await createAlert({
      branchId,
      template: 'discount-approval',
      subject: `Approve discount: ${formatINR(b.discount)} off ${price.itemLabel} for ${who}`,
      body: `Asked by ${req.user.name}: ${b.reason}. Open Approvals to decide.`,
      roles: ['owner', 'manager'],
      dedupeKey: `approval:${a._id}`,
    });
    await audit(req, 'discount.request', { entity: 'DiscountApproval', entityId: a._id, branchId, details: { kind: b.kind, item: price.itemLabel, listPrice: price.listPrice, discount: b.discount } });
    res.status(201).json({ success: true, data: shape(a.toObject()) });
  },
);

// Owner/manager: all requests in their branches. Others: their own requests.
router.get('/', async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (!can(req.user.role, 'discounts.approve')) filter.requestedBy = req.user._id;
  const pendingFilter = { ...filter, status: 'pending' };
  const now = new Date();
  if (q.status === 'expired') Object.assign(filter, { status: 'approved', expiresAt: { $lte: now } });
  else if (q.status === 'approved') Object.assign(filter, { status: 'approved', expiresAt: { $gt: now } });
  else if (['pending', 'rejected', 'used'].includes(q.status)) filter.status = q.status;
  const [data, pending] = await Promise.all([
    paginate(DiscountApproval, filter, q, { sort: { createdAt: -1 }, populate: POPULATE }),
    DiscountApproval.countDocuments(pendingFilter),
  ]);
  res.json({ success: true, data: { ...data, items: data.items.map(shape), pending } });
});

// Approved and still usable approvals for a member (shown on the sale form).
router.get('/usable', async (req, res) => {
  const filter = { ...branchFilter(req), status: 'approved', expiresAt: { $gt: new Date() } };
  if (req.query.kind && APPROVAL_KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
  if (req.query.memberId && mongoose.isValidObjectId(req.query.memberId)) filter.memberId = req.query.memberId;
  else if (req.query.kind === 'shop') filter.requestedBy = req.user._id;
  else return res.json({ success: true, data: [] });
  const list = await DiscountApproval.find(filter).sort({ decidedAt: -1 }).limit(10).populate(POPULATE).lean();
  res.json({ success: true, data: list.map(shape) });
});

router.get('/:id', async (req, res) => {
  const a = await findInBranch(req, DiscountApproval, req.params.id, { notFound: 'Request not found' });
  if (!can(req.user.role, 'discounts.approve') && String(a.requestedBy) !== String(req.user._id)) throw ApiError.forbidden();
  await a.populate(POPULATE);
  res.json({ success: true, data: shape(a.toObject()) });
});

const decide = (approve) => async (req, res) => {
  const a = await findInBranch(req, DiscountApproval, req.params.id, { notFound: 'Request not found' });
  if (a.status !== 'pending') throw ApiError.badRequest('This request was already decided');
  const amount = approve ? Math.min(a.requestedDiscount, req.body.approvedDiscount || a.requestedDiscount) : undefined;
  const now = new Date();
  const updated = await DiscountApproval.findOneAndUpdate(
    { _id: a._id, status: 'pending' },
    {
      status: approve ? 'approved' : 'rejected',
      decidedBy: req.user._id,
      decidedAt: now,
      decisionNote: req.body.note,
      ...(approve ? { approvedDiscount: amount, expiresAt: new Date(now.getTime() + APPROVAL_VALID_HOURS * 3600 * 1000) } : {}),
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.conflict('This request was just decided by someone else');
  const [member, requester] = await Promise.all([a.memberId ? Member.findById(a.memberId).select('name').lean() : null, User.findById(a.requestedBy).select('role').lean()]);
  const who = member?.name || a.customerName || 'walk-in customer';
  await createAlert({
    branchId: a.branchId,
    template: approve ? 'discount-approved' : 'discount-rejected',
    subject: approve ? `Discount approved: ${formatINR(amount)} off ${a.itemLabel} for ${who}` : `Discount rejected for ${who} (${a.itemLabel})`,
    body: approve ? `By ${req.user.name}. Open the sale again and complete it within ${APPROVAL_VALID_HOURS} hours.` : `By ${req.user.name}${req.body.note ? `: ${req.body.note}` : ''}`,
    roles: requester?.role ? [requester.role] : undefined,
    dedupeKey: `approval-decided:${a._id}`,
  });
  await audit(req, approve ? 'discount.approve' : 'discount.reject', { entity: 'DiscountApproval', entityId: a._id, branchId: a.branchId, details: { discount: amount ?? a.requestedDiscount, note: req.body.note } });
  await updated.populate(POPULATE);
  res.json({ success: true, data: shape(updated.toObject()) });
};

router.post(
  '/:id/approve',
  permit('discounts.approve'),
  validate({ body: z.object({ note: z.string().trim().max(300).optional(), approvedDiscount: z.number().int().min(1).optional() }) }),
  decide(true),
);
router.post('/:id/reject', permit('discounts.approve'), validate({ body: z.object({ note: z.string().trim().max(300).optional() }) }), decide(false));

export default router;
