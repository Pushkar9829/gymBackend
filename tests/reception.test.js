import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Attendance } from '../src/modules/attendance/attendance.model.js';
import { AccessLog } from '../src/modules/access/accessLog.model.js';
import { Device, DeviceUser, DeviceCommand } from '../src/modules/devices/device.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { HandoverNote } from '../src/modules/handover/handover.model.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { refreshMember, loadAccess } from '../src/modules/members/member.state.js';
import { processDevicePunch } from '../src/modules/attendance/attendance.service.js';
import { addDays, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let manager;
let rec2;
let rec2User;
let device;
const V1 = '/api/v1';
const checkIn = (token, body) => api().post(`${V1}/attendance/check-in`).set(auth(token)).send(body);
const dashboard = async () => (await api().get(`${V1}/reports/dashboard`).set(auth(owner))).body.data;
const mediaBox = (buf) => {
  const m = buf.toString('latin1').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

before(async () => {
  ctx = await setupDb();
  const pw = await hashPassword('Password@1');
  await User.create({ name: 'Manny Manager', email: 'mgr@t.com', role: 'manager', passwordHash: pw, branchIds: [ctx.main._id] });
  rec2User = await User.create({ name: 'Rina Desk', email: 'rec3@t.com', role: 'receptionist', passwordHash: pw, branchIds: [ctx.main._id] });
  [owner, rec, trainer, manager, rec2] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com'), login('mgr@t.com'), login('rec3@t.com')]);
  const r = await api().post(`${V1}/devices`).set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Front door', serialNo: 'TRIAL0001' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  device = await Device.findById(r.body.data.device._id).lean();
});
after(teardown);

/* ---------------- Trial / guest pass ---------------- */
let lead;
let trial;
let before0;

test('trial settings have safe defaults', async () => {
  const s = (await api().get(`${V1}/settings`).set(auth(rec))).body.data.settings;
  assert.deepEqual({ ...s.trial }, { enabled: true, defaultDays: 1, maxDays: 3, repeatDays: 90, allowClassBooking: true });
  assert.equal(s.receiptPaper, 'a4');
});

test('reception issues a paid trial from a lead: lead moves to trial, fee is a receipt', async () => {
  before0 = await dashboard();
  lead = (await api().post(`${V1}/leads`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Tina Trial', phone: '9300000001', source: 'instagram' })).body.data;
  const tooLong = await api().post(`${V1}/trials`).set(auth(rec)).send({ leadId: lead._id, days: 4 });
  assert.equal(tooLong.status, 400);
  const r = await api().post(`${V1}/trials`).set(auth(rec)).send({ leadId: lead._id, days: 2, fee: 20000, mode: 'cash' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  trial = r.body.data.member;
  assert.equal(trial.isTrial, true);
  assert.equal(trial.name, 'Tina Trial');
  assert.equal(ymd(trial.trial.from), ymd(new Date()));
  assert.equal(ymd(trial.trial.to), ymd(addDays(new Date(), 1)));
  assert.equal(r.body.data.access.allowed, true);
  assert.equal(r.body.data.payment.trialFee, true);
  assert.equal(r.body.data.payment.amount, 20000);
  const l = await Lead.findById(lead._id).lean();
  assert.equal(l.status, 'trial');
  assert.equal(ymd(l.trialTo), ymd(trial.trial.to));
  assert.match(l.followUps.at(-1).note, /Trial pass given/);
  // The fee shows up as a normal payment with a receipt.
  const pdf = await api().get(`${V1}/payments/${r.body.data.payment._id}/receipt.pdf`).set(auth(rec));
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers['content-type'], /pdf/);
});

test('trial visitor gets in at the desk (search, QR / code) and on the biometric device', async () => {
  const found = await api().get(`${V1}/members`).query({ search: 'Tina', includeTrials: 'true' }).set(auth(rec));
  assert.equal(found.body.data.items.length, 1);
  const r = await checkIn(rec, { memberId: trial._id });
  assert.equal(r.body.data.allowed, true, JSON.stringify(r.body));
  assert.equal(r.body.data.code, 'TRIAL');
  assert.match(r.body.data.reason, /^Trial pass valid till \d{2}-\d{2}-\d{4}$/);
  assert.equal(r.body.data.member.isTrial, true);
  assert.equal((await checkIn(rec, { memberCode: trial.memberCode })).body.data.allowed, true);
  const visit = await Attendance.findOne({ memberId: trial._id }).lean();
  assert.equal(visit.isTrial, true);

  // Device: user pushed enabled, valid only for the trial days.
  const du = await DeviceUser.findOne({ memberId: trial._id }).lean();
  assert.equal(du.enabled, true);
  assert.equal(ymd(du.validTo), ymd(trial.trial.to));
  const cmd = await DeviceCommand.findOne({ memberId: trial._id, kind: 'USER_SYNC', status: 'pending' }).lean();
  assert.match(cmd.command, new RegExp(`Pin=${trial.memberCode}\\t.*Disable=0`));
  const punch = await processDevicePunch({ device, pin: String(trial.memberCode), at: new Date() });
  assert.equal(punch.allowed, true);
  assert.equal(punch.access.code, 'TRIAL');
});

test('trials are kept out of member lists, counts, reports and announcements', async () => {
  const after1 = await dashboard();
  assert.deepEqual(after1.members, before0.members);
  assert.equal(after1.attendance.checkinsToday, before0.attendance.checkinsToday);
  assert.equal(after1.trials.active, 1);
  assert.equal(after1.trials.visitsToday, 1);
  const list = await api().get(`${V1}/members`).query({ search: 'Tina' }).set(auth(rec));
  assert.equal(list.body.data.total, 0);
  const none = await api().get(`${V1}/members`).query({ status: 'none' }).set(auth(owner));
  assert.ok(!none.body.data.items.some((m) => m._id === trial._id));
  const preview = await api().post(`${V1}/announcements`).set(auth(owner)).send({ audience: 'all', channels: ['sms'], text: 'Gym closed on Sunday', preview: true });
  assert.equal(preview.body.data.total, 0);
  const branches = await api().get(`${V1}/reports/branches`).set(auth(owner));
  const main = branches.body.data.rows.find((r) => r.name === 'Main');
  assert.equal(main.newMembers, 0);
  assert.equal(main.visits, 0);
  // Trial visitors cannot get a membership, PT or the member app until converted.
  const sub = await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: trial._id, planId: String(ctx.monthly._id) });
  assert.equal(sub.status, 400);
  assert.match(sub.body.message, /trial pass/);
  const dup = await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Tina Again', phone: '9300000001' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.message, /Convert to member/);
});

test('trial list shows status, visits and counts; trainers cannot see it', async () => {
  const r = await api().get(`${V1}/trials`).query({ status: 'active' }).set(auth(rec));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.items.length, 1);
  assert.equal(r.body.data.items[0].status, 'active');
  assert.equal(r.body.data.items[0].visits, 1);
  assert.equal(r.body.data.counts.active, 1);
  assert.equal((await api().get(`${V1}/trials`).set(auth(trainer))).status, 403);
  assert.equal((await api().post(`${V1}/trials`).set(auth(trainer)).send({ branchId: String(ctx.main._id), name: 'X Y', phone: '9300000099' })).status, 403);
});

test('entry stops after the last trial day: devices are disabled like an expired member', async () => {
  const later = addDays(new Date(), 2);
  const { access } = await loadAccess(await Member.findById(trial._id).lean(), { now: later });
  assert.equal(access.allowed, false);
  assert.equal(access.code, 'TRIAL_ENDED');
  assert.match(access.reason, /^Trial ended on /);
  await refreshMember(trial._id, { now: later });
  const du = await DeviceUser.findOne({ memberId: trial._id }).lean();
  assert.equal(du.enabled, false);
  const cmd = await DeviceCommand.findOne({ memberId: trial._id, kind: 'USER_SYNC', status: 'pending' }).lean();
  assert.match(cmd.command, /Disable=1/);
  await refreshMember(trial._id); // back to today
});

test('one trial per phone in 90 days unless the owner / a manager overrides; running and member phones refused', async () => {
  const again = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Tina Trial', phone: '9300000001' });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already has a trial pass/);

  const end = await api().post(`${V1}/trials/${trial._id}/end`).set(auth(rec));
  assert.equal(end.status, 200, JSON.stringify(end.body));
  const denied = await checkIn(rec, { memberId: trial._id });
  assert.equal(denied.body.data.allowed, false);
  assert.equal(denied.body.data.code, 'TRIAL_ENDED');
  assert.match(denied.body.data.reason, /^Trial ended on /);
  assert.equal((await DeviceUser.findOne({ memberId: trial._id }).lean()).enabled, false);

  const body = { branchId: String(ctx.main._id), name: 'Tina Trial', phone: '+919300000001' };
  const blocked = await api().post(`${V1}/trials`).set(auth(rec)).send(body);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /Next trial allowed from/);
  const check = await api().get(`${V1}/trials/check`).query({ phone: '9300000001' }).set(auth(rec));
  assert.ok(check.body.data.nextAllowedOn);
  assert.equal((await api().post(`${V1}/trials`).set(auth(rec)).send({ ...body, override: true })).status, 403);
  const ok = await api().post(`${V1}/trials`).set(auth(manager)).send({ ...body, override: true, overrideReason: 'Brought a friend' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.member._id, trial._id); // same visitor record
  assert.equal(ok.body.data.member.trial.override, true);
  assert.equal(ok.body.data.member.trial.count, 2);
  assert.equal((await checkIn(rec, { memberId: trial._id })).body.data.allowed, true);

  const m = (await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Real Member', phone: '9300000002' })).body.data;
  const mem = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Real Member', phone: '9300000002' });
  assert.equal(mem.status, 409);
  assert.match(mem.body.message, new RegExp(`#${m.memberCode}`));
});

test('a trial can start later; the device opens on day one; switched off in settings blocks issuing', async () => {
  const r = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Uma Upcoming', phone: '9300000003', startDate: ymd(addDays(new Date(), 1)), days: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ci = await checkIn(rec, { memberId: r.body.data.member._id });
  assert.equal(ci.body.data.code, 'TRIAL_NOT_STARTED');
  assert.match(ci.body.data.reason, /^Trial pass starts on /);
  const du = await DeviceUser.findOne({ memberId: r.body.data.member._id }).lean();
  assert.equal(du.enabled, true);
  assert.equal(ymd(du.validFrom), ymd(addDays(new Date(), 1)));
  const list = await api().get(`${V1}/trials`).query({ status: 'upcoming' }).set(auth(rec));
  assert.equal(list.body.data.items[0].name, 'Uma Upcoming');

  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { trial: { enabled: false } } });
  const off = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Off Guy', phone: '9300000004' });
  assert.equal(off.status, 400);
  assert.match(off.body.message, /switched off/);
  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { trial: { enabled: true, maxDays: 2 } } });
  const three = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Long Guy', phone: '9300000005', days: 3 });
  assert.match(three.body.message, /at most 2 day/);
  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { trial: { maxDays: 3 } } });
});

