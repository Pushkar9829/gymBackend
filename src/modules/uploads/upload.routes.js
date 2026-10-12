import express, { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { can } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { loadAccessibleMember } from '../members/trainerScope.js';
import { audit } from '../audit/audit.model.js';
import { MAX_PRIVATE_BYTES, savePrivateImage, sendPrivateFile, findPrivateFile } from './privateFile.model.js';

const router = Router();
router.use(requireStaff);

// Only public things go to the CDN: the gym logo / branding images shown on the public join page.
// Member photos and documents are private files (below), never Cloudinary.
const FOLDERS = ['branding'];
const PUBLIC_FORMATS = 'jpg,png,webp';

/**
 * Signed direct upload: the browser uploads straight to Cloudinary (Render's disk is ephemeral).
 * The client posts the file to https://api.cloudinary.com/v1_1/<cloudName>/image/upload with these fields.
 * Note: these are public CDN links (anyone with the link can open them), so only branding images are allowed.
 */
router.post('/signature', permit('settings.write'), validate({ body: z.object({ folder: z.enum(FOLDERS) }) }), (req, res) => {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) throw new ApiError(503, 'File uploads are not configured');
  const timestamp = Math.round(Date.now() / 1000);
  const params = { timestamp, folder: `gym/${req.body.folder}`, allowed_formats: PUBLIC_FORMATS };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);
  res.json({ success: true, data: { ...params, signature, apiKey, cloudName } });
});

/* ---------- Private member files: stored in the database, served only after a permission check ---------- */
const READ_PERM = { progress: 'fitness.read', signature: 'members.read', photo: 'members.read', document: 'members.documents' };

// Raw image body (the browser shrinks photos before sending). ?memberId=...&kind=progress
router.post(
  '/private',
  permit('fitness.write'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PRIVATE_BYTES }),
  validate({ query: z.object({ memberId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id'), kind: z.enum(['progress']) }) }),
  async (req, res) => {
    const member = await loadAccessibleMember(req, req.validQuery.memberId);
    const file = await savePrivateImage({ buffer: req.body, member, kind: req.validQuery.kind, user: req.user });
    res.status(201).json({ success: true, data: { _id: file._id, size: file.size, contentType: file.contentType } });
  },
);

// ?thumb=1 sends the small version of a profile photo (lists, avatars).
router.get('/private/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('File not found');
  const thumb = req.query.thumb === '1';
  const file = await findPrivateFile({ _id: req.params.id }, { thumb });
  if (!file) throw ApiError.notFound('File not found');
  // Documents (ID proofs...) are for the desk and managers, not trainers.
  if (!can(req.user.role, READ_PERM[file.kind])) throw ApiError.forbidden();
  await loadAccessibleMember(req, file.memberId); // branch + trainer's own clients
  if (file.kind === 'document') {
    await audit(req, 'member.document.view', { entity: 'Member', entityId: file.memberId, branchId: file.branchId, details: { fileId: file._id, name: file.name } });
  }
  sendPrivateFile(res, file, { thumb });
});

export default router;
