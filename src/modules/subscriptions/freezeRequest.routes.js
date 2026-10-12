import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, dmy, parseDay, startOfDay, ymd } from '../../utils/dates.js';
import { Subscription } from './subscription.model.js';
import { FreezeRequest } from './freezeRequest.model.js';
import { Member } from '../members/member.model.js';
import { freeze, checkFreeze, freezeAllowance } from './subscription.service.js';
import { createAlert } from '../notifications/notification.service.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { audit } from '../audit/audit.model.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const range = (r) => `${dmy(r.from)} to ${dmy(addDays(r.from, r.days - 1))}`;

/* ======================= Staff: /api/v1/freeze-requests (whoever can freeze a membership) ======================= */
export const freezeRequestRouter = Router();
freezeRequestRouter.use(requireStaff, permit('subscriptions.write'));

const POPULATE = [
  { path: 'memberId', select: 'name memberCode phone photoUrl photoFileId' },
  { path: 'subscriptionId', select: 'plan startDate endDate freezes status' },
  { path: 'decidedBy', select: 'name' },
];

freezeRequestRouter.get('/', async (req, res) => {
  const q = req.query;
  const scope = branchFilter(req);
  const filter = { ...scope };
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(q.status)) filter.status = q.status;
  const [data, pending] = await Promise.all([
    paginate(FreezeRequest, filter, q, { sort: { createdAt: -1 }, populate: POPULATE }),
    FreezeRequest.countDocuments({ ...scope, status: 'pending' }),
  ]);
  const items = data.items.map((r) => {
    const o = r.toObject ? r.toObject() : r;
    return { ...o, allowance: o.subscriptionId ? freezeAllowance(o.subscriptionId) : null };
  });
  res.json({ success: true, data: { ...data, items, pending } });
});

async function tellMember(request, status, note) {
  const member = await Member.findById(request.memberId).lean();
  if (!member) return;
  await notifyMember({
    member,
    template: 'freeze_update',
    vars: { dates: range({ from: request.approvedFrom || request.from, days: request.approvedDays || request.days }), status: status === 'approved' ? 'is approved' : `was not approved${note ? `: ${note}` : ''}` },
    dedupeKey: `freeze-request:${request._id}:${status}`,
  });
}

freezeRequestRouter.post(
  '/:id/approve',
  validate({ body: z.object({ from: day.optional(), days: z.number().int().min(1).max(180).optional(), note: z.string().trim().max(300).optional() }) }),
  async (req, res) => {
    const r = await findInBranch(req, FreezeRequest, req.params.id, { notFound: 'Request not found' });
    if (r.status !== 'pending') throw ApiError.badRequest('This request was already decided');
    const from = req.body.from || ymd(r.from);
    const days = req.body.days || r.days;
    // Claim the request first so two people approving at once cannot freeze twice.
    const updated = await FreezeRequest.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'approved', decidedBy: req.user._id, decidedAt: new Date(), decisionNote: req.body.note, approvedFrom: parseDay(from), approvedDays: days }, $unset: { pendingKey: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw ApiError.conflict('This request was just decided by someone else');
    let result;
    try {
      // The normal freeze: plan limits apply; a future start date simply waits for that day.
      result = await freeze({ subscriptionId: r.subscriptionId, from, days, reason: `App request: ${r.reason}`, user: req.user });
    } catch (err) {
      await FreezeRequest.updateOne(
        { _id: r._id },
        { $set: { status: 'pending', pendingKey: String(r.subscriptionId) }, $unset: { decidedBy: 1, decidedAt: 1, decisionNote: 1, approvedFrom: 1, approvedDays: 1 } },
      );
      throw err;
    }
    await tellMember(updated, 'approved');
    await audit(req, 'freeze.request.approve', { entity: 'FreezeRequest', entityId: r._id, branchId: r.branchId, details: { from, days } });
    await updated.populate(POPULATE);
    res.json({ success: true, data: { request: updated, access: result.access && { ...result.access, current: undefined } } });
  },
);

