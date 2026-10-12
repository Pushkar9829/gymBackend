import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Member } from '../src/modules/members/member.model.js';
import { PrivateFile } from '../src/modules/uploads/privateFile.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { migratePrivateFiles, parseCloudinaryUrl, cloudinaryThumbUrl } from '../src/scripts/migrate-private-files.js';

// Member documents (ID proofs...) and profile photos live in the private store, never on a public link.

let ctx;
let owner;
let rec;
let trainer;
let otherRec;
let memberA; // trainer's client, uses the app
let memberB; // not the trainer's client, uses the app
let tokenA;
let tokenB;

/** A real PNG with random pixels. */
function makePng(w = 40, h = 40) {
  const crc = (buf) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(zlib.crc32(buf) >>> 0);
    return b;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % (w * 3 + 1) === 0 ? 0 : Math.floor(Math.random() * 256);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const makePdf = (pad = 0) => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'), Buffer.alloc(pad, 0x20), Buffer.from('\n%%EOF\n')]);
const makeExe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

const memberLogin = async (phone) => (await api().post('/api/v1/auth/member/login').send({ phone, password: 'Member@123' })).body.data.accessToken;
const uploadDoc = (token, memberId, body, { name = 'Aadhaar.pdf', kind = 'id-proof', type = 'application/pdf' } = {}) =>
  api().post(`/api/v1/members/${memberId}/documents?name=${encodeURIComponent(name)}&kind=${kind}`).set(auth(token)).set('Content-Type', type).send(body);
const uploadPhoto = (token, memberId, body, type = 'image/png') => api().post(`/api/v1/members/${memberId}/photo`).set(auth(token)).set('Content-Type', type).send(body);
const getFile = (token, id, q = '') => {
  const r = api().get(`/api/v1/uploads/private/${id}${q}`).buffer(true).parse((res, cb) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });
  return token ? r.set(auth(token)) : r;
};

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  rec = await login('rec@t.com');
  trainer = await login('trainer@t.com');
  otherRec = await login('rec2@t.com');
  const add = async (name, phone, extra = {}) => {
    const r = await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await api().post(`/api/v1/members/${r.body.data._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
    return r.body.data;
  };
  memberA = await add('Asha Docs', '9000000001', { trainerId: String(ctx.trainer._id) });
  memberB = await add('Bina Other', '9000000002');
  tokenA = await memberLogin('9000000001');
  tokenB = await memberLogin('9000000002');
});

after(teardown);

/* ---------------- Documents ---------------- */
let docFileId;

test('documents are uploaded privately with real type and size checks', async () => {
  const r = await uploadDoc(rec, memberA._id, makePdf());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const doc = r.body.data.at(-1);
  assert.equal(doc.name, 'Aadhaar.pdf');
  assert.equal(doc.kind, 'id-proof');
  assert.equal(doc.contentType, 'application/pdf');
  assert.equal(doc.url, undefined); // no public link
  assert.ok(doc.fileId);
  docFileId = doc.fileId;
  const stored = await PrivateFile.findById(docFileId).lean();
  assert.equal(stored.kind, 'document');
  assert.equal(stored.attached, true);
  assert.equal(stored.memberVisible, false);

  // A PDF over the 3 MB image limit is fine for documents (up to 5 MB)...
  const big = await uploadDoc(rec, memberA._id, makePdf(4 * 1024 * 1024), { name: 'scan.pdf' });
  assert.equal(big.status, 201, JSON.stringify(big.body));
  // ...but not over 5 MB.
  assert.equal((await uploadDoc(rec, memberA._id, makePdf(6 * 1024 * 1024), { name: 'huge.pdf' })).status, 413);
  // An image document.
  const img = await uploadDoc(rec, memberA._id, makePng(), { name: 'medical.png', kind: 'medical', type: 'image/png' });
  assert.equal(img.status, 201);
  assert.equal(img.body.data.at(-1).contentType, 'image/png');

  // A ".pdf" that is really a program is refused (magic bytes), whatever the browser says.
  const exe = await uploadDoc(rec, memberA._id, makeExe(), { name: 'id.pdf' });
  assert.equal(exe.status, 400);
  assert.match(exe.body.message, /PDF, JPEG, PNG or WebP/);
  const exe2 = await uploadDoc(rec, memberA._id, makeExe(), { name: 'id.pdf', type: 'application/octet-stream' });
  assert.equal(exe2.status, 400);
  // Other types are not read at all; old clients sending a public link are refused.
  assert.equal((await uploadDoc(rec, memberA._id, 'hello', { name: 'a.txt', type: 'text/plain' })).status, 400);
  assert.equal((await api().post(`/api/v1/members/${memberA._id}/documents`).set(auth(rec)).send({ name: 'x', kind: 'other', url: 'https://res.cloudinary.com/x/image/upload/a.jpg' })).status, 400);
  // Trainers cannot add documents; other branch staff cannot reach the member.
  assert.equal((await uploadDoc(trainer, memberA._id, makePdf())).status, 403);
  assert.equal((await uploadDoc(otherRec, memberA._id, makePdf())).status, 403);
  assert.equal(await PrivateFile.countDocuments({ kind: 'document' }), 3);
});

test('staff with access can open a document; others cannot; each view is audited', async () => {
  const r = await getFile(rec, docFileId);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-disposition'], /inline; filename="Aadhaar.pdf"/);
  assert.equal(r.body.toString('ascii', 0, 5), '%PDF-');
  assert.equal((await getFile(owner, docFileId)).status, 200);
  const views = await AuditLog.find({ action: 'member.document.view' }).lean();
  assert.equal(views.length, 2);
  assert.equal(String(views[0].entityId), String(memberA._id));

  assert.equal((await getFile(null, docFileId)).status, 401);
  assert.equal((await getFile(otherRec, docFileId)).status, 403); // other branch
  assert.equal((await getFile(trainer, docFileId)).status, 403); // trainers never see ID proofs, even of their own clients
  assert.equal((await getFile(rec, '64b000000000000000000000')).status, 404);
  assert.equal(await AuditLog.countDocuments({ action: 'member.document.view' }), 2);

  // The member does not see documents in the app (own or anyone else's).
  assert.equal((await api().get(`/api/v1/me/files/${docFileId}`).set(auth(tokenA))).status, 404);
  assert.equal((await api().get(`/api/v1/me/files/${docFileId}`).set(auth(tokenB))).status, 404);

  // Trainers do not get the document list either; the members list never carries documents.
  const asTrainer = await api().get(`/api/v1/members/${memberA._id}`).set(auth(trainer));
  assert.equal(asTrainer.status, 200);
  assert.equal(asTrainer.body.data.member.documents, undefined);
  const asRec = await api().get(`/api/v1/members/${memberA._id}`).set(auth(rec));
  assert.equal(asRec.body.data.member.documents.length, 3);
  const list = await api().get('/api/v1/members?search=Asha').set(auth(rec));
  assert.equal(list.body.data.items[0].documents, undefined);
});

test('deleting a document deletes the private file', async () => {
  const docs = (await api().get(`/api/v1/members/${memberA._id}`).set(auth(rec))).body.data.member.documents;
  const doc = docs.find((d) => String(d.fileId) === String(docFileId));
  assert.equal((await api().delete(`/api/v1/members/${memberA._id}/documents/${doc._id}`).set(auth(trainer))).status, 403);
  const r = await api().delete(`/api/v1/members/${memberA._id}/documents/${doc._id}`).set(auth(rec));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 2);
  assert.equal(await PrivateFile.exists({ _id: docFileId }), null);
  assert.equal((await getFile(rec, docFileId)).status, 404);
});

/* ---------------- Profile photos ---------------- */
let photoId;

test('profile photo is private, with a small thumbnail for lists', async () => {
  const full = makePng(120, 120);
  const thumb = makePng(16, 16);
  assert.equal((await uploadPhoto(trainer, memberA._id, full)).status, 403); // trainers cannot change members
  assert.equal((await uploadPhoto(rec, memberA._id, makeExe())).status, 400);
  assert.equal((await api().put(`/api/v1/members/${memberA._id}/photo/thumb`).set(auth(rec)).set('Content-Type', 'image/png').send(thumb)).status, 404); // no photo yet
  const r = await uploadPhoto(rec, memberA._id, full);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  photoId = r.body.data.photoFileId;
  const t = await api().put(`/api/v1/members/${memberA._id}/photo/thumb`).set(auth(rec)).set('Content-Type', 'image/png').send(thumb);
  assert.equal(t.status, 200);
  assert.equal((await api().put(`/api/v1/members/${memberA._id}/photo/thumb`).set(auth(rec)).set('Content-Type', 'image/png').send(makeExe())).status, 400);
  assert.equal((await api().put(`/api/v1/members/${memberA._id}/photo/thumb`).set(auth(rec)).set('Content-Type', 'image/png').send(Buffer.concat([makePng(), Buffer.alloc(250 * 1024)]))).status, 413);

  // Lists carry the file id (never a public link) and fetch the thumbnail.
  const list = await api().get('/api/v1/members?search=Asha').set(auth(rec));
  assert.equal(String(list.body.data.items[0].photoFileId), String(photoId));
  assert.equal(list.body.data.items[0].photoUrl, undefined);
  const small = await getFile(rec, photoId, '?thumb=1');
  assert.equal(small.status, 200);
  assert.equal(small.headers['content-type'], 'image/png');
  assert.match(small.headers['cache-control'], /no-store/);
  assert.ok(small.body.equals(thumb));
  const big = await getFile(rec, photoId);
  assert.ok(big.body.equals(full));

  // Staff: branch + trainer's own clients.
  assert.equal((await getFile(trainer, photoId, '?thumb=1')).status, 200); // A is the trainer's client
  assert.equal((await getFile(otherRec, photoId, '?thumb=1')).status, 403);
  assert.equal((await getFile(null, photoId, '?thumb=1')).status, 401);
  // Photos are not audited (lists load many).
  assert.equal(await AuditLog.countDocuments({ action: 'member.document.view' }), 2);

  // The member sees their own photo in the app, not someone else's.
  const me = await api().get('/api/v1/me').set(auth(tokenA));
  assert.equal(String(me.body.data.member.photoFileId), String(photoId));
  assert.equal((await api().get(`/api/v1/me/files/${photoId}?thumb=1`).set(auth(tokenA))).status, 200);
  assert.equal((await api().get(`/api/v1/me/files/${photoId}`).set(auth(tokenA))).status, 200);
  assert.equal((await api().get(`/api/v1/me/files/${photoId}`).set(auth(tokenB))).status, 404);

  // Check-in desk result carries the photo id.
  const ci = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberA._id });
  assert.equal(String(ci.body.data.member.photoFileId), String(photoId));
});

test('photo of a member who is not the trainer\'s client is hidden from the trainer; a thumbless photo falls back to full size', async () => {
  const full = makePng(50, 50);
  const r = await uploadPhoto(rec, memberB._id, full);
  assert.equal(r.status, 201);
  const id = r.body.data.photoFileId;
  assert.equal((await getFile(trainer, id, '?thumb=1')).status, 404);
  const small = await getFile(rec, id, '?thumb=1');
  assert.equal(small.status, 200);
  assert.ok(small.body.equals(full));
});

test('replacing and removing a photo deletes the old private file', async () => {
  const r = await uploadPhoto(rec, memberA._id, makePng(30, 30), 'image/png');
  assert.equal(r.status, 201);
  assert.notEqual(String(r.body.data.photoFileId), String(photoId));
  assert.equal(await PrivateFile.exists({ _id: photoId }), null);
  photoId = r.body.data.photoFileId;
  await Member.updateOne({ _id: memberA._id }, { photoUrl: 'https://res.cloudinary.com/testcloud/image/upload/v1/gym/members/old.jpg' });
  assert.equal((await api().delete(`/api/v1/members/${memberA._id}/photo`).set(auth(trainer))).status, 403);
  assert.equal((await api().delete(`/api/v1/members/${memberA._id}/photo`).set(auth(rec))).status, 200);
  const m = await Member.findById(memberA._id).lean();
  assert.equal(m.photoFileId, undefined);
  assert.equal(m.photoUrl, undefined);
  assert.equal(await PrivateFile.exists({ _id: photoId }), null);
  // photoUrl in the member form is ignored now (no new public links).
  const put = await api().put(`/api/v1/members/${memberA._id}`).set(auth(rec)).send({ photoUrl: 'https://res.cloudinary.com/x/image/upload/new.jpg' });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.photoUrl, undefined);
});

/* ---------------- Old records and the public upload route ---------------- */
test('old Cloudinary links still work for existing records', async () => {
  const url = 'https://res.cloudinary.com/testcloud/image/upload/v1/gym/documents/old-id.jpg';
  const photoUrl = 'https://res.cloudinary.com/testcloud/image/upload/v1/gym/members/old-photo.jpg';
  await Member.updateOne({ _id: memberB._id }, { photoUrl, $unset: { photoFileId: 1 }, $push: { documents: { name: 'Old ID', kind: 'id-proof', url } } });
  const r = await api().get(`/api/v1/members/${memberB._id}`).set(auth(rec));
  assert.equal(r.body.data.member.photoUrl, photoUrl);
  const doc = r.body.data.member.documents.find((d) => d.name === 'Old ID');
  assert.equal(doc.url, url);
  assert.equal(doc.fileId, undefined);
  const list = await api().get('/api/v1/members?search=Bina').set(auth(rec));
  assert.equal(list.body.data.items[0].photoUrl, photoUrl);
  // An old document can still be removed.
  assert.equal((await api().delete(`/api/v1/members/${memberB._id}/documents/${doc._id}`).set(auth(rec))).status, 200);
});

test('the public upload route is only for branding images', async () => {
  assert.equal((await api().post('/api/v1/uploads/signature').set(auth(rec)).send({ folder: 'branding' })).status, 403);
  assert.equal((await api().post('/api/v1/uploads/signature').set(auth(owner)).send({ folder: 'documents' })).status, 400);
  assert.equal((await api().post('/api/v1/uploads/signature').set(auth(owner)).send({ folder: 'members' })).status, 400);
});

/* ---------------- Migration script (Cloudinary mocked) ---------------- */
test('migration: dry run, apply, then delete the remote originals', async () => {
  await PrivateFile.deleteMany({});
  await Member.updateMany({}, { $unset: { photoUrl: 1, photoFileId: 1 }, $set: { documents: [] } });
  const base = 'https://res.cloudinary.com/testcloud';
  const photo = makePng(80, 80);
  const thumb = makePng(10, 10);
  const pdf = makePdf();
  const files = {
    [`${base}/image/upload/v17/gym/members/p1.jpg`]: photo,
    [`${base}/image/upload/c_fill,g_auto,w_128,h_128,q_80,f_jpg/v17/gym/members/p1.jpg`]: thumb,
    [`${base}/image/upload/v17/gym/documents/id1.pdf`]: pdf,
    [`${base}/raw/upload/v17/gym/documents/bad.pdf`]: makeExe(),
    'https://example.com/elsewhere/id2.png': makePng(),
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = files[url];
    return body ? { ok: true, status: 200, headers: new Map([['content-length', String(body.length)]]), arrayBuffer: async () => body } : { ok: false, status: 404, headers: new Map() };
  };
  const destroyed = [];
  const destroyRemote = async (c) => {
    destroyed.push(c);
    return 'ok';
  };
  await Member.updateOne({ _id: memberA._id }, {
    photoUrl: `${base}/image/upload/v17/gym/members/p1.jpg`,
    documents: [
      { name: 'ID', kind: 'id-proof', url: `${base}/image/upload/v17/gym/documents/id1.pdf` },
      { name: 'Fake', kind: 'other', url: `${base}/raw/upload/v17/gym/documents/bad.pdf` },
    ],
  });
  await Member.updateOne({ _id: memberB._id }, { documents: [{ name: 'Elsewhere', kind: 'medical', url: 'https://example.com/elsewhere/id2.png' }] });
  const opts = { fetchImpl, destroyRemote, cloudName: 'testcloud', log: () => {} };

  // Dry run: lists, changes nothing, downloads nothing.
  const dry = await migratePrivateFiles(opts);
  assert.deepEqual(dry.photos, { toCopy: 1, copied: 0, failed: 0 });
  assert.deepEqual(dry.documents, { toCopy: 3, copied: 0, failed: 0 });
  assert.equal(dry.remote.toDelete, 0);
  assert.equal(fetched.length, 0);
  assert.equal(await PrivateFile.countDocuments(), 0);

  // Apply: copies; the program disguised as a PDF is refused and reported; nothing is deleted remotely.
  const run = await migratePrivateFiles({ ...opts, apply: true });
  assert.deepEqual(run.photos, { toCopy: 1, copied: 1, failed: 0 });
  assert.deepEqual(run.documents, { toCopy: 3, copied: 2, failed: 1 });
  assert.equal(run.problems.length, 1);
  assert.match(run.problems[0].error, /not a PDF/);
  assert.equal(run.remote.toDelete, 3); // listed only
  assert.equal(destroyed.length, 0);
  const a = await Member.findById(memberA._id).lean();
  assert.ok(a.photoFileId);
  assert.ok(a.photoUrl); // kept until --delete-remote
  const pf = await PrivateFile.findById(a.photoFileId).lean();
  assert.equal(pf.kind, 'photo');
  assert.equal(pf.memberVisible, true);
  assert.ok(Buffer.from(pf.data.buffer).equals(photo));
  assert.ok(Buffer.from(pf.thumb.buffer).equals(thumb));
  const idDoc = a.documents.find((d) => d.name === 'ID');
  assert.ok(idDoc.fileId);
  assert.equal(idDoc.contentType, 'application/pdf');
  assert.equal(a.documents.find((d) => d.name === 'Fake').fileId, undefined);
  // The app now serves the private copy.
  const served = await getFile(rec, idDoc.fileId);
  assert.equal(served.status, 200);
  assert.equal(served.body.toString('ascii', 0, 5), '%PDF-');

  // Re-running apply copies nothing new (only the refused file is tried again).
  const again = await migratePrivateFiles({ ...opts, apply: true });
  assert.equal(again.photos.toCopy, 0);
  assert.equal(again.documents.toCopy, 1);
  assert.equal(await PrivateFile.countDocuments(), 3);

  // --delete-remote: deletes only our Cloudinary originals; other links are just removed from the record.
  const del = await migratePrivateFiles({ ...opts, deleteRemote: true });
  assert.deepEqual(del.remote, { toDelete: 3, deleted: 2, unlinked: 1, failed: 0 });
  assert.deepEqual(destroyed, [
    { cloudName: 'testcloud', resourceType: 'image', publicId: 'gym/members/p1' },
    { cloudName: 'testcloud', resourceType: 'image', publicId: 'gym/documents/id1' },
  ]);
  const a2 = await Member.findById(memberA._id).lean();
  assert.equal(a2.photoUrl, undefined);
  assert.equal(a2.documents.find((d) => d.name === 'ID').url, undefined);
  assert.ok(a2.documents.find((d) => d.name === 'Fake').url); // never copied, so never deleted
  const b2 = await Member.findById(memberB._id).lean();
  assert.equal(b2.documents[0].url, undefined);
  assert.ok(b2.documents[0].fileId);
  // Nothing left to do.
  const last = await migratePrivateFiles(opts);
  assert.equal(last.remote.toDelete, 0);
});

test('migration: a failed remote delete keeps the link so it can be retried', async () => {
  await Member.updateOne({ _id: memberB._id }, { photoUrl: 'https://res.cloudinary.com/testcloud/image/upload/gym/members/p9.png', photoFileId: memberB._id });
  const res = await migratePrivateFiles({ deleteRemote: true, cloudName: 'testcloud', log: () => {}, fetchImpl: async () => assert.fail('no downloads'), destroyRemote: async () => { throw new Error('rate limited'); } });
  assert.equal(res.remote.failed, 1);
  assert.ok((await Member.findById(memberB._id).lean()).photoUrl);
});

test('Cloudinary link parsing', () => {
  assert.deepEqual(parseCloudinaryUrl('https://res.cloudinary.com/c1/image/upload/v123/gym/members/a%20b.jpg'), { cloudName: 'c1', resourceType: 'image', publicId: 'gym/members/a b' });
  assert.deepEqual(parseCloudinaryUrl('https://res.cloudinary.com/c1/raw/upload/gym/documents/x.pdf'), { cloudName: 'c1', resourceType: 'raw', publicId: 'gym/documents/x.pdf' });
  assert.equal(parseCloudinaryUrl('https://example.com/a.jpg'), null);
  assert.equal(cloudinaryThumbUrl('https://res.cloudinary.com/c1/image/upload/v1/a.jpg'), 'https://res.cloudinary.com/c1/image/upload/c_fill,g_auto,w_128,h_128,q_80,f_jpg/v1/a.jpg');
  assert.equal(cloudinaryThumbUrl('https://res.cloudinary.com/c1/raw/upload/v1/a.pdf'), null);
});
