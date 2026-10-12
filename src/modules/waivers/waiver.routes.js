import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { dayjs, dmy, startOfDay, tz } from '../../utils/dates.js';
import { Gym, getGym } from '../settings/gym.model.js';
import { Member } from '../members/member.model.js';
import { Branch } from '../branches/branch.model.js';
import { User } from '../users/user.model.js';
import { loadAccessibleMember } from '../members/trainerScope.js';
import { refreshMember } from '../members/member.state.js';
import { PrivateFile, savePrivateImage, dataUrlToBuffer } from '../uploads/privateFile.model.js';
import { render, header } from '../invoices/invoice.pdf.js';
import { audit } from '../audit/audit.model.js';
import { WaiverVersion, WaiverSignature } from './waiver.model.js';
import { waiverSettings, waiverPending, requiredVersion } from './waiver.rules.js';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ACTIVE_STATES = ['active', 'frozen', 'upcoming'];

/** Members who would have to sign: active / frozen / upcoming members and running trial passes below `need`. */
export function unsignedFilter(need) {
  const today = startOfDay();
  return {
    isDeleted: false,
    $and: [
      { $or: [{ isTrial: { $ne: true }, membershipStatus: { $in: ACTIVE_STATES } }, { isTrial: true, 'trial.endedAt': null, 'trial.to': { $gte: today } }] },
      { $or: [{ 'waiver.version': null }, { 'waiver.version': { $lt: need } }] },
    ],
  };
}

async function refreshAll(settings) {
  for await (const m of Member.find({ isDeleted: false }).lean().cursor()) await refreshMember(m, { settings });
}

/** Signs the current waiver version: stores the signature image privately and updates the member. */
export async function signWaiver({ member, version, signature, via, user, req }) {
  const gym = await getGym();
  const w = waiverSettings(gym.settings);
  if (!w.currentVersion) throw ApiError.badRequest('There is no waiver to sign yet');
  if (version !== w.currentVersion) throw ApiError.conflict('The waiver text was just updated. Please read it again and sign.');
  const current = await WaiverVersion.findOne({ version }).lean();
  const buffer = dataUrlToBuffer(signature);
  if (buffer.length < 200) throw ApiError.badRequest('Please sign in the box');
  const file = await savePrivateImage({ buffer, member, kind: 'signature', user, attached: true, memberVisible: true });
  const signedAt = new Date();
  const sig = await WaiverSignature.create({
    memberId: member._id,
    branchId: member.branchId,
    version,
    textHash: current.hash,
    signatureFileId: file._id,
    signedAt,
    via,
    staffId: via === 'desk' ? user?._id : undefined,
    ip: req.ip,
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
  });
  await Member.updateOne({ _id: member._id }, { waiver: { version, signedAt, signatureId: sig._id } });
  await refreshMember(member._id); // entry may open now
  return sig;
}

