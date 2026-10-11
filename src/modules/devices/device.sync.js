import crypto from 'node:crypto';
import { Device, DeviceUser, DeviceCommand } from './device.model.js';
import { buildUserSyncCommands, buildUserDeleteCommands } from './adms.js';
import { nextSeq } from '../../utils/counter.js';
import { ymd } from '../../utils/dates.js';

const hashState = (s) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify([s.pin, s.name, s.enabled, s.validFrom ? ymd(s.validFrom) : null, s.validTo ? ymd(s.validTo) : null]))
    .digest('hex');

async function enqueue(device, { memberId, kind, bodies }) {
  // A newer state for the same member makes older unsent commands pointless.
  if (memberId) {
    await DeviceCommand.updateMany(
      { deviceId: device._id, memberId, status: 'pending', kind: { $in: ['USER_SYNC', 'USER_DELETE'] } },
      { $set: { status: 'superseded' } },
    );
  }
  const docs = [];
  for (const command of bodies) {
    const cmdId = await nextSeq(`devcmd:${device._id}`);
    docs.push({ deviceId: device._id, cmdId, memberId, kind, command });
  }
  return DeviceCommand.insertMany(docs);
}

/**
 * Pushes the member's desired access state to every active device in their branch.
 * Only queues commands when the state actually changed (unless force).
 */
export async function syncMemberToDevices(member, access, { force = false, devices } = {}) {
  const targets = devices || (await Device.find({ branchId: member.branchId, isActive: true }).lean());
  if (!targets.length) return { queued: 0 };

  const desired = {
    pin: String(member.memberCode),
    name: member.name,
    enabled: Boolean(access.device.enabled),
    validFrom: access.device.validFrom,
    validTo: access.device.validTo,
  };
  const stateHash = hashState(desired);
  let queued = 0;

  for (const device of targets) {
    const existing = await DeviceUser.findOne({ deviceId: device._id, memberId: member._id }).lean();
    if (!force && existing?.stateHash === stateHash) continue;
    // Never-enrolled members with no access don't need a disabled record pushed.
    if (!existing && !desired.enabled && !force) continue;

    await enqueue(device, { memberId: member._id, kind: 'USER_SYNC', bodies: buildUserSyncCommands(device, desired) });
    await DeviceUser.updateOne(
      { deviceId: device._id, memberId: member._id },
      {
        $set: {
          pin: desired.pin,
          name: desired.name,
          enabled: desired.enabled,
          validFrom: desired.validFrom,
          validTo: desired.validTo,
          stateHash,
          lastQueuedAt: new Date(),
        },
      },
      { upsert: true },
    );
    queued += 1;
  }
  return { queued };
}

/** Removes a member from devices (member deleted or moved to another branch). Templates are deleted too. */
export async function removeMemberFromDevices(member, { branchId } = {}) {
  const filter = branchId ? { branchId, isActive: true } : { isActive: true };
  const devices = await Device.find(filter).lean();
  for (const device of devices) {
    const du = await DeviceUser.findOne({ deviceId: device._id, memberId: member._id });
    if (!du) continue;
    await enqueue(device, { memberId: member._id, kind: 'USER_DELETE', bodies: buildUserDeleteCommands(device, du.pin) });
    await du.deleteOne();
  }
}

export async function queueRawCommand(device, command) {
  return enqueue(device, { kind: 'RAW', bodies: [command] });
}
