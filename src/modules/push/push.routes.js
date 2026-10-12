import { Router } from 'express';
import { z } from 'zod';
import { requireMember } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { getGym } from '../settings/gym.model.js';
import { PushSubscription, pushOn, vapidPublicKey, isPushEndpoint } from './push.service.js';

const MAX_DEVICES = 10;

/* Member app: /api/v1/me/push */
export const portalPushRouter = Router();
portalPushRouter.use(requireMember);

portalPushRouter.get('/push/config', async (_req, res) => {
  const enabled = pushOn(await getGym());
  res.json({ success: true, data: { enabled, publicKey: enabled ? vapidPublicKey() : null } });
});

const endpoint = z.string().trim().max(1000).refine(isPushEndpoint, 'Not a browser push address');

portalPushRouter.post(
  '/push/subscribe',
  validate({ body: z.object({ endpoint, keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }) }) }),
  async (req, res) => {
    if (!pushOn(await getGym())) throw ApiError.badRequest('Notifications are not available');
    const { endpoint: url, keys } = req.body;
    // Same browser, another member logged in: the device now belongs to this member.
    await PushSubscription.findOneAndUpdate(
      { endpoint: url },
      { $set: { memberId: req.member._id, branchId: req.member.branchId, keys, ua: String(req.get('user-agent') || '').slice(0, 200), failures: 0 } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    const extra = await PushSubscription.find({ memberId: req.member._id }).sort({ updatedAt: -1 }).skip(MAX_DEVICES).select('_id').lean();
    if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map((x) => x._id) } });
    res.status(201).json({ success: true, data: { subscribed: true } });
  },
);

portalPushRouter.post('/push/unsubscribe', validate({ body: z.object({ endpoint: z.string().trim().max(1000) }) }), async (req, res) => {
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, memberId: req.member._id });
  res.json({ success: true, data: { subscribed: false } });
});
