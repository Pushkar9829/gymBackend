import { Attendance } from './attendance.model.js';
import { AccessLog } from '../access/accessLog.model.js';
import { Member } from '../members/member.model.js';
import { loadAccess, refreshMember } from '../members/member.state.js';
import { createAlert } from '../notifications/notification.service.js';
import { ymd } from '../../utils/dates.js';
import { logger } from '../../config/logger.js';
import { User } from '../users/user.model.js';
import { recordStaffPunch, STAFF_PIN_START } from '../staff/staff.service.js';

/** Upserts today's attendance row. exit=true records check-out instead. */
export async function markAttendance({ member, at, method, deviceId, userId, exit = false }) {
  const day = ymd(at);
  if (exit) {
    return Attendance.findOneAndUpdate(
      { memberId: member._id, day },
      { $set: { checkOutAt: at, lastPunchAt: at }, $inc: { punches: 1 } },
      { returnDocument: 'after' },
    );
  }
  try {
    const row = await Attendance.findOneAndUpdate(
      { memberId: member._id, day },
      {
        $setOnInsert: { branchId: member.branchId, checkInAt: at, method, deviceId, markedBy: userId },
        $max: { lastPunchAt: at },
        $inc: { punches: 1 },
      },
      { upsert: true, returnDocument: 'after' },
    );
    await Member.updateOne({ _id: member._id, $or: [{ lastVisitAt: null }, { lastVisitAt: { $lt: at } }] }, { lastVisitAt: at });
    return row;
  } catch (err) {
    if (err?.code === 11000) return Attendance.findOne({ memberId: member._id, day }); // concurrent first punch
    throw err;
  }
}

async function alertDenied(member, access, source) {
  await createAlert({
    branchId: member.branchId,
    memberId: member._id,
    template: 'access-denied',
    subject: `Entry denied: ${member.name} (#${member.memberCode})`,
    body: `${access.reason} [${source}]`,
    dedupeKey: `deny:${member._id}:${ymd(new Date())}:${access.code}`,
  });
}

/**
 * QR / manual check-in at reception. Same rule engine as the biometric device.
 */
export async function staffCheckIn({ member, method, user, at = new Date() }) {
  const { access } = await loadAccess(member, { now: at });
  await AccessLog.create({
    branchId: member.branchId,
    memberId: member._id,
    pin: String(member.memberCode),
    at,
    result: access.allowed ? 'allow' : 'deny',
    code: access.code,
    reason: access.reason,
    source: method,
    byUser: user?._id,
  });
  if (!access.allowed) {
    await alertDenied(member, access, method);
    return { allowed: false, access };
  }
  const attendance = await markAttendance({ member, at, method, userId: user?._id });
  return { allowed: true, access, attendance };
}

/**
 * A punch reported by a biometric device.
 * deviceGranted: true = device opened the door, false = device refused, null = unknown (attendance logs are successes).
 */
export async function processDevicePunch({ device, pin, at, deviceGranted = true, deviceEvent, deviceReason }) {
  const dup = await AccessLog.exists({ deviceId: device._id, pin, at });
  if (dup) return { duplicate: true };

  const code = /^\d+$/.test(pin) ? Number(pin) : null;
  if (code && code >= STAFF_PIN_START && deviceGranted) {
    const staff = await User.findOne({ devicePin: code, isActive: true }).lean();
    if (staff) {
      await AccessLog.create({ branchId: device.branchId, deviceId: device._id, pin, at, result: 'allow', code: 'STAFF', reason: `Staff: ${staff.name}`, source: 'biometric' });
      return { staff: true, attendance: await recordStaffPunch({ user: staff, at, method: 'biometric', deviceId: device._id, branchId: device.branchId }) };
    }
  }
  const member = code ? await Member.findOne({ memberCode: code, isDeleted: false }).lean() : null;
  const base = { branchId: device.branchId, deviceId: device._id, pin, at, source: 'biometric', deviceEvent: deviceEvent != null ? String(deviceEvent) : undefined };

  if (!member) {
    await AccessLog.create({ ...base, result: deviceGranted ? 'allow' : 'deny', code: 'UNKNOWN_USER', reason: deviceReason || `No member with code ${pin}` });
    return { unknown: true };
  }

  const { access } = await loadAccess(member, { now: at });
  const exit = device.location === 'exit';

  if (!deviceGranted) {
    // Device kept the door closed. Use our reason when we know why (expired, frozen...).
    const reason = access.allowed ? deviceReason || 'Denied by device' : access.reason;
    await AccessLog.create({ ...base, memberId: member._id, result: 'deny', code: access.allowed ? 'DEVICE_DENIED' : access.code, reason });
    if (!access.allowed) await alertDenied(member, access, 'biometric');
    else await refreshMember(member, { force: true }); // device thinks they are invalid but they are valid: re-sync
    return { allowed: false, access };
  }

  if (!access.allowed && !exit) {
    // Door opened although membership is not valid: device out of sync. Record it, alert, force re-sync.
    await AccessLog.create({
      ...base,
      memberId: member._id,
      result: 'allow',
      code: 'OUT_OF_SYNC',
      reason: `Device allowed entry but ${access.reason}. Device re-sync queued.`,
    });
    await createAlert({
      branchId: member.branchId,
      memberId: member._id,
      template: 'device-out-of-sync',
      subject: `Check device: ${member.name} (#${member.memberCode}) was let in`,
      body: access.reason,
      dedupeKey: `oos:${member._id}:${ymd(at)}`,
    });
    logger.warn({ memberId: member._id, device: device.serialNo }, 'device let in a member without valid access');
    await refreshMember(member, { force: true });
    await markAttendance({ member, at, method: 'biometric', deviceId: device._id });
    return { allowed: true, outOfSync: true, access };
  }

  await AccessLog.create({ ...base, memberId: member._id, result: 'allow', code: exit ? 'EXIT' : access.code, reason: exit ? 'Exit' : access.reason });
  const attendance = await markAttendance({ member, at, method: 'biometric', deviceId: device._id, exit });
  return { allowed: true, access, attendance };
}
