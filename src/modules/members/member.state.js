import { Member } from './member.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { getGym } from '../settings/gym.model.js';
import { computeAccess } from '../access/access.engine.js';
import { syncMemberToDevices } from '../devices/device.sync.js';
import { logger } from '../../config/logger.js';

export async function loadAccess(member, { now = new Date(), settings } = {}) {
  const [subscriptions, gymSettings] = await Promise.all([
    Subscription.find({ memberId: member._id }).lean(),
    settings ? Promise.resolve(settings) : getGym().then((g) => g.settings || {}),
  ]);
  return { access: computeAccess({ member, subscriptions, settings: gymSettings, now }), subscriptions };
}

/**
 * Recomputes the member's denormalised membership fields and pushes the
 * resulting access state to the biometric devices. Call after anything that
 * can change access: subscription, freeze, payment, block, branch change, delete.
 */
export async function refreshMember(memberOrId, { now = new Date(), settings, force = false, devices } = {}) {
  // Note: an ObjectId also has an `_id` getter, so check for a real document.
  const isDoc = memberOrId && typeof memberOrId === 'object' && 'memberCode' in memberOrId;
  const member = isDoc ? memberOrId : await Member.findById(memberOrId).lean();
  if (!member) return null;
  const { access, subscriptions } = await loadAccess(member, { now, settings });

  const upcoming = access.membershipStatus === 'upcoming' ? earliestFuture(subscriptions, now) : null;
  const shown = access.current || upcoming || latest(subscriptions);
  const totalDue = subscriptions.filter((s) => s.status !== 'cancelled').reduce((sum, s) => sum + (s.dueAmount || 0), 0);

  await Member.updateOne(
    { _id: member._id },
    {
      $set: {
        membershipStatus: access.membershipStatus,
        membershipStart: access.window?.from || shown?.startDate || null,
        membershipEnd: access.window?.to || shown?.endDate || null,
        currentPlanName: shown?.plan?.name || null,
        dueAmount: totalDue,
      },
    },
  );

  if (!member.isDeleted) {
    try {
      await syncMemberToDevices(member, access, { force, devices });
    } catch (err) {
      // Device sync must never block billing; the daily job re-syncs drift.
      logger.error({ err, memberId: member._id }, 'device sync failed');
    }
  }
  return access;
}

const earliestFuture = (subs, now) =>
  subs
    .filter((s) => s.status !== 'cancelled' && new Date(s.endDate) >= now)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0] || null;

const latest = (subs) =>
  subs.filter((s) => s.status !== 'cancelled').sort((a, b) => new Date(b.endDate) - new Date(a.endDate))[0] || null;
