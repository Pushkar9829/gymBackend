import crypto from 'node:crypto';
import { User } from '../users/user.model.js';
import { Device, DeviceCommand } from '../devices/device.model.js';
import { buildUserSyncCommands } from '../devices/adms.js';
import { StaffAttendance, DeviceStaff } from './staff.model.js';
import { nextSeq } from '../../utils/counter.js';
import { ymd } from '../../utils/dates.js';

export const STAFF_PIN_START = 90001; // member codes start at 1001, so staff PINs never clash in practice

export async function ensureDevicePin(user) {
  if (user.devicePin) return user.devicePin;
  const pin = await nextSeq('staffPin', STAFF_PIN_START);
  await User.updateOne({ _id: user._id }, { devicePin: pin });
  return pin;
}

/** Puts the staff member on the biometric devices of their branches (owner: all branches). */
export async function syncStaffToDevices(user, { force = false, devices } = {}) {
  const pin = String(await ensureDevicePin(user));
  const targets =
    devices || (await Device.find({ isActive: true, ...(user.role === 'owner' ? {} : { branchId: { $in: user.branchIds || [] } }) }).lean());
  const enabled = Boolean(user.isActive);
  const stateHash = crypto.createHash('sha1').update(JSON.stringify([pin, user.name, enabled])).digest('hex');
  let queued = 0;
  for (const device of targets) {
    if (user.role !== 'owner' && !(user.branchIds || []).map(String).includes(String(device.branchId))) continue;
    const existing = await DeviceStaff.findOne({ deviceId: device._id, userId: user._id }).lean();
    if (!force && existing?.stateHash === stateHash) continue;
    if (!existing && !enabled) continue;
    for (const command of buildUserSyncCommands(device, { pin, name: user.name, enabled, validFrom: null, validTo: null, timezoneId: 1 })) {
      const cmdId = await nextSeq(`devcmd:${device._id}`);
      await DeviceCommand.create({ deviceId: device._id, cmdId, kind: 'STAFF_SYNC', command });
    }
    await DeviceStaff.updateOne({ deviceId: device._id, userId: user._id }, { $set: { pin, enabled, stateHash, lastQueuedAt: new Date() } }, { upsert: true });
    queued += 1;
  }
  return { queued };
}

/** Records a staff punch: first of the day is check-in, any later punch moves check-out. */
export async function recordStaffPunch({ user, at = new Date(), method, deviceId, branchId }) {
  const day = ymd(at);
  const existing = await StaffAttendance.findOne({ userId: user._id, day });
  if (!existing) {
    try {
      return await StaffAttendance.create({ userId: user._id, branchId: branchId || user.branchIds?.[0], day, checkInAt: at, method, deviceId });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return StaffAttendance.findOne({ userId: user._id, day });
    }
  }
  if (at > existing.checkInAt && (!existing.checkOutAt || at > existing.checkOutAt)) {
    existing.checkOutAt = at;
    await existing.save();
  }
  return existing;
}
