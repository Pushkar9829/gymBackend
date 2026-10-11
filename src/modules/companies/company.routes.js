import { Router } from 'express';
import { z } from 'zod';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees } from '../../utils/money.js';
import { ymd } from '../../utils/dates.js';
import { Company } from './company.model.js';
import { Member } from '../members/member.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const body = z.object({
  name: z.string().trim().min(2).max(100),
  gstin: z.string().trim().max(15).optional().or(z.literal('')),
  contactName: z.string().max(80).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  address: z.string().max(300).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  billTo: z.enum(['member', 'company']).optional(),
  isActive: z.boolean().optional(),
});

router.get('/', permit('members.read'), async (_req, res) => {
  const companies = await Company.find().sort({ name: 1 }).lean();
  const counts = await Member.aggregate([{ $match: { companyId: { $ne: null }, isDeleted: false } }, { $group: { _id: '$companyId', n: { $sum: 1 } } }]);
  const n = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json({ success: true, data: companies.map((c) => ({ ...c, members: n[String(c._id)] || 0 })) });
});

router.post('/', permit('plans.write'), validate({ body }), async (req, res) => {
  const c = await Company.create(req.body);
  await audit(req, 'company.create', { entity: 'Company', entityId: c._id });
  res.status(201).json({ success: true, data: c });
});

router.put('/:id', permit('plans.write'), validate({ body: body.partial() }), async (req, res) => {
  const c = await Company.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!c) throw ApiError.notFound('Company not found');
  await audit(req, 'company.update', { entity: 'Company', entityId: c._id, details: req.body });
  res.json({ success: true, data: c });
});

/** Employees, their memberships and what the company owes (company-billed memberships). */
router.get('/:id/statement', permit('payments.read'), async (req, res) => {
  const company = await Company.findById(req.params.id).lean();
  if (!company) throw ApiError.notFound('Company not found');
  const members = await Member.find({ companyId: company._id, isDeleted: false })
    .select('name memberCode phone membershipStatus membershipEnd currentPlanName dueAmount branchId')
    .sort({ name: 1 })
    .lean();
  const subs = await Subscription.find({ companyId: company._id, status: 'active' })
    .populate('memberId', 'name memberCode')
    .sort({ startDate: -1 })
    .lean();
  const billed = subs.filter((s) => s.billTo === 'company');
  const totals = billed.reduce((t, s) => ({ billed: t.billed + s.totalAmount, paid: t.paid + s.paidAmount, due: t.due + s.dueAmount }), { billed: 0, paid: 0, due: 0 });
  if (isExport(req.query)) {
    return sendExport(res, req.query.export, `statement-${company.name.replace(/\W+/g, '-')}`, subs, [
      { label: 'Member', value: (s) => s.memberId?.name },
      { label: 'Code', value: (s) => s.memberId?.memberCode },
      { label: 'Plan', value: (s) => s.plan?.name },
      { label: 'From', value: (s) => ymd(s.startDate) },
      { label: 'To', value: (s) => ymd(s.endDate) },
      { label: 'Billed to', key: 'billTo' },
      { label: 'Total (Rs)', value: (s) => toRupees(s.totalAmount) },
      { label: 'Paid (Rs)', value: (s) => toRupees(s.paidAmount) },
      { label: 'Due (Rs)', value: (s) => toRupees(s.dueAmount) },
    ]);
  }
  res.json({ success: true, data: { company, members, subscriptions: subs, totals } });
});

export default router;
