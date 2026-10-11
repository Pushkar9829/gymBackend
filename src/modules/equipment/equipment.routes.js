import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, startOfDay } from '../../utils/dates.js';
import { Equipment, MaintenanceLog, EQUIPMENT_CATEGORIES, EQUIPMENT_STATUS } from './equipment.model.js';
import { Expense } from '../expenses/expense.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { audit } from '../audit/audit.model.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const optDate = z.coerce.date().optional().nullable();
const body = z.object({
  branchId: objectId,
  name: z.string().trim().min(2).max(80),
  category: z.enum(EQUIPMENT_CATEGORIES).optional(),
  brand: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
  serialNo: z.string().max(60).optional(),
  location: z.string().max(60).optional(),
  purchaseDate: optDate,
  cost: z.number().int().min(0).optional().nullable(),
  vendor: z.string().max(80).optional(),
  vendorPhone: z.string().max(20).optional(),
  warrantyUntil: optDate,
  serviceIntervalDays: z.number().int().min(0).max(730).optional(),
  lastServiceAt: optDate,
  notes: z.string().max(500).optional(),
});

const nextDue = (e) => (e.serviceIntervalDays ? addDays(e.lastServiceAt || e.purchaseDate || new Date(), e.serviceIntervalDays) : null);

router.get('/', permit('equipment.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.status && EQUIPMENT_STATUS.includes(q.status)) filter.status = q.status;
  else filter.status = { $ne: 'retired' };
  if (q.category) filter.category = String(q.category);
  if (q.due === 'true') filter.nextServiceDue = { $lte: addDays(startOfDay(), 7) };
  const [items, counts] = await Promise.all([
    Equipment.find(filter).sort({ status: 1, nextServiceDue: 1, name: 1 }).lean(),
    Equipment.aggregate([{ $match: branchFilter(req) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const dueSoon = await Equipment.countDocuments({ ...branchFilter(req), status: { $ne: 'retired' }, nextServiceDue: { $lte: addDays(startOfDay(), 7) } });
  res.json({ success: true, data: { items, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), dueSoon } });
});

router.post('/', permit('equipment.manage'), validate({ body }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const e = new Equipment(req.body);
  e.nextServiceDue = nextDue(e);
  await e.save();
  await audit(req, 'equipment.create', { entity: 'Equipment', entityId: e._id, branchId: e.branchId });
  res.status(201).json({ success: true, data: e });
});

router.put('/:id', permit('equipment.manage'), validate({ body: body.partial().extend({ status: z.enum(EQUIPMENT_STATUS).optional() }) }), async (req, res) => {
  const e = await findInBranch(req, Equipment, req.params.id, { notFound: 'Equipment not found' });
  if (req.body.branchId) assertBranchAccess(req, req.body.branchId);
  Object.assign(e, req.body);
  if ('serviceIntervalDays' in req.body || 'lastServiceAt' in req.body) e.nextServiceDue = nextDue(e);
  await e.save();
  res.json({ success: true, data: e });
});

router.get('/:id/logs', permit('equipment.read'), async (req, res) => {
  const e = await findInBranch(req, Equipment, req.params.id, { notFound: 'Equipment not found' });
  res.json({ success: true, data: await paginate(MaintenanceLog, { equipmentId: e._id }, req.query, { sort: { date: -1 }, populate: { path: 'by', select: 'name' } }) });
});

/**
 * Any staff can report a problem (status -> needs-repair / out-of-order).
 * Managers log service / repair work; a cost is booked as a maintenance expense.
 */
router.post(
  '/:id/logs',
  permit('equipment.read'),
  validate({
    body: z.object({
      type: z.enum(['service', 'repair', 'inspection', 'issue-reported']),
      date: z.coerce.date().optional(),
      cost: z.number().int().min(0).default(0),
      vendor: z.string().max(80).optional(),
      notes: z.string().trim().max(500).optional(),
      statusAfter: z.enum(EQUIPMENT_STATUS).optional(),
    }),
  }),
  async (req, res) => {
    const e = await findInBranch(req, Equipment, req.params.id, { notFound: 'Equipment not found' });
    const isReport = req.body.type === 'issue-reported';
    if (!isReport && !can(req.user.role, 'equipment.manage')) {
      throw ApiError.forbidden('You can report an issue; service and repair entries need the equipment manager permission');
    }
    const date = req.body.date || new Date();
    let expense = null;
    if (req.body.cost > 0) {
      expense = await Expense.create({ branchId: e.branchId, category: 'maintenance', amount: req.body.cost, date, note: `${req.body.type}: ${e.name}${req.body.vendor ? ` (${req.body.vendor})` : ''}`, createdBy: req.user._id });
    }
    const statusAfter = req.body.statusAfter || (isReport ? 'needs-repair' : 'working');
    const log = await MaintenanceLog.create({ ...req.body, date, equipmentId: e._id, branchId: e.branchId, statusAfter, expenseId: expense?._id, by: req.user._id });

    e.status = statusAfter;
    e.issue = statusAfter === 'working' ? undefined : req.body.notes || e.issue;
    if (req.body.type === 'service') {
      e.lastServiceAt = date;
      e.nextServiceDue = nextDue(e);
    }
    await e.save();
    if (isReport) {
      await createAlert({ branchId: e.branchId, template: 'equipment-issue', subject: `Equipment problem: ${e.name}`, body: req.body.notes || statusAfter, dedupeKey: `eq-issue:${log._id}` });
    }
    res.status(201).json({ success: true, data: { log, equipment: e } });
  },
);

export default router;

/** Daily job: alert for equipment whose service is due within 3 days or overdue. */
export async function equipmentServiceAlerts({ now = new Date() } = {}) {
  const due = await Equipment.find({ status: { $ne: 'retired' }, nextServiceDue: { $lte: addDays(startOfDay(now), 3) } }).lean();
  let n = 0;
  for (const e of due) {
    const overdue = e.nextServiceDue < startOfDay(now);
    const a = await createAlert({
      branchId: e.branchId,
      template: 'equipment-service',
      subject: `${overdue ? 'Service overdue' : 'Service due'}: ${e.name}`,
      body: e.vendor ? `Vendor: ${e.vendor} ${e.vendorPhone || ''}` : 'Log the service in Equipment when done',
      dedupeKey: `eq-service:${e._id}:${e.nextServiceDue.toISOString().slice(0, 10)}`,
    });
    if (a) n += 1;
  }
  return n;
}
