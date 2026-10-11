import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import QRCode from 'qrcode';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate, escapeRegex } from '../../utils/pagination.js';
import { addDays, startOfDay } from '../../utils/dates.js';
import { nextSeq } from '../../utils/counter.js';
import { Member, MEMBERSHIP_STATUS } from './member.model.js';
import { refreshMember, loadAccess } from './member.state.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Payment } from '../payments/payment.model.js';
import { Attendance } from '../attendance/attendance.model.js';
import { AccessLog } from '../access/accessLog.model.js';
import { DeviceUser } from '../devices/device.model.js';
import { removeMemberFromDevices } from '../devices/device.sync.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';
import { qrPayload } from '../access/qr.js';
import { audit } from '../audit/audit.model.js';
import { can } from '../../config/permissions.js';
import { trainerMemberFilter, loadAccessibleMember } from './trainerScope.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const phone = z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number');
const optionalStr = (max = 200) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

const memberBody = z.object({
  branchId: objectId,
  name: z.string().trim().min(2).max(80),
  phone,
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dob: z.coerce.date().optional(),
  photoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  address: optionalStr(300),
  emergencyContact: z.object({ name: optionalStr(80), phone: optionalStr(15), relation: optionalStr(40) }).optional(),
  healthNotes: optionalStr(1000),
  trainerId: objectId.optional().nullable(),
  companyId: objectId.optional().nullable(),
  cardNo: z.string().trim().regex(/^\d{4,20}$/, 'Card number must be 4-20 digits').optional().nullable().or(z.literal('').transform(() => null)),
  source: optionalStr(40),
  notes: optionalStr(1000),
  joinedAt: z.coerce.date().optional(),
});

const MEMBER_CODE_START = 1001;

// Trainers only see members assigned to them or their PT clients.
const loadMember = (req, id, opts) => loadAccessibleMember(req, id, opts);
const newMemberCode = () => nextSeq('memberCode', MEMBER_CODE_START);

