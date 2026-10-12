import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate, escapeRegex } from '../../utils/pagination.js';
import { endOfDay } from '../../utils/dates.js';
import { nextSeq } from '../../utils/counter.js';
import { Lead, LEAD_STATUS, LEAD_SOURCES } from './lead.model.js';
import { Member } from '../members/member.model.js';
import { audit } from '../audit/audit.model.js';
import { convertTrial } from '../trials/trial.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const body = z.object({
  branchId: objectId,
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number'),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  source: z.enum(LEAD_SOURCES).optional(),
  interestPlanId: objectId.optional().nullable(),
  notes: z.string().max(1000).optional(),
  status: z.enum(LEAD_STATUS).optional(),
  assignedTo: objectId.optional().nullable(),
  nextFollowUpAt: z.coerce.date().optional().nullable(),
  trialFrom: z.coerce.date().optional().nullable(),
  trialTo: z.coerce.date().optional().nullable(),
  lostReason: z.string().max(200).optional(),
});

router.get('/', permit('leads.read'), async (req, res) => {
  const q = req.query;
  const filter = { isDeleted: false, ...branchFilter(req) };
  if (q.status && LEAD_STATUS.includes(q.status)) filter.status = q.status;
  if (q.source) filter.source = String(q.source);
  if (q.followUpDue === 'true') {
    filter.status = { $in: ['new', 'contacted', 'trial'] };
    filter.nextFollowUpAt = { $lte: endOfDay() };
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(String(q.search).trim()), 'i');
    filter.$or = [{ name: rx }, { phone: rx }];
  }
  const [data, counts] = await Promise.all([
    paginate(Lead, filter, q, {
      sort: q.followUpDue === 'true' ? { nextFollowUpAt: 1 } : { createdAt: -1 },
      populate: [{ path: 'assignedTo', select: 'name' }, { path: 'interestPlanId', select: 'name' }],
    }),
    Lead.aggregate([{ $match: { isDeleted: false, ...branchFilter(req) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ success: true, data: { ...data, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } });
});

router.post('/', permit('leads.write'), validate({ body }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const lead = await Lead.create({ ...req.body, assignedTo: req.body.assignedTo || req.user._id });
  res.status(201).json({ success: true, data: lead });
});

router.get('/:id', permit('leads.read'), async (req, res) => {
  const lead = await findInBranch(req, Lead, req.params.id, { notFound: 'Lead not found', extra: { isDeleted: false } });
  await lead.populate([{ path: 'assignedTo', select: 'name' }, { path: 'followUps.by', select: 'name' }, { path: 'interestPlanId', select: 'name' }]);
  res.json({ success: true, data: lead });
});

router.put('/:id', permit('leads.write'), validate({ body: body.partial() }), async (req, res) => {
  const lead = await findInBranch(req, Lead, req.params.id, { notFound: 'Lead not found', extra: { isDeleted: false } });
  if (req.body.branchId) assertBranchAccess(req, req.body.branchId);
  if (req.body.status === 'converted') throw ApiError.badRequest('Use the convert action to convert a lead');
  Object.assign(lead, req.body);
  await lead.save();
  res.json({ success: true, data: lead });
});

router.post(
  '/:id/follow-ups',
  permit('leads.write'),
  validate({
    body: z.object({
      note: z.string().trim().min(1).max(1000),
      nextFollowUpAt: z.coerce.date().optional().nullable(),
      status: z.enum(['new', 'contacted', 'trial', 'lost']).optional(),
    }),
  }),
  async (req, res) => {
    const lead = await findInBranch(req, Lead, req.params.id, { notFound: 'Lead not found', extra: { isDeleted: false } });
    lead.followUps.push({ note: req.body.note, by: req.user._id });
    if ('nextFollowUpAt' in req.body) lead.nextFollowUpAt = req.body.nextFollowUpAt;
    if (req.body.status) lead.status = req.body.status;
    else if (lead.status === 'new') lead.status = 'contacted';
    await lead.save();
    res.json({ success: true, data: lead });
  },
);

/** Creates a member from the lead. Membership + payment are then added from the member screen. */
router.post('/:id/convert', permit('leads.write', 'members.write'), async (req, res) => {
  const lead = await findInBranch(req, Lead, req.params.id, { notFound: 'Lead not found', extra: { isDeleted: false } });
  if (lead.status === 'converted') throw ApiError.badRequest('Lead already converted');
  let member = await Member.findOne({ phone: lead.phone, isDeleted: false });
  // A trial visitor joining: keep the same record and visit history.
  if (member?.isTrial) ({ member } = await convertTrial(member, req.user));
  if (!member) {
    member = await Member.create({
      branchId: lead.branchId,
      memberCode: await nextSeq('memberCode', 1001),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source: lead.source,
      notes: lead.notes,
    });
  }
  lead.status = 'converted';
  lead.convertedMemberId = member._id;
  lead.nextFollowUpAt = null;
  await lead.save();
  await audit(req, 'lead.convert', { entity: 'Lead', entityId: lead._id, branchId: lead.branchId, details: { memberId: member._id } });
  res.json({ success: true, data: { lead, member } });
});

router.delete('/:id', permit('leads.write'), async (req, res) => {
  const lead = await findInBranch(req, Lead, req.params.id, { notFound: 'Lead not found', extra: { isDeleted: false } });
  lead.isDeleted = true;
  await lead.save();
  res.json({ success: true });
});

export default router;
