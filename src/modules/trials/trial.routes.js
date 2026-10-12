import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate, escapeRegex } from '../../utils/pagination.js';
import { nextSeq } from '../../utils/counter.js';
import { addDays, asGymDay, dmy, startOfDay, ymd } from '../../utils/dates.js';
import { can } from '../../config/permissions.js';
import { Member } from '../members/member.model.js';
import { Lead } from '../leads/lead.model.js';
import { Payment } from '../payments/payment.model.js';
import { Attendance } from '../attendance/attendance.model.js';
import { getGym } from '../settings/gym.model.js';
import { refreshMember } from '../members/member.state.js';
import { nextReceiptNo } from '../subscriptions/subscription.service.js';
import { audit } from '../audit/audit.model.js';
import { trialSettings, phoneMatcher, trialStatus, trialStatusFilter, lastTrialFor, nextTrialDay, convertTrial } from './trial.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const STATUSES = ['active', 'upcoming', 'ended', 'converted', 'all'];

router.get('/', permit('trials.write'), async (req, res) => {
  const q = req.query;
  const status = STATUSES.includes(q.status) ? q.status : 'all';
  const scope = { isDeleted: false, ...branchFilter(req) };
  const filter = { ...scope, ...trialStatusFilter(status) };
  if (q.search) {
    const s = String(q.search).trim();
    const rx = new RegExp(escapeRegex(s), 'i');
    filter.$and = [{ $or: [{ name: rx }, { phone: rx }, ...(/^\d+$/.test(s) ? [{ memberCode: Number(s) }] : [])] }];
  }
  const [data, ...counts] = await Promise.all([
    paginate(Member, filter, q, {
      sort: status === 'upcoming' ? { 'trial.from': 1 } : { 'trial.issuedAt': -1 },
      select: 'name phone email memberCode branchId isTrial trial lastVisitAt isBlocked',
      populate: [{ path: 'trial.issuedBy', select: 'name' }],
    }),
    ...['active', 'upcoming', 'ended', 'converted'].map((s) => Member.countDocuments({ ...scope, ...trialStatusFilter(s) })),
  ]);
  // Visits made on the trial pass (attendance rows flagged as trial).
  const ids = data.items.map((m) => m._id);
  const visits = ids.length ? await Attendance.aggregate([{ $match: { memberId: { $in: ids }, isTrial: true } }, { $group: { _id: '$memberId', n: { $sum: 1 } } }]) : [];
  const byId = Object.fromEntries(visits.map((v) => [String(v._id), v.n]));
  const items = data.items.map((m) => ({ ...(m.toObject ? m.toObject() : m), status: trialStatus(m), visits: byId[String(m._id)] || 0 }));
  const [active, upcoming, ended, converted] = counts;
  res.json({ success: true, data: { ...data, items, counts: { active, upcoming, ended, converted } } });
});

