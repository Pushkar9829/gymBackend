import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { rzp } from '../src/modules/online/razorpay.client.js';
import { devOutbox } from '../src/modules/messaging/providers.js';
import { OnlinePayment } from '../src/modules/online/onlinePayment.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { Payment } from '../src/modules/payments/payment.model.js';
import { Invoice } from '../src/modules/invoices/invoice.model.js';
import { Plan } from '../src/modules/plans/plan.model.js';
import { Gym } from '../src/modules/settings/gym.model.js';
import { Referral } from '../src/modules/referrals/referral.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { runDailyJob } from '../src/jobs/daily.service.js';
import { addDays, ymd } from '../src/utils/dates.js';

// Batch D: buy a membership online from the public Join page. Razorpay is mocked exactly like online.test.js.

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';

let ctx;
let owner;
const calls = [];
let seq = 0;
rzp.request = async (method, path, body) => {
  calls.push({ method, path, body });
  seq += 1;
  if (path === '/orders') return { id: `order_join_${seq}`, amount: body.amount };
  throw new Error('unexpected Razorpay call');
};
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const J = '/api/v1/public/join';

/** OTP from the dev outbox (log provider), then the join token. */
async function verifiedToken(phone, expect = 'new') {
  const s = await api().post(`${J}/otp`).send({ phone });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const msg = [...devOutbox].reverse().find((m) => m.to === phone && m.template === 'otp');
  const otp = msg.text.match(/\d{6}/)[0];
  const v = await api().post(`${J}/otp/verify`).send({ phone, otp });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.status, expect);
  return v.body.data.token;
}

async function order(token, extra = {}) {
  return api()
    .post(`${J}/order`)
    .send({ token, branchId: String(ctx.main._id), planId: String(ctx.monthly._id), name: 'Online Joiner', email: 'joiner@example.com', gender: 'female', dob: '1995-04-02', startDate: ymd(new Date()), ...extra });
}

const checkout = (orderId, paymentId) => api().post(`${J}/pay/verify`).send({ orderId, paymentId, signature: sign('test_secret', `${orderId}|${paymentId}`) });
const webhook = (orderId, paymentId, amount) => {
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount } } } });
  return api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign('whsec', evt)).send(evt);
};

let referrer;
before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  await Plan.updateOne({ _id: ctx.monthly._id }, { sellOnline: true });
  await api().post('/api/v1/coupons').set(auth(owner)).send({ code: 'JOIN10', type: 'percent', value: 10 });
  // A member with a running membership who invites a friend.
  referrer = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Riya Referrer', phone: '9500000001' })).body.data;
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: referrer._id, planId: String(ctx.quarterly._id), payment: { amount: Math.round(270000 * 1.18), mode: 'upi' } });
  await api().get(`/api/v1/members/${referrer._id}`).set(auth(owner)); // makes the referral code
  referrer = await Member.findById(referrer._id).lean();
  await Gym.updateOne({}, { 'settings.referral.newMemberDiscountPercent': 10, 'settings.referral.rewardDays': 15 });
});
after(teardown);

test('public info offers online joining only with keys and a plan on sale online', async () => {
  const r = await api().get('/api/v1/public/info');
  assert.equal(r.body.data.onlineJoin, true);
  assert.equal(r.body.data.plans.find((p) => p.name === 'Monthly').sellOnline, true);
  assert.equal(r.body.data.plans.find((p) => p.name === 'Quarterly').sellOnline, false);
  // Referral link lookup shows a short name only.
  const ref = await api().get(`/api/v1/public/referral/${referrer.referralCode.toLowerCase()}`);
  assert.deepEqual(ref.body.data, { valid: true, code: referrer.referralCode, name: 'Riya R.', friendDiscountPercent: 10 });
  assert.equal((await api().get('/api/v1/public/referral/ZZZZZZ')).body.data.valid, false);
});

test('phone must be verified by OTP before an order', async () => {
  assert.equal((await order(undefined)).status, 400); // token missing
  assert.equal((await order('x'.repeat(40))).status, 401);
  await api().post(`${J}/otp`).send({ phone: '9511111111' });
  const again = await api().post(`${J}/otp`).send({ phone: '9511111111' });
  assert.equal(again.status, 429); // resend only after 30 s
  const wrong = await api().post(`${J}/otp/verify`).send({ phone: '9511111111', otp: '000000' });
  assert.equal(wrong.status, 400);
  // A plan that is not on sale online cannot be quoted.
  const q = await api().post(`${J}/quote`).send({ branchId: String(ctx.main._id), planId: String(ctx.quarterly._id) });
  assert.equal(q.status, 400);
  assert.match(q.body.message, /cannot be bought online/);
});

