import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { paginate, escapeRegex } from '../../utils/pagination.js';
import { nextSeq } from '../../utils/counter.js';
import { ApiError } from '../../utils/ApiError.js';
import { Member } from '../members/member.model.js';
import { User } from '../users/user.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { audit } from '../audit/audit.model.js';
import { Feedback, FEEDBACK_TYPES, FEEDBACK_CATEGORIES, FEEDBACK_STATUS } from './feedback.model.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const newBody = z.object({
  type: z.enum(FEEDBACK_TYPES),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  subject: z.string().trim().min(3).max(100),
  message: z.string().trim().min(3).max(2000),
  rating: z.number().int().min(1).max(5).optional().nullable(),
});
const replyBody = z.object({ text: z.string().trim().min(1).max(2000) });

const STATUS_TEXT = { open: 'received', 'in-progress': 'being worked on', resolved: 'resolved', closed: 'closed' };

async function createTicket({ member, data, source, user }) {
  const fb = await Feedback.create({
    ...data,
    rating: data.rating || undefined,
    ticketNo: `FB-${String(await nextSeq('feedback')).padStart(5, '0')}`,
    branchId: member.branchId,
    memberId: member._id,
    source,
    createdBy: user?._id,
    // Complaints about safety-critical things get looked at first.
    priority: data.priority || (data.type === 'complaint' && ['equipment', 'cleanliness'].includes(data.category) ? 'high' : 'normal'),
  });
  await createAlert({
    branchId: member.branchId,
    memberId: member._id,
    template: 'feedback',
    subject: `${fb.type === 'complaint' ? 'New complaint' : fb.type === 'praise' ? 'New praise' : 'New suggestion'} ${fb.ticketNo}: ${fb.subject}`,
    body: `${member.name} · ${fb.category}. Open Complaints & feedback.`,
    dedupeKey: `feedback:${fb._id}`,
  });
  return fb;
}

/** SMS / WhatsApp to the member when staff reply or the status changes (channels the gym switched on). */
async function tellMember(fb, what) {
  const member = await Member.findById(fb.memberId).lean();
  if (!member) return;
  await notifyMember({
    member,
    template: 'feedback_update',
    vars: { ticket: fb.ticketNo, status: what },
    dedupeKey: `feedback:${fb._id}:${fb.replies.length}:${fb.status}`,
  });
}

/* ---------------- Staff ---------------- */
export const feedbackRouter = Router();
feedbackRouter.use(requireStaff);

feedbackRouter.get('/', permit('feedback.read'), async (req, res) => {
  const q = req.query;
  const bf = branchFilter(req);
  const filter = { ...bf };
  if (q.status && FEEDBACK_STATUS.includes(q.status)) filter.status = q.status;
  if (q.type && FEEDBACK_TYPES.includes(q.type)) filter.type = q.type;
  if (q.category && FEEDBACK_CATEGORIES.includes(q.category)) filter.category = q.category;
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.search) {
    const rx = new RegExp(escapeRegex(String(q.search).trim()), 'i');
    filter.$or = [{ ticketNo: rx }, { subject: rx }];
  }
  const [page, counts, avg] = await Promise.all([
    paginate(Feedback, filter, q, {
      sort: { priority: 1, lastActivityAt: -1 }, // 'high' sorts before 'normal'
      populate: [{ path: 'memberId', select: 'name memberCode phone' }, { path: 'assignedTo', select: 'name' }],
    }),
    Feedback.aggregate([{ $match: bf }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Feedback.aggregate([{ $match: { ...bf, memberRating: { $ne: null } } }, { $group: { _id: null, avg: { $avg: '$memberRating' }, n: { $sum: 1 } } }]),
  ]);
  res.json({
    success: true,
    data: { ...page, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), satisfaction: avg[0] ? { average: Math.round(avg[0].avg * 10) / 10, ratings: avg[0].n } : null },
  });
});

feedbackRouter.get('/:id', permit('feedback.read'), async (req, res) => {
  const fb = await findInBranch(req, Feedback, req.params.id, { notFound: 'Ticket not found' });
  await fb.populate([{ path: 'memberId', select: 'name memberCode phone' }, { path: 'assignedTo', select: 'name' }, { path: 'createdBy', select: 'name' }]);
  res.json({ success: true, data: fb });
});

// The desk logs a complaint for a member who spoke to them in person.
feedbackRouter.post(
  '/',
  permit('feedback.write'),
  validate({ body: newBody.extend({ memberId: objectId, priority: z.enum(['normal', 'high']).optional() }) }),
  async (req, res) => {
    const member = await findInBranch(req, Member, req.body.memberId, { notFound: 'Member not found', extra: { isDeleted: false } });
    const { memberId, ...data } = req.body; // eslint-disable-line no-unused-vars
    const fb = await createTicket({ member, data, source: 'desk', user: req.user });
    await audit(req, 'feedback.create', { entity: 'Feedback', entityId: fb._id, branchId: fb.branchId });
    res.status(201).json({ success: true, data: fb });
  },
);

