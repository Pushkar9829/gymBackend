import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { ymd, addDays } from '../src/utils/dates.js';
import { Device, DeviceCommand, DeviceUser } from '../src/modules/devices/device.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { AccessLog } from '../src/modules/access/accessLog.model.js';
import { runDailyJob } from '../src/jobs/daily.service.js';

let ctx;
let owner;
let rec;
let trainer;
let otherRec;
let device;

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer, otherRec] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com'), login('rec2@t.com')]);
  device = await Device.create({ branchId: ctx.main._id, name: 'Door', serialNo: 'TESTSN001', dialect: 'security' });
});
after(teardown);

const day = (n) => ymd(addDays(new Date(), n));
const createMember = async (name, phone, token = rec) => {
  const r = await api().post('/api/v1/members').set(auth(token)).send({ branchId: String(ctx.main._id), name, phone });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
};
const commandsFor = (memberId) => DeviceCommand.find({ deviceId: device._id, memberId, status: 'pending' }).sort({ cmdId: 1 }).lean();
const checkIn = (memberId, token = rec) => api().post('/api/v1/attendance/check-in').set(auth(token)).send({ memberId });

test('health + auth basics', async () => {
  assert.equal((await api().get('/api/health')).status, 200);
  assert.equal((await api().get('/api/v1/members')).status, 401);
  const bad = await api().post('/api/v1/auth/login').send({ login: 'owner@t.com', password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('refresh token rotates and old token is rejected', async () => {
  const res = await api().post('/api/v1/auth/login').send({ login: 'owner@t.com', password: 'Password@1' });
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('gym_rt='));
  const r1 = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
  assert.equal(r1.status, 200);
  assert.ok(r1.body.data.accessToken);
  const reuse = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
  assert.equal(reuse.status, 401);
});

test('new member + membership with partial payment -> invoice, dues, device user enabled, check-in allowed', async () => {
  const m = await createMember('Rahul', '9800000001');
  assert.equal(m.memberCode, 1001);

  const r = await api()
    .post('/api/v1/subscriptions')
    .set(auth(rec))
    .send({ memberId: m._id, planId: String(ctx.monthly._id), discount: 10000, payment: { amount: 50000, mode: 'upi' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sub = r.body.data.subscription;
  // (1000 + 200 joining - 100 discount) = 1100 + 18% = 1298
  assert.equal(sub.totalAmount, 129800);
  assert.equal(sub.paidAmount, 50000);
  assert.equal(sub.dueAmount, 79800);
  assert.match(r.body.data.invoice.invoiceNo, /^INV\/\d{4}-\d{2}\/00001$/);
  assert.equal(r.body.data.access.allowed, true);

  const cmds = await commandsFor(m._id);
  assert.equal(cmds.length, 2);
  assert.match(cmds[0].command, /Pin=1001.*Disable=0/);

  const ci = await checkIn(m._id);
  assert.equal(ci.status, 200);
  assert.equal(ci.body.data.allowed, true);

  const pdf = await api().get(`/api/v1/invoices/${r.body.data.invoice._id}/pdf`).set(auth(rec));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(pdf.body.length > 1000);

  // Overpayment rejected, exact due accepted
  const over = await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub._id, amount: 79801, mode: 'cash' });
  assert.equal(over.status, 400);
  const pay = await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub._id, amount: 79800, mode: 'cash' });
  assert.equal(pay.status, 201);
  assert.equal((await Member.findById(m._id)).dueAmount, 0);
});

test('expired membership: no entry at reception and device user disabled', async () => {
  const m = await createMember('Amit', '9800000002');
  await api()
    .post('/api/v1/subscriptions')
    .set(auth(owner))
    .send({ memberId: m._id, planId: String(ctx.day._id), startDate: day(-2), payment: { amount: 11800, mode: 'cash' } });
  // Day pass two days ago -> already expired
  const ci = await checkIn(m._id);
  assert.equal(ci.body.data.allowed, false);
  assert.equal(ci.body.data.code, 'EXPIRED');
  const denied = await AccessLog.findOne({ memberId: m._id, result: 'deny' });
  assert.equal(denied.code, 'EXPIRED');
  // Never enabled on device -> nothing pushed
  assert.equal(await DeviceUser.countDocuments({ memberId: m._id }), 0);
});

test('freeze disables device + entry; ending freeze re-enables', async () => {
  const m = await createMember('Priya', '9800000003');
  const r = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id) });
  const subId = r.body.data.subscription._id;
  const endBefore = r.body.data.subscription.endDate;

  const f = await api().post(`/api/v1/subscriptions/${subId}/freeze`).set(auth(rec)).send({ days: 5, reason: 'Travel' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.data.access.code, 'FROZEN');
  assert.equal(ymd(f.body.data.subscription.endDate), ymd(addDays(endBefore, 5)));
  let cmds = await commandsFor(m._id);
  assert.match(cmds[0].command, /Disable=1/);
  assert.equal((await checkIn(m._id)).body.data.code, 'FROZEN');

  // Over the plan's freeze allowance
  const tooMuch = await api().post(`/api/v1/subscriptions/${subId}/freeze`).set(auth(rec)).send({ from: day(10), days: 6 });
  assert.equal(tooMuch.status, 400);

  const freezeId = f.body.data.subscription.freezes[0]._id;
  const u = await api().post(`/api/v1/subscriptions/${subId}/freezes/${freezeId}/end`).set(auth(rec));
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.data.access.allowed, true);
  assert.equal(ymd(u.body.data.subscription.endDate), ymd(endBefore));
  cmds = await commandsFor(m._id);
  assert.match(cmds[0].command, /Disable=0/);
});

