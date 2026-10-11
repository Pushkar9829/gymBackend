import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { rzp } from '../src/modules/online/razorpay.client.js';
import { OnlinePayment } from '../src/modules/online/onlinePayment.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { Payment } from '../src/modules/payments/payment.model.js';

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';

let ctx;
let owner;
let memberToken;
let member;
const calls = [];
let seq = 0;
rzp.request = async (method, path, body) => {
  calls.push({ method, path, body });
  seq += 1;
  if (path === '/orders') return { id: `order_${seq}`, amount: body.amount };
  if (path === '/payment_links') return { id: `plink_${seq}`, short_url: `https://rzp.io/i/${seq}` };
  throw new Error('unexpected');
};
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  member = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Online Payer', phone: '9600000001' })).body.data;
  await api().post(`/api/v1/members/${member._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  memberToken = (await api().post('/api/v1/auth/member/login').send({ phone: '9600000001', password: 'Member@123' })).body.data.accessToken;
});
after(teardown);

test('coupons: create, apply percent with cap, max uses enforced', async () => {
  const c = await api().post('/api/v1/coupons').set(auth(owner)).send({ code: 'fit20', type: 'percent', value: 20, maxDiscount: 15000, maxUses: 1 });
  assert.equal(c.status, 201);
  assert.equal(c.body.data.code, 'FIT20');
  assert.equal((await api().post('/api/v1/coupons').set(auth(owner)).send({ code: 'BAD', type: 'percent', value: 150 })).status, 400);

  const q = await api().post('/api/v1/me/quote').set(auth(memberToken)).send({ planId: String(ctx.monthly._id), couponCode: 'fit20' });
  // gross 1200 (1000 + 200 joining), 20% = 240 capped at 150 -> 1050 + 18% = 1239
  assert.equal(q.body.data.couponDiscount, 15000);
  assert.equal(q.body.data.totalAmount, 123900);
});

test('portal renew: order -> verified payment creates membership once (checkout + webhook)', async () => {
  const start = await api().post('/api/v1/me/pay/renew').set(auth(memberToken)).send({ planId: String(ctx.monthly._id), couponCode: 'FIT20' });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  assert.equal(start.body.data.amount, 123900);
  assert.equal(await Subscription.countDocuments({ memberId: member._id }), 0); // nothing until paid

  const orderId = start.body.data.orderId;
  const bad = await api().post('/api/v1/me/pay/verify').set(auth(memberToken)).send({ orderId, paymentId: 'pay_ABC123', signature: 'x'.repeat(64) });
  assert.equal(bad.status, 400);

  const ok = await api()
    .post('/api/v1/me/pay/verify')
    .set(auth(memberToken))
    .send({ orderId, paymentId: 'pay_ABC123', signature: sign('test_secret', `${orderId}|pay_ABC123`) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'paid');

  // Webhook for the same payment arrives later: must not double-apply.
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_ABC123', order_id: orderId, amount: 123900 } } } });
  const wh = await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign('whsec', evt)).send(evt);
  assert.equal(wh.status, 200);

  const subs = await Subscription.find({ memberId: member._id }).lean();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].dueAmount, 0);
  assert.equal(subs[0].couponCode, 'FIT20');
  assert.equal(await Payment.countDocuments({ memberId: member._id, mode: 'online' }), 1);

  // Coupon was single-use
  const again = await api().post('/api/v1/me/quote').set(auth(memberToken)).send({ planId: String(ctx.monthly._id), couponCode: 'FIT20' });
  assert.equal(again.status, 400);
});

test('webhook with bad signature is rejected', async () => {
  const evt = JSON.stringify({ event: 'payment.captured', payload: {} });
  const r = await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope').send(evt);
  assert.equal(r.status, 400);
});

test('staff payment link for a due, paid via webhook', async () => {
  const s = await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: member._id, planId: String(ctx.day._id) });
  const subId = s.body.data.subscription._id;
  const link = await api().post('/api/v1/online-payments/link').set(auth(owner)).send({ subscriptionId: subId });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.match(link.body.data.shortUrl, /^https:\/\/rzp\.io/);
  const op = await OnlinePayment.findById(link.body.data.onlinePaymentId);

  const evt = JSON.stringify({
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: op.paymentLinkId, amount_paid: op.amount } }, payment: { entity: { id: 'pay_LINK1', amount: op.amount } } },
  });
  await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign('whsec', evt)).send(evt);
  assert.equal((await Subscription.findById(subId)).dueAmount, 0);
  assert.equal((await OnlinePayment.findById(op._id)).status, 'paid');
});

test('portal due payment rejects when nothing is due', async () => {
  const sub = await Subscription.findOne({ memberId: member._id, dueAmount: 0 });
  const r = await api().post('/api/v1/me/pay/due').set(auth(memberToken)).send({ subscriptionId: String(sub._id) });
  assert.equal(r.status, 400);
});
