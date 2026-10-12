import { Router } from 'express';
import { requireStaff, requireMember, permit } from '../../middlewares/auth.js';
import { branchFilter } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { getGym } from '../settings/gym.model.js';
import { Referral, REFERRAL_STATUS } from './referral.model.js';
import { ensureReferralCode, referralSettings, firstName } from './referral.service.js';

/* ---------------- Staff report: /api/v1/referrals (owner / manager) ---------------- */
export const referralRouter = Router();
referralRouter.use(requireStaff);

referralRouter.get('/', permit('reports.read'), async (req, res) => {
  const filter = { ...branchFilter(req) };
  if (REFERRAL_STATUS.includes(req.query.status)) filter.status = req.query.status;
  const [data, counts] = await Promise.all([
    paginate(Referral, filter, req.query, {
      sort: { createdAt: -1 },
      populate: [
        { path: 'referrerId', select: 'name memberCode phone' },
        { path: 'referredId', select: 'name memberCode phone' },
        { path: 'rewardSubscriptionId', select: 'plan.name endDate' },
      ],
    }),
    Referral.aggregate([{ $match: { ...branchFilter(req) } }, { $group: { _id: '$status', n: { $sum: 1 }, days: { $sum: { $cond: [{ $eq: ['$status', 'rewarded'] }, '$rewardDays', 0] } } } }]),
  ]);
  const summary = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  summary.daysGiven = counts.reduce((s, c) => s + (c.days || 0), 0);
  res.json({ success: true, data: { ...data, summary } });
});

/* ---------------- Member app: /api/v1/me/referral ---------------- */
export const portalReferralRouter = Router();
portalReferralRouter.use(requireMember);

portalReferralRouter.get('/referral', async (req, res) => {
  const gym = await getGym();
  const cfg = referralSettings(gym.settings);
  if (!cfg.enabled) return res.json({ success: true, data: { enabled: false } });
  const code = await ensureReferralCode(req.member);
  const list = await Referral.find({ referrerId: req.member._id }).sort({ createdAt: -1 }).limit(50).populate('referredId', 'name').lean();
  res.json({
    success: true,
    data: {
      enabled: true,
      code,
      gymName: gym.name,
      rewardDays: cfg.rewardDays,
      friendDiscountPercent: cfg.newMemberDiscountPercent,
      // Friends' first names only.
      referrals: list.map((r) => ({ _id: r._id, name: firstName(r.referredId?.name), status: r.status, rewardDays: r.rewardDays, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
    },
  });
});
