/**
 * ZKTeco / eSSL ADMS ("iclock" cloud push) protocol helpers.
 *
 * NOTE: firmware differs between models. The command formats below follow the published
 * "Security PUSH" (access control) and "Attendance PUSH" protocol documents. Verify against the
 * exact device model during installation; all formats are isolated in this file.
 */
import { dayjs, tz } from '../../utils/dates.js';

const clean = (s) => String(s ?? '').replace(/[\t\r\n]/g, ' ').trim();

/** ZK packed time used by Security PUSH StartTime/EndTime (device local time). */
export function zkEncodeTime(date, { endOfDay = false } = {}) {
  if (!date) return 0;
  const d = dayjs(date).tz(tz);
  const [h, m, s] = endOfDay ? [23, 59, 59] : [0, 0, 0];
  return ((d.year() - 2000) * 12 * 31 + d.month() * 31 + (d.date() - 1)) * 24 * 60 * 60 + h * 3600 + m * 60 + s;
}

export function zkDecodeTime(n) {
  let t = Number(n);
  const sec = t % 60; t = Math.floor(t / 60);
  const min = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = t % 12; t = Math.floor(t / 12);
  const year = t + 2000;
  return dayjs.tz(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, tz).toDate();
}

/** Command bodies (without the "C:<id>:" prefix) that put a member into the desired state. */
export function buildUserSyncCommands(device, { pin, name, enabled, validFrom, validTo }) {
  const n = clean(name).slice(0, 24);
  if (device.dialect === 'attendance') {
    const grp = enabled ? device.allowedGroup : device.blockedGroup;
    return [`DATA UPDATE USERINFO PIN=${pin}\tName=${n}\tPri=0\tPasswd=\tCard=\tGrp=${grp}\tTZ=0000000000000000\tVerify=0`];
  }
  // Security PUSH: the device itself refuses entry outside StartTime..EndTime or when Disable=1.
  const start = enabled ? zkEncodeTime(validFrom) : 0;
  const end = enabled ? zkEncodeTime(validTo, { endOfDay: true }) : 0;
  return [
    `DATA UPDATE user CardNo=\tPin=${pin}\tPassword=\tGroup=0\tStartTime=${start}\tEndTime=${end}\tName=${n}\tPrivilege=0\tDisable=${enabled ? 0 : 1}\tVerify=0`,
    `DATA UPDATE userauthorize Pin=${pin}\tAuthorizeTimezoneId=1\tAuthorizeDoorId=${device.doorId || 1}\tDevID=1`,
  ];
}

export function buildUserDeleteCommands(device, pin) {
  if (device.dialect === 'attendance') return [`DATA DELETE USERINFO PIN=${pin}`];
  return [`DATA DELETE userauthorize Pin=${pin}`, `DATA DELETE user Pin=${pin}`];
}

/** Options returned to an attendance-push device on GET /iclock/cdata?options=all */
export function attendanceHandshake(device) {
  return [
    `GET OPTION FROM: ${device.serialNo}`,
    `ATTLOGStamp=${device.attStamp || 0}`,
    `OPERLOGStamp=${device.opStamp || 0}`,
    'ATTPHOTOStamp=None',
    'ErrorDelay=30',
    'Delay=5',
    'TransTimes=00:00;12:00',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog EnrollUser ChgUser',
    `TimeZone=${device.timezoneOffset ?? 5.5}`,
    'Realtime=1',
    'Encrypt=None',
  ].join('\n');
}

/** Config returned to a Security PUSH device on GET /iclock/push */
export function securityPushConfig(device) {
  return [
    'ServerVersion=3.1.2',
    'ServerName=GymADMS',
    'PushVersion=3.1.2',
    'ErrorDelay=30',
    'RequestDelay=3',
    'TransTimes=00:00\t12:00',
    'TransInterval=1',
    'TransTables=User Transaction',
    'Realtime=1',
    `SessionID=${String(device._id).slice(-12)}`,
    'TimeoutSec=10',
  ].join('\n');
}

/** "1001\t2026-10-11 07:15:02\t0\t1\t0\t0" -> { pin, at } (attendance push ATTLOG) */
export function parseAttLog(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [pin, time, status, verify] = line.split('\t');
      return { pin: clean(pin), at: parseDeviceTime(time), status, verify, raw: line };
    })
    .filter((r) => r.pin && r.at);
}

/** "time=2026-10-11 07:15:02\tpin=1001\t...\tevent=0\t..." -> records (Security PUSH rtlog) */
export function parseKeyValueLines(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split('\t').map((kv) => {
      const i = kv.indexOf('=');
      return i === -1 ? [kv, ''] : [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()];
    })));
}

/**
 * Security PUSH event codes. Granted events open the door; everything else is a denial.
 * Common denials: 20 too-short interval, 22 illegal time zone, 23 access denied,
 * 27 unregistered user, 29 user expired / disabled, 41 verify mode error.
 */
const GRANTED_EVENTS = new Set([0, 1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19, 26]);
export const isGrantedEvent = (event) => GRANTED_EVENTS.has(Number(event));

const DEVICE_DENY_REASONS = {
  20: 'Scan too soon after the previous one',
  22: 'Outside allowed time',
  23: 'Access denied by device',
  27: 'Unregistered user / finger',
  29: 'User expired or disabled on device',
  41: 'Verification mode error',
};
export const deviceEventReason = (event) => DEVICE_DENY_REASONS[Number(event)] || `Device event ${event}`;

/** "ID=12&Return=0&CMD=DATA" lines -> [{ id, ret, cmd }] */
export function parseCommandResults(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const p = new URLSearchParams(line);
      return { id: Number(p.get('ID')), ret: p.get('Return'), cmd: p.get('CMD') };
    })
    .filter((r) => Number.isFinite(r.id));
}

export function parseDeviceTime(s) {
  if (!s) return null;
  const d = dayjs.tz(String(s).trim().replace(' ', 'T'), tz);
  return d.isValid() ? d.toDate() : null;
}
