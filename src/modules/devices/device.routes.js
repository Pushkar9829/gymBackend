import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { Device, DeviceCommand, DeviceUser } from './device.model.js';
import { Member } from '../members/member.model.js';
import { refreshMember } from '../members/member.state.js';
import { queueRawCommand } from './device.sync.js';
import { getGym } from '../settings/gym.model.js';
import { audit } from '../audit/audit.model.js';
import { User } from '../users/user.model.js';
import { syncStaffToDevices } from '../staff/staff.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const ONLINE_MS = 2 * 60 * 1000;

const body = z.object({
  branchId: objectId,
  name: z.string().trim().min(2).max(60),
  serialNo: z.string().trim().min(4).max(40),
  location: z.enum(['entry', 'exit', 'both']).optional(),
  dialect: z.enum(['security', 'attendance']).optional(),
  allowedGroup: z.number().int().min(1).max(99).optional(),
  blockedGroup: z.number().int().min(1).max(99).optional(),
  doorId: z.number().int().min(1).max(15).optional(),
  timezoneOffset: z.number().min(-12).max(14).optional(),
  allowedIps: z.array(z.string().trim()).max(10).optional(),
  isActive: z.boolean().optional(),
});

async function withStatus(devices) {
  const ids = devices.map((d) => d._id);
  const [pending, failed] = await Promise.all([
    DeviceCommand.aggregate([{ $match: { deviceId: { $in: ids }, status: { $in: ['pending', 'sent'] } } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]),
    DeviceCommand.aggregate([{ $match: { deviceId: { $in: ids }, status: 'failed' } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]),
  ]);
  const p = Object.fromEntries(pending.map((x) => [String(x._id), x.n]));
  const f = Object.fromEntries(failed.map((x) => [String(x._id), x.n]));
  return devices.map((d) => ({
    ...d,
    online: Boolean(d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < ONLINE_MS),
    pendingCommands: p[String(d._id)] || 0,
    failedCommands: f[String(d._id)] || 0,
  }));
}

router.get('/', permit('devices.read'), async (req, res) => {
  const devices = await Device.find(branchFilter(req)).populate('branchId', 'name').sort({ name: 1 }).lean();
  res.json({ success: true, data: await withStatus(devices) });
});

/** Queues every member of the device's branch (full re-sync). */
async function fullSync(device) {
  const settings = (await getGym()).settings;
  const devices = [device.toObject ? device.toObject() : device];
  let count = 0;
  for await (const m of Member.find({ branchId: device.branchId, isDeleted: false }).lean().cursor()) {
    await refreshMember(m, { settings, devices, force: true });
    count += 1;
  }
  // Staff of this branch (and owners) for staff attendance.
  for (const u of await User.find({ isActive: true, $or: [{ role: 'owner' }, { branchIds: device.branchId }] }).lean()) {
    await syncStaffToDevices(u, { devices, force: true });
  }
  await Device.updateOne({ _id: device._id }, { lastFullSyncAt: new Date() });
  return count;
}

router.post('/', permit('devices.write'), validate({ body }), async (req, res) => {
  assertBranchAccess(req, req.body.branchId);
  const device = await Device.create(req.body);
  await audit(req, 'device.create', { entity: 'Device', entityId: device._id, branchId: device.branchId });
  const members = await fullSync(device);
  res.status(201).json({ success: true, data: { device, membersQueued: members } });
});

router.put('/:id', permit('devices.write'), validate({ body: body.partial() }), async (req, res) => {
  const device = await findInBranch(req, Device, req.params.id, { notFound: 'Device not found' });
  if (req.body.branchId) assertBranchAccess(req, req.body.branchId);
  Object.assign(device, req.body);
  await device.save();
  await audit(req, 'device.update', { entity: 'Device', entityId: device._id, details: req.body });
  res.json({ success: true, data: device });
});

router.post('/:id/sync', permit('devices.write'), async (req, res) => {
  const device = await findInBranch(req, Device, req.params.id, { notFound: 'Device not found' });
  const members = await fullSync(device);
  await audit(req, 'device.sync', { entity: 'Device', entityId: device._id });
  res.json({ success: true, data: { membersQueued: members } });
});

router.post('/:id/reboot', permit('devices.write'), async (req, res) => {
  const device = await findInBranch(req, Device, req.params.id, { notFound: 'Device not found' });
  await queueRawCommand(device, 'REBOOT');
  await audit(req, 'device.reboot', { entity: 'Device', entityId: device._id });
  res.json({ success: true });
});

router.get('/:id/commands', permit('devices.read'), async (req, res) => {
  const device = await findInBranch(req, Device, req.params.id, { notFound: 'Device not found' });
  const filter = { deviceId: device._id };
  if (req.query.status) filter.status = String(req.query.status);
  const data = await paginate(DeviceCommand, filter, req.query, { sort: { cmdId: -1 }, populate: { path: 'memberId', select: 'name memberCode' } });
  res.json({ success: true, data });
});

router.get('/:id/users', permit('devices.read'), async (req, res) => {
  const device = await findInBranch(req, Device, req.params.id, { notFound: 'Device not found' });
  const data = await paginate(DeviceUser, { deviceId: device._id }, req.query, {
    sort: { pin: 1 },
    populate: { path: 'memberId', select: 'name memberCode membershipStatus' },
  });
  res.json({ success: true, data });
});

export default router;