test('converting keeps the record and visits, closes the trial and the lead; then a membership gives entry', async () => {
  const visitsBefore = await Attendance.countDocuments({ memberId: trial._id });
  assert.ok(visitsBefore >= 1);
  const newBefore = (await dashboard()).members.newThisMonth;
  const r = await api().post(`${V1}/trials/${trial._id}/convert`).set(auth(rec));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await Member.findById(trial._id).lean();
  assert.equal(m.isTrial, false);
  assert.ok(m.trial.convertedAt);
  assert.equal(m.memberCode, trial.memberCode);
  assert.equal(await Attendance.countDocuments({ memberId: trial._id }), visitsBefore);
  assert.equal((await Lead.findById(lead._id).lean()).status, 'converted');
  assert.equal((await dashboard()).members.newThisMonth, newBefore + 1);
  const converted = await api().get(`${V1}/trials`).query({ status: 'converted' }).set(auth(rec));
  assert.equal(converted.body.data.items[0]._id, trial._id);
  assert.equal(converted.body.data.items[0].status, 'converted');

  const denied = await checkIn(rec, { memberId: trial._id });
  assert.equal(denied.body.data.code, 'NO_MEMBERSHIP');
  await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: trial._id, planId: String(ctx.monthly._id) });
  const ok = await checkIn(rec, { memberId: trial._id });
  assert.equal(ok.body.data.allowed, true);
  assert.equal(ok.body.data.code, 'OK');
});