test('renewal chains after current end and extends device validity', async () => {
  const m = await createMember('Sneha', '9800000004');
  const first = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id) });
  const renew = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id) });
  assert.equal(renew.status, 201, JSON.stringify(renew.body));
  assert.equal(renew.body.data.subscription.type, 'renewal');
  assert.equal(renew.body.data.subscription.joiningFee, 0);
  assert.equal(ymd(renew.body.data.subscription.startDate), ymd(addDays(first.body.data.subscription.endDate, 1)));
  const du = await DeviceUser.findOne({ memberId: m._id });
  assert.equal(ymd(du.validTo), ymd(renew.body.data.subscription.endDate));
  // Overlapping manual start date rejected
  const clash = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), startDate: day(3) });
  assert.equal(clash.status, 409);
});

test('cancel and block both cut access immediately', async () => {
  const m = await createMember('Vikram', '9800000005');
  const r = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id) });
  const subId = r.body.data.subscription._id;

  const blocked = await api().post(`/api/v1/members/${m._id}/block`).set(auth(rec)).send({ reason: 'Unpaid locker damage' });
  assert.equal(blocked.body.data.access.code, 'BLOCKED');
  assert.match((await commandsFor(m._id))[0].command, /Disable=1/);
  await api().post(`/api/v1/members/${m._id}/unblock`).set(auth(rec));
  assert.equal((await checkIn(m._id)).body.data.allowed, true);

  // Receptionist cannot cancel; owner can
  assert.equal((await api().post(`/api/v1/subscriptions/${subId}/cancel`).set(auth(rec)).send({ reason: 'Moving city' })).status, 403);
  const c = await api().post(`/api/v1/subscriptions/${subId}/cancel`).set(auth(owner)).send({ reason: 'Moving city' });
  assert.equal(c.status, 200);
  assert.equal(c.body.data.access.code, 'CANCELLED');
  assert.equal((await checkIn(m._id)).body.data.allowed, false);
});

test('change plan gives pro-rata credit and keeps access', async () => {
  const m = await createMember('Neha', '9800000006');
  const r = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.monthly._id), payment: { amount: 141600, mode: 'card' } });
  const subId = r.body.data.subscription._id;
  // Downgrade to a plan cheaper than the remaining credit is refused and nothing changes
  const down = await api().post(`/api/v1/subscriptions/${subId}/change-plan`).set(auth(rec)).send({ planId: String(ctx.day._id) });
  assert.equal(down.status, 400);
  assert.equal((await Subscription.findById(subId)).status, 'active');
  const up = await api().post(`/api/v1/subscriptions/${subId}/change-plan`).set(auth(rec)).send({ planId: String(ctx.quarterly._id) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.ok(up.body.data.credit > 0);
  assert.equal(up.body.data.subscription.type, 'upgrade');
  assert.equal(up.body.data.access.allowed, true);
  const old = await Subscription.findById(subId);
  assert.equal(old.status, 'cancelled');
});

