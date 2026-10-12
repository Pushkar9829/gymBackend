import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { PtBooking } from '../src/modules/pt/ptBooking.model.js';
import { PtPurchase, PtSession } from '../src/modules/pt/pt.model.js';
import { PrivateFile } from '../src/modules/uploads/privateFile.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { sendPtReminders } from '../src/modules/pt/ptBooking.service.js';
import { loadAccess } from '../src/modules/members/member.state.js';
import { computeAccess, DENY_CODES } from '../src/modules/access/access.engine.js';
import { getGym } from '../src/modules/settings/gym.model.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { addDays, dayjs, parseDay, tz, ymd } from '../src/utils/dates.js';

// Batch C: PT slot booking, progress notes + private photos, freeze requests, digital waiver, trial class setting.

let ctx;
let owner;
let rec;
let trainer;
let trainer2;
let memberA;
let memberB;
let memberC;
let tokenA;
let tokenB;
let purchaseA;
let purchaseB;
let purchaseC;

/** A real PNG (random pixels, so it is a few KB) that pdfmake can embed. */
function makePng(w = 60, h = 30) {
  const crc = (buf) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(zlib.crc32(buf) >>> 0);
    return b;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % (w * 3 + 1) === 0 ? 0 : Math.floor(Math.random() * 256);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pngDataUrl = () => `data:image/png;base64,${makePng().toString('base64')}`;

const slotAt = (daysAhead, hhmm) => dayjs.tz(`${ymd(addDays(new Date(), daysAhead))} ${hhmm}`, tz).toDate();
const memberLogin = async (phone) => (await api().post('/api/v1/auth/member/login').send({ phone, password: 'Member@123' })).body.data.accessToken;

async function addMember(name, phone, { portal = false, plan = ctx.monthly } = {}) {
  const m = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone })).body.data;
  if (plan) {
    const s = await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m._id, planId: String(plan._id) });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  }
  if (portal) await api().post(`/api/v1/members/${m._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  return m;
}

async function sell(member, pkg) {
  const r = await api().post('/api/v1/pt/purchases').set(auth(rec)).send({ memberId: member._id, packageId: pkg._id, trainerId: String(ctx.trainer._id) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.purchase;
}

before(async () => {
  ctx = await setupDb();
  await User.updateOne({ _id: ctx.trainer._id }, { ptCommissionPercent: 50 });
  await User.create({ name: 'Trainer Two', email: 't2@t.com', role: 'trainer', passwordHash: await hashPassword('Password@1'), branchIds: [ctx.main._id] });
  [owner, rec, trainer, trainer2] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com'), login('t2@t.com')]);
  memberA = await addMember('Asha PT', '9300000001', { portal: true });
  memberB = await addMember('Bala PT', '9300000002', { portal: true });
  memberC = await addMember('Chetan PT', '9300000003');
  tokenA = await memberLogin('9300000001');
  tokenB = await memberLogin('9300000002');
  const pkg5 = (await api().post('/api/v1/pt/packages').set(auth(owner)).send({ name: '5 sessions', sessions: 5, validityDays: 30, price: 500000 })).body.data;
  const pkg1 = (await api().post('/api/v1/pt/packages').set(auth(owner)).send({ name: '1 session', sessions: 1, validityDays: 30, price: 100000 })).body.data;
  purchaseA = await sell(memberA, pkg5);
  purchaseB = await sell(memberB, pkg5);
  purchaseC = await sell(memberC, pkg1);
});
after(teardown);

/* ---------------- Trial visitors and classes ---------------- */
test('trial visitors can be booked into a class unless the gym switches it off', async () => {
  const trial = await api().post('/api/v1/trials').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Tia Trial', phone: '9300000099' });
  assert.equal(trial.status, 201, JSON.stringify(trial.body));
  const visitor = trial.body.data.member;
  const type = (await api().post('/api/v1/classes/types').set(auth(owner)).send({ name: 'Trial Yoga', durationMin: 60, defaultCapacity: 5 })).body.data;
  const mk = async (h) =>
    (await api().post('/api/v1/classes/sessions').set(auth(owner)).send({ branchId: String(ctx.main._id), classTypeId: type._id, startsAt: new Date(Date.now() + h * 3600000), durationMin: 60, capacity: 5 })).body.data;
  const s1 = await mk(2);
  const ok = await api().post(`/api/v1/classes/sessions/${s1._id}/bookings`).set(auth(rec)).send({ memberId: visitor._id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const off = await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { trial: { allowClassBooking: false } } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.settings.trial.allowClassBooking, false);
  const s2 = await mk(3);
  const no = await api().post(`/api/v1/classes/sessions/${s2._id}/bookings`).set(auth(rec)).send({ memberId: visitor._id });
  assert.equal(no.status, 400);
  assert.match(no.body.message, /Trial visitors cannot book classes/);
  // Normal members are not affected.
  assert.equal((await api().post(`/api/v1/classes/sessions/${s2._id}/bookings`).set(auth(rec)).send({ memberId: memberA._id })).status, 201);
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { trial: { allowClassBooking: true } } });
});

/* ---------------- PT availability and booking ---------------- */
test('trainer sets weekly PT hours; reception cannot; owner can for any trainer', async () => {
  const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '06:00', end: '21:00', branchId: String(ctx.main._id) }));
  assert.equal((await api().put('/api/v1/pt/availability').set(auth(rec)).send({ trainerId: String(ctx.trainer._id), slotMin: 60, weekly })).status, 403);
  assert.equal((await api().put('/api/v1/pt/availability').set(auth(trainer)).send({ slotMin: 60, weekly: [{ day: 1, start: '10:00', end: '09:00', branchId: String(ctx.main._id) }] })).status, 400);
  assert.equal((await api().put('/api/v1/pt/availability').set(auth(trainer)).send({ slotMin: 50, weekly })).status, 400);
  assert.equal((await api().put('/api/v1/pt/availability').set(auth(trainer)).send({ slotMin: 60, weekly: [{ day: 1, start: '06:00', end: '09:00', branchId: String(ctx.other._id) }] })).status, 400);
  const r = await api().put('/api/v1/pt/availability').set(auth(trainer)).send({ slotMin: 60, weekly });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.weekly.length, 7);
  const o = await api().put('/api/v1/pt/availability').set(auth(owner)).send({ trainerId: String(ctx.trainer._id), slotMin: 60, weekly });
  assert.equal(o.status, 200);
  const mine = await api().get('/api/v1/pt/availability').set(auth(trainer));
  assert.equal(mine.body.data.slotMin, 60);
});

test('member sees free slots inside the booking window', async () => {
  const r = await api().get('/api/v1/me/pt-booking').set(auth(tokenA));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.purchases.length, 1);
  assert.equal(r.body.data.purchases[0].bookable, 5);
  assert.equal(r.body.data.settings.cancelHours, 4);
  const s = await api().get(`/api/v1/me/pt-booking/slots?purchaseId=${purchaseA._id}`).set(auth(tokenA));
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.data.days.length, 15); // today + 14 days
  const tomorrow = s.body.data.days.find((d) => d.day === ymd(addDays(new Date(), 1)));
  assert.equal(tomorrow.slots.length, 15); // 06:00 ... 20:00
  assert.ok(s.body.data.days.every((d) => d.slots.every((x) => new Date(x.startsAt) > new Date())));
});

let bookingA;
test('member books a slot; no double booking, one per day, window, hours and past are enforced', async () => {
  const r = await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(1, '07:00') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  bookingA = r.body.data;
  // Trainer gets an in-app alert addressed to them.
  const alert = await Notification.findOne({ template: 'pt-booking', dedupeKey: `pt-book:${bookingA._id}` }).lean();
  assert.ok(alert);
  assert.deepEqual(alert.userIds.map(String), [String(ctx.trainer._id)]);
  const forTrainer = await api().get('/api/v1/notifications').set(auth(trainer));
  assert.ok(forTrainer.body.data.items.some((n) => n.template === 'pt-booking'));
  const forTrainer2 = await api().get('/api/v1/notifications').set(auth(trainer2));
  assert.ok(!forTrainer2.body.data.items.some((n) => n.template === 'pt-booking'));

  // Same slot for another member (staff booking): taken
  const dbl = await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseB._id, startsAt: slotAt(1, '07:00') });
  assert.equal(dbl.status, 409);
  // Taken slot is gone from the member's list
  const s = await api().get(`/api/v1/me/pt-booking/slots?purchaseId=${purchaseB._id}`).set(auth(tokenB));
  const day1 = s.body.data.days.find((d) => d.day === ymd(addDays(new Date(), 1)));
  assert.ok(!day1.slots.some((x) => new Date(x.startsAt).getTime() === slotAt(1, '07:00').getTime()));
  // One per day
  const second = await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(1, '09:00') });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /per day/);
  // Booking window (14 days)
  const far = await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(20, '07:00') });
  assert.equal(far.status, 400);
  assert.match(far.body.message, /14 days ahead/);
  // Outside the trainer's hours / not on a slot boundary
  assert.equal((await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(2, '05:00') })).status, 400);
  assert.equal((await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(2, '07:30') })).status, 400);
  // Past
  assert.equal((await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(-1, '07:00') })).status, 400);
  // Someone else's package
  assert.equal((await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseB._id, startsAt: slotAt(3, '07:00') })).status, 404);
});

test('package validity and sessions left limit bookings', async () => {
  // Staff are not limited by the member window, but are by the package validity (30 days).
  const late = await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseB._id, startsAt: slotAt(35, '07:00') });
  assert.equal(late.status, 400);
  assert.match(late.body.message, /valid from/);
  const staffFar = await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseB._id, startsAt: slotAt(20, '08:00') });
  assert.equal(staffFar.status, 201, JSON.stringify(staffFar.body));
  assert.equal(staffFar.body.data.source, 'staff');
  // 1-session package: the second booking has nothing left to book
  assert.equal((await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseC._id, startsAt: slotAt(2, '10:00') })).status, 201);
  const none = await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseC._id, startsAt: slotAt(3, '10:00') });
  assert.equal(none.status, 400);
  assert.match(none.body.message, /No sessions left/);
});

test('member cancels before the cut-off; after it only staff can (late cancel); trainer is told', async () => {
  const c = await api().post(`/api/v1/me/pt-booking/${bookingA._id}/cancel`).set(auth(tokenA));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.data.status, 'cancelled');
  assert.equal(c.body.data.cancelledBy, 'member');
  assert.ok(await Notification.exists({ template: 'pt-booking-cancelled', userIds: ctx.trainer._id }));
  // Slot is free again: another member can take it
  const b = await api().post('/api/v1/pt/bookings').set(auth(rec)).send({ purchaseId: purchaseB._id, startsAt: slotAt(1, '07:00') });
  assert.equal(b.status, 201, JSON.stringify(b.body));

  // Cut-off of 48 hours: tomorrow's booking can no longer be cancelled in the app
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { pt: { cancelHours: 48 } } });
  const tooLate = await api().post(`/api/v1/me/pt-booking/${b.body.data._id}/cancel`).set(auth(tokenB));
  assert.equal(tooLate.status, 400);
  assert.match(tooLate.body.message, /48 hour/);
  const staff = await api().post(`/api/v1/pt/bookings/${b.body.data._id}/cancel`).set(auth(rec)).send({ reason: 'Member called' });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.data.lateCancel, true);
  assert.equal(staff.body.data.cancelledBy, 'staff');
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { pt: { cancelHours: 4 } } });
});

test('mark done logs the session with the normal logic (sessions left, commission); no-show follows the setting', async () => {
  const book = async (d) => {
    const r = await api().post('/api/v1/me/pt-booking').set(auth(tokenA)).send({ purchaseId: purchaseA._id, startsAt: slotAt(d, '07:00') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const toPast = (b) => PtBooking.updateOne({ _id: b._id }, { startsAt: new Date(Date.now() - 10 * 60000), endsAt: new Date(Date.now() + 50 * 60000), day: ymd(new Date()) });
  const b1 = await book(2);
  const early = await api().post(`/api/v1/pt/bookings/${b1._id}/done`).set(auth(trainer)).send({});
  assert.equal(early.status, 400);
  assert.match(early.body.message, /30 minutes/);
  await toPast(b1);
  // Another trainer cannot touch it
  assert.equal((await api().post(`/api/v1/pt/bookings/${b1._id}/done`).set(auth(trainer2)).send({})).status, 404);
  const done = await api().post(`/api/v1/pt/bookings/${b1._id}/done`).set(auth(trainer)).send({ notes: 'Legs' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.booking.status, 'done');
  assert.equal(done.body.data.purchase.sessionsUsed, 1);
  // (5000 / 5) x 50% = 500 per session
  assert.equal(done.body.data.session.commission, 50000);
  assert.equal((await PtSession.findById(done.body.data.session._id).lean()).status, 'done');
  assert.equal((await api().post(`/api/v1/pt/bookings/${b1._id}/done`).set(auth(trainer)).send({})).status, 400);

  // No-show uses a session by default (same as logging a no-show today)
  const b2 = await book(3);
  await toPast(b2);
  const ns = await api().post(`/api/v1/pt/bookings/${b2._id}/no-show`).set(auth(rec)).send({});
  assert.equal(ns.status, 200, JSON.stringify(ns.body));
  assert.equal(ns.body.data.purchase.sessionsUsed, 2);
  assert.equal((await PtSession.findById(ns.body.data.session._id).lean()).status, 'no-show');

  // Switched off: a no-show does not use a session
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { pt: { noShowUsesSession: false } } });
  const b3 = await book(4);
  await toPast(b3);
  const ns2 = await api().post(`/api/v1/pt/bookings/${b3._id}/no-show`).set(auth(rec)).send({});
  assert.equal(ns2.status, 200);
  assert.equal(ns2.body.data.purchase.sessionsUsed, 2);
  assert.equal((await PtBooking.findById(b3._id).lean()).status, 'no-show');
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { pt: { noShowUsesSession: true } } });

  // Undoing the logged session opens the booking again
  assert.equal((await api().delete(`/api/v1/pt/sessions/${done.body.data.session._id}`).set(auth(trainer))).status, 200);
  const again = await PtBooking.findById(b1._id).lean();
  assert.equal(again.status, 'booked');
  assert.equal(again.sessionId, undefined);
  assert.equal((await PtPurchase.findById(purchaseA._id).lean()).sessionsUsed, 1);
});

test('schedule: trainers see only their own bookings; staff see all', async () => {
  const from = ymd(addDays(new Date(), -1));
  const to = ymd(addDays(new Date(), 21));
  const all = await api().get(`/api/v1/pt/bookings?from=${from}&to=${to}`).set(auth(rec));
  assert.equal(all.status, 200);
  assert.ok(all.body.data.length >= 4);
  assert.ok(all.body.data.every((b) => b.status !== 'cancelled'));
  assert.ok(all.body.data[0].memberId.name);
  const mine = await api().get(`/api/v1/pt/bookings?from=${from}&to=${to}`).set(auth(trainer));
  assert.equal(mine.body.data.length, all.body.data.length); // every booking is with this trainer
  const other = await api().get(`/api/v1/pt/bookings?from=${from}&to=${to}`).set(auth(trainer2));
  assert.equal(other.body.data.length, 0);
});

test('reminder on the day goes out on the switched-on channels', async () => {
  await PtBooking.create({
    trainerId: ctx.trainer._id, memberId: memberB._id, ptPurchaseId: purchaseB._id, branchId: ctx.main._id,
    startsAt: new Date(Date.now() + 60000), endsAt: new Date(Date.now() + 3660000), day: ymd(new Date()), slotKey: 'test-reminder',
  });
  assert.equal(await sendPtReminders({ gym: await getGym() }), 0); // SMS / WhatsApp off
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { channels: { sms: true } } });
  assert.ok((await sendPtReminders({ gym: await getGym() })) >= 1);
  assert.equal(await sendPtReminders({ gym: await getGym() }), 0); // once per booking
  const n = await Notification.findOne({ template: 'pt_reminder', memberId: memberB._id }).lean();
  assert.match(n.body, /personal training with Trainer/);
});

/* ---------------- Progress notes and private photos ---------------- */
let photoId;
let note;
test('progress photos: only staff who may write fitness for this member can upload; images only', async () => {
  const png = makePng();
  const up = (token, memberId = memberA._id, body = png, type = 'image/png') =>
    api().post(`/api/v1/uploads/private?memberId=${memberId}&kind=progress`).set(auth(token)).set('Content-Type', type).send(body);
  assert.equal((await up(rec)).status, 403); // reception has no fitness.write
  assert.equal((await up(trainer2)).status, 404); // not this trainer's client
  const fake = await up(trainer, memberA._id, Buffer.from('<script>alert(1)</script> not an image'));
  assert.equal(fake.status, 400);
  const r = await up(trainer);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.contentType, 'image/png');
  photoId = r.body.data._id;
});

test('trainer adds a progress note with a photo; photos are served only to allowed people', async () => {
  // A photo cannot be attached to another member's note
  const wrong = await api().post('/api/v1/fitness/progress').set(auth(trainer)).send({ memberId: memberB._id, text: 'Good week', photoIds: [photoId] });
  assert.equal(wrong.status, 400);
  const r = await api().post('/api/v1/fitness/progress').set(auth(trainer)).send({ memberId: memberA._id, text: 'Down 2 kg, squats better', photoIds: [photoId] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  note = r.body.data;
  assert.equal(note.visibleToMember, true);
  assert.equal(note.createdBy.name, 'Trainer');
  assert.equal((await api().post('/api/v1/fitness/progress').set(auth(trainer)).send({ memberId: memberA._id, text: 'x' })).status, 400);
  assert.equal((await api().post('/api/v1/fitness/progress').set(auth(rec)).send({ memberId: memberA._id, text: 'Desk note' })).status, 403);

  const list = await api().get(`/api/v1/fitness/progress?memberId=${memberA._id}`).set(auth(rec));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal((await api().get(`/api/v1/fitness/progress?memberId=${memberA._id}`).set(auth(trainer2))).status, 404);

  // The photo itself
  const img = await api().get(`/api/v1/uploads/private/${photoId}`).set(auth(trainer));
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(img.headers['cache-control'], /no-store/);
  assert.equal((await api().get(`/api/v1/uploads/private/${photoId}`)).status, 401);
  assert.equal((await api().get(`/api/v1/uploads/private/${photoId}`).set(auth(trainer2))).status, 404);
  const otherBranch = await login('rec2@t.com');
  assert.equal((await api().get(`/api/v1/uploads/private/${photoId}`).set(auth(otherBranch))).status, 403);

  // Member sees their visible note and photo; another member cannot fetch it
  const mine = await api().get('/api/v1/me/progress').set(auth(tokenA));
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].text, 'Down 2 kg, squats better');
  assert.equal((await api().get(`/api/v1/me/files/${photoId}`).set(auth(tokenA))).status, 200);
  assert.equal((await api().get(`/api/v1/me/files/${photoId}`).set(auth(tokenB))).status, 404);
});

test('hiding a note hides its photos from the member; only the author or owner/manager may delete', async () => {
  const hide = await api().patch(`/api/v1/fitness/progress/${note._id}`).set(auth(trainer)).send({ visibleToMember: false });
  assert.equal(hide.status, 200);
  assert.equal((await api().get('/api/v1/me/progress').set(auth(tokenA))).body.data.length, 0);
  assert.equal((await api().get(`/api/v1/me/files/${photoId}`).set(auth(tokenA))).status, 404);
  assert.equal((await api().get(`/api/v1/uploads/private/${photoId}`).set(auth(trainer))).status, 200); // staff still see it

  // Trainer 2 gets the member as a client too, but did not write the note
  await Member.updateOne({ _id: memberA._id }, { trainerId: (await User.findOne({ email: 't2@t.com' }))._id });
  assert.equal((await api().delete(`/api/v1/fitness/progress/${note._id}`).set(auth(trainer2))).status, 403);
  assert.equal((await api().delete(`/api/v1/fitness/progress/${note._id}`).set(auth(owner))).status, 200);
  assert.equal(await PrivateFile.countDocuments({ _id: photoId }), 0);
  await Member.updateOne({ _id: memberA._id }, { $unset: { trainerId: 1 } });
});

/* ---------------- Freeze requests from the app ---------------- */
let freezeReq;
test('member asks for a freeze: start from tomorrow, within the plan allowance, one waiting at a time', async () => {
  const g = await api().get('/api/v1/me/freeze').set(auth(tokenA));
  assert.equal(g.status, 200);
  const sub = g.body.data.subscription;
  assert.deepEqual(g.body.data.allowance, { daysAllowed: 10, daysUsed: 0, daysLeft: 10, freezesAllowed: 2, freezesUsed: 0, freezesLeft: 2 });
  const ask = (body) => api().post('/api/v1/me/freeze-requests').set(auth(tokenA)).send({ subscriptionId: sub._id, reason: 'Travelling home', ...body });
  assert.equal((await ask({ from: ymd(new Date()), days: 3 })).status, 400); // today
  const tooMany = await ask({ from: ymd(addDays(new Date(), 3)), days: 15 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /10 day\(s\) left/);
  assert.equal((await ask({ from: ymd(addDays(new Date(), 3)), days: 4, reason: 'x' })).status, 400);
  const ok = await ask({ from: ymd(addDays(new Date(), 3)), days: 4 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const dup = await ask({ from: ymd(addDays(new Date(), 10)), days: 2 });
  assert.equal(dup.status, 409);
  // Cancel own and ask again
  assert.equal((await api().post(`/api/v1/me/freeze-requests/${ok.body.data._id}/cancel`).set(auth(tokenA))).status, 200);
  const again = await ask({ from: ymd(addDays(new Date(), 3)), days: 5 });
  assert.equal(again.status, 201);
  freezeReq = again.body.data;
  const alert = await Notification.findOne({ template: 'freeze-request', dedupeKey: `freeze-request:${freezeReq._id}` }).lean();
  assert.deepEqual(alert.roles, ['owner', 'manager', 'receptionist']);
});

test('reception approves: the freeze starts on the future date; member is told; trainers cannot', async () => {
  assert.equal((await api().get('/api/v1/freeze-requests').set(auth(trainer))).status, 403);
  const list = await api().get('/api/v1/freeze-requests?status=pending').set(auth(rec));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.pending, 1);
  assert.equal(list.body.data.items[0].memberId.name, 'Asha PT');
  assert.equal(list.body.data.items[0].allowance.daysLeft, 10);
  const subBefore = await Subscription.findOne({ memberId: memberA._id }).lean();

  const r = await api().post(`/api/v1/freeze-requests/${freezeReq._id}/approve`).set(auth(rec)).send({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.request.status, 'approved');
  assert.equal(r.body.data.access.allowed, true); // not frozen yet
  assert.equal((await api().post(`/api/v1/freeze-requests/${freezeReq._id}/approve`).set(auth(rec)).send({})).status, 400);
  const sub = await Subscription.findOne({ memberId: memberA._id }).lean();
  assert.equal(sub.freezes.length, 1);
  assert.equal(ymd(sub.freezes[0].from), ymd(addDays(new Date(), 3)));
  assert.equal(sub.freezes[0].days, 5);
  assert.equal(ymd(sub.endDate), ymd(addDays(subBefore.endDate, 5)));
  const member = await Member.findById(memberA._id).lean();
  const { access } = await loadAccess(member, { now: dayjs(parseDay(ymd(addDays(new Date(), 4)))).add(10, 'hour').toDate() });
  assert.equal(access.code, 'FROZEN');
  assert.ok(await Notification.exists({ template: 'freeze_update', memberId: memberA._id, body: /is approved/ }));
  const mine = await api().get('/api/v1/me/freeze').set(auth(tokenA));
  assert.equal(mine.body.data.requests[0].status, 'approved');
  assert.equal(mine.body.data.allowance.daysLeft, 5);
});

test('reject needs a note; the member sees it', async () => {
  const sub = (await api().get('/api/v1/me/freeze').set(auth(tokenA))).body.data.subscription;
  const ask = await api().post('/api/v1/me/freeze-requests').set(auth(tokenA)).send({ subscriptionId: sub._id, from: ymd(addDays(new Date(), 15)), days: 2, reason: 'Exams' });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  assert.equal((await api().post(`/api/v1/freeze-requests/${ask.body.data._id}/reject`).set(auth(rec)).send({})).status, 400);
  const r = await api().post(`/api/v1/freeze-requests/${ask.body.data._id}/reject`).set(auth(rec)).send({ note: 'Please visit the desk' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'rejected');
  const mine = await api().get('/api/v1/me/freeze').set(auth(tokenA));
  assert.equal(mine.body.data.requests[0].status, 'rejected');
  assert.equal(mine.body.data.requests[0].decisionNote, 'Please visit the desk');
  // Branch scope: a receptionist of another branch cannot decide
  const otherRec = await login('rec2@t.com');
  assert.equal((await api().get('/api/v1/freeze-requests').set(auth(otherRec))).body.data.total, 0);
});

/* ---------------- Digital waiver ---------------- */
const WAIVER_TEXT = 'I take part in gym activities at my own risk.\n\nI will follow the trainer and the gym rules.';

test('waiver settings: text is versioned; entry rule needs a text; only the owner edits', async () => {
  const g = await api().get('/api/v1/waivers').set(auth(rec));
  assert.equal(g.status, 200);
  assert.equal(g.body.data.settings.currentVersion, 0);
  assert.equal((await api().put('/api/v1/waivers').set(auth(owner)).send({ requireForEntry: true })).status, 400);
  assert.equal((await api().put('/api/v1/waivers').set(auth(rec)).send({ text: WAIVER_TEXT })).status, 403);
  const r = await api().put('/api/v1/waivers').set(auth(owner)).send({ text: WAIVER_TEXT, askMembers: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.settings.currentVersion, 1);
  assert.equal(r.body.data.settings.minVersion, 1);
  assert.equal(r.body.data.unsigned, 4); // three members with active memberships + the running trial pass
  // Same text again: no new version
  assert.equal((await api().put('/api/v1/waivers').set(auth(owner)).send({ text: WAIVER_TEXT })).body.data.settings.currentVersion, 1);
});

let sigFileId;
test('member signs in the app; PDF and the signature image are private', async () => {
  const w = await api().get('/api/v1/me/waiver').set(auth(tokenA));
  assert.equal(w.body.data.pending, true);
  assert.equal(w.body.data.ask, true);
  assert.equal(w.body.data.current.version, 1);
  assert.equal((await api().post('/api/v1/me/waiver/sign').set(auth(tokenA)).send({ version: 2, signature: pngDataUrl() })).status, 409);
  assert.equal((await api().post('/api/v1/me/waiver/sign').set(auth(tokenA)).send({ version: 1, signature: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await api().post('/api/v1/me/waiver/sign').set(auth(tokenA)).send({ version: 1, signature: 'not an image' })).status, 400);
  const s = await api().post('/api/v1/me/waiver/sign').set(auth(tokenA)).set('User-Agent', 'TestPhone/1.0').send({ version: 1, signature: pngDataUrl() });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal((await api().get('/api/v1/me/waiver').set(auth(tokenA))).body.data.pending, false);

  const member = await Member.findById(memberA._id).lean();
  assert.equal(member.waiver.version, 1);
  const desk = await api().get(`/api/v1/members/${memberA._id}/waiver`).set(auth(rec));
  assert.equal(desk.body.data.pending, false);
  const sig = desk.body.data.signatures[0];
  assert.equal(sig.via, 'app');
  assert.equal(sig.version, 1);
  assert.equal(sig.textHash.length, 64);
  sigFileId = sig.signatureFileId;

  const pdf = await api().get(`/api/v1/members/${memberA._id}/waiver/pdf`).set(auth(rec)).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  assert.equal((await api().get('/api/v1/me/waiver/pdf').set(auth(tokenA))).status, 200);
  assert.equal((await api().get('/api/v1/me/waiver/pdf').set(auth(tokenB))).status, 404);
  assert.equal((await api().get(`/api/v1/me/files/${sigFileId}`).set(auth(tokenA))).status, 200);
  assert.equal((await api().get(`/api/v1/me/files/${sigFileId}`).set(auth(tokenB))).status, 404);
  assert.equal((await api().get(`/api/v1/uploads/private/${sigFileId}`).set(auth(trainer2))).status, 404);
  assert.equal((await api().get(`/api/v1/uploads/private/${sigFileId}`).set(auth(rec))).status, 200);
});

test('"Require signed waiver for entry": unsigned members are refused with WAIVER_REQUIRED until they sign at the desk', async () => {
  const g = await api().get('/api/v1/waivers').set(auth(owner));
  assert.equal(g.body.data.unsigned, 3); // the warning count before switching on
  const on = await api().put('/api/v1/waivers').set(auth(owner)).send({ requireForEntry: true });
  assert.equal(on.status, 200);
  const checkB = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberB._id });
  assert.equal(checkB.body.data.allowed, false);
  assert.equal(checkB.body.data.code, 'WAIVER_REQUIRED');
  assert.match(checkB.body.data.reason, /Waiver not signed/);
  const checkA = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberA._id });
  assert.equal(checkA.body.data.allowed, true);
  // Member app shows the reason too
  assert.equal((await api().get('/api/v1/me').set(auth(tokenB))).body.data.access.code, 'WAIVER_REQUIRED');

  // Desk signature (trainers cannot sign for members: no members.write)
  assert.equal((await api().post(`/api/v1/members/${memberB._id}/waiver/sign`).set(auth(trainer)).send({ version: 1, signature: pngDataUrl() })).status, 403);
  const desk = await api().post(`/api/v1/members/${memberB._id}/waiver/sign`).set(auth(rec)).send({ version: 1, signature: pngDataUrl() });
  assert.equal(desk.status, 201, JSON.stringify(desk.body));
  assert.equal(desk.body.data.via, 'desk');
  assert.equal(String(desk.body.data.staffId), String(ctx.reception._id));
  const again = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberB._id });
  assert.equal(again.body.data.allowed, true);
});

test('a new version needs re-signing only when the owner asks for it', async () => {
  const v2 = await api().put('/api/v1/waivers').set(auth(owner)).send({ text: `${WAIVER_TEXT}\n\nLockers are at your own risk.` });
  assert.equal(v2.body.data.settings.currentVersion, 2);
  assert.equal(v2.body.data.settings.minVersion, 1);
  assert.equal((await api().get('/api/v1/me/waiver').set(auth(tokenA))).body.data.pending, false);
  const before = (await api().get('/api/v1/waivers').set(auth(owner))).body.data;
  assert.equal(before.unsignedIfResign, 4); // what the owner is warned about
  const v3 = await api().put('/api/v1/waivers').set(auth(owner)).send({ text: `${WAIVER_TEXT}\n\nNew rules from today.`, requireResign: true });
  assert.equal(v3.body.data.settings.currentVersion, 3);
  assert.equal(v3.body.data.settings.minVersion, 3);
  assert.equal((await api().get('/api/v1/me/waiver').set(auth(tokenA))).body.data.pending, true);
  const denied = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberA._id });
  assert.equal(denied.body.data.code, 'WAIVER_REQUIRED');
  const versions = (await api().get('/api/v1/waivers').set(auth(owner))).body.data.versions;
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  // Old signed copy still prints with its own text
  const sigs = (await api().get(`/api/v1/members/${memberA._id}/waiver`).set(auth(rec))).body.data.signatures;
  assert.equal((await api().get(`/api/v1/members/${memberA._id}/waiver/pdf?signatureId=${sigs[0]._id}`).set(auth(rec))).status, 200);
  await api().put('/api/v1/waivers').set(auth(owner)).send({ requireForEntry: false });
  assert.equal((await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: memberC._id })).body.data.allowed, true);
});

test('access engine: waiver rule comes after membership problems and turns the device off', () => {
  assert.ok(DENY_CODES.includes('WAIVER_REQUIRED'));
  const now = new Date();
  const sub = { _id: 's', startDate: addDays(now, -5), endDate: addDays(now, 20), status: 'active', freezes: [], plan: { name: 'M' }, dueAmount: 0 };
  const settings = { waiver: { requireForEntry: true, currentVersion: 2, minVersion: 1 } };
  const a = computeAccess({ member: {}, subscriptions: [sub], settings, now });
  assert.equal(a.code, 'WAIVER_REQUIRED');
  assert.equal(a.device.enabled, false);
  assert.equal(computeAccess({ member: { waiver: { version: 1 } }, subscriptions: [sub], settings, now }).allowed, true);
  const expired = computeAccess({ member: {}, subscriptions: [{ ...sub, startDate: addDays(now, -40), endDate: addDays(now, -10) }], settings, now });
  assert.equal(expired.code, 'EXPIRED');
  // Rule off or no waiver text: nothing changes
  assert.equal(computeAccess({ member: {}, subscriptions: [sub], settings: { waiver: { requireForEntry: false, currentVersion: 2 } }, now }).allowed, true);
  assert.equal(computeAccess({ member: {}, subscriptions: [sub], settings: { waiver: { requireForEntry: true, currentVersion: 0 } }, now }).allowed, true);
});