router.get('/', permit('members.read'), async (req, res) => {
  const q = req.query;
  const showDeleted = q.deleted === 'true' && can(req.user.role, 'members.delete');
  const filter = { isDeleted: showDeleted, ...branchFilter(req), ...(await trainerMemberFilter(req.user)) };
  if (q.status && MEMBERSHIP_STATUS.includes(q.status)) filter.membershipStatus = q.status;
  if (q.blocked === 'true') filter.isBlocked = true;
  if (q.due === 'true') filter.dueAmount = { $gt: 0 };
  if (q.trainerId && mongoose.isValidObjectId(q.trainerId)) filter.trainerId = q.trainerId;
  if (q.expiringInDays) {
    const days = Math.min(60, Math.max(0, Number(q.expiringInDays) || 7));
    filter.membershipStatus = { $in: ['active', 'frozen'] };
    filter.membershipEnd = { $gte: startOfDay(), $lte: addDays(startOfDay(), days) };
  }
  if (q.search) {
    const s = String(q.search).trim();
    const rx = new RegExp(escapeRegex(s), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    if (/^\d+$/.test(s)) filter.$or.push({ memberCode: Number(s) });
  }
  const sort = q.sort === 'name' ? { name: 1 } : q.sort === 'end' ? { membershipEnd: 1 } : { createdAt: -1 };
  const data = await paginate(Member, filter, q, { sort, populate: { path: 'trainerId', select: 'name' } });
  res.json({ success: true, data });
});

router.post('/', permit('members.write'), validate({ body: memberBody.extend({ portalPassword: z.string().min(8).optional() }) }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const { portalPassword, ...data } = req.body;
  const existing = await Member.findOne({ phone: data.phone, isDeleted: false }).select('name memberCode').lean();
  if (existing && !req.query.allowDuplicatePhone) {
    throw ApiError.conflict(`Phone already registered to ${existing.name} (#${existing.memberCode})`);
  }
  const member = await Member.create({
    ...data,
    cardNo: data.cardNo || undefined, // never store null: the unique sparse index allows only one null
    memberCode: await newMemberCode(),
    ...(portalPassword ? { portalEnabled: true, passwordHash: await hashPassword(portalPassword) } : {}),
  });
  await audit(req, 'member.create', { entity: 'Member', entityId: member._id, branchId: member.branchId });
  res.status(201).json({ success: true, data: member });
});

router.post(
  '/import',
  permit('members.write'),
  validate({ body: z.object({ branchId: objectId, rows: z.array(memberBody.omit({ branchId: true })).min(1).max(1000) }) }),
  async (req, res) => {
    assertBranchAccess(req, req.body.branchId);
    const results = { created: 0, skipped: [] };
    for (const [i, row] of req.body.rows.entries()) {
      if (await Member.exists({ phone: row.phone, isDeleted: false })) {
        results.skipped.push({ row: i + 1, phone: row.phone, reason: 'Phone already exists' });
        continue;
      }
      await Member.create({ ...row, cardNo: row.cardNo || undefined, branchId: req.body.branchId, memberCode: await newMemberCode() });
      results.created += 1;
    }
    await audit(req, 'member.import', { entity: 'Member', branchId: req.body.branchId, details: { created: results.created } });
    res.json({ success: true, data: results });
  },
);

router.get('/:id', permit('members.read'), async (req, res) => {
  const member = await loadMember(req, req.params.id);
  await member.populate([{ path: 'trainerId', select: 'name phone' }, { path: 'branchId', select: 'name code' }, { path: 'companyId', select: 'name discountPercent billTo' }]);
  const { access, subscriptions } = await loadAccess(member);
  const deviceUsers = await DeviceUser.find({ memberId: member._id }).populate('deviceId', 'name serialNo lastSeenAt').lean();
  subscriptions.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
  res.json({
    success: true,
    data: { member, access: { ...access, current: undefined }, subscriptions, deviceUsers },
  });
});

router.put('/:id', permit('members.write'), validate({ body: memberBody.partial() }), async (req, res) => {
  const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
  const oldBranch = String(member.branchId);
  if (req.body.branchId) assertBranchAccess(req, req.body.branchId);
  const { cardNo, ...changes } = req.body;
  Object.assign(member, changes);
  // null / '' removes the card. Unset it instead of storing null: the unique sparse index allows only one null.
  if (cardNo !== undefined) member.cardNo = cardNo || undefined;
  await member.save();
  if (req.body.branchId && req.body.branchId !== oldBranch) {
    await removeMemberFromDevices(member, { branchId: oldBranch });
    await Subscription.updateMany({ memberId: member._id }, { branchId: member.branchId });
  }
  await refreshMember(member.toObject());
  await audit(req, 'member.update', { entity: 'Member', entityId: member._id, branchId: member.branchId, details: req.body });
  res.json({ success: true, data: member });
});

router.delete('/:id', permit('members.delete'), async (req, res) => {
  const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
  member.isDeleted = true;
  member.portalEnabled = false;
  await member.save();
  await removeMemberFromDevices(member);
  await revokeAllSessions(member._id);
  await audit(req, 'member.delete', { entity: 'Member', entityId: member._id, branchId: member.branchId });
  res.json({ success: true });
});

router.post(
  '/:id/documents',
  permit('members.write'),
  validate({ body: z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['id-proof', 'medical', 'waiver', 'photo', 'other']).default('other'), url: z.string().url() }) }),
  async (req, res) => {
    const member = await loadMember(req, req.params.id);
    if (member.documents.length >= 20) throw ApiError.badRequest('Maximum 20 documents per member');
    member.documents.push({ ...req.body, uploadedBy: req.user._id });
    await member.save();
    await audit(req, 'member.document.add', { entity: 'Member', entityId: member._id, details: { name: req.body.name, kind: req.body.kind } });
    res.status(201).json({ success: true, data: member.documents });
  },
);

router.delete('/:id/documents/:docId', permit('members.write'), async (req, res) => {
  const member = await loadMember(req, req.params.id);
  const doc = member.documents.id(req.params.docId);
  if (!doc) throw ApiError.notFound('Document not found');
  doc.deleteOne();
  await member.save();
  await audit(req, 'member.document.remove', { entity: 'Member', entityId: member._id, details: { name: doc.name } });
  res.json({ success: true, data: member.documents });
});

router.post('/:id/restore', permit('members.delete'), async (req, res) => {
  const member = await loadMember(req, req.params.id, { deleted: true });
  const clash = await Member.findOne({ phone: member.phone, isDeleted: false, _id: { $ne: member._id } }).select('name memberCode').lean();
  if (clash) throw ApiError.conflict(`Phone ${member.phone} now belongs to ${clash.name} (#${clash.memberCode})`);
  member.isDeleted = false;
  await member.save();
  // Back on the devices if they still have a valid membership (fingerprints must be re-enrolled).
  const access = await refreshMember(member.toObject(), { force: true });
  await audit(req, 'member.restore', { entity: 'Member', entityId: member._id, branchId: member.branchId });
  res.json({ success: true, data: { member, access: { ...access, current: undefined } } });
});

