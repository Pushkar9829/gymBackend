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
import { PrivateFile, MAX_PRIVATE_BYTES, savePrivateImage, sendPrivateFile } from './privateFile.model.js';

const router = Router();
router.use(requireStaff);

const FOLDERS = ['members', 'documents', 'expenses', 'branding'];

/**
 * Signed direct upload: the browser uploads straight to Cloudinary (Render's disk is ephemeral).
 * The client posts the file to https://api.cloudinary.com/v1_1/<cloudName>/auto/upload with these fields.
 * Note: these are public CDN links (anyone with the link can open them).
 */
router.post('/signature', validate({ body: z.object({ folder: z.enum(FOLDERS) }) }), (req, res) => {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) throw new ApiError(503, 'File uploads are not configured');
  const timestamp = Math.round(Date.now() / 1000);
  const params = { timestamp, folder: `gym/${req.body.folder}` };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);
  res.json({ success: true, data: { ...params, signature, apiKey, cloudName } });
});

/* ---------- Private member files (progress photos, signatures): stored in the database, served only after a permission check ---------- */
const READ_PERM = { progress: 'fitness.read', signature: 'members.read' };

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

router.get('/private/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('File not found');
  const file = await PrivateFile.findById(req.params.id);
  if (!file) throw ApiError.notFound('File not found');
  if (!can(req.user.role, READ_PERM[file.kind])) throw ApiError.forbidden();
  await loadAccessibleMember(req, file.memberId); // branch + trainer's own clients
  sendPrivateFile(res, file);
});

export default router;
