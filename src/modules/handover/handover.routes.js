import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, asGymDay, dmy, parseDay } from '../../utils/dates.js';
import { can } from '../../config/permissions.js';
import { User } from '../users/user.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { audit } from '../audit/audit.model.js';
import { HandoverNote } from './handover.model.js';

const router = Router();
router.use(requireStaff);

export const EDIT_MINUTES = 15;
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const POPULATE = [
  { path: 'createdBy', select: 'name role' },
  { path: 'assignedTo', select: 'name role' },
  { path: 'doneBy', select: 'name' },
  { path: 'acks.userId', select: 'name' },
];
const mine = (req, id) => String(id?._id || id) === String(req.user._id);
const canEdit = (req, note) => mine(req, note.createdBy) && Date.now() - new Date(note.createdAt) <= EDIT_MINUTES * 60000;

/** Staff a task can be given to: active, can see the board, works in the branch. */
async function checkAssignee(assignedTo, branchId) {
  if (!assignedTo) return null;
  const u = await User.findOne({ _id: assignedTo, isActive: true }).select('name role branchIds').lean();
  const inBranch = u && (u.role === 'owner' || (u.branchIds || []).map(String).includes(String(branchId)));
  if (!u || !inBranch || !can(u.role, 'handover.read')) throw ApiError.badRequest('Choose a staff member of this branch');
  return u;
}

async function alertAssignee(req, note, assignee) {
  if (!assignee || mine(req, assignee._id)) return;
  await createAlert({
    branchId: note.branchId,
    template: 'handover-task',
    subject: `Task for you from ${req.user.name}`,
    body: `${note.text.slice(0, 140)}${note.dueDate ? ` (by ${dmy(note.dueDate)})` : ''}`,
    dedupeKey: `handover:${note._id}:${assignee._id}`,
    userIds: [assignee._id],
  });
}

const withFlags = (req, n) => ({
  ...n,
  canEdit: canEdit(req, n),
  canDelete: canEdit(req, n) || can(req.user.role, 'handover.manage'),
  acked: (n.acks || []).some((a) => mine(req, a.userId)),
});

/** Dashboard card: open tasks, and notes from the last 24 hours I have not acknowledged yet. */
router.get('/board', permit('handover.read'), async (req, res) => {
  const scope = { ...branchFilter(req), isDeleted: false };
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [tasks, notes, openTasks] = await Promise.all([
    HandoverNote.find({ ...scope, isTask: true, doneAt: null }).sort({ createdAt: -1 }).limit(50).populate(POPULATE).lean(),
    HandoverNote.find({ ...scope, isTask: false, createdAt: { $gte: since }, createdBy: { $ne: req.user._id }, 'acks.userId': { $ne: req.user._id } })
      .sort({ important: -1, createdAt: -1 })
      .limit(20)
      .populate(POPULATE)
      .lean(),
    HandoverNote.countDocuments({ ...scope, isTask: true, doneAt: null }),
  ]);
  // Mine first, then important, then by due date.
  const rank = (t) => [mine(req, t.assignedTo) ? 0 : 1, t.important ? 0 : 1, t.dueDate ? new Date(t.dueDate).getTime() : Infinity];
  tasks.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  res.json({ success: true, data: { tasks: tasks.slice(0, 20).map((n) => withFlags(req, n)), notes: notes.map((n) => withFlags(req, n)), openTasks } });
});

router.get('/', permit('handover.read'), async (req, res) => {
  const q = req.query;
  const filter = { ...branchFilter(req), isDeleted: false };
  if (q.status === 'open') Object.assign(filter, { isTask: true, doneAt: null });
  else if (q.status === 'done') Object.assign(filter, { isTask: true, doneAt: { $ne: null } });
  else if (q.status === 'notes') filter.isTask = false;
  if (q.date && /^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) {
    const from = parseDay(String(q.date));
    filter.createdAt = { $gte: from, $lt: addDays(from, 1) };
  }
  if (q.mine === 'true') filter.assignedTo = req.user._id;
  const data = await paginate(HandoverNote, filter, q, { sort: q.status === 'done' ? { doneAt: -1 } : { createdAt: -1 }, populate: POPULATE });
  res.json({ success: true, data: { ...data, items: data.items.map((n) => withFlags(req, n)), editMinutes: EDIT_MINUTES } });
});

/** Staff who can be given a task in a branch. */
router.get('/staff', permit('handover.write'), async (req, res) => {
  const branchId = req.query.branchId;
  if (branchId) assertBranchAccess(req, branchId);
  const users = await User.find({ isActive: true, ...(branchId ? { $or: [{ role: 'owner' }, { branchIds: new mongoose.Types.ObjectId(String(branchId)) }] } : {}) })
    .select('name role')
    .sort({ name: 1 })
    .lean();
  res.json({ success: true, data: users.filter((u) => can(u.role, 'handover.read')) });
});