test('converting a lead whose phone is on a trial converts that trial record', async () => {
  const t = (await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Lee Lead', phone: '9300000006' })).body.data.member;
  const l = (await api().post(`${V1}/leads`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Lee Lead', phone: '9300000006' })).body.data;
  const r = await api().post(`${V1}/leads/${l._id}/convert`).set(auth(rec));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.member._id, t._id);
  assert.equal((await Member.findById(t._id).lean()).isTrial, false);
});

/* ---------------- Entry denied -> fix -> retry ---------------- */
test('expired member: denied, renewed, retried check-in is allowed and logged', async () => {
  const m = (await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Eli Expired', phone: '9300000010' })).body.data;
  await api().post(`${V1}/subscriptions`).set(auth(owner)).send({ memberId: m._id, planId: String(ctx.day._id), startDate: ymd(addDays(new Date(), -3)) });
  const denied = await checkIn(rec, { memberId: m._id });
  assert.equal(denied.body.data.allowed, false);
  assert.equal(denied.body.data.code, 'EXPIRED');
  const renew = await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), payment: { amount: 50000, mode: 'cash' } });
  assert.equal(renew.status, 201, JSON.stringify(renew.body));
  const retry = await checkIn(rec, { memberId: m._id });
  assert.equal(retry.body.data.allowed, true);
  assert.ok(retry.body.data.attendance);
  const logs = await AccessLog.find({ memberId: m._id }).sort({ at: 1 }).lean();
  assert.deepEqual(logs.map((l) => l.result), ['deny', 'allow']);
});