const issueBody = z
  .object({
    branchId: objectId.optional(),
    leadId: objectId.optional(),
    name: z.string().trim().min(2).max(80).optional(),
    phone: z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number').optional(),
    email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
    days: z.number().int().min(1).max(3).optional(),
    startDate: z.coerce.date().optional(),
    fee: z.number().int().min(0).max(10000000).default(0), // paise; 0 = free
    mode: z.enum(['cash', 'upi', 'card', 'bank']).default('cash'),
    reference: z.string().trim().max(100).optional(),
    override: z.boolean().default(false),
    overrideReason: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.leadId || (b.branchId && b.name && b.phone), 'Choose a lead, or enter the name and phone');

router.post('/', permit('trials.write'), validate({ body: issueBody }), async (req, res) => {
  const b = req.body;
  const gym = await getGym();
  const cfg = trialSettings(gym.settings);
  if (!cfg.enabled) throw ApiError.badRequest('Trial passes are switched off in Settings');
  const days = b.days || cfg.defaultDays;
  if (days > cfg.maxDays) throw ApiError.badRequest(`A trial can be at most ${cfg.maxDays} day(s)`);

  let lead = null;
  let who = { branchId: b.branchId, name: b.name, phone: b.phone, email: b.email };
  if (b.leadId) {
    lead = await findInBranch(req, Lead, b.leadId, { notFound: 'Lead not found', extra: { isDeleted: false } });
    if (lead.status === 'converted') throw ApiError.badRequest('This lead is already a member');
    who = { branchId: String(lead.branchId), name: lead.name, phone: lead.phone, email: lead.email };
  }
  assertBranchAccess(req, who.branchId);

  const today = startOfDay();
  const from = b.startDate ? asGymDay(b.startDate) : today;
  if (ymd(from) < ymd(today)) throw ApiError.badRequest('A trial cannot start in the past');
  if (ymd(from) > ymd(addDays(today, 30))) throw ApiError.badRequest('A trial can start at most 30 days ahead');
  const to = startOfDay(addDays(from, days - 1));

  const phoneRx = phoneMatcher(who.phone);
  const member = await Member.findOne({ phone: phoneRx, isDeleted: false, isTrial: { $ne: true } }).select('name memberCode').lean();
  if (member) throw ApiError.conflict(`${member.name} (#${member.memberCode}) is already a member with this phone number`);
  let visitor = await Member.findOne({ phone: phoneRx, isDeleted: false, isTrial: true });
  const running = visitor && ['active', 'upcoming'].includes(trialStatus(visitor));
  if (running) throw ApiError.conflict(`${visitor.name} already has a trial pass till ${dmy(visitor.trial.to)}`);

  // One trial per phone number in `repeatDays` days, unless the owner / a manager overrides it.
  const last = await lastTrialFor(who.phone);
  const nextDay = last ? nextTrialDay(last.trial.issuedAt, cfg.repeatDays) : null;
  const blocked = Boolean(nextDay && ymd(today) < ymd(nextDay));
  if (blocked) {
    if (!b.override) {
      throw ApiError.conflict(`A trial was given to this number on ${dmy(last.trial.issuedAt)}. Next trial allowed from ${dmy(nextDay)}`);
    }
    if (!can(req.user.role, 'trials.override')) throw ApiError.forbidden('Only the owner or a manager can give another trial so soon');
  }

  if (!lead) {
    lead = await Lead.findOne({ phone: phoneRx, isDeleted: false, status: { $in: ['new', 'contacted', 'trial', 'lost'] } }).sort({ createdAt: -1 });
  }

  const trial = {
    from,
    to,
    days,
    fee: b.fee,
    leadId: lead?._id,
    issuedAt: new Date(),
    issuedBy: req.user._id,
    override: blocked || undefined,
    overrideReason: blocked ? b.overrideReason : undefined,
    count: (visitor?.trial?.count || last?.trial?.count || 0) + 1,
  };
  if (visitor) {
    Object.assign(visitor, { name: who.name, email: who.email || visitor.email, branchId: who.branchId, trial });
    await visitor.save();
  } else {
    visitor = await Member.create({
      branchId: who.branchId,
      memberCode: await nextSeq('memberCode', 1001),
      name: who.name,
      phone: who.phone,
      email: who.email,
      source: lead?.source || 'walk-in',
      isTrial: true,
      trial,
    });
  }

  let payment = null;
  if (b.fee > 0) {
    payment = await Payment.create({
      receiptNo: await nextReceiptNo(gym),
      memberId: visitor._id,
      branchId: visitor.branchId,
      trialFee: true,
      amount: b.fee,
      mode: b.mode,
      reference: b.reference,
      note: `Trial pass ${dmy(from)} to ${dmy(to)}`,
      receivedBy: req.user._id,
    });
    visitor.trial.paymentId = payment._id;
    await visitor.save();
  }

  if (lead) {
    lead.status = 'trial';
    lead.trialFrom = from;
    lead.trialTo = to;
    lead.nextFollowUpAt = to; // ask about joining on the last trial day
    lead.followUps.push({ note: `Trial pass given: ${dmy(from)} to ${dmy(to)}${b.fee ? ` (paid)` : ''}`, by: req.user._id });
    await lead.save();
  }

  const access = await refreshMember(visitor.toObject());
  await audit(req, 'trial.issue', {
    entity: 'Member',
    entityId: visitor._id,
    branchId: visitor.branchId,
    details: { from: ymd(from), to: ymd(to), fee: b.fee, leadId: lead?._id, override: blocked || undefined, reason: blocked ? b.overrideReason : undefined },
  });
  res.status(201).json({ success: true, data: { member: visitor, payment, lead, access: access && { ...access, current: undefined } } });
});

/** Ends a running trial now: entry stops and the devices are updated. */
router.post('/:id/end', permit('trials.write'), async (req, res) => {
  const m = await findInBranch(req, Member, req.params.id, { notFound: 'Trial not found', extra: { isDeleted: false, isTrial: true } });
  if (trialStatus(m) === 'ended') throw ApiError.badRequest('This trial has already ended');
  m.trial.endedAt = new Date();
  m.trial.endedBy = req.user._id;
  await m.save();
  const access = await refreshMember(m.toObject());
  await audit(req, 'trial.end', { entity: 'Member', entityId: m._id, branchId: m.branchId });
  res.json({ success: true, data: { member: m, access: access && { ...access, current: undefined } } });
});

/** Trial visitor joins: becomes a normal member (same code and visit history). Add the membership next. */
router.post('/:id/convert', permit('trials.write', 'members.write'), async (req, res) => {
  const m = await findInBranch(req, Member, req.params.id, { notFound: 'Trial not found', extra: { isDeleted: false, isTrial: true } });
  const { member, lead } = await convertTrial(m, req.user);
  await audit(req, 'trial.convert', { entity: 'Member', entityId: member._id, branchId: member.branchId, details: { leadId: lead?._id } });
  res.json({ success: true, data: { member, lead } });
});

/** Is a trial allowed for this phone number? Used by the issue form to warn early. */
router.get('/check', permit('trials.write'), validate({ query: z.object({ phone: z.string().trim().regex(/^\+?\d{10,13}$/) }) }), async (req, res) => {
  const gym = await getGym();
  const cfg = trialSettings(gym.settings);
  const phoneRx = phoneMatcher(req.query.phone);
  const member = await Member.findOne({ phone: phoneRx, isDeleted: false, isTrial: { $ne: true } }).select('name memberCode').lean();
  const last = await lastTrialFor(req.query.phone);
  const nextDay = last ? nextTrialDay(last.trial.issuedAt, cfg.repeatDays) : null;
  res.json({
    success: true,
    data: {
      member: member || null,
      lastTrialAt: last?.trial?.issuedAt || null,
      nextAllowedOn: nextDay && ymd(new Date()) < ymd(nextDay) ? nextDay : null,
    },
  });
});

export default router;
