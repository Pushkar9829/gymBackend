import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { ClassSession, Booking } from '../src/modules/classes/class.model.js';
import { dayjs, tz, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let type;
const members = [];
let memberToken;
let session;

const tomorrow = dayjs().tz(tz).add(1, 'day');

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
  for (const [name, phone, plan] of [
    ['Class A', '9200000001', ctx.monthly],
    ['Class B', '9200000002', ctx.monthly],
    ['Class C', '9200000003', ctx.monthly],
    ['No Plan', '9200000004', null],
  ]) {
    const m = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone })).body.data;
    if (plan) await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m._id, planId: String(plan._id) });
    members.push(m);
  }
  await api().post(`/api/v1/members/${members[0]._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  memberToken = (await api().post('/api/v1/auth/member/login').send({ phone: '9200000001', password: 'Member@123' })).body.data.accessToken;
});
after(teardown);

test('owner sets up a class type and a weekly schedule; sessions are generated', async () => {
  type = (await api().post('/api/v1/classes/types').set(auth(owner)).send({ name: 'Yoga', durationMin: 60, defaultCapacity: 2 })).body.data;
  assert.equal((await api().post('/api/v1/classes/types').set(auth(rec)).send({ name: 'Zumba' })).status, 403);
  const s = await api()
    .post('/api/v1/classes/schedules')
    .set(auth(owner))
    .send({ branchId: String(ctx.main._id), classTypeId: type._id, trainerId: String(ctx.trainer._id), weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '07:00', durationMin: 60, capacity: 2 });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const list = await api().get(`/api/v1/classes/sessions?from=${ymd(tomorrow)}&to=${ymd(tomorrow.add(6, 'day'))}`).set(auth(rec));
  assert.equal(list.body.data.length, 7);
  // Listing again does not duplicate
  await api().get(`/api/v1/classes/sessions?from=${ymd(tomorrow)}&to=${ymd(tomorrow.add(6, 'day'))}`).set(auth(rec));
  assert.equal(await ClassSession.countDocuments({}), 7);
  session = list.body.data[0];
  assert.equal(dayjs(session.startsAt).tz(tz).format('HH:mm'), '07:00');
});

test('member books from the app; capacity fills; next goes to waitlist', async () => {
  const r = await api().post(`/api/v1/me/classes/${session._id}/book`).set(auth(memberToken));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.booking.status, 'booked');
  assert.equal((await api().post(`/api/v1/me/classes/${session._id}/book`).set(auth(memberToken))).status, 409);

  const b = await api().post(`/api/v1/classes/sessions/${session._id}/bookings`).set(auth(rec)).send({ memberId: members[1]._id });
  assert.equal(b.body.data.booking.status, 'booked');
  const c = await api().post(`/api/v1/classes/sessions/${session._id}/bookings`).set(auth(rec)).send({ memberId: members[2]._id });
  assert.equal(c.body.data.booking.status, 'waitlisted');
  const s = await ClassSession.findById(session._id);
  assert.equal(s.bookedCount, 2);
  assert.equal(s.waitlistCount, 1);
});

test('member without a valid membership cannot book', async () => {
  const r = await api().post(`/api/v1/classes/sessions/${session._id}/bookings`).set(auth(rec)).send({ memberId: members[3]._id });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /No active membership/);
});

test('cancelling a seat promotes the first waitlisted member', async () => {
  const mine = await Booking.findOne({ sessionId: session._id, memberId: members[0]._id });
  const r = await api().post(`/api/v1/me/bookings/${mine._id}/cancel`).set(auth(memberToken));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const promoted = await Booking.findOne({ sessionId: session._id, memberId: members[2]._id });
  assert.equal(promoted.status, 'booked');
  const s = await ClassSession.findById(session._id);
  assert.equal(s.bookedCount, 2);
  assert.equal(s.waitlistCount, 0);
});

test('portal timetable shows my booking status', async () => {
  await api().post(`/api/v1/me/classes/${session._id}/book`).set(auth(memberToken)); // full -> waitlist
  const r = await api().get(`/api/v1/me/classes?from=${ymd(tomorrow)}`).set(auth(memberToken));
  const mine = r.body.data.sessions.find((x) => x._id === String(session._id));
  assert.equal(mine.myBooking.status, 'waitlisted');
});

test('attendance only from 30 minutes before the class, and only by its trainer', async () => {
  const b = await Booking.findOne({ sessionId: session._id, status: 'booked' });
  const early = await api().post(`/api/v1/classes/bookings/${b._id}/attendance`).set(auth(trainer)).send({ status: 'attended' });
  assert.equal(early.status, 400);
  await ClassSession.updateOne({ _id: session._id }, { startsAt: new Date(Date.now() - 5 * 60000) });
  const ok = await api().post(`/api/v1/classes/bookings/${b._id}/attendance`).set(auth(trainer)).send({ status: 'attended' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('staff cancels a whole class: bookings cancelled, members informed', async () => {
  const list = await api().get(`/api/v1/classes/sessions?from=${ymd(tomorrow.add(1, 'day'))}&to=${ymd(tomorrow.add(1, 'day'))}`).set(auth(rec));
  const s2 = list.body.data[0];
  await api().post(`/api/v1/me/classes/${s2._id}/book`).set(auth(memberToken));
  assert.equal((await api().post(`/api/v1/classes/sessions/${s2._id}/cancel`).set(auth(rec)).send({ reason: 'x' })).status, 403);
  const r = await api().post(`/api/v1/classes/sessions/${s2._id}/cancel`).set(auth(owner)).send({ reason: 'Trainer unwell' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.informed, 1);
  assert.equal(await Booking.countDocuments({ sessionId: s2._id, status: 'booked' }), 0);
  assert.equal((await api().post(`/api/v1/me/classes/${s2._id}/book`).set(auth(memberToken))).status, 404);
});

test('class report shows fill rate', async () => {
  const r = await api().get('/api/v1/classes/report').set(auth(owner));
  assert.equal(r.status, 200);
  assert.equal(r.body.data[0].name, 'Yoga');
});
