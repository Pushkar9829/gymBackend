import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { loadAccessibleMember } from '../members/trainerScope.js';
import { Measurement } from './fitness.model.js';
import { PrivateFile, sendPrivateFile, findPrivateFile } from '../uploads/privateFile.model.js';
import { audit } from '../audit/audit.model.js';

/** Trainer's notes on a client's progress, with up to 4 private photos. */
const progressNoteSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    text: { type: String, required: true },
    photoIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile' }],
    measurementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Measurement' },
    visibleToMember: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
progressNoteSchema.index({ memberId: 1, createdAt: -1 });
export const ProgressNote = mongoose.model('ProgressNote', progressNoteSchema);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const MEASURE_FIELDS = 'date weightKg bodyFatPercent waistCm chestCm armsCm bmi';

/* ======================= Staff: /api/v1/fitness/progress ======================= */
const router = Router();
router.use(requireStaff);

router.get('/', permit('fitness.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.query.memberId);
  const notes = await ProgressNote.find({ memberId: member._id }).sort({ createdAt: -1 }).limit(200).populate('createdBy', 'name').populate('measurementId', MEASURE_FIELDS).lean();
  res.json({ success: true, data: notes });
});

const noteBody = z.object({
  memberId: objectId,
  text: z.string().trim().min(2, 'Write a short note').max(2000),
  photoIds: z.array(objectId).max(4, 'Up to 4 photos per note').default([]),
  measurementId: objectId.optional().nullable(),
  visibleToMember: z.boolean().default(true),
});

router.post('/', permit('fitness.write'), validate({ body: noteBody }), async (req, res) => {
  const b = req.body;
  const member = await loadAccessibleMember(req, b.memberId);
  const ids = [...new Set(b.photoIds)];
  if (ids.length) {
    const ok = await PrivateFile.countDocuments({ _id: { $in: ids }, memberId: member._id, kind: 'progress', attached: false });
    if (ok !== ids.length) throw ApiError.badRequest('A photo is missing or belongs to someone else. Upload it again.');
  }
  if (b.measurementId && !(await Measurement.exists({ _id: b.measurementId, memberId: member._id }))) throw ApiError.badRequest('Measurement not found for this member');
  const note = await ProgressNote.create({ memberId: member._id, branchId: member.branchId, text: b.text, photoIds: ids, measurementId: b.measurementId || undefined, visibleToMember: b.visibleToMember, createdBy: req.user._id });
  if (ids.length) await PrivateFile.updateMany({ _id: { $in: ids } }, { attached: true, memberVisible: b.visibleToMember });
  await audit(req, 'progress.note.add', { entity: 'ProgressNote', entityId: note._id, branchId: member.branchId, details: { memberId: member._id, photos: ids.length } });
  await note.populate([{ path: 'createdBy', select: 'name' }, { path: 'measurementId', select: MEASURE_FIELDS }]);
  res.status(201).json({ success: true, data: note });
});

async function loadNote(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Note not found');
  const note = await ProgressNote.findById(req.params.id);
  if (!note) throw ApiError.notFound('Note not found');
  await loadAccessibleMember(req, note.memberId);
  return note;
}
const isOwnerOrManager = (req) => ['owner', 'manager'].includes(req.user.role);

router.patch('/:id', permit('fitness.write'), validate({ body: z.object({ visibleToMember: z.boolean() }) }), async (req, res) => {
  const note = await loadNote(req);
  if (String(note.createdBy) !== String(req.user._id) && !isOwnerOrManager(req)) throw ApiError.forbidden('Only the author or a manager can change this note');
  note.visibleToMember = req.body.visibleToMember;
  await note.save();
  await PrivateFile.updateMany({ _id: { $in: note.photoIds } }, { memberVisible: note.visibleToMember });
  res.json({ success: true, data: note });
});

router.delete('/:id', permit('fitness.write'), async (req, res) => {
  const note = await loadNote(req);
  if (String(note.createdBy) !== String(req.user._id) && !isOwnerOrManager(req)) throw ApiError.forbidden('Only the author or a manager can delete this note');
  await PrivateFile.deleteMany({ _id: { $in: note.photoIds } });
  await note.deleteOne();
  await audit(req, 'progress.note.delete', { entity: 'ProgressNote', entityId: note._id, branchId: note.branchId, details: { memberId: note.memberId } });
  res.json({ success: true });
});

export default router;

/* ======================= Member app: /api/v1/me/progress, /me/files/:id ======================= */
export const portalProgressRouter = Router();
portalProgressRouter.use(requireMember);

portalProgressRouter.get('/progress', async (req, res) => {
  const notes = await ProgressNote.find({ memberId: req.member._id, visibleToMember: true })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('createdBy', 'name')
    .populate('measurementId', MEASURE_FIELDS)
    .select('-branchId')
    .lean();
  res.json({ success: true, data: notes });
});

// A member's own files that are shared with them (visible progress photos, their signature, their profile photo).
// Documents (ID proofs) are not shown in the app. ?thumb=1 = small profile photo.
portalProgressRouter.get('/files/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('File not found');
  const thumb = req.query.thumb === '1';
  const file = await findPrivateFile({ _id: req.params.id, memberId: req.member._id, memberVisible: true }, { thumb });
  if (!file) throw ApiError.notFound('File not found');
  sendPrivateFile(res, file, { thumb });
});