router.post('/:id/block', permit('members.write'), validate({ body: z.object({ reason: z.string().trim().min(2).max(200) }) }), async (req, res) => {
  const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
  member.isBlocked = true;
  member.blockReason = req.body.reason;
  await member.save();
  const access = await refreshMember(member.toObject());
  await audit(req, 'member.block', { entity: 'Member', entityId: member._id, branchId: member.branchId, details: req.body });
  res.json({ success: true, data: { member, access } });
});

router.post('/:id/unblock', permit('members.write'), async (req, res) => {
  const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
  member.isBlocked = false;
  member.blockReason = undefined;
  await member.save();
  const access = await refreshMember(member.toObject());
  await audit(req, 'member.unblock', { entity: 'Member', entityId: member._id, branchId: member.branchId });
  res.json({ success: true, data: { member, access } });
});

router.post(
  '/:id/portal',
  permit('members.write'),
  validate({ body: z.object({ enabled: z.boolean(), password: z.string().min(8).max(100).optional() }) }),
  async (req, res) => {
    const member = await Member.findOne({ _id: req.params.id, isDeleted: false }).select('+passwordHash');
    if (!member) throw ApiError.notFound('Member not found');
    assertBranchAccess(req, member.branchId);
    if (req.body.enabled && !req.body.password && !member.passwordHash) throw ApiError.badRequest('Set a password to enable portal access');
    member.portalEnabled = req.body.enabled;
    if (req.body.password) member.passwordHash = await hashPassword(req.body.password);
    await member.save();
    if (!req.body.enabled || req.body.password) await revokeAllSessions(member._id);
    await audit(req, 'member.portal', { entity: 'Member', entityId: member._id, details: { enabled: req.body.enabled } });
    res.json({ success: true, data: { portalEnabled: member.portalEnabled } });
  },
);

router.put(
  '/:id/biometric',
  permit('members.write'),
  validate({ body: z.object({ consent: z.boolean().optional(), fingerEnrolled: z.boolean().optional(), faceEnrolled: z.boolean().optional() }) }),
  async (req, res) => {
    const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
    const { consent, ...flags } = req.body;
    if ((flags.fingerEnrolled || flags.faceEnrolled) && !member.biometric?.consentAt && !consent) {
      throw ApiError.badRequest('Record the member\'s biometric consent before enrolment');
    }
    if (consent) member.biometric = { ...member.biometric?.toObject?.(), consentAt: new Date(), consentBy: req.user._id };
    Object.assign(member.biometric, flags);
    await member.save();
    // Make sure the user exists on the device so enrolment can be done at the terminal.
    await refreshMember(member.toObject(), { force: true });
    await audit(req, 'member.biometric', { entity: 'Member', entityId: member._id, details: req.body });
    res.json({ success: true, data: member.biometric });
  },
);

router.post('/:id/resync', permit('members.write'), async (req, res) => {
  const member = await findInBranch(req, Member, req.params.id, { notFound: 'Member not found', extra: { isDeleted: false } });
  const access = await refreshMember(member.toObject(), { force: true });
  res.json({ success: true, data: { access: { ...access, current: undefined } } });
});

router.get('/:id/card', permit('members.read'), async (req, res) => {
  const member = await loadMember(req, req.params.id);
  const payload = qrPayload(member.memberCode);
  res.json({ success: true, data: { payload, qr: await QRCode.toDataURL(payload, { margin: 1, width: 300 }) } });
});

router.get('/:id/timeline', permit('members.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.params.id);
  const [payments, attendance, accessLogs] = await Promise.all([
    Payment.find({ memberId: member._id }).sort({ paidAt: -1 }).limit(100).populate('receivedBy', 'name').lean(),
    Attendance.find({ memberId: member._id }).sort({ checkInAt: -1 }).limit(60).lean(),
    AccessLog.find({ memberId: member._id }).sort({ at: -1 }).limit(60).populate('deviceId', 'name').lean(),
  ]);
  res.json({ success: true, data: { payments, attendance, accessLogs } });
});

export default router;
