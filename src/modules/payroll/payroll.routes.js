import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { dayjs, tz } from '../../utils/dates.js';
import { Payslip } from './payroll.model.js';
import { generatePayroll, payPayslip, computeTotals } from './payroll.service.js';
import { payslipPdf } from './payslip.pdf.js';
import { getGym } from '../settings/gym.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const monthOf = (q) => (/^\d{4}-\d{2}$/.test(String(q.month)) ? String(q.month) : dayjs().tz(tz).subtract(1, 'month').format('YYYY-MM'));
const line = z.object({ label: z.string().trim().min(1).max(60), amount: z.number().int().min(0) });

async function loadPayslip(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Payslip not found');
  const p = await Payslip.findById(req.params.id);
  if (!p) throw ApiError.notFound('Payslip not found');
  if (p.branchId) assertBranchAccess(req, p.branchId);
  return p;
}

// Staff: own payslips (finalized / paid only)
router.get('/mine', async (req, res) => {
  const data = await Payslip.find({ userId: req.user._id, status: { $ne: 'draft' } }).sort({ month: -1 }).lean();
  res.json({ success: true, data });
});

router.get('/mine/:id/pdf', async (req, res) => {
  const p = await Payslip.findOne({ _id: req.params.id, userId: req.user._id, status: { $ne: 'draft' } }).populate('userId', 'name role email devicePin').lean();
  if (!p) throw ApiError.notFound('Payslip not found');
  sendPdf(res, p, await payslipPdf(p, await getGym()));
});

router.get('/', permit('payroll.manage'), async (req, res) => {
  const month = monthOf(req.query);
  const data = await Payslip.find({ month, ...branchFilter(req) }).populate('userId', 'name role').sort({ status: 1 }).lean();
  const totals = data.reduce((t, p) => ({ gross: t.gross + p.grossPay, net: t.net + p.netPay, paid: t.paid + (p.status === 'paid' ? p.netPay : 0) }), { gross: 0, net: 0, paid: 0 });
  res.json({ success: true, data: { month, items: data, totals } });
});

router.post('/generate', permit('payroll.manage'), validate({ body: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }) }), async (req, res) => {
  const bf = req.allowedBranchIds === null ? {} : { branchId: { $in: req.allowedBranchIds } };
  const r = await generatePayroll({ month: req.body.month, branchFilter: bf });
  await audit(req, 'payroll.generate', { entity: 'Payslip', details: { month: req.body.month, ...r } });
  res.json({ success: true, data: r });
});

router.put(
  '/:id',
  permit('payroll.manage'),
  validate({ body: z.object({ additions: z.array(line).max(10).optional(), deductions: z.array(line).max(10).optional(), paidLeaveDays: z.number().int().min(0).max(31).optional(), notes: z.string().max(300).optional() }) }),
  async (req, res) => {
    const p = await loadPayslip(req);
    if (p.status !== 'draft') throw ApiError.badRequest('Only draft payslips can be edited');
    if (req.body.paidLeaveDays != null && req.body.paidLeaveDays !== p.paidLeaveDays) {
      p.paidLeaveDays = req.body.paidLeaveDays;
      const counted = Math.min(p.workingDays, p.daysPresent + p.paidLeaveDays);
      p.basePay = p.salaryType === 'per-day' ? p.rate * counted : Math.round((p.rate * counted) / p.workingDays);
    }
    if (req.body.additions) p.additions = req.body.additions;
    if (req.body.deductions) p.deductions = req.body.deductions;
    if (req.body.notes !== undefined) p.notes = req.body.notes;
    Object.assign(p, computeTotals(p));
    await p.save();
    res.json({ success: true, data: p });
  },
);

router.post('/:id/finalize', permit('payroll.manage'), async (req, res) => {
  const p = await loadPayslip(req);
  if (p.status !== 'draft') throw ApiError.badRequest('Already finalized');
  p.status = 'finalized';
  await p.save();
  await audit(req, 'payroll.finalize', { entity: 'Payslip', entityId: p._id, details: { month: p.month, net: p.netPay } });
  res.json({ success: true, data: p });
});

router.post('/:id/reopen', permit('payroll.manage'), async (req, res) => {
  const p = await loadPayslip(req);
  if (p.status !== 'finalized') throw ApiError.badRequest('Only finalized (unpaid) payslips can be reopened');
  p.status = 'draft';
  await p.save();
  res.json({ success: true, data: p });
});

router.post(
  '/:id/pay',
  permit('payroll.manage'),
  validate({ body: z.object({ mode: z.enum(['cash', 'upi', 'bank']), reference: z.string().trim().max(100).optional() }) }),
  async (req, res) => {
    const p = await loadPayslip(req);
    const paid = await payPayslip({ payslip: p, ...req.body, user: req.user });
    await audit(req, 'payroll.pay', { entity: 'Payslip', entityId: p._id, details: { month: p.month, net: p.netPay, mode: req.body.mode } });
    res.json({ success: true, data: paid });
  },
);

router.get('/:id/pdf', permit('payroll.manage'), async (req, res) => {
  const p = await loadPayslip(req);
  await p.populate('userId', 'name role email devicePin');
  sendPdf(res, p.toObject(), await payslipPdf(p.toObject(), await getGym()));
});

function sendPdf(res, p, pdf) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${p.month}-${String(p.userId?.name || '').replace(/\W+/g, '-')}.pdf"`);
  res.send(pdf);
}

export default router;
