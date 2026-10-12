import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';

export const PRIVATE_KINDS = ['progress', 'signature'];
export const MAX_PRIVATE_BYTES = 3 * 1024 * 1024;

/**
 * Personal files (progress photos, waiver signatures) kept in the database, not on the public CDN.
 * They are only ever served through authenticated API routes that check who may see them.
 */
const privateFileSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    kind: { type: String, enum: PRIVATE_KINDS, required: true },
    contentType: { type: String, required: true },
    size: Number,
    data: { type: Buffer, required: true },
    // Linked to a saved note / signature. Unlinked uploads are removed by the daily job.
    attached: { type: Boolean, default: false },
    // Member may see it in the app (progress photos follow their note's switch; signatures are always theirs).
    memberVisible: { type: Boolean, default: false },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
privateFileSchema.index({ memberId: 1, kind: 1 });
privateFileSchema.index({ attached: 1, createdAt: 1 });
export const PrivateFile = mongoose.model('PrivateFile', privateFileSchema);

/** Checks the real file type from its first bytes (never trust the browser's label). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Stores an image buffer for a member. Throws 400 for anything that is not a JPEG / PNG / WebP image. */
export async function savePrivateImage({ buffer, member, kind, user, attached = false, memberVisible = false }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest('Choose an image');
  if (buffer.length > MAX_PRIVATE_BYTES) throw ApiError.badRequest('Image must be under 3 MB');
  const contentType = sniffImage(buffer);
  if (!contentType) throw ApiError.badRequest('Only JPEG, PNG or WebP images are allowed');
  return PrivateFile.create({ memberId: member._id, branchId: member.branchId, kind, contentType, size: buffer.length, data: buffer, uploadedBy: user?._id, attached, memberVisible });
}

/** "data:image/png;base64,...." -> Buffer (signature pads send this). */
export function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw ApiError.badRequest('Signature image is missing or not valid');
  return Buffer.from(m[2], 'base64');
}

export function sendPrivateFile(res, file) {
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.data.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(file.data);
}
