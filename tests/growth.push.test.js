import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { pushClient, PushSubscription } from '../src/modules/push/push.service.js';
import { notifyMember } from '../src/modules/messaging/messaging.service.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Gym } from '../src/modules/settings/gym.model.js';

// Batch D: member app push notifications (Web Push). web-push is mocked: nothing is ever sent.

const sent = [];
let failWith = null;
pushClient.send = async (subscription, payload) => {
  if (failWith) {
    const err = new Error('push service error');
    err.statusCode = failWith;
    throw err;
  }
  sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  return { statusCode: 201 };
};

let ctx;
let owner;
let token;
let member;
const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: 'BOr8pFQ0sm0DcRfmXWbWtQyqXx9Ln2Lk9yJHfPBQb', auth: 'x7xT3qPP4gIrFgS7' } });

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  member = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Push Pooja', phone: '9800000001' })).body.data;
  await api().post(`/api/v1/members/${member._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  token = (await api().post('/api/v1/auth/member/login').send({ phone: '9800000001', password: 'Member@123' })).body.data.accessToken;
});
after(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  return teardown();
});

test('without VAPID keys push is off: no opt-in, nothing sent', async () => {
  const c = await api().get('/api/v1/me/push/config').set(auth(token));
  assert.deepEqual(c.body.data, { enabled: false, publicKey: null });
  assert.equal((await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(1))).status, 400);
  await PushSubscription.create({ memberId: member._id, ...sub(0) }); // even with a stored device
  const m = await Member.findById(member._id).lean();
  await notifyMember({ member: m, template: 'class_reminder', vars: { className: 'Yoga', time: '07:00 AM' }, dedupeKey: 'nokeys' });
  assert.equal(sent.length, 0);
  await PushSubscription.deleteMany({});
  assert.equal((await api().get('/api/v1/settings').set(auth(owner))).body.data.pushReady, false);
});

test('with keys: subscribe, notifyMember sends a short push that opens the right page', async () => {
  process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey_abcdefghijklmnopqrstuvwxyz0123456789';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  const c = await api().get('/api/v1/me/push/config').set(auth(token));
  assert.equal(c.body.data.enabled, true);
  assert.equal(c.body.data.publicKey, process.env.VAPID_PUBLIC_KEY);

  // Only real browser push services are accepted.
  const evil = await api().post('/api/v1/me/push/subscribe').set(auth(token)).send({ ...sub(1), endpoint: 'https://127.0.0.1/internal' });
  assert.equal(evil.status, 400);
  assert.equal((await api().post('/api/v1/me/push/subscribe').set(auth(token)).send({ ...sub(1), endpoint: 'http://fcm.googleapis.com/x' })).status, 400);

  assert.equal((await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(1))).status, 201);
  assert.equal((await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(1))).status, 201); // same device again
  assert.equal((await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(2))).status, 201);
  assert.equal(await PushSubscription.countDocuments({ memberId: member._id }), 2);

  const m = await Member.findById(member._id).lean();
  const r = await notifyMember({ member: m, template: 'renewal_reminder', vars: { plan: 'Monthly', date: '20-10-2026' }, dedupeKey: 'renewal-7:x' });
  assert.equal(r.length, 1); // SMS / WhatsApp are off: push only
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.title, 'Membership ending soon');
  assert.equal(sent[0].payload.url, '/portal/renew');
  assert.match(sent[0].payload.body, /Monthly membership at Test Gym ends on 20-10-2026/);
  const n = await Notification.findOne({ channel: 'push', template: 'renewal_reminder' }).lean();
  assert.equal(n.status, 'sent');
  assert.equal(n.memberId.toString(), member._id);

  // Same dedupe key: not sent again.
  await notifyMember({ member: m, template: 'renewal_reminder', vars: { plan: 'Monthly', date: '20-10-2026' }, dedupeKey: 'renewal-7:x' });
  assert.equal(sent.length, 2);
  assert.equal((await api().get('/api/v1/settings').set(auth(owner))).body.data.pushReady, true);
});

test('a device the browser dropped (410) is removed; other errors are kept', async () => {
  const m = await Member.findById(member._id).lean();
  failWith = 500;
  await notifyMember({ member: m, template: 'pt_reminder', vars: { trainer: 'Arjun', time: '06:00 PM' }, dedupeKey: 'pt:1' });
  assert.equal(await PushSubscription.countDocuments({ memberId: member._id }), 2);
  assert.equal((await Notification.findOne({ channel: 'push', template: 'pt_reminder' }).lean()).status, 'failed');
  failWith = 410;
  await notifyMember({ member: m, template: 'pt_reminder', vars: { trainer: 'Arjun', time: '06:00 PM' }, dedupeKey: 'pt:2' });
  assert.equal(await PushSubscription.countDocuments({ memberId: member._id }), 0);
  failWith = null;
});

test('gym switch off, explicit channels and unsubscribe', async () => {
  await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(3));
  const m = await Member.findById(member._id).lean();
  const before = sent.length;
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { channels: { push: false } } });
  assert.equal((await api().get('/api/v1/me/push/config').set(auth(token))).body.data.enabled, false);
  await notifyMember({ member: m, template: 'freeze_update', vars: { dates: 'x', status: 'is approved' }, dedupeKey: 'f:1' });
  assert.equal(sent.length, before);
  await Gym.updateOne({}, { 'settings.channels.push': true });
  // A caller that names its channels gets push only when it asks for it.
  await notifyMember({ member: m, template: 'freeze_update', vars: { dates: 'x', status: 'is approved' }, dedupeKey: 'f:2', channels: ['sms'] });
  assert.equal(sent.length, before);
  await notifyMember({ member: m, template: 'freeze_update', vars: { dates: 'x', status: 'is approved' }, dedupeKey: 'f:3' });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).payload.url, '/portal/freeze');
  // Trial visitors get nothing.
  await notifyMember({ member: { ...m, isTrial: true }, template: 'freeze_update', vars: {}, dedupeKey: 'f:4' });
  assert.equal(sent.length, before + 1);

  assert.equal((await api().post('/api/v1/me/push/unsubscribe').set(auth(token)).send({ endpoint: sub(3).endpoint })).status, 200);
  assert.equal(await PushSubscription.countDocuments({ memberId: member._id }), 0);
});

test('member deleted: their devices are removed', async () => {
  await api().post('/api/v1/me/push/subscribe').set(auth(token)).send(sub(4));
  assert.equal((await api().delete(`/api/v1/members/${member._id}`).set(auth(owner))).status, 200);
  assert.equal(await PushSubscription.countDocuments({ memberId: member._id }), 0);
});
