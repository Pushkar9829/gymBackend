/**
 * One-off: moves old member profile photos and documents from public Cloudinary links into the private store.
 *
 *   npm run migrate:private-files                       dry run: lists what it would do, changes nothing
 *   npm run migrate:private-files -- --apply            copies each file into the private store and switches the record
 *   npm run migrate:private-files -- --delete-remote    deletes the Cloudinary originals of records already copied
 *
 * Safe to re-run: records that already have a private copy are skipped by --apply.
 * The public link stays on the record (but is no longer shown) until --delete-remote removes the original.
 */
import { pathToFileURL } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';
import { Member } from '../modules/members/member.model.js';
import { PrivateFile, MAX_PRIVATE_BYTES, MAX_DOCUMENT_BYTES, MAX_THUMB_BYTES, sniffImage, sniffDocument } from '../modules/uploads/privateFile.model.js';

const FETCH_TIMEOUT_MS = 30_000;

/** https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/v123/gym/members/abc.jpg -> parts, or null. */
export function parseCloudinaryUrl(url) {
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(?:v\d+\/)?([^?#]+)$/.exec(String(url || ''));
  if (!m) return null;
  const [, cloudName, resourceType, path] = m;
  // Image / video public ids have no extension; raw files keep it.
  const publicId = resourceType === 'raw' ? decodeURIComponent(path) : decodeURIComponent(path).replace(/\.[a-z0-9]+$/i, '');
  return { cloudName, resourceType, publicId };
}

/** Cloudinary makes a 128 px square version of an image link on the fly. */
export function cloudinaryThumbUrl(url) {
  const c = parseCloudinaryUrl(url);
  if (!c || c.resourceType !== 'image') return null;
  return url.replace('/image/upload/', '/image/upload/c_fill,g_auto,w_128,h_128,q_80,f_jpg/');
}

async function download(fetchImpl, url, maxBytes) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
  const len = Number(r.headers?.get?.('content-length') || 0);
  if (len > maxBytes) throw new Error(`too large (${Math.round(len / 1024)} KB)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`too large (${Math.round(buf.length / 1024)} KB)`);
  return buf;
}

/** Deletes one Cloudinary original with the account's API credentials. */
export async function destroyOnCloudinary({ publicId, resourceType }) {
  const r = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'upload', invalidate: true });
  if (r?.result !== 'ok' && r?.result !== 'not found') throw new Error(`Cloudinary said: ${r?.result || 'no answer'}`);
  return r.result;
}

/**
 * Runs the migration. apply=false and deleteRemote=false = dry run.
 * fetchImpl / destroyRemote / cloudName are injectable for tests (the real Cloudinary is never called there).
 */
export async function migratePrivateFiles({
  apply = false,
  deleteRemote = false,
  fetchImpl = globalThis.fetch,
  destroyRemote = destroyOnCloudinary,
  cloudName = process.env.CLOUDINARY_CLOUD_NAME,
  log = console.log,
} = {}) {
  const report = { photos: { toCopy: 0, copied: 0, failed: 0 }, documents: { toCopy: 0, copied: 0, failed: 0 }, remote: { toDelete: 0, deleted: 0, unlinked: 0, failed: 0 }, problems: [] };
  const problem = (member, what, err) => {
    report.problems.push({ memberId: String(member._id), memberCode: member.memberCode, what, error: err.message });
    log(`  ! #${member.memberCode} ${what}: ${err.message}`);
  };

  /* ---- 1. Copy into the private store ---- */
  const members = Member.find({ $or: [{ photoUrl: { $nin: [null, ''] } }, { documents: { $elemMatch: { url: { $nin: [null, ''] } } } }] })
    .select('memberCode name branchId photoUrl photoFileId documents')
    .cursor();
  const copied = [];
  for await (const m of members) {
    if (m.photoUrl && !m.photoFileId) {
      report.photos.toCopy += 1;
      log(`${apply ? 'copy' : 'would copy'} photo of #${m.memberCode} ${m.name}: ${m.photoUrl}`);
      if (apply) {
        try {
          const data = await download(fetchImpl, m.photoUrl, MAX_PRIVATE_BYTES);
          const contentType = sniffImage(data);
          if (!contentType) throw new Error('not a JPEG / PNG / WebP image');
          let thumb;
          const thumbUrl = cloudinaryThumbUrl(m.photoUrl);
          if (thumbUrl) {
            thumb = await download(fetchImpl, thumbUrl, MAX_THUMB_BYTES).catch(() => undefined);
            if (thumb && !sniffImage(thumb)) thumb = undefined;
          }
          const file = await PrivateFile.create({
            memberId: m._id, branchId: m.branchId, kind: 'photo', contentType, size: data.length, data,
            ...(thumb ? { thumb, thumbType: sniffImage(thumb) } : {}),
            attached: true, memberVisible: true,
          });
          copied.push(file._id);
          await Member.updateOne({ _id: m._id }, { photoFileId: file._id });
          report.photos.copied += 1;
        } catch (err) {
          report.photos.failed += 1;
          problem(m, 'photo', err);
        }
      }
    }
    for (const d of m.documents) {
      if (!d.url || d.fileId) continue;
      report.documents.toCopy += 1;
      log(`${apply ? 'copy' : 'would copy'} document "${d.name}" of #${m.memberCode} ${m.name}: ${d.url}`);
      if (!apply) continue;
      try {
        const data = await download(fetchImpl, d.url, MAX_DOCUMENT_BYTES);
        const contentType = sniffDocument(data);
        if (!contentType) throw new Error('not a PDF / JPEG / PNG / WebP file');
        const file = await PrivateFile.create({ memberId: m._id, branchId: m.branchId, kind: 'document', name: d.name, contentType, size: data.length, data, attached: true });
        copied.push(file._id);
        await Member.updateOne({ _id: m._id, 'documents._id': d._id }, { $set: { 'documents.$.fileId': file._id, 'documents.$.contentType': contentType, 'documents.$.size': data.length } });
        report.documents.copied += 1;
      } catch (err) {
        report.documents.failed += 1;
        problem(m, `document "${d.name}"`, err);
      }
    }
  }

  /* ---- 2. Delete the public originals of records that now have a private copy ---- */
  const done = await Member.find({ $or: [{ photoFileId: { $ne: null }, photoUrl: { $nin: [null, ''] } }, { documents: { $elemMatch: { fileId: { $ne: null }, url: { $nin: [null, ''] } } } }] })
    .select('memberCode name photoUrl photoFileId documents')
    .lean();
  for (const m of done) {
    const targets = [];
    if (m.photoFileId && m.photoUrl) targets.push({ what: 'photo', url: m.photoUrl, unset: { filter: { _id: m._id }, update: { $unset: { photoUrl: 1 } } } });
    for (const d of m.documents || []) {
      if (d.fileId && d.url) targets.push({ what: `document "${d.name}"`, url: d.url, unset: { filter: { _id: m._id, 'documents._id': d._id }, update: { $unset: { 'documents.$.url': 1 } } } });
    }
    for (const t of targets) {
      report.remote.toDelete += 1;
      const c = parseCloudinaryUrl(t.url);
      const ours = c && cloudName && c.cloudName === cloudName;
      log(`${deleteRemote ? 'delete' : 'would delete'} ${ours ? 'Cloudinary original' : 'old link (not on this Cloudinary account, only removed from the record)'} of #${m.memberCode} ${t.what}: ${t.url}`);
      if (!deleteRemote) continue;
      try {
        if (ours) {
          await destroyRemote(c);
          report.remote.deleted += 1;
        } else {
          report.remote.unlinked += 1;
        }
        await Member.updateOne(t.unset.filter, t.unset.update);
      } catch (err) {
        report.remote.failed += 1;
        problem(m, `delete ${t.what}`, err);
      }
    }
  }
  report.copiedFileIds = copied;
  return report;
}

/* ---- Command line ---- */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { connectDb, disconnectDb } = await import('../config/db.js');
  const apply = process.argv.includes('--apply');
  const deleteRemote = process.argv.includes('--delete-remote');
  const { cloudName, apiKey, apiSecret } = (await import('../config/env.js')).env.cloudinary;
  if (deleteRemote && !(cloudName && apiKey && apiSecret)) {
    console.error('--delete-remote needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
    process.exit(1);
  }
  if (cloudName) cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  await connectDb();
  console.log(apply || deleteRemote ? `Running:${apply ? ' --apply' : ''}${deleteRemote ? ' --delete-remote' : ''}` : 'DRY RUN (nothing is changed). Add --apply to copy, then --delete-remote to delete the public originals.');
  try {
    const report = await migratePrivateFiles({ apply, deleteRemote, cloudName });
    delete report.copiedFileIds;
    console.log(JSON.stringify(report, null, 2));
    if (report.problems.length) process.exitCode = 2;
  } finally {
    await disconnectDb();
  }
}