const body = z.object({
  branchId: objectId,
  text: z.string().trim().min(2).max(1000),
  isTask: z.boolean().default(false),
  dueDate: z.coerce.date().optional().nullable(),
  assignedTo: objectId.optional().nullable(),
  important: z.boolean().default(false),
});

router.post('/', permit('handover.write'), validate({ body }), async (req, res) => {
  const b = req.body;
  assertBranchAccess(req, b.branchId);
  const assignee = b.isTask ? await checkAssignee(b.assignedTo, b.branchId) : null;
  const note = await HandoverNote.create({
    branchId: b.branchId,
    text: b.text,
    isTask: b.isTask,
    dueDate: b.isTask && b.dueDate ? asGymDay(b.dueDate) : undefined,
    assignedTo: assignee?._id,
    important: b.important,
    createdBy: req.user._id,
  });
  await alertAssignee(req, note, assignee);
  await audit(req, 'handover.create', { entity: 'HandoverNote', entityId: note._id, branchId: note.branchId, details: { isTask: note.isTask, assignedTo: assignee?._id } });
  res.status(201).json({ success: true, data: note });
});

router.put('/:id', permit('handover.write'), validate({ body: body.omit({ branchId: true }).partial() }), async (req, res) => {
  const note = await findInBranch(req, HandoverNote, req.params.id, { notFound: 'Note not found', extra: { isDeleted: false } });
  if (!canEdit(req, note)) throw ApiError.forbidden(`You can edit your own notes for ${EDIT_MINUTES} minutes after posting`);
  const b = req.body;
  const before = note.assignedTo ? String(note.assignedTo) : null;
  if (b.text !== undefined) note.text = b.text;
  if (b.important !== undefined) note.important = b.important;
  if (b.isTask !== undefined) note.isTask = b.isTask;
  if (b.dueDate !== undefined) note.dueDate = b.dueDate ? asGymDay(b.dueDate) : undefined;
  let assignee = null;
  if (b.assignedTo !== undefined) {
    assignee = await checkAssignee(b.assignedTo, note.branchId);
    note.assignedTo = assignee?._id;
  }
  if (!note.isTask) {
    note.assignedTo = undefined;
    note.dueDate = undefined;
  }
  note.editedAt = new Date();
  await note.save();
  if (assignee && note.isTask && String(assignee._id) !== before) await alertAssignee(req, note, assignee);
  res.json({ success: true, data: note });
});

router.delete('/:id', permit('handover.read'), async (req, res) => {
  const note = await findInBranch(req, HandoverNote, req.params.id, { notFound: 'Note not found', extra: { isDeleted: false } });
  const own = can(req.user.role, 'handover.write') && canEdit(req, note);
  if (!own && !can(req.user.role, 'handover.manage')) throw ApiError.forbidden(`You can delete your own notes for ${EDIT_MINUTES} minutes. After that, ask the owner or a manager.`);
  note.isDeleted = true;
  note.deletedBy = req.user._id;
  note.deletedAt = new Date();
  await note.save();
  await audit(req, 'handover.delete', { entity: 'HandoverNote', entityId: note._id, branchId: note.branchId, details: { text: note.text.slice(0, 100) } });
  res.json({ success: true });
});

/** Mark a task done: front-desk staff, managers, or the person it was given to. */
router.post('/:id/done', permit('handover.read'), async (req, res) => {
  const note = await findInBranch(req, HandoverNote, req.params.id, { notFound: 'Note not found', extra: { isDeleted: false } });
  if (!note.isTask) throw ApiError.badRequest('Only tasks can be marked done');
  if (note.doneAt) throw ApiError.badRequest('This task is already done');
  if (!can(req.user.role, 'handover.write') && !mine(req, note.assignedTo)) throw ApiError.forbidden('Only the person this task is for, or the front desk, can mark it done');
  note.doneAt = new Date();
  note.doneBy = req.user._id;
  await note.save();
  res.json({ success: true, data: note });
});

router.post('/:id/reopen', permit('handover.write'), async (req, res) => {
  const note = await findInBranch(req, HandoverNote, req.params.id, { notFound: 'Note not found', extra: { isDeleted: false } });
  if (!note.doneAt) throw ApiError.badRequest('This task is still open');
  note.doneAt = undefined;
  note.doneBy = undefined;
  await note.save();
  res.json({ success: true, data: note });
});

/** "Got it": the current user has read the note. */
router.post('/:id/ack', permit('handover.read'), async (req, res) => {
  const note = await findInBranch(req, HandoverNote, req.params.id, { notFound: 'Note not found', extra: { isDeleted: false } });
  await HandoverNote.updateOne({ _id: note._id, 'acks.userId': { $ne: req.user._id } }, { $push: { acks: { userId: req.user._id, at: new Date() } } });
  res.json({ success: true });
});

export default router;