test('dues pending with "block on dues": collect due, then entry is allowed', async () => {
  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { blockOnDues: true } });
  const m = (await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Dina Dues', phone: '9300000011' })).body.data;
  const sub = (await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), payment: { amount: 10000, mode: 'cash' } })).body.data.subscription;
  const denied = await checkIn(rec, { memberId: m._id });
  assert.equal(denied.body.data.code, 'DUES');
  const pay = await api().post(`${V1}/payments`).set(auth(rec)).send({ subscriptionId: sub._id, amount: sub.dueAmount, mode: 'upi' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal((await checkIn(rec, { memberId: m._id })).body.data.allowed, true);
  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { blockOnDues: false } });
});

test('frozen member: end the freeze, then entry is allowed', async () => {
  const m = (await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Fred Frozen', phone: '9300000012' })).body.data;
  const sub = (await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), payment: { amount: 141600, mode: 'cash' } })).body.data.subscription;
  const fr = await api().post(`${V1}/subscriptions/${sub._id}/freeze`).set(auth(rec)).send({ from: ymd(new Date()), days: 5, reason: 'Travel' });
  assert.equal(fr.status, 200, JSON.stringify(fr.body));
  const denied = await checkIn(rec, { memberId: m._id });
  assert.equal(denied.body.data.code, 'FROZEN');
  const freezeId = fr.body.data.subscription.freezes[0]._id;
  const end = await api().post(`${V1}/subscriptions/${sub._id}/freezes/${freezeId}/end`).set(auth(rec));
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.equal((await checkIn(rec, { memberId: m._id })).body.data.allowed, true);
});

