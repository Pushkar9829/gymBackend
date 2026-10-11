import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { rzp } from '../src/modules/online/razorpay.client.js';
import { Autopay } from '../src/modules/online/autopay.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { DeviceCommand } from '../src/modules/devices/device.model.js';
import { Plan } from '../src/modules/plans/plan.model.js';

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';

let ctx;
let owner;
let rec;
let member;
const calls = [];
rzp.request = async (method, path, body) => {
  calls.push({ method, path, body });
  if (path === '/plans') return { id: `plan_${calls.length}` };
  if (path === '/subscriptions') return { id: `sub_${calls.length}`, short_url: `https://rzp.io/s/${calls.length}` };
  if (path.endsWith('/cancel')) return { status: 'cancelled' };
  throw new Error(`unexpected ${path}`);
};
const sign = (data) => crypto.createHmac('sha256', 'whsec').update(data).digest('hex');
const webhook = (evt) => {
  const raw = JSON.stringify(evt);
  return api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign(raw)).send(raw);
};

before(async () => {
  ctx = await setupDb();
  [owner, rec] = await Promise.all([login('owner@t.com'), login('rec@t.com')]);
  member = (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Auto Payer', phone: '9700100001' })).body.data;
  await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: member._id, planId: String(ctx.monthly._id), payment: { amount: 141600, mode: 'cash' } });
});
after(teardown);

test('autopay only for monthly, non-family plans', async () => {
  const r = await api().post('/api/v1/online-payments/autopay').set(auth(rec)).send({ memberId: member._id, planId: String(ctx.day._id) });
  assert.equal(r.status, 400);
});

test('staff sets up autopay: Razorpay plan reused per amount, mandate link returned', async () => {
  const r = await api().post('/api/v1/online-payments/autopay').set(auth(rec)).send({ memberId: member._id, planId: String(ctx.monthly._id) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.amount, 118000); // 1000 + 18%, no joining fee
  assert.match(r.body.data.shortUrl, /rzp\.io/);
  assert.equal((await Plan.findById(ctx.monthly._id)).razorpayPlans.length, 1);
  assert.equal((await api().post('/api/v1/online-payments/autopay').set(auth(rec)).send({ memberId: member._id, planId: String(ctx.monthly._id) })).status, 409);
});

test('subscription.charged renews the membership exactly once', async () => {
  const a = await Autopay.findOne({ memberId: member._id });
  await webhook({ event: 'subscription.activated', payload: { subscription: { entity: { id: a.rzpSubscriptionId } } } });
  assert.equal((await Autopay.findById(a._id)).status, 'active');

  const charged = { event: 'subscription.charged', payload: { subscription: { entity: { id: a.rzpSubscriptionId } }, payment: { entity: { id: 'pay_AUTO1', amount: 118000 } } } };
  await webhook(charged);
  await webhook(charged); // retry from Razorpay
  const subs = await Subscription.find({ memberId: member._id, status: 'active' }).sort({ startDate: 1 }).lean();
  assert.equal(subs.length, 2);
  assert.equal(subs[1].type, 'renewal');
  assert.equal(subs[1].dueAmount, 0);
  assert.equal((await Autopay.findById(a._id)).chargedCount, 1);
});

test('halted autopay alerts staff; member/staff can cancel', async () => {
  const a = await Autopay.findOne({ memberId: member._id });
  await webhook({ event: 'subscription.halted', payload: { subscription: { entity: { id: a.rzpSubscriptionId } } } });
  const n = await api().get('/api/v1/notifications').set(auth(owner));
  assert.ok(n.body.data.items.some((x) => x.template === 'autopay-problem'));
  // halted is not cancellable state in our model -> reactivate first via event, then cancel
  await webhook({ event: 'subscription.resumed', payload: { subscription: { entity: { id: a.rzpSubscriptionId } } } });
  const c = await api().post(`/api/v1/online-payments/autopay/${a._id}/cancel`).set(auth(rec));
  assert.equal(c.status, 200);
  assert.ok(calls.some((x) => x.path.endsWith('/cancel')));
});

test('RFID: card number goes to the device; card tap checks in', async () => {
  await api().post('/api/v1/devices').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Door', serialNo: 'RFID0001' });
  const u = await api().put(`/api/v1/members/${member._id}`).set(auth(rec)).send({ cardNo: '0012345678' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const cmd = await DeviceCommand.findOne({ memberId: member._id, command: /CardNo=0012345678/ }).lean();
  assert.ok(cmd, 'device command carries the card number');

  const ci = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ cardNo: '0012345678' });
  assert.equal(ci.status, 200);
  assert.equal(ci.body.data.allowed, true);
  const unknown = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ cardNo: '99999999' });
  assert.equal(unknown.status, 404);
  // Same card cannot be given to two members
  const other = (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Other', phone: '9700100002' })).body.data;
  assert.equal((await api().put(`/api/v1/members/${other._id}`).set(auth(rec)).send({ cardNo: '0012345678' })).status, 409);
});

test('many members without a card can be registered and edited (no duplicate-null card error)', async () => {
  const ids = [];
  for (const phone of ['9500000001', '9500000002', '9500000003']) {
    const r = await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: `No Card ${phone.slice(-1)}`, phone, cardNo: null });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body.data._id);
  }
  for (const id of ids) {
    const r = await api().put(`/api/v1/members/${id}`).set(auth(rec)).send({ address: 'MG Road', cardNo: '' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  // Giving a card and then removing it again also works.
  assert.equal((await api().put(`/api/v1/members/${ids[0]}`).set(auth(rec)).send({ cardNo: '55667788' })).status, 200);
  assert.equal((await api().put(`/api/v1/members/${ids[0]}`).set(auth(rec)).send({ cardNo: null })).status, 200);
});