freezeRequestRouter.post('/:id/reject', validate({ body: z.object({ note: z.string().trim().min(2, 'Add a short note for the member').max(300) }) }), async (req, res) => {
  const r = await findInBranch(req, FreezeRequest, req.params.id, { notFound: 'Request not found' });
  const updated = await FreezeRequest.findOneAndUpdate(
    { _id: r._id, status: 'pending' },
    { $set: { status: 'rejected', decidedBy: req.user._id, decidedAt: new Date(), decisionNote: req.body.note }, $unset: { pendingKey: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.badRequest('This request was already decided');
  await tellMember(updated, 'rejected', req.body.note);
  await audit(req, 'freeze.request.reject', { entity: 'FreezeRequest', entityId: r._id, branchId: r.branchId, details: { note: req.body.note } });
  await updated.populate(POPULATE);
  res.json({ success: true, data: updated });
});

/* ======================= Member app: /api/v1/me/freeze ======================= */
export const portalFreezeRouter = Router();
portalFreezeRouter.use(requireMember);

/** The membership running today (or the next one), its freeze allowance and the member's requests. */
async function currentSub(memberId) {
  const today = startOfDay();
  const subs = await Subscription.find({ memberId, status: 'active', endDate: { $gte: today } }).sort({ startDate: 1 }).lean();
  return subs.find((s) => s.startDate <= today) || subs[0] || null;
}

portalFreezeRouter.get('/freeze', async (req, res) => {
  const sub = await currentSub(req.member._id);
  const requests = await FreezeRequest.find({ memberId: req.member._id }).sort({ createdAt: -1 }).limit(10).select('-pendingKey -decidedBy').lean();
  res.json({
    success: true,
    data: {
      subscription: sub && { _id: sub._id, plan: { name: sub.plan?.name }, startDate: sub.startDate, endDate: sub.endDate, freezes: sub.freezes },
      allowance: sub ? freezeAllowance(sub) : null,
      requests,
    },
  });
});

portalFreezeRouter.post(
  '/freeze-requests',
  validate({ body: z.object({ subscriptionId: objectId, from: day, days: z.number().int().min(1).max(180), reason: z.string().trim().min(3, 'Tell the gym why (at least 3 letters)').max(300) }) }),
  async (req, res) => {
    const b = req.body;
    const sub = await Subscription.findOne({ _id: b.subscriptionId, memberId: req.member._id, status: 'active' });
    if (!sub || ymd(sub.endDate) < ymd(new Date())) throw ApiError.notFound('Active membership not found');
    const start = parseDay(b.from);
    if (ymd(start) <= ymd(new Date())) throw ApiError.badRequest('A freeze can start from tomorrow at the earliest');
    const a = freezeAllowance(sub);
    if (!a.daysAllowed) throw ApiError.badRequest('Your plan does not include freeze days. Please talk to the gym.');
    checkFreeze(sub, { start, days: b.days });
    let request;
    try {
      request = await FreezeRequest.create({ memberId: req.member._id, branchId: sub.branchId, subscriptionId: sub._id, from: start, days: b.days, reason: b.reason, pendingKey: String(sub._id) });
    } catch (err) {
      if (err?.code === 11000) throw ApiError.conflict('You already have a freeze request waiting. Cancel it first to ask again.');
      throw err;
    }
    const m = req.member;
    await createAlert({
      branchId: sub.branchId,
      memberId: m._id,
      template: 'freeze-request',
      subject: `Freeze request: ${m.name} (#${m.memberCode}), ${b.days} day(s) from ${dmy(start)}`,
      body: `“${b.reason}”. Open Approvals > Freeze requests to approve or reject.`,
      roles: ['owner', 'manager', 'receptionist'],
      dedupeKey: `freeze-request:${request._id}`,
    });
    res.status(201).json({ success: true, data: request });
  },
);

portalFreezeRouter.post('/freeze-requests/:id/cancel', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Request not found');
  const updated = await FreezeRequest.findOneAndUpdate(
    { _id: req.params.id, memberId: req.member._id, status: 'pending' },
    { $set: { status: 'cancelled', cancelledAt: new Date() }, $unset: { pendingKey: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.notFound('No waiting request found');
  res.json({ success: true, data: updated });
});