test('refund: receptionist forbidden, owner allowed, cannot exceed paid', async () => {
  const m = await Member.findOne({ phone: '9800000001' });
  const list = await api().get(`/api/v1/payments?memberId=${m._id}`).set(auth(owner));
  const p = list.body.data.items.find((x) => x.type === 'payment');
  assert.equal((await api().post(`/api/v1/payments/${p._id}/refund`).set(auth(rec)).send({ amount: 100, mode: 'cash', reason: 'test' })).status, 403);
  assert.equal((await api().post(`/api/v1/payments/${p._id}/refund`).set(auth(owner)).send({ amount: p.amount + 1, mode: 'cash', reason: 'test' })).status, 400);
  const ok = await api().post(`/api/v1/payments/${p._id}/refund`).set(auth(owner)).send({ amount: 1000, mode: 'cash', reason: 'Goodwill' });
  assert.equal(ok.status, 201);
  const receipt = await api().get(`/api/v1/payments/${ok.body.data._id}/receipt.pdf`).set(auth(owner));
  assert.equal(receipt.status, 200);
});

test('RBAC + branch isolation', async () => {
  const m = await Member.findOne({ phone: '9800000001' });
  assert.equal((await api().get(`/api/v1/members/${m._id}`).set(auth(otherRec))).status, 403);
  const list = await api().get('/api/v1/members').set(auth(otherRec));
  assert.equal(list.body.data.total, 0);
  assert.equal((await api().post('/api/v1/payments').set(auth(trainer)).send({})).status, 403);
  assert.equal((await api().get('/api/v1/members').set(auth(trainer))).status, 200);
  assert.equal((await api().put('/api/v1/settings').set(auth(rec)).send({ name: 'X' })).status, 403);
  const dash = await api().get('/api/v1/reports/dashboard').set(auth(trainer));
  assert.equal(dash.body.data.money, null);
});

test('QR check-in: valid signed QR works, forged QR rejected', async () => {
  const m = await Member.findOne({ phone: '9800000001' });
  const card = await api().get(`/api/v1/members/${m._id}/card`).set(auth(rec));
  assert.match(card.body.data.qr, /^data:image\/png;base64,/);
  const ok = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ qr: card.body.data.payload });
  assert.equal(ok.body.data.allowed, true);
  const forged = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ qr: `GYM1:${m.memberCode}:AAAAAAAAAAAAAAAA` });
  assert.equal(forged.status, 400);
});

test('daily job expires a membership that ended yesterday and disables the device user', async () => {
  const m = await createMember('Karan', '9800000007');
  await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m._id, planId: String(ctx.day._id) });
  assert.match((await commandsFor(m._id))[0].command, /Disable=0/);
  // Run the job "tomorrow"
  const report = await runDailyJob({ now: addDays(new Date(), 1) });
  assert.ok(report.members > 0);
  const member = await Member.findById(m._id);
  assert.equal(member.membershipStatus, 'expired');
  const cmds = await commandsFor(m._id);
  assert.match(cmds[0].command, /Disable=1/);
});

test('member portal: login, dashboard with QR card, own invoice only', async () => {
  const m = await Member.findOne({ phone: '9800000001' });
  const en = await api().post(`/api/v1/members/${m._id}/portal`).set(auth(rec)).send({ enabled: true, password: 'Member@123' });
  assert.equal(en.status, 200);
  const lg = await api().post('/api/v1/auth/member/login').send({ phone: '9800000001', password: 'Member@123' });
  assert.equal(lg.status, 200);
  const token = lg.body.data.accessToken;
  const me = await api().get('/api/v1/me').set(auth(token));
  assert.equal(me.status, 200);
  assert.equal(me.body.data.member.memberCode, m.memberCode);
  assert.ok(me.body.data.card.qr);
  // Member token cannot use staff API
  assert.equal((await api().get('/api/v1/members').set(auth(token))).status, 401);
  const otherSub = await Subscription.findOne({ memberId: { $ne: m._id } });
  assert.equal((await api().get(`/api/v1/me/invoices/${otherSub.invoiceId}/pdf`).set(auth(token))).status, 404);
});

