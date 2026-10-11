import { Router } from 'express';
import { z } from 'zod';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';
import { requireStaff } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';

const router = Router();
router.use(requireStaff);

const FOLDERS = ['members', 'documents', 'expenses', 'branding'];

/**
 * Signed direct upload: the browser uploads straight to Cloudinary (Render's disk is ephemeral).
 * The client posts the file to https://api.cloudinary.com/v1_1/<cloudName>/auto/upload with these fields.
 */
router.post('/signature', validate({ body: z.object({ folder: z.enum(FOLDERS) }) }), (req, res) => {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) throw new ApiError(503, 'File uploads are not configured');
  const timestamp = Math.round(Date.now() / 1000);
  const params = { timestamp, folder: `gym/${req.body.folder}` };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);
  res.json({ success: true, data: { ...params, signature, apiKey, cloudName } });
});

export default router;
