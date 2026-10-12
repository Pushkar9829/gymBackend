import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';

// progress = trainer's progress photo, signature = waiver signature, photo = member profile photo,
// document = member document (ID proof, medical certificate...).
export const PRIVATE_KINDS = ['progress', 'signature', 'photo', 'document'];
export const MAX_PRIVATE_BYTES = 3 * 1024 * 1024;
// Scanned ID proofs as PDF are often a little over 3 MB.
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
// Small square thumbnail of a profile photo (the browser makes it, 128 px) for lists.
export const MAX_THUMB_BYTES = 200 * 1024;

/**
 * Personal files (progress photos, waiver signatures, profile photos, ID proofs) kept in the database, not on the public CDN.
 * They are only ever served through authenticated API routes that check who may see them.
 */
const privateFileSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    kind: { type: String, enum: PRIVATE_KINDS, required: true },
    name: String, // original file name (documents)
    contentType: { type: String, required: true },
    size: Number,
    data: { type: Buffer, required: true },
    // Profile photos: small version for lists and avatars.
    thumb: Buffer,
    thumbType: String,
    // Linked to a saved note / signature / member. Unlinked uploads are removed by the daily job.
    attached: { type: Boolean, default: false },
    // Member may see it in the app (progress photos follow their note's switch; signatures and profile photos are always theirs).
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

/** Image types plus PDF (documents). */
export function sniffDocument(buf) {
  if (buf && buf.length >= 8 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return sniffImage(buf);
}

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Stores an image buffer for a member. Throws 400 for anything that is not a JPEG / PNG / WebP image. */
export async function savePrivateImage({ buffer, member, kind, user, attached = false, memberVisible = false }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest('Choose an image');
  if (buffer.length > MAX_PRIVATE_BYTES) throw ApiError.badRequest(`Image must be under ${mb(MAX_PRIVATE_BYTES)}`);
  const contentType = sniffImage(buffer);
  if (!contentType) throw ApiError.badRequest('Only JPEG, PNG or WebP images are allowed');
  return PrivateFile.create({ memberId: member._id, branchId: member.branchId, kind, contentType, size: buffer.length, data: buffer, uploadedBy: user?._id, attached, memberVisible });
}

/** Stores a member document (PDF or image). Throws 400 for other types or files over 5 MB. */
export async function savePrivateDocument({ buffer, member, user, name }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest('Choose a file');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw ApiError.badRequest(`File must be under ${mb(MAX_DOCUMENT_BYTES)}`);
  const contentType = sniffDocument(buffer);
  if (!contentType) throw ApiError.badRequest('Only PDF, JPEG, PNG or WebP files are allowed');
  return PrivateFile.create({ memberId: member._id, branchId: member.branchId, kind: 'document', name, contentType, size: buffer.length, data: buffer, uploadedBy: user?._id, attached: true });
}

/** Checks a thumbnail buffer and returns its type (throws 400). */
export function checkThumb(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest('Choose an image');
  if (buffer.length > MAX_THUMB_BYTES) throw ApiError.badRequest('Thumbnail must be under 200 KB');
  const type = sniffImage(buffer);
  if (!type) throw ApiError.badRequest('Only JPEG, PNG or WebP images are allowed');
  return type;
}

/** "data:image/png;base64,...." -> Buffer (signature pads send this). */
export function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw ApiError.badRequest('Signature image is missing or not valid');
  return Buffer.from(m[2], 'base64');
}

/**
 * Loads a file for sending. With thumb=true only the small version is read from the database
 * (falls back to the full file when there is no thumbnail).
 */
export async function findPrivateFile(filter, { thumb = false } = {}) {
  if (thumb) {
    const small = await PrivateFile.findOne(filter).select('-data');
    if (!small || small.thumb?.length) return small;
  }
  return PrivateFile.findOne(filter).select('-thumb');
}

export function sendPrivateFile(res, file, { thumb = false } = {}) {
  const useThumb = thumb && file.thumb?.length > 0;
  const data = useThumb ? file.thumb : file.data;
  const headers = {
    'Content-Type': useThumb ? file.thumbType : file.contentType,
    'Content-Length': String(data.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (file.kind === 'document') {
    const safe = String(file.name || 'document').replace(/[^\w .()-]/g, '_').slice(0, 80) || 'document';
    headers['Content-Disposition'] = `inline; filename="${safe}"`;
  }
  res.set(headers);
  res.end(data);
}
