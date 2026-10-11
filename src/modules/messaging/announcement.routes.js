import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { addDays, startOfDay } from '../../utils/dates.js';
import { logger } from '../../config/logger.js';
import { Member } from '../members/member.model.js';
import { getGym } from '../settings/gym.model.js';
import { sendMessage } from './messaging.service.js';
import { sendMemberEmail } from '../notifications/notification.service.js';
import { inBackground } from '../notifications/emails.js';
import { devOutbox } from './providers.js';
import { audit } from '../audit/audit.model.js';

const announcementSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }, // empty = all branches
    audience: { type: String, enum: ['active', 'expiring', 'expired', 'due', 'all'], required: true },
    channels: [{ type: String, enum: ['sms', 'whatsapp', 'email'] }],
    subject: String,
    text: { type: String, required: true },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    status: { type: String, enum: ['sending', 'done'], default: 'sending' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const Announcement = mongoose.model('Announcement', announcementSchema);

const router = Router();
router.use(requireStaff);

function audienceFilter(audience) {
  const today = startOfDay();
  switch (audience) {
    case 'active':
      return { membershipStatus: { $in: ['active', 'frozen'] } };
    case 'expiring':
      return { membershipStatus: 'active', membershipEnd: { $gte: today, $lt: addDays(today, 8) } };
    case 'expired':
      return { membershipStatus: 'expired', membershipEnd: { $gte: addDays(today, -60) } };
    case 'due':
      return { dueAmount: { $gt: 0 } };
    default:
      return {};
  }
}

router.get('/', permit('members.write'), async (req, res) => {
  const filter = req.allowedBranchIds === null ? {} : { branchId: { $in: req.allowedBranchIds } };
  res.json({ success: true, data: await paginate(Announcement, filter, req.query, { sort: { createdAt: -1 }, populate: { path: 'createdBy', select: 'name' } }) });
});

const body = z.object({
  branchId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id').optional(),
  audience: z.enum(['active', 'expiring', 'expired', 'due', 'all']),
  channels: z.array(z.enum(['sms', 'whatsapp', 'email'])).min(1),
  subject: z.string().trim().max(120).optional(),
  text: z.string().trim().min(5).max(600),
  preview: z.boolean().default(false),
});

/** preview=true returns the recipient count only. */
router.post('/', permit('members.write'), validate({ body }), async (req, res) => {
  const { branchId, audience, channels, subject, text, preview } = req.body;
  if (branchId) assertBranchAccess(req, branchId);
  // No branch chosen = every branch the sender can see.
  const scope = branchId
    ? { branchId: new mongoose.Types.ObjectId(branchId) }
    : branchFilter({ allowedBranchIds: req.allowedBranchIds, query: {} });
  const filter = { isDeleted: false, ...scope, ...audienceFilter(audience) };
  const total = await Member.countDocuments(filter);
  if (preview) return res.json({ success: true, data: { total } });

  const a = await Announcement.create({ branchId, audience, channels, subject, text, total, createdBy: req.user._id });
  await audit(req, 'announcement.send', { entity: 'Announcement', entityId: a._id, branchId, details: { audience, channels, total } });

  // Sent in the background; progress is visible in the history list.
  await inBackground('announcement', async () => {
    const gym = await getGym();
    let sent = 0;
    let failed = 0;
    for await (const member of Member.find(filter).lean().cursor()) {
      for (const channel of channels) {
        try {
          const key = `announce:${a._id}:${member._id}`;
          const n =
            channel === 'email'
              ? await sendMemberEmail({ member, template: 'announcement', dedupeKey: `${key}:email`, subject: subject || `Message from ${gym.name}`, text })
              : await sendMessage({ member, channel, template: 'announcement', vars: { name: member.name, text, gym: gym.name }, dedupeKey: key });
          if (n?.status === 'failed') failed += 1;
          else if (n) sent += 1;
        } catch (err) {
          failed += 1;
          logger.error({ err }, 'announcement message failed');
        }
      }
    }
    await Announcement.updateOne({ _id: a._id }, { sent, failed, status: 'done' });
  });
  res.status(201).json({ success: true, data: await Announcement.findById(a._id).lean() });
});

/** Development only: messages that were not really sent because no SMS/WhatsApp provider is configured. */
router.get('/dev-outbox', permit('settings.write'), (_req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ success: false });
  res.json({ success: true, data: devOutbox.slice(-50).reverse() });
});

export default router;
