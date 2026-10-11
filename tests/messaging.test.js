import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { devOutbox } from '../src/modules/messaging/providers.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Announcement } from '../src/modules/messaging/announcement.routes.js';
import { runDailyJob } from '../src/jobs/daily.service.js';
import { addDays, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
const lastOtp = (phone) => devOutbox.filter((m) => m.to === phone && m.template === 'otp').at(-1)?.text.match(/\d{6}/)?.[0];

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { channels: { sms: true, whatsapp: true } } });
  for (const [name, phone] of [['Sms One', '9500000001'], ['Sms Two', '9500000002']]) {
    const m = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone, email: `${phone}@x.com` })).body.data;
    await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m._id, planId: String(ctx.monthly._id) });
  }
});
after(teardown);

test('welcome SMS + WhatsApp sent once when channels are on', async () => {
  const n = await Notification.find({ template: 'welcome', channel: { $in: ['sms', 'whatsapp'] } }).lean();
  assert.equal(n.length, 4); // 2 members x 2 channels
  assert.ok(devOutbox.some((m) => m.channel === 'whatsapp' && /member code is 100\d/.test(m.text)));
});

test('member OTP login: unknown phone gives same answer, wrong code rejected, right code logs in', async () => {
  const unknown = await api().post('/api/v1/auth/member/otp/send').send({ phone: '9999988888' });
  assert.equal(unknown.status, 200);
  assert.equal(lastOtp('9999988888'), undefined);

  assert.equal((await api().post('/api/v1/auth/member/otp/send').send({ phone: '9500000001' })).status, 200);
  assert.equal((await api().post('/api/v1/auth/member/otp/send').send({ phone: '9500000001' })).status, 429); // resend too soon
  const otp = lastOtp('9500000001');
  assert.match(otp, /^\d{6}$/);
  const wrong = String((Number(otp) + 1) % 1000000).padStart(6, '1');
  assert.equal((await api().post('/api/v1/auth/member/otp/verify').send({ phone: '9500000001', otp: wrong })).status, 400);
  const ok = await api().post('/api/v1/auth/member/otp/verify').send({ phone: '9500000001', otp });
  assert.equal(ok.status, 200);
  const me = await api().get('/api/v1/me').set(auth(ok.body.data.accessToken));
  assert.equal(me.status, 200);
  // Code is single use
  assert.equal((await api().post('/api/v1/auth/member/otp/verify').send({ phone: '9500000001', otp })).status, 400);
});

test('renewal reminder goes out by SMS/WhatsApp from the daily job', async () => {
  // Monthly plan from today ends in ~1 month; run the job 7 days before the end.
  const sub = (await api().get('/api/v1/subscriptions').set(auth(owner))).body.data.items[0];
  const runAt = addDays(new Date(sub.endDate), -7);
  await runDailyJob({ now: runAt });
  const n = await Notification.find({ template: 'renewal_reminder' }).lean();
  assert.ok(n.length >= 2, `got ${n.length}`);
  assert.ok(n.every((x) => x.body.includes(ymd(sub.endDate).split('-').reverse().join('-'))));
});

test('announcement: preview count, send to active members on two channels', async () => {
  const preview = await api().post('/api/v1/announcements').set(auth(owner)).send({ audience: 'active', channels: ['sms'], text: 'Gym closed on Monday for maintenance', preview: true });
  assert.equal(preview.body.data.total, 2);
  const r = await api().post('/api/v1/announcements').set(auth(owner)).send({ audience: 'active', channels: ['sms', 'email'], text: 'Gym closed on Monday for maintenance' });
  assert.equal(r.status, 201);
  const a = await Announcement.findById(r.body.data._id).lean();
  assert.equal(a.status, 'done');
  assert.equal(a.sent, 4);
});

test('staff sessions: list and revoke others', async () => {
  const l1 = await api().post('/api/v1/auth/login').send({ login: 'owner@t.com', password: 'Password@1' });
  const cookie = l1.headers['set-cookie'].find((c) => c.startsWith('gym_rt='));
  const list = await api().get('/api/v1/auth/sessions').set(auth(l1.body.data.accessToken)).set('Cookie', cookie);
  assert.ok(list.body.data.length >= 2);
  assert.equal(list.body.data.filter((s) => s.current).length, 1);
  await api().post('/api/v1/auth/sessions/revoke-others').set(auth(l1.body.data.accessToken)).set('Cookie', cookie);
  const after = await api().get('/api/v1/auth/sessions').set(auth(l1.body.data.accessToken)).set('Cookie', cookie);
  assert.equal(after.body.data.length, 1);
});