test('reports respond', async () => {
  for (const path of ['dashboard', 'collections', 'dues', 'memberships', 'pnl', 'attendance', 'leads']) {
    const r = await api().get(`/api/v1/reports/${path}`).set(auth(owner));
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
  }
  const csv = await api().get('/api/v1/reports/dues?export=csv').set(auth(owner));
  assert.match(csv.headers['content-type'], /text\/csv/);
});

test('leads: create, follow-up, convert to member', async () => {
  const l = await api().post('/api/v1/leads').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Lead One', phone: '9811111111', source: 'instagram' });
  assert.equal(l.status, 201);
  const f = await api().post(`/api/v1/leads/${l.body.data._id}/follow-ups`).set(auth(rec)).send({ note: 'Called, will visit', nextFollowUpAt: day(1) });
  assert.equal(f.body.data.status, 'contacted');
  const c = await api().post(`/api/v1/leads/${l.body.data._id}/convert`).set(auth(rec));
  assert.equal(c.status, 200);
  assert.ok(c.body.data.member.memberCode);
});

test('expenses + P&L', async () => {
  const e = await api().post('/api/v1/expenses').set(auth(owner)).send({ branchId: String(ctx.main._id), category: 'rent', amount: 5000000, date: day(0) });
  assert.equal(e.status, 201);
  const pnl = await api().get('/api/v1/reports/pnl').set(auth(owner));
  assert.equal(pnl.body.data.expenses, 5000000);
});

test('emails: welcome + invoice on first membership, receipt on payment (dedupe once)', async () => {
  const { Notification } = await import('../src/modules/notifications/notification.model.js');
  const r = await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Mail Me', phone: '9800000099', email: 'mail@me.com' });
  const sub = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: r.body.data._id, planId: String(ctx.monthly._id) });
  await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub.body.data.subscription._id, amount: 1000, mode: 'cash' });
  const sent = await Notification.find({ memberId: r.body.data._id, channel: 'email' }).lean();
  assert.deepEqual(sent.map((n) => n.template).sort(), ['invoice', 'receipt', 'welcome']);
});

test('trainer only sees assigned members', async () => {
  const m = await Member.findOne({ phone: '9800000001' });
  assert.equal((await api().get(`/api/v1/members/${m._id}`).set(auth(trainer))).status, 404);
  await Member.updateOne({ _id: m._id }, { trainerId: ctx.trainer._id });
  assert.equal((await api().get(`/api/v1/members/${m._id}`).set(auth(trainer))).status, 200);
  const list = await api().get('/api/v1/members').set(auth(trainer));
  assert.equal(list.body.data.total, 1);
});

test('delete then restore a member', async () => {
  const m = await createMember('Undo Me', '9800000088');
  assert.equal((await api().delete(`/api/v1/members/${m._id}`).set(auth(owner))).status, 200);
  const deleted = await api().get('/api/v1/members?deleted=true').set(auth(owner));
  assert.ok(deleted.body.data.items.some((x) => x._id === m._id));
  assert.equal((await api().post(`/api/v1/members/${m._id}/restore`).set(auth(rec))).status, 403);
  const ok = await api().post(`/api/v1/members/${m._id}/restore`).set(auth(owner));
  assert.equal(ok.status, 200);
  assert.equal((await Member.findById(m._id)).isDeleted, false);
});

test('excel export', async () => {
  const x = await api().get('/api/v1/reports/dues?export=xlsx').set(auth(owner)).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(x.status, 200);
  assert.match(x.headers['content-type'], /spreadsheetml/);
  assert.equal(x.body.subarray(0, 2).toString(), 'PK'); // xlsx is a zip
});