test('order -> verified payment creates member, membership, payment and invoice once (checkout then webhook)', async () => {
  const phone = '9511111112';
  const token = await verifiedToken(phone);
  const quote = await api().post(`${J}/quote`).send({ branchId: String(ctx.main._id), planId: String(ctx.monthly._id), couponCode: 'join10', referralCode: referrer.referralCode });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  // gross 1200 (1000 + 200 joining): coupon 10% = 120, referral 10% = 120 -> 960 + 18% GST = 1132.80
  assert.equal(quote.body.data.couponDiscount, 12000);
  assert.equal(quote.body.data.referralDiscount, 12000);
  assert.equal(quote.body.data.totalAmount, 113280);

  const o = await order(token, { couponCode: 'JOIN10', referralCode: referrer.referralCode });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(o.body.data.amount, 113280);
  assert.equal(o.body.data.prefill.contact, phone);
  assert.equal(await Member.countDocuments({ phone }), 0); // nothing until paid
  const orderId = o.body.data.orderId;

  const bad = await api().post(`${J}/pay/verify`).send({ orderId, paymentId: 'pay_JOIN1', signature: 'x'.repeat(64) });
  assert.equal(bad.status, 400);

  const before = (await Subscription.findOne({ memberId: referrer._id, status: 'active' }).lean()).endDate;
  const ok = await checkout(orderId, 'pay_JOIN1');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'paid');
  assert.equal(ok.body.data.member.name, 'Online Joiner');
  assert.ok(ok.body.data.member.memberCode > 1000);
  assert.equal(ok.body.data.membership.plan, 'Monthly');
  assert.equal(ok.body.data.appPath, '/portal/login');

  // Webhook for the same payment arrives later: must not create anything again.
  assert.equal((await webhook(orderId, 'pay_JOIN1', 113280)).status, 200);
  assert.equal((await checkout(orderId, 'pay_JOIN1')).body.data.status, 'paid');

  const members = await Member.find({ phone }).lean();
  assert.equal(members.length, 1);
  const m = members[0];
  assert.equal(m.source, 'online');
  assert.equal(m.portalEnabled, true);
  assert.equal(m.gender, 'female');
  assert.equal(m.membershipStatus, 'active');
  assert.equal(String(m.referredBy), String(referrer._id));
  const subs = await Subscription.find({ memberId: m._id }).lean();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].dueAmount, 0);
  assert.equal(subs[0].couponCode, 'JOIN10');
  assert.equal(subs[0].referralDiscount, 12000);
  assert.equal(subs[0].joiningFee, 20000);
  assert.equal(await Payment.countDocuments({ memberId: m._id, mode: 'online', reference: 'pay_JOIN1' }), 1);
  assert.equal(await Invoice.countDocuments({ memberId: m._id }), 1);
  assert.equal((await OnlinePayment.findOne({ orderId }).lean()).status, 'paid');
  // Staff alert, welcome message, referral reward for the referrer (+15 days).
  assert.ok(await Notification.exists({ channel: 'inapp', template: 'online-join', memberId: m._id }));
  assert.equal((await Referral.findOne({ referredId: m._id }).lean()).status, 'rewarded');
  const afterEnd = (await Subscription.findOne({ memberId: referrer._id, status: 'active' }).lean()).endDate;
  assert.equal(ymd(afterEnd), ymd(addDays(before, 15)));
});

test('a number that is already a member is not joined again: told to log in', async () => {
  const phone = '9511111113';
  const token = await verifiedToken(phone);
  // Registered at the desk meanwhile.
  await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Desk Person', phone });
  const o = await order(token);
  assert.equal(o.status, 409);
  assert.equal(o.body.code, 'ALREADY_MEMBER');
  assert.match(o.body.message, /Log in to the member app/);
  // Verifying again now says "member" and gives no token.
  await new Promise((r) => setTimeout(r, 10));
  await OnlinePayment.deleteMany({});
  const { JoinOtp } = await import('../src/modules/online/join.service.js');
  await JoinOtp.deleteMany({ phone });
  const s = await api().post(`${J}/otp`).send({ phone });
  assert.equal(s.status, 200);
  const otp = [...devOutbox].reverse().find((m) => m.to === phone).text.match(/\d{6}/)[0];
  const v = await api().post(`${J}/otp/verify`).send({ phone, otp });
  assert.deepEqual(v.body.data, { status: 'member' });
  assert.equal(await Member.countDocuments({ phone }), 1);
});