/** PDF of a signed waiver: gym header, the exact text signed, the signature and when / how it was signed. */
export async function waiverPdf(sig) {
  const [member, version, file, gym, staff] = await Promise.all([
    Member.findById(sig.memberId).lean(),
    WaiverVersion.findOne({ version: sig.version }).lean(),
    PrivateFile.findById(sig.signatureFileId).lean(),
    getGym(),
    sig.staffId ? User.findById(sig.staffId).select('name').lean() : null,
  ]);
  const branch = await Branch.findById(member.branchId).lean();
  const seller = { name: gym.name, gstin: gym.gstin, address: branch?.address || gym.address, phone: branch?.phone || gym.phone, email: gym.email, branchName: branch?.name };
  const image = file ? `data:${file.contentType};base64,${Buffer.from(file.data.buffer || file.data).toString('base64')}` : null;
  const when = `${dmy(sig.signedAt)} ${dayjs(sig.signedAt).tz(tz).format('hh:mm A')}`;
  return render({
    info: { title: `Waiver - ${member.name}` },
    content: [
      ...header(seller, 'WAIVER', `v${sig.version}`, sig.signedAt),
      { text: `Member: ${member.name} (#${member.memberCode}) · ${member.phone}`, bold: true, margin: [0, 0, 0, 10] },
      ...String(version?.text || '').split(/\n{2,}/).map((p) => ({ text: p.trim(), margin: [0, 0, 0, 6], alignment: 'justify' })),
      { text: 'Signature', bold: true, margin: [0, 16, 0, 4] },
      image ? { image, fit: [220, 90] } : { text: '(signature image missing)', color: '#b91c1c' },
      { canvas: [{ type: 'line', x1: 0, y1: 2, x2: 220, y2: 2, lineWidth: 0.5, lineColor: '#999' }] },
      { text: member.name, margin: [0, 4, 0, 10] },
      {
        table: {
          widths: [110, '*'],
          body: [
            ['Signed on', when],
            ['Signed', sig.via === 'desk' ? `At the gym desk${staff ? `, staff present: ${staff.name}` : ''}` : 'In the member app'],
            ['Waiver version', `v${sig.version}`],
            ['Text fingerprint', sig.textHash.slice(0, 32)],
            ['Device', [sig.ip, sig.userAgent].filter(Boolean).join(' · ') || '—'],
          ].map(([k, v]) => [{ text: k, color: '#555' }, { text: v, fontSize: 9 }]),
        },
        layout: 'noBorders',
      },
    ],
  });
}

async function sendPdf(res, sig, member) {
  const pdf = await waiverPdf(sig);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="waiver-${member.memberCode}-v${sig.version}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.end(pdf);
}

/* ======================= Settings: /api/v1/waivers ======================= */
export const waiverRouter = Router();
waiverRouter.use(requireStaff);

waiverRouter.get('/', permit('members.read'), async (_req, res) => {
  const gym = await getGym();
  const w = waiverSettings(gym.settings);
  const versions = await WaiverVersion.find().sort({ version: -1 }).populate('createdBy', 'name').lean();
  const [unsigned, unsignedIfResign] = await Promise.all([
    w.currentVersion ? Member.countDocuments(unsignedFilter(requiredVersion(gym.settings))) : 0,
    Member.countDocuments(unsignedFilter((w.currentVersion || 0) + 1)),
  ]);
  res.json({ success: true, data: { settings: w, current: versions[0] || null, versions, unsigned, unsignedIfResign } });
});

