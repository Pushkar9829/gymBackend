import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { ymd, addDays, dayjs, tz } from '../src/utils/dates.js';
import { DeviceCommand } from '../src/modules/devices/device.model.js';
import { AccessLog } from '../src/modules/access/accessLog.model.js';
import { Attendance } from '../src/modules/attendance/attendance.model.js';
import { zkEncodeTime, zkDecodeTime } from '../src/modules/devices/adms.js';

let ctx;
let owner;
let device;
let active;
let expired;
const SN = 'ZKSN0001';
const nowStr = () => dayjs().tz(tz).format('YYYY-MM-DD HH:mm:ss');

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');

  const mk = async (name, phone) =>
    (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone })).body.data;
  active = await mk('Active One', '9700000001');
  expired = await mk('Expired One', '9700000002');
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: active._id, planId: String(ctx.monthly._id) });
  await api()
    .post('/api/v1/subscriptions')
    .set(auth(owner))
    .send({ memberId: expired._id, planId: String(ctx.day._id), startDate: ymd(addDays(new Date(), -3)) });

  // Registering the device queues a full sync of the branch
  const r = await api().post('/api/v1/devices').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Front door', serialNo: SN });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  device = r.body.data.device;
});
after(teardown);

test('zk time encode/decode round trip', () => {
  const d = dayjs.tz('2026-10-11T00:00:00', tz).toDate();
  assert.equal(zkDecodeTime(zkEncodeTime(d)).getTime(), d.getTime());
});

test('unknown device is rejected', async () => {
  const r = await api().get('/iclock/cdata?SN=NOPE&options=all');
  assert.equal(r.status, 403);
});

test('handshake + push config', async () => {
  const h = await api().get(`/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`);
  assert.equal(h.status, 200);
  assert.match(h.text, /ATTLOGStamp=/);
  const p = await api().get(`/iclock/push?SN=${SN}`);
  assert.match(p.text, /TransTables=User Transaction/);
});

test('device pulls queued commands and reports results', async () => {
  const r = await api().get(`/iclock/getrequest?SN=${SN}`);
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n');
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /^C:\d+:DATA UPDATE user /);
  // expired member who was never on the device is not pushed... but full sync forces it disabled
  assert.ok(lines.some((l) => /Pin=1002.*Disable=1/.test(l)));
  assert.ok(lines.some((l) => /Pin=1001.*Disable=0/.test(l)));

  // Nothing new on the next poll
  assert.equal((await api().get(`/iclock/getrequest?SN=${SN}`)).text, 'OK');

  const ids = lines.map((l) => l.split(':')[1]);
  const body = ids.map((id) => `ID=${id}&Return=0&CMD=DATA`).join('\n');
  const ack = await api().post(`/iclock/devicecmd?SN=${SN}`).set('Content-Type', 'text/plain').send(body);
  assert.equal(ack.text, 'OK');
  assert.equal(await DeviceCommand.countDocuments({ deviceId: device._id, status: 'done' }), ids.length);

  const list = await api().get('/api/v1/devices').set(auth(owner));
  assert.equal(list.body.data[0].online, true);
  assert.equal(list.body.data[0].pendingCommands, 0);
});

test('rtlog: granted punch for active member -> attendance', async () => {
  const body = `time=${nowStr()}\tpin=1001\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=0\tverifytype=1\tindex=1`;
  const r = await api().post(`/iclock/cdata?SN=${SN}&table=rtlog`).set('Content-Type', 'text/plain').send(body);
  assert.equal(r.text, 'OK');
  const att = await Attendance.findOne({ memberId: active._id });
  assert.equal(att.method, 'biometric');
  // Same record re-sent by the device is ignored
  await api().post(`/iclock/cdata?SN=${SN}&table=rtlog`).set('Content-Type', 'text/plain').send(body);
  assert.equal(await AccessLog.countDocuments({ memberId: active._id }), 1);
});

test('rtlog: device denied expired member -> deny log with our reason + staff alert', async () => {
  const body = `time=${nowStr()}\tpin=1002\tcardno=0\teventaddr=1\tevent=29\tinoutstatus=0\tverifytype=1\tindex=2`;
  await api().post(`/iclock/cdata?SN=${SN}&table=rtlog`).set('Content-Type', 'text/plain').send(body);
  const log = await AccessLog.findOne({ memberId: expired._id });
  assert.equal(log.result, 'deny');
  assert.equal(log.code, 'EXPIRED');
  assert.equal(await Attendance.countDocuments({ memberId: expired._id }), 0);
  const n = await api().get('/api/v1/notifications?unread=true').set(auth(owner));
  assert.ok(n.body.data.items.some((x) => x.template === 'access-denied'));
});

test('ATTLOG (attendance firmware): out-of-sync device let expired member in -> flagged + re-sync queued', async () => {
  const before = await DeviceCommand.countDocuments({ memberId: expired._id, status: 'pending' });
  // A different time than the rtlog punch above, so it is not treated as a duplicate.
  const twoMinAgo = dayjs().tz(tz).subtract(2, 'minute').format('YYYY-MM-DD HH:mm:ss');
  const body = `1002\t${twoMinAgo}\t0\t1\t0\t0`;
  const r = await api().post(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=999`).set('Content-Type', 'text/plain').send(body);
  assert.equal(r.text, 'OK: 1');
  const log = await AccessLog.findOne({ memberId: expired._id, code: 'OUT_OF_SYNC' });
  assert.ok(log);
  assert.ok((await DeviceCommand.countDocuments({ memberId: expired._id, status: 'pending' })) > before);
});

test('unknown pin is logged', async () => {
  const body = `time=${nowStr()}\tpin=777\tevent=27\tindex=3`;
  await api().post(`/iclock/cdata?SN=${SN}&table=rtlog`).set('Content-Type', 'text/plain').send(body);
  const log = await AccessLog.findOne({ pin: '777' });
  assert.equal(log.code, 'UNKNOWN_USER');
});
