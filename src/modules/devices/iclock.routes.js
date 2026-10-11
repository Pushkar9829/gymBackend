/**
 * Endpoints called BY the biometric devices (ZKTeco / eSSL ADMS push).
 * Mounted at /iclock because that path is fixed in device firmware.
 * Devices speak plain text; every response must be text/plain.
 */
import express, { Router } from 'express';
import { Device, DeviceCommand, DeviceUser } from './device.model.js';
import {
  attendanceHandshake,
  securityPushConfig,
  parseAttLog,
  parseKeyValueLines,
  parseCommandResults,
  parseDeviceTime,
  isGrantedEvent,
  deviceEventReason,
} from './adms.js';
import { processDevicePunch } from '../attendance/attendance.service.js';
import { logger } from '../../config/logger.js';

const router = Router();
router.use(express.text({ type: () => true, limit: '2mb' }));

const MAX_COMMANDS_PER_POLL = 20;
const RESEND_AFTER_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const text = (res, body, status = 200) => res.status(status).type('text/plain').send(body);

/** Identifies the device by serial number (and optional IP allow-list). */
async function loadDevice(req, res, next) {
  const sn = String(req.query.SN || req.query.sn || '').trim();
  if (!sn) return text(res, 'ERROR: missing SN', 400);
  const device = await Device.findOne({ serialNo: sn, isActive: true });
  if (!device) {
    logger.warn({ sn, ip: req.ip }, 'unknown biometric device');
    return text(res, 'ERROR: unknown device', 403);
  }
  if (device.allowedIps?.length && !device.allowedIps.includes(req.ip)) {
    logger.warn({ sn, ip: req.ip }, 'biometric device IP not allowed');
    return text(res, 'ERROR: forbidden', 403);
  }
  req.device = device;
  // Heartbeat (throttled to avoid a write on every poll)
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 30000 || device.lastIp !== req.ip) {
    await Device.updateOne({ _id: device._id }, { lastSeenAt: new Date(), lastIp: req.ip });
  }
  next();
}

router.use(loadDevice);

// --- Security PUSH registration / config
router.post('/registry', (req, res) => text(res, `RegistryCode=${String(req.device._id).slice(-10)}`));
router.get('/push', (req, res) => text(res, securityPushConfig(req.device)));
router.post('/push', (req, res) => text(res, securityPushConfig(req.device)));
router.get('/ping', (_req, res) => text(res, 'OK'));

// --- Attendance PUSH handshake
router.get('/cdata', async (req, res) => {
  if (req.query.options === 'all' || req.query.type === 'options') {
    if (req.query.pushver || req.query.language) {
      await Device.updateOne({ _id: req.device._id }, { firmware: String(req.query.pushver || '') });
    }
    return text(res, attendanceHandshake(req.device));
  }
  return text(res, 'OK');
});

// --- Data upload (punches, user changes, operation logs...)
router.post('/cdata', async (req, res) => {
  const table = String(req.query.table || '').toLowerCase();
  const device = req.device;
  const body = typeof req.body === 'string' ? req.body : '';

  if (table === 'attlog') {
    const records = parseAttLog(body);
    for (const r of records) {
      try {
        await processDevicePunch({ device, pin: r.pin, at: r.at, deviceGranted: true });
      } catch (err) {
        logger.error({ err, sn: device.serialNo, pin: r.pin }, 'punch processing failed');
      }
    }
    if (req.query.Stamp) await Device.updateOne({ _id: device._id }, { attStamp: String(req.query.Stamp) });
    return text(res, `OK: ${records.length}`);
  }

  if (table === 'rtlog') {
    const records = parseKeyValueLines(body);
    for (const r of records) {
      const pin = String(r.pin || '').trim();
      const at = parseDeviceTime(r.time);
      if (!pin || pin === '0' || !at) continue; // door/alarm events without a user
      const granted = isGrantedEvent(r.event);
      try {
        await processDevicePunch({
          device,
          pin,
          at,
          deviceGranted: granted,
          deviceEvent: r.event,
          deviceReason: granted ? undefined : deviceEventReason(r.event),
        });
      } catch (err) {
        logger.error({ err, sn: device.serialNo, pin }, 'rtlog processing failed');
      }
    }
    return text(res, 'OK');
  }

  if (table === 'operlog' && req.query.Stamp) {
    await Device.updateOne({ _id: device._id }, { opStamp: String(req.query.Stamp) });
  }
  // USERINFO / BIODATA / tabledata / rtstate etc. are acknowledged only.
  return text(res, 'OK');
});

// --- Device polls for pending commands
router.get('/getrequest', async (req, res) => {
  const device = req.device;
  const now = Date.now();
  await DeviceCommand.updateMany(
    { deviceId: device._id, status: 'sent', attempts: { $gte: MAX_ATTEMPTS }, sentAt: { $lt: new Date(now - RESEND_AFTER_MS) } },
    { status: 'failed', returnCode: 'NO_RESPONSE' },
  );
  const cmds = await DeviceCommand.find({
    deviceId: device._id,
    $or: [{ status: 'pending' }, { status: 'sent', sentAt: { $lt: new Date(now - RESEND_AFTER_MS) }, attempts: { $lt: MAX_ATTEMPTS } }],
  })
    .sort({ cmdId: 1 })
    .limit(MAX_COMMANDS_PER_POLL)
    .lean();
  if (!cmds.length) return text(res, 'OK');
  await DeviceCommand.updateMany({ _id: { $in: cmds.map((c) => c._id) } }, { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } });
  return text(res, cmds.map((c) => `C:${c.cmdId}:${c.command}`).join('\n') + '\n');
});

// --- Device reports command results
router.post('/devicecmd', async (req, res) => {
  const results = parseCommandResults(req.body);
  for (const r of results) {
    const ok = Number(r.ret) >= 0;
    const cmd = await DeviceCommand.findOneAndUpdate(
      { deviceId: req.device._id, cmdId: r.id },
      { status: ok ? 'done' : 'failed', returnCode: r.ret, doneAt: new Date() },
      { returnDocument: 'after' },
    );
    if (ok && cmd?.memberId && cmd.kind === 'USER_SYNC') {
      await DeviceUser.updateOne({ deviceId: req.device._id, memberId: cmd.memberId }, { lastConfirmedAt: new Date() });
    }
    if (!ok) logger.warn({ sn: req.device.serialNo, cmdId: r.id, ret: r.ret }, 'device command failed');
  }
  return text(res, 'OK');
});

export default router;