/* ---------------- Thermal receipts ---------------- */
test('receipts follow the paper setting: A4 by default, 80 mm and 58 mm rolls', async () => {
  const m = (await api().post(`${V1}/members`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Paper Person', phone: '9300000020' })).body.data;
  const subRes = await api().post(`${V1}/subscriptions`).set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), payment: { amount: 50000, mode: 'cash' } });
  assert.equal(subRes.status, 201, JSON.stringify(subRes.body));
  const sub = subRes.body.data;
  const pdf = async (url) => {
    const r = await api().get(url).set(auth(rec)).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(r.status, 200, url);
    assert.match(r.headers['content-type'], /application\/pdf/);
    return mediaBox(r.body);
  };
  const payUrl = `${V1}/payments/${sub.payment._id}/receipt.pdf`;
  assert.equal(Math.round((await pdf(payUrl)).width), 595);

  // Shop sale and locker allotment to print
  const product = (await api().post(`${V1}/shop/products`).set(auth(owner)).send({ name: 'Water', sku: 'W1', category: 'snack', price: 2000, costPrice: 1000, taxPercent: 12 })).body.data;
  await api().post(`${V1}/shop/products/${product._id}/stock`).set(auth(owner)).send({ branchId: String(ctx.main._id), qty: 10, type: 'purchase' });
  const sale = (await api().post(`${V1}/shop/sales`).set(auth(rec)).send({ branchId: String(ctx.main._id), memberId: m._id, items: [{ productId: product._id, qty: 2 }], mode: 'cash' })).body.data;
  await api().post(`${V1}/lockers/bulk`).set(auth(owner)).send({ branchId: String(ctx.main._id), prefix: 'T', from: 1, to: 1, monthlyFee: 30000 });
  const locker = (await api().get(`${V1}/lockers`).set(auth(rec))).body.data.items[0];
  const allot = (await api().post(`${V1}/lockers/${locker._id}/allot`).set(auth(rec)).send({ memberId: m._id, months: 1, rent: 30000, deposit: 50000, mode: 'upi' })).body.data;
  assert.ok(allot.receiptNo);
  const lockerUrl = `${V1}/lockers/allotments/${allot.allotment._id}/receipt.pdf`;
  assert.equal(Math.round((await pdf(lockerUrl)).width), 595); // A4 locker receipt exists too

  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { receiptPaper: '80mm' } });
  for (const url of [payUrl, `${V1}/shop/sales/${sale._id}/receipt.pdf`, lockerUrl]) {
    const box = await pdf(url);
    assert.ok(Math.abs(box.width - 226.77) < 0.01, `${url}: ${box.width}`);
    assert.ok(box.height < 842, `${url} height grows with content: ${box.height}`);
  }

  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { receiptPaper: '58mm' } });
  const rel = await api().post(`${V1}/lockers/allotments/${allot.allotment._id}/release`).set(auth(rec)).send({ depositReturned: 50000, mode: 'cash' });
  assert.ok(rel.body.data.receiptNo);
  const trialPay = await api().post(`${V1}/trials`).set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Paid Trial', phone: '9300000021', fee: 10000, mode: 'upi' });
  for (const url of [payUrl, `${V1}/shop/sales/${sale._id}/receipt.pdf`, lockerUrl, `${lockerUrl}?no=${encodeURIComponent(allot.receiptNo)}`, `${V1}/payments/${trialPay.body.data.payment._id}/receipt.pdf`]) {
    const box = await pdf(url);
    assert.ok(Math.abs(box.width - 164.4) < 0.01, `${url}: ${box.width}`);
  }
  assert.equal((await api().get(`${lockerUrl}?no=NOPE`).set(auth(rec))).status, 404);
  await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { receiptPaper: 'a4' } });
  assert.equal((await api().put(`${V1}/settings`).set(auth(owner)).send({ settings: { receiptPaper: '72mm' } })).status, 400);
});

/* ---------------- Shift handover ---------------- */
let task;
let note;