test('a trial visitor joining online is converted (same record), webhook first then checkout', async () => {
  const phone = '9511111114';
  const t = await api().post('/api/v1/trials').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Tara Trial', phone });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const trialId = t.body.data.member._id;
  const code = t.body.data.member.memberCode;
  const token = await verifiedToken(phone, 'trial');
  const o = await order(token, { name: 'Tara Trial' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const { orderId, amount } = o.body.data;

  await webhook(orderId, 'pay_TRIAL1', amount);
  const ok = await checkout(orderId, 'pay_TRIAL1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.member.memberCode, code);

  const all = await Member.find({ phone }).lean();
  assert.equal(all.length, 1);
  assert.equal(String(all[0]._id), trialId);
  assert.equal(all[0].isTrial, false);
  assert.ok(all[0].trial.convertedAt);
  assert.equal(all[0].portalEnabled, true);
  assert.equal(await Subscription.countDocuments({ memberId: trialId }), 1);
  assert.equal(await Payment.countDocuments({ memberId: trialId, mode: 'online' }), 1);
});

test('cancelled / unpaid orders create nothing and expire; a late payment is still applied', async () => {
  const phone = '9511111115';
  const token = await verifiedToken(phone);
  const o = await order(token, { name: 'Late Payer', startDate: ymd(addDays(new Date(), 3)) });
  assert.equal(o.status, 201);
  assert.equal(await Member.countDocuments({ phone }), 0);
  // The daily job marks the unpaid order expired after 30 minutes.
  await runDailyJob({ now: new Date(Date.now() + 31 * 60 * 1000) });
  const op = await OnlinePayment.findOne({ orderId: o.body.data.orderId }).lean();
  assert.equal(op.status, 'expired');
  assert.equal(await Member.countDocuments({ phone }), 0);
  // Razorpay still captured the money later: never lose it.
  await webhook(o.body.data.orderId, 'pay_LATE1', o.body.data.amount);
  const m = await Member.findOne({ phone }).lean();
  assert.ok(m);
  const sub = await Subscription.findOne({ memberId: m._id }).lean();
  assert.equal(ymd(sub.startDate), ymd(addDays(new Date(), 3)));
});

test('start date must be within 30 days and not in the past', async () => {
  const token = await verifiedToken('9511111116');
  assert.equal((await order(token, { startDate: ymd(addDays(new Date(), -1)) })).status, 400);
  assert.equal((await order(token, { startDate: ymd(addDays(new Date(), 31)) })).status, 400);
  // Own referral code / unknown code
  assert.equal((await order(token, { referralCode: 'NOPE99' })).status, 400);
});

test('without Razorpay keys online joining is switched off', async () => {
  const keep = process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_ID;
  try {
    assert.equal((await api().get('/api/v1/public/info')).body.data.onlineJoin, false);
    assert.equal((await api().post(`${J}/otp`).send({ phone: '9511111117' })).status, 503);
    assert.equal((await api().post(`${J}/quote`).send({ branchId: String(ctx.main._id), planId: String(ctx.monthly._id) })).status, 503);
    // The enquiry form still works, and keeps the friend's referral code on the lead.
    const e = await api().post('/api/v1/public/enquiry').send({ branchId: String(ctx.main._id), name: 'Enquirer', phone: '9511111117', referralCode: referrer.referralCode });
    assert.equal(e.status, 201);
    const { Lead } = await import('../src/modules/leads/lead.model.js');
    const lead = await Lead.findOne({ phone: '9511111117' }).lean();
    assert.equal(lead.source, 'referral');
    assert.match(lead.notes, /Referred by Riya Referrer/);
  } finally {
    process.env.RAZORPAY_KEY_ID = keep;
  }
  assert.ok(calls.every((c) => c.path === '/orders'));
});
