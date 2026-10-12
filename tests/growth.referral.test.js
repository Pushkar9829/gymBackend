import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Member } from '../src/modules/members/member.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { Referral } from '../src/modules/referrals/referral.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Device, DeviceUser } from '../src/modules/devices/device.model.js';
import { Gym } from '../src/modules/settings/gym.model.js';
import { ensureReferralCode } from '../src/modules/referrals/referral.service.js';
import { addDays, ymd } from '../src/utils/dates.js';

// Batch D: refer a friend. Reward = free days on the referrer's membership after the friend's first paid membership.

let ctx;
let owner;
let rec;
let referrer;
const M = '/api/v1/members';

async function addMember(name, phone, extra = {}, query = '') {
  const r = await api().post(`${M}${query}`).set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone, ...extra });
  return r;
}
async function buy(memberId, planId = ctx.monthly._id, pay = true, extra = {}) {
  const r = await api()
    .post('/api/v1/subscriptions')
    .set(auth(owner))
    .send({ memberId: String(memberId), planId: String(planId), ...(pay ? { payment: { amount: 10000, mode: 'cash' } } : {}), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.subscription;
}
const liveEnd = async (memberId) => (await Subscription.findOne({ memberId, status: 'active' }).sort({ startDate: 1 }).lean()).endDate;

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  rec = await login('rec@t.com');
  await Device.create({ branchId: ctx.main._id, name: 'Door', serialNo: 'REF000001', dialect: 'security' });
  await Gym.updateOne({}, { 'settings.channels.sms': true });
  referrer = (await addMember('Ravi Referrer', '9400000001')).body.data;
  await buy(referrer._id, ctx.quarterly._id);
});
after(teardown);

test('every member gets a unique 6-character code, made once', async () => {
  const codes = new Set();
  for (let i = 0; i < 40; i += 1) {
    const m = await Member.create({ branchId: ctx.main._id, memberCode: 5000 + i, name: `Bulk ${i}`, phone: `93000000${String(i).padStart(2, '0')}` });
    const c = await ensureReferralCode(m);
    assert.match(c, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(await ensureReferralCode(await Member.findById(m._id)), c);
    codes.add(c);
  }
  assert.equal(codes.size, 40);
  // Member detail backfills the code for an existing member; search finds a member by code.
  const d = await api().get(`${M}/${referrer._id}`).set(auth(rec));
  assert.match(d.body.data.member.referralCode, /^[A-Z0-9]{6}$/);
  referrer = d.body.data.member;
  const s = await api().get(M).query({ search: referrer.referralCode.toLowerCase() }).set(auth(rec));
  assert.equal(s.body.data.items[0]._id, referrer._id);
});

test('self-referral, same phone and trial referrers are refused', async () => {
  const self = await buyAttempt(referrer._id, referrer._id);
  assert.equal(self.status, 400);
  const same = await addMember('Same Phone', '9400000001', { referredBy: referrer._id }, '?allowDuplicatePhone=1');
  assert.equal(same.status, 400);
  assert.match(same.body.message, /same phone/);
  const t = await api().post('/api/v1/trials').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Trial Tom', phone: '9400000099' });
  const viaTrial = await addMember('Friend Of Trial', '9400000098', { referredBy: t.body.data.member._id });
  assert.equal(viaTrial.status, 400);
  assert.match(viaTrial.body.message, /Trial visitors/);
  assert.equal(await Member.countDocuments({ phone: '9400000098' }), 0); // nothing created
});
const buyAttempt = (memberId, referredBy) => api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: String(memberId), planId: String(ctx.day._id), referredBy: String(referredBy) });

test('reward once, only after the friend first pays: end date and device validity move by 15 days', async () => {
  const friend = (await addMember('Farah Friend', '9400000002', { referredBy: referrer._id })).body.data;
  assert.equal(friend.source, 'referral');
  let ref = await Referral.findOne({ referredId: friend._id }).lean();
  assert.equal(ref.status, 'pending');
  assert.equal(ref.rewardDays, 15);

  const before = await liveEnd(referrer._id);
  const sub = await buy(friend._id, ctx.monthly._id, false); // membership saved with the full amount due
  assert.equal((await Referral.findOne({ referredId: friend._id }).lean()).status, 'pending');
  assert.equal(ymd(await liveEnd(referrer._id)), ymd(before));

  const pay = await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub._id, amount: 10000, mode: 'upi' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  ref = await Referral.findOne({ referredId: friend._id }).lean();
  assert.equal(ref.status, 'rewarded');
  const after = await liveEnd(referrer._id);
  assert.equal(ymd(after), ymd(addDays(before, 15)));
  const target = await Subscription.findById(ref.rewardSubscriptionId).lean();
  assert.equal(target.extensions.length, 1);
  assert.equal(target.extensions[0].days, 15);
  const m = await Member.findById(referrer._id).lean();
  assert.equal(ymd(m.membershipEnd), ymd(after));
  const du = await DeviceUser.findOne({ memberId: referrer._id }).lean();
  assert.equal(ymd(du.validTo), ymd(after)); // devices follow the new end date
  assert.ok(await Notification.exists({ memberId: referrer._id, template: 'referral_reward', channel: 'sms' }));

  // More payments or a renewal by the friend never reward again.
  await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub._id, amount: 10000, mode: 'upi' });
  await buy(friend._id, ctx.day._id);
  assert.equal(ymd(await liveEnd(referrer._id)), ymd(after));
  assert.equal(await Referral.countDocuments({ referrerId: referrer._id, status: 'rewarded' }), 1);
});