test('front desk posts notes and tasks; trainers can read but not post', async () => {
  const branchId = String(ctx.main._id);
  const r = await api().post(`${V1}/handover`).set(auth(rec)).send({ branchId, text: 'AC in cardio room leaking, technician coming at 4', important: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  note = r.body.data;
  assert.equal((await api().post(`${V1}/handover`).set(auth(trainer)).send({ branchId, text: 'trainer note' })).status, 403);
  const wrong = await api().post(`${V1}/handover`).set(auth(rec)).send({ branchId, text: 'Call Mr Shah', isTask: true, assignedTo: String(ctx.otherRec._id) });
  assert.equal(wrong.status, 400); // other branch staff
  const t = await api().post(`${V1}/handover`).set(auth(rec)).send({ branchId, text: 'Call Mr Shah about renewal', isTask: true, assignedTo: String(rec2User._id), dueDate: ymd(new Date()) });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  task = t.body.data;
  const staff = await api().get(`${V1}/handover/staff`).query({ branchId }).set(auth(rec));
  assert.ok(staff.body.data.some((u) => u.name === 'Rina Desk'));
  assert.ok(!staff.body.data.some((u) => u.name === 'Other Rec'));
});

test('the assignee gets an in-app alert only they see', async () => {
  const n = await Notification.findOne({ template: 'handover-task' }).lean();
  assert.deepEqual(n.userIds.map(String), [String(rec2User._id)]);
  const mine = await api().get(`${V1}/notifications`).set(auth(rec2));
  assert.ok(mine.body.data.items.some((x) => x.template === 'handover-task'));
  const others = await api().get(`${V1}/notifications`).set(auth(owner));
  assert.ok(!others.body.data.items.some((x) => x.template === 'handover-task'));
});

test('board: open tasks + unacknowledged notes; "Got it" is per user; "Mark done" closes the task', async () => {
  const board = async (token) => (await api().get(`${V1}/handover/board`).set(auth(token))).body.data;
  const b2 = await board(rec2);
  assert.equal(b2.tasks[0]._id, task._id);
  assert.equal(b2.notes.length, 1);
  assert.equal((await board(rec)).notes.length, 0); // own notes need no "Got it"
  const tb = await board(trainer);
  assert.equal(tb.notes.length, 1);
  assert.equal((await api().post(`${V1}/handover/${note._id}/ack`).set(auth(trainer))).status, 200);
  await api().post(`${V1}/handover/${note._id}/ack`).set(auth(trainer)); // twice = once
  assert.equal((await board(trainer)).notes.length, 0);
  assert.equal((await board(rec2)).notes.length, 1);
  assert.equal((await HandoverNote.findById(note._id).lean()).acks.length, 1);

  assert.equal((await api().post(`${V1}/handover/${task._id}/done`).set(auth(trainer))).status, 403); // not theirs
  const done = await api().post(`${V1}/handover/${task._id}/done`).set(auth(rec2));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await board(rec2)).tasks.length, 0);
  assert.equal((await api().post(`${V1}/handover/${task._id}/done`).set(auth(rec2))).status, 400);

  const doneList = await api().get(`${V1}/handover`).query({ status: 'done' }).set(auth(rec));
  assert.equal(doneList.body.data.items[0].doneBy.name, 'Rina Desk');
  assert.equal((await api().get(`${V1}/handover`).query({ status: 'open' }).set(auth(rec))).body.data.total, 0);
  const today = await api().get(`${V1}/handover`).query({ status: 'all', date: ymd(new Date()) }).set(auth(rec));
  assert.equal(today.body.data.total, 2);
  const yesterday = await api().get(`${V1}/handover`).query({ date: ymd(addDays(new Date(), -1)) }).set(auth(rec));
  assert.equal(yesterday.body.data.total, 0);
});

test('own notes can be edited / deleted for 15 minutes; owner / manager can delete any', async () => {
  const edit = await api().put(`${V1}/handover/${note._id}`).set(auth(rec)).send({ text: 'AC in cardio room leaking, technician at 5' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.ok(edit.body.data.editedAt);
  assert.equal((await api().put(`${V1}/handover/${note._id}`).set(auth(rec2)).send({ text: 'hijack' })).status, 403);
  await HandoverNote.collection.updateOne({ _id: new mongoose.Types.ObjectId(note._id) }, { $set: { createdAt: new Date(Date.now() - 20 * 60000) } });
  assert.equal((await api().put(`${V1}/handover/${note._id}`).set(auth(rec)).send({ text: 'too late' })).status, 403);
  assert.equal((await api().delete(`${V1}/handover/${note._id}`).set(auth(rec))).status, 403);
  assert.equal((await api().delete(`${V1}/handover/${note._id}`).set(auth(manager))).status, 200);
  const fresh = (await api().post(`${V1}/handover`).set(auth(rec)).send({ branchId: String(ctx.main._id), text: 'Typo note' })).body.data;
  assert.equal((await api().delete(`${V1}/handover/${fresh._id}`).set(auth(rec))).status, 200);
  const list = await api().get(`${V1}/handover`).set(auth(rec));
  assert.ok(!list.body.data.items.some((n) => n._id === note._id || n._id === fresh._id));
});

test('other branch staff do not see this branch board', async () => {
  const otherTok = await login('rec2@t.com');
  const r = await api().get(`${V1}/handover`).set(auth(otherTok));
  assert.equal(r.body.data.total, 0);
  assert.equal((await api().post(`${V1}/handover/${task._id}/reopen`).set(auth(otherTok))).status, 403);
  const reopen = await api().post(`${V1}/handover/${task._id}/reopen`).set(auth(rec));
  assert.equal(reopen.status, 200);
});