waiverRouter.put(
  '/',
  permit('settings.write'),
  validate({
    body: z.object({
      text: z.string().trim().min(20, 'Write the waiver text (at least 20 letters)').max(20000).optional(),
      requireResign: z.boolean().default(false),
      askMembers: z.boolean().optional(),
      requireForEntry: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const b = req.body;
    const gym = await Gym.findOne();
    gym.settings.waiver ||= {};
    const before = waiverSettings(gym.settings.toObject());
    const w = gym.settings.waiver;
    let created = null;
    const current = before.currentVersion ? await WaiverVersion.findOne({ version: before.currentVersion }).lean() : null;
    if (b.text && b.text !== current?.text) {
      const version = before.currentVersion + 1;
      created = await WaiverVersion.create({ version, text: b.text, hash: sha256(b.text), requireResign: version === 1 || b.requireResign, createdBy: req.user._id });
      w.currentVersion = version;
      if (version === 1 || b.requireResign) w.minVersion = version;
    }
    if (b.askMembers !== undefined) w.askMembers = b.askMembers;
    if (b.requireForEntry !== undefined) {
      if (b.requireForEntry && !w.currentVersion) throw ApiError.badRequest('Add the waiver text first');
      w.requireForEntry = b.requireForEntry;
    }
    gym.markModified('settings.waiver');
    await gym.save();
    const after = waiverSettings(gym.settings.toObject());
    await audit(req, 'waiver.update', { entity: 'Gym', entityId: gym._id, details: { version: created?.version, requireResign: created ? created.requireResign : undefined, askMembers: after.askMembers, requireForEntry: after.requireForEntry } });
    // Entry rule changed: re-check everyone so the devices follow at once.
    if (after.requireForEntry !== before.requireForEntry || (after.requireForEntry && after.minVersion !== before.minVersion)) await refreshAll(gym.settings.toObject());
    const unsigned = after.currentVersion ? await Member.countDocuments(unsignedFilter(requiredVersion(gym.settings.toObject()))) : 0;
    res.json({ success: true, data: { settings: after, created, unsigned } });
  },
);

/* ======================= At the desk: /api/v1/members/:id/waiver ======================= */
export const memberWaiverRouter = Router();
memberWaiverRouter.use(requireStaff);

memberWaiverRouter.get('/:id/waiver', permit('members.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.params.id);
  const gym = await getGym();
  const w = waiverSettings(gym.settings);
  const [current, signatures] = await Promise.all([
    w.currentVersion ? WaiverVersion.findOne({ version: w.currentVersion }).select('version text createdAt').lean() : null,
    WaiverSignature.find({ memberId: member._id }).sort({ signedAt: -1 }).limit(20).populate('staffId', 'name').select('-userAgent').lean(),
  ]);
  res.json({ success: true, data: { settings: w, pending: waiverPending(member, gym.settings), current, signatures } });
});

const signBody = z.object({ version: z.number().int().min(1), signature: z.string().max(1500000) });

memberWaiverRouter.post('/:id/waiver/sign', permit('members.write'), validate({ body: signBody }), async (req, res) => {
  const member = await loadAccessibleMember(req, req.params.id);
  const sig = await signWaiver({ member, version: req.body.version, signature: req.body.signature, via: 'desk', user: req.user, req });
  await audit(req, 'waiver.sign', { entity: 'Member', entityId: member._id, branchId: member.branchId, details: { version: sig.version, via: 'desk' } });
  res.status(201).json({ success: true, data: sig });
});

memberWaiverRouter.get('/:id/waiver/pdf', permit('members.read'), async (req, res) => {
  const member = await loadAccessibleMember(req, req.params.id);
  const filter = { memberId: member._id };
  if (req.query.signatureId && /^[0-9a-f]{24}$/i.test(String(req.query.signatureId))) filter._id = req.query.signatureId;
  const sig = await WaiverSignature.findOne(filter).sort({ signedAt: -1 }).lean();
  if (!sig) throw ApiError.notFound('No signed waiver yet');
  await sendPdf(res, sig, member);
});

/* ======================= Member app: /api/v1/me/waiver ======================= */
export const portalWaiverRouter = Router();
portalWaiverRouter.use(requireMember);

portalWaiverRouter.get('/waiver', async (req, res) => {
  const gym = await getGym();
  const w = waiverSettings(gym.settings);
  const current = w.currentVersion ? await WaiverVersion.findOne({ version: w.currentVersion }).select('version text createdAt').lean() : null;
  const m = req.member;
  res.json({
    success: true,
    data: {
      ask: w.askMembers || w.requireForEntry,
      requiredForEntry: w.requireForEntry,
      pending: waiverPending(m, gym.settings),
      current,
      signed: m.waiver?.signedAt ? { version: m.waiver.version, signedAt: m.waiver.signedAt } : null,
    },
  });
});

portalWaiverRouter.post('/waiver/sign', validate({ body: signBody }), async (req, res) => {
  const sig = await signWaiver({ member: req.member, version: req.body.version, signature: req.body.signature, via: 'app', req });
  res.status(201).json({ success: true, data: { version: sig.version, signedAt: sig.signedAt } });
});

portalWaiverRouter.get('/waiver/pdf', async (req, res) => {
  const sig = await WaiverSignature.findOne({ memberId: req.member._id }).sort({ signedAt: -1 }).lean();
  if (!sig) throw ApiError.notFound('No signed waiver yet');
  await sendPdf(res, sig, req.member);
});
