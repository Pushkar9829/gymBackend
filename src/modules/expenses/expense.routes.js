import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { parseDay, addDays } from '../../utils/dates.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees } from '../../utils/money.js';
import { Expense, EXPENSE_CATEGORIES } from './expense.model.js';
import { audit } from '../audit/audit.model.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const body = z.object({
  branchId: objectId,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.number().int().min(1),
  date: z.coerce.date(),
  mode: z.enum(['cash', 'upi', 'card', 'bank']).optional(),
  note: z.string().trim().max(300).optional(),
  billUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
});

function listFilter(req) {
  const q = req.query;
  const filter = { isDeleted: false, ...branchFilter(req) };
  if (q.category) filter.category = String(q.category);
  if (q.from || q.to) {
    filter.date = {};
    if (q.from) filter.date.$gte = parseDay(String(q.from));
    if (q.to) filter.date.$lt = addDays(parseDay(String(q.to)), 1);
  }
  return filter;
}

router.get('/', permit('expenses.read'), async (req, res) => {
  const filter = listFilter(req);
  if (isExport(req.query)) {
    const rows = await Expense.find(filter).sort({ date: -1 }).limit(20000).lean();
    return sendExport(res, req.query.export, 'expenses', rows, [
      { label: 'Date', value: (r) => r.date },
      { label: 'Category', key: 'category' },
      { label: 'Amount (Rs)', value: (r) => toRupees(r.amount) },
      { label: 'Mode', key: 'mode' },
      { label: 'Note', key: 'note' },
    ]);
  }
  const [data, byCategory] = await Promise.all([
    paginate(Expense, filter, req.query, { sort: { date: -1 }, populate: { path: 'createdBy', select: 'name' } }),
    Expense.aggregate([{ $match: filter }, { $group: { _id: '$category', amount: { $sum: '$amount' } } }, { $sort: { amount: -1 } }]),
  ]);
  const total = byCategory.reduce((s, c) => s + c.amount, 0);
  res.json({ success: true, data: { ...data, summary: { total, byCategory } } });
});

router.post('/', permit('expenses.write'), validate({ body }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const expense = await Expense.create({ ...req.body, createdBy: req.user._id });
  await audit(req, 'expense.create', { entity: 'Expense', entityId: expense._id, branchId: expense.branchId, details: { amount: expense.amount } });
  res.status(201).json({ success: true, data: expense });
});

router.put('/:id', permit('expenses.write'), validate({ body: body.partial() }), async (req, res) => {
  const expense = await findInBranch(req, Expense, req.params.id, { notFound: 'Expense not found', extra: { isDeleted: false } });
  if (req.body.branchId) assertBranchAccess(req, req.body.branchId);
  Object.assign(expense, req.body);
  await expense.save();
  await audit(req, 'expense.update', { entity: 'Expense', entityId: expense._id, branchId: expense.branchId, details: req.body });
  res.json({ success: true, data: expense });
});

router.delete('/:id', permit('expenses.write'), async (req, res) => {
  const expense = await findInBranch(req, Expense, req.params.id, { notFound: 'Expense not found', extra: { isDeleted: false } });
  expense.isDeleted = true;
  await expense.save();
  await audit(req, 'expense.delete', { entity: 'Expense', entityId: expense._id, branchId: expense.branchId });
  res.json({ success: true });
});

export default router;