test('referral at the first membership (desk), with the new-member discount', async () => {
  await Gym.updateOne({}, { 'settings.referral.newMemberDiscountPercent': 10 });
  const friend = (await addMember('Gita Gift', '9400000003')).body.data;
  const sub = await buy(friend._id, ctx.monthly._id, true, { referredBy: referrer._id });
  assert.equal(sub.referralDiscount, 12000); // 10% of 1000 + 200 joining
  assert.equal((await Referral.findOne({ referredId: friend._id }).lean()).status, 'rewarded');
  // Not after the first membership.
  const late = (await addMember('Late Larry', '9400000004')).body.data;
  await buy(late._id, ctx.day._id);
  const r = await buyAttempt(late._id, referrer._id);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /before the first membership/);
  await Gym.updateOne({}, { 'settings.referral.newMemberDiscountPercent': 0 });
});

test('yearly cap: further friends are recorded but not rewarded', async () => {
  const put = await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { referral: { maxPerYear: 2 } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const before = await liveEnd(referrer._id);
  const friend = (await addMember('Capped Kiran', '9400000005', { referredBy: referrer._id })).body.data;
  await buy(friend._id);
  const ref = await Referral.findOne({ referredId: friend._id }).lean();
  assert.equal(ref.status, 'capped');
  assert.equal(ymd(await liveEnd(referrer._id)), ymd(before));
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { referral: { maxPerYear: 12 } } });
});

test('referrer without a membership: days wait for their next membership', async () => {
  const idle = (await addMember('Idle Isha', '9400000006')).body.data;
  const friend = (await addMember('Friend Of Isha', '9400000007', { referredBy: idle._id })).body.data;
  await buy(friend._id);
  assert.equal((await Referral.findOne({ referredId: friend._id }).lean()).status, 'waiting');
  const sub = await buy(idle._id, ctx.monthly._id);
  const ref = await Referral.findOne({ referredId: friend._id }).lean();
  assert.equal(ref.status, 'rewarded');
  const s = await Subscription.findById(sub._id).lean();
  assert.equal(ymd(s.endDate), ymd(addDays(s.originalEndDate, 15)));
});

test('friend cancels and is refunded within 7 days: reward taken back', async () => {
  const before = await liveEnd(referrer._id);
  const friend = (await addMember('Quick Quitter', '9400000008', { referredBy: referrer._id })).body.data;
  const sub = await buy(friend._id);
  assert.equal(ymd(await liveEnd(referrer._id)), ymd(addDays(before, 15)));
  // Cancel first, refund after (the second step decides).
  await api().post(`/api/v1/subscriptions/${sub._id}/cancel`).set(auth(owner)).send({ reason: 'Changed mind' });
  assert.equal((await Referral.findOne({ referredId: friend._id }).lean()).status, 'rewarded');
  const { Payment } = await import('../src/modules/payments/payment.model.js');
  const p = await Payment.findOne({ subscriptionId: sub._id, type: 'payment' }).lean();
  const refund = await api().post(`/api/v1/payments/${p._id}/refund`).set(auth(owner)).send({ amount: 10000, mode: 'cash', reason: 'Cancelled in 2 days' });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  const ref = await Referral.findOne({ referredId: friend._id }).lean();
  assert.equal(ref.status, 'revoked');
  assert.equal(ymd(await liveEnd(referrer._id)), ymd(before));
  const du = await DeviceUser.findOne({ memberId: referrer._id }).lean();
  assert.equal(ymd(du.validTo), ymd(before));
});

test('member app shows the code and friends; report for owner / manager only', async () => {
  await api().post(`${M}/${referrer._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  const token = (await api().post('/api/v1/auth/member/login').send({ phone: '9400000001', password: 'Member@123' })).body.data.accessToken;
  const me = await api().get('/api/v1/me/referral').set(auth(token));
  assert.equal(me.status, 200);
  assert.equal(me.body.data.code, referrer.referralCode);
  assert.equal(me.body.data.rewardDays, 15);
  assert.ok(me.body.data.referrals.some((r) => r.name === 'Farah' && r.status === 'rewarded'));
  assert.ok(me.body.data.referrals.every((r) => !('phone' in r)));

  const list = await api().get('/api/v1/referrals').set(auth(owner));
  assert.equal(list.status, 200);
  assert.ok(list.body.data.items.length >= 5);
  assert.ok(list.body.data.summary.rewarded >= 2);
  assert.equal(list.body.data.items[0].referrerId.name !== undefined, true);
  assert.equal((await api().get('/api/v1/referrals').query({ status: 'revoked' }).set(auth(owner))).body.data.items.length, 1);
  assert.equal((await api().get('/api/v1/referrals').set(auth(rec))).status, 403);
});

test('referrals switched off: no new referrals', async () => {
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { referral: { enabled: false } } });
  const r = await addMember('Off Friend', '9400000009', { referredBy: referrer._id });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /switched off/);
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { referral: { enabled: true } } });
});
