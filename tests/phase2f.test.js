import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { dayjs, tz } from '../src/utils/dates.js';
import { computeAccess } from '../src/modules/access/access.engine.js';
import { DeviceCommand } from '../src/modules/devices/device.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { StaffAttendance } from '../src/modules/staff/staff.model.js';

let ctx;
let owner;
let rec;
let trainer;

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
});
after(teardown);

test('time-slot plan: entry only inside the slot, device gets the access time-zone', async () => {
  const plan = await api()
    .post('/api/v1/plans')
    .set(auth(owner))
    .send({ name: 'Morning', durationValue: 1, durationUnit: 'month', price: 80000, accessStart: '06:00', accessEnd: '11:00', deviceTimezoneId: 2 });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const bad = await api().post('/api/v1/plans').set(auth(owner)).send({ name: 'Bad', durationValue: 1, durationUnit: 'month', price: 1, accessStart: '11:00' });
  assert.equal(bad.status, 400);

  const today = dayjs().tz(tz).startOf('day');
  const sub = { startDate: today.toDate(), endDate: today.add(20, 'day').toDate(), status: 'active', dueAmount: 0, freezes: [], plan: { name: 'Morning', accessStart: '06:00', accessEnd: '11:00', deviceTimezoneId: 2 } };
  const at = (hhmm) => dayjs.tz(`${today.format('YYYY-MM-DD')}T${hhmm}:00`, tz).toDate();
  const morning = computeAccess({ member: {}, subscriptions: [sub], now: at('07:30') });
  assert.equal(morning.allowed, true);
  assert.equal(morning.device.timezoneId, 2);
  const evening = computeAccess({ member: {}, subscriptions: [sub], now: at('18:00') });
  assert.equal(evening.allowed, false);
  assert.equal(evening.code, 'OUTSIDE_HOURS');
  assert.equal(evening.device.enabled, true); // device enforces the slot itself

  // Device command carries the time-zone number
  await api().post('/api/v1/devices').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Door', serialNo: 'SLOT0001' });
  const m = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Early Bird', phone: '9100000001' })).body.data;
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m._id, planId: plan.body.data._id });
  const cmds = await DeviceCommand.find({ memberId: m._id }).lean();
  assert.ok(cmds.some((c) => /userauthorize Pin=\d+\tAuthorizeTimezoneId=2/.test(c.command)));
});

test('staff get a device PIN and are pushed to the device; a staff punch records staff attendance', async () => {
  const r = await api().post('/api/v1/users').set(auth(owner)).send({ name: 'New Trainer', email: 'nt@t.com', password: 'Password@1', role: 'trainer', branchIds: [String(ctx.main._id)] });
  assert.equal(r.status, 201);
  const u = await User.findById(r.body.data._id).lean();
  assert.ok(u.devicePin >= 90001);
  assert.ok(await DeviceCommand.exists({ kind: 'STAFF_SYNC', command: new RegExp(`Pin=${u.devicePin}\\t`) }));

  // Both punches on today's date, whatever time the suite runs (just after midnight too).
  const now = dayjs().tz(tz);
  const start = now.startOf('day');
  const t1 = (now.subtract(3, 'hour').isBefore(start) ? start : now.subtract(3, 'hour')).format('YYYY-MM-DD HH:mm:ss');
  const t2 = now.subtract(1, 'minute').format('YYYY-MM-DD HH:mm:ss');
  for (const [i, t] of [t1, t2].entries()) {
    await api()
      .post('/iclock/cdata?SN=SLOT0001&table=rtlog')
      .set('Content-Type', 'text/plain')
      .send(`time=${t}\tpin=${u.devicePin}\tevent=0\tindex=${i}`);
  }
  const row = await StaffAttendance.findOne({ userId: u._id }).lean();
  assert.equal(row.method, 'biometric');
  assert.ok(row.checkOutAt > row.checkInAt);
});

test('manual clock in / out and monthly summary', async () => {
  assert.equal((await api().post('/api/v1/staff-attendance/clock-in').set(auth(rec))).status, 201);
  assert.equal((await api().post('/api/v1/staff-attendance/clock-in').set(auth(rec))).status, 409);
  assert.equal((await api().post('/api/v1/staff-attendance/clock-out').set(auth(rec))).status, 200);
  // Receptionist only sees own rows; owner sees everyone
  const mine = await api().get('/api/v1/staff-attendance').set(auth(rec));
  assert.equal(mine.body.data.total, 1);
  const sum = await api().get('/api/v1/staff-attendance/summary').set(auth(owner));
  assert.ok(sum.body.data.rows.length >= 2);
  assert.equal((await api().post('/api/v1/staff-attendance/clock-out').set(auth(trainer))).status, 400);
});

test('public enquiry: no login, creates a website lead, repeats merge, honeypot ignored', async () => {
  const info = await api().get('/api/v1/public/info');
  assert.equal(info.status, 200);
  assert.ok(info.body.data.plans.length >= 1);
  assert.equal(info.body.data.gym.name, 'Test Gym');

  const body = { branchId: String(ctx.main._id), name: 'Web Visitor', phone: '9100000099', interest: 'Monthly', message: 'Evening batch?' };
  assert.equal((await api().post('/api/v1/public/enquiry').send(body)).status, 201);
  assert.equal((await api().post('/api/v1/public/enquiry').send(body)).status, 201);
  const leads = await Lead.find({ phone: '9100000099' }).lean();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'website');
  assert.equal(leads[0].followUps.length, 1);

  await api().post('/api/v1/public/enquiry').send({ ...body, phone: '9100000098', website: 'http://spam' });
  assert.equal(await Lead.countDocuments({ phone: '9100000098' }), 0);
});

test('member documents: add and remove', async () => {
  const m = (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Doc Holder', phone: '9100000002' })).body.data;
  // Documents are private files now (raw upload); a public link is no longer accepted.
  const old = await api().post(`/api/v1/members/${m._id}/documents`).set(auth(rec)).send({ name: 'Aadhaar', kind: 'id-proof', url: 'https://res.cloudinary.com/demo/raw/upload/a.pdf' });
  assert.equal(old.status, 400);
  const add = await api().post(`/api/v1/members/${m._id}/documents?name=Aadhaar&kind=id-proof`).set(auth(rec)).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4\n%%EOF\n'));
  assert.equal(add.status, 201);
  assert.equal(add.body.data.length, 1);
  const del = await api().delete(`/api/v1/members/${m._id}/documents/${add.body.data[0]._id}`).set(auth(rec));
  assert.equal(del.body.data.length, 0);
});

test('branch comparison report', async () => {
  const r = await api().get('/api/v1/reports/branches').set(auth(owner));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.rows.length, 2);
  assert.ok('profit' in r.body.data.rows[0]);
  const scoped = await api().get('/api/v1/reports/branches').set(auth(rec));
  assert.equal(scoped.status, 403);
});