feedbackRouter.post('/:id/replies', permit('feedback.write'), validate({ body: replyBody }), async (req, res) => {
  const fb = await findInBranch(req, Feedback, req.params.id, { notFound: 'Ticket not found' });
  if (fb.status === 'closed') throw ApiError.badRequest('This ticket is closed');
  fb.replies.push({ from: 'staff', userId: req.user._id, name: req.user.name, text: req.body.text });
  if (fb.status === 'open') fb.status = 'in-progress';
  fb.lastActivityAt = new Date();
  await fb.save();
  await tellMember(fb, 'has a new reply');
  res.status(201).json({ success: true, data: fb });
});

feedbackRouter.patch(
  '/:id',
  permit('feedback.write'),
  validate({ body: z.object({ status: z.enum(FEEDBACK_STATUS).optional(), priority: z.enum(['normal', 'high']).optional(), assignedTo: objectId.nullable().optional() }) }),
  async (req, res) => {
    const fb = await findInBranch(req, Feedback, req.params.id, { notFound: 'Ticket not found' });
    const before = fb.status;
    if (req.body.assignedTo) {
      const u = await User.findOne({ _id: req.body.assignedTo, isActive: true }).select('_id');
      if (!u) throw ApiError.badRequest('Staff member not found');
    }
    Object.assign(fb, req.body);
    if (fb.status !== before) {
      if (fb.status === 'resolved') fb.resolvedAt = new Date();
      if (fb.status === 'open' || fb.status === 'in-progress') fb.resolvedAt = undefined;
    }
    fb.lastActivityAt = new Date();
    await fb.save();
    if (fb.status !== before) {
      await audit(req, 'feedback.status', { entity: 'Feedback', entityId: fb._id, branchId: fb.branchId, details: { from: before, to: fb.status } });
      if (['resolved', 'in-progress'].includes(fb.status)) await tellMember(fb, `is ${STATUS_TEXT[fb.status]}`);
    }
    res.json({ success: true, data: fb });
  },
);

/* ---------------- Member app (/me/feedback) ---------------- */
export const portalFeedbackRouter = Router();
portalFeedbackRouter.use(requireMember);

const mine = async (req) => {
  const fb = mongoose.isValidObjectId(req.params.id) && (await Feedback.findOne({ _id: req.params.id, memberId: req.member._id }));
  if (!fb) throw ApiError.notFound('Ticket not found');
  return fb;
};
// Members see who replied, not internal fields.
const forMember = (fb) => {
  const { _id, ticketNo, type, category, subject, message, rating, status, replies, createdAt, resolvedAt, memberRating } = fb.toObject ? fb.toObject() : fb;
  return { _id, ticketNo, type, category, subject, message, rating, status, createdAt, resolvedAt, memberRating, replies: replies.map(({ from, name, text, at }) => ({ from, name: from === 'staff' ? name : undefined, text, at })) };
};

portalFeedbackRouter.get('/feedback', async (req, res) => {
  const list = await Feedback.find({ memberId: req.member._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, data: list.map(forMember) });
});

portalFeedbackRouter.post('/feedback', validate({ body: newBody }), async (req, res) => {
  // A small guard against floods from one account.
  const today = await Feedback.countDocuments({ memberId: req.member._id, createdAt: { $gte: new Date(Date.now() - 86400000) } });
  if (today >= 5) throw ApiError.badRequest('You can send up to 5 tickets a day. Please add to an existing ticket instead.');
  const fb = await createTicket({ member: req.member, data: req.body, source: 'app' });
  res.status(201).json({ success: true, data: forMember(fb) });
});

portalFeedbackRouter.post('/feedback/:id/replies', validate({ body: replyBody }), async (req, res) => {
  const fb = await mine(req);
  if (fb.status === 'closed') throw ApiError.badRequest('This ticket is closed. Please raise a new one.');
  fb.replies.push({ from: 'member', text: req.body.text });
  if (fb.status === 'resolved') {
    // Member says it is not fixed: reopen.
    fb.status = 'open';
    fb.resolvedAt = undefined;
  }
  fb.lastActivityAt = new Date();
  await fb.save();
  await createAlert({
    branchId: fb.branchId,
    memberId: fb.memberId,
    template: 'feedback',
    subject: `Member replied on ${fb.ticketNo}: ${fb.subject}`,
    body: req.body.text.slice(0, 140),
    dedupeKey: `feedback:${fb._id}:reply:${fb.replies.length}`,
  });
  res.status(201).json({ success: true, data: forMember(fb) });
});

// After a fix: the member rates how it was handled, which closes the ticket.
portalFeedbackRouter.post('/feedback/:id/rate', validate({ body: z.object({ rating: z.number().int().min(1).max(5) }) }), async (req, res) => {
  const fb = await mine(req);
  if (fb.status !== 'resolved') throw ApiError.badRequest('You can rate a ticket once it is resolved');
  fb.memberRating = req.body.rating;
  fb.status = 'closed';
  fb.lastActivityAt = new Date();
  await fb.save();
  res.json({ success: true, data: forMember(fb) });
});
