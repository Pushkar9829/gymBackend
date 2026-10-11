import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { LockerAllotment } from '../src/modules/lockers/locker.model.js';
import { lockerAlerts } from '../src/modules/lockers/locker.routes.js';
import { addDays, startOfDay, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let memberToken;
const members = [];

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
  for (const [name, phone, plan] of [
    ['Locker A', '9400000001', ctx.monthly],
    ['Locker B', '9400000002', ctx.monthly],
    ['No Plan', '9400000003', null],
  ]) {
    const m = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name, phone })).body.data;
    if (plan) await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m._id, planId: String(plan._id) });
    members.push(m);
  }
  await api().post(`/api/v1/members/${members[0]._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  memberToken = (await api().post('/api/v1/auth/member/login').send({ phone: '9400000001', password: 'Member@123' })).body.data.accessToken;
});
after(teardown);

/* ---------------- Lockers ---------------- */
let lockers;
let allotment;

test('owner adds lockers in bulk; repeats are skipped; reception cannot add', async () => {
  const body = { branchId: String(ctx.main._id), prefix: 'L', from: 1, to: 10, monthlyFee: 30000 };
  assert.equal((await api().post('/api/v1/lockers/bulk').set(auth(rec)).send(body)).status, 403);
  const r = await api().post('/api/v1/lockers/bulk').set(auth(owner)).send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.added, 10);
  const again = await api().post('/api/v1/lockers/bulk').set(auth(owner)).send({ ...body, to: 12 });
  assert.deepEqual(again.body.data, { added: 2, skipped: 10 });
  const list = await api().get('/api/v1/lockers').set(auth(rec));
  lockers = list.body.data.items;
  assert.equal(lockers.length, 12);
  assert.deepEqual(lockers.slice(0, 3).map((l) => l.number), ['L1', 'L2', 'L3']); // natural order
  assert.equal(lockers[9].number, 'L10');
  assert.equal(list.body.data.counts.available, 12);
  assert.equal((await api().get('/api/v1/lockers').set(auth(trainer))).status, 403);
});

test('reception allots a locker with rent + deposit; rules are enforced', async () => {
  const l1 = lockers[0];
  const send = (b, id = l1._id) => api().post(`/api/v1/lockers/${id}/allot`).set(auth(rec)).send({ months: 1, rent: 30000, deposit: 50000, mode: 'upi', ...b });
  const noPlan = await send({ memberId: members[2]._id });
  assert.equal(noPlan.status, 400);
  assert.match(noPlan.body.message, /no active membership/);

  const r = await send({ memberId: members[0]._id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  allotment = r.body.data.allotment;
  assert.match(r.body.data.receiptNo, /^LKR\//);
  assert.equal(allotment.charges.length, 2);
  assert.equal(ymd(allotment.startDate), ymd(startOfDay()));

  assert.equal((await send({ memberId: members[1]._id })).status, 400); // locker taken
  const second = await send({ memberId: members[0]._id }, lockers[1]._id);
  assert.match(second.body.message, /already has a locker/);

  const list = await api().get('/api/v1/lockers?status=occupied').set(auth(rec));
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].allotmentId.memberId.name, 'Locker A');
});

test('maintenance blocks allotting; an occupied locker cannot be put in maintenance', async () => {
  assert.equal((await api().put(`/api/v1/lockers/${lockers[0]._id}`).set(auth(owner)).send({ maintenance: true })).status, 400);
  assert.equal((await api().put(`/api/v1/lockers/${lockers[2]._id}`).set(auth(owner)).send({ maintenance: true })).status, 200);
  const r = await api().post(`/api/v1/lockers/${lockers[2]._id}/allot`).set(auth(rec)).send({ memberId: members[1]._id, months: 1, rent: 0 });
  assert.match(r.body.message, /maintenance/);
});

test('member sees their locker in the app', async () => {
  const r = await api().get('/api/v1/me/locker').set(auth(memberToken));
  assert.equal(r.body.data.number, 'L1');
  assert.equal(r.body.data.deposit, 50000);
});

test('extend adds rent and moves the end date; locker rent counts in P&L', async () => {
  const before = new Date(allotment.endDate);
  const r = await api().post(`/api/v1/lockers/allotments/${allotment._id}/extend`).set(auth(rec)).send({ months: 2, rent: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(new Date(r.body.data.allotment.endDate) > addDays(before, 55));
  const pnl = await api().get('/api/v1/reports/pnl').set(auth(owner));
  assert.equal(pnl.body.data.lockerRent, 90000); // deposit is not income
});

test('overdue lockers: staff alert once a day, reminder before the end date', async () => {
  await LockerAllotment.updateOne({ _id: allotment._id }, { endDate: addDays(startOfDay(), -1) });
  const r1 = await lockerAlerts();
  assert.equal(r1.alerts, 1);
  assert.equal((await lockerAlerts()).alerts, 0);
  assert.ok(await Notification.exists({ template: 'locker-overdue' }));
  const dash = await api().get('/api/v1/reports/dashboard').set(auth(rec));
  assert.equal(dash.body.data.lockersOverdue, 1);
  const list = await api().get('/api/v1/lockers?status=overdue').set(auth(rec));
  assert.equal(list.body.data.items.length, 1);
});

test('release returns the deposit (not more than held) and frees the locker', async () => {
  const url = `/api/v1/lockers/allotments/${allotment._id}/release`;
  assert.equal((await api().post(url).set(auth(rec)).send({ depositReturned: 99999 })).status, 400);
  const r = await api().post(url).set(auth(rec)).send({ depositReturned: 40000, note: 'Lost key: Rs 100 kept' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'ended');
  const list = await api().get('/api/v1/lockers').set(auth(rec));
  assert.equal(list.body.data.items.find((l) => l.number === 'L1').status, 'available');
  assert.equal((await api().get('/api/v1/me/locker').set(auth(memberToken))).body.data, null);
  const hist = await api().get(`/api/v1/lockers/allotments?memberId=${members[0]._id}`).set(auth(rec));
  assert.equal(hist.body.data.length, 1);
  assert.equal(hist.body.data[0].lockerId.number, 'L1');
  // A locker with history cannot be deleted, an unused one can.
  assert.equal((await api().delete(`/api/v1/lockers/${lockers[0]._id}`).set(auth(owner))).status, 400);
  assert.equal((await api().delete(`/api/v1/lockers/${lockers[11]._id}`).set(auth(owner))).status, 200);
});

test('a reception user from another branch cannot touch these lockers', async () => {
  const other = await login('rec2@t.com');
  const r = await api().post(`/api/v1/lockers/${lockers[3]._id}/allot`).set(auth(other)).send({ memberId: members[1]._id, months: 1, rent: 0 });
  assert.equal(r.status, 403);
});

/* ---------------- Feedback ---------------- */
let ticket;

test('member raises a complaint in the app; staff are alerted; high priority for equipment', async () => {
  const r = await api()
    .post('/api/v1/me/feedback')
    .set(auth(memberToken))
    .send({ type: 'complaint', category: 'equipment', subject: 'Treadmill 3 belt slipping', message: 'It jerks at 8 km/h', rating: 3 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ticket = r.body.data;
  assert.match(ticket.ticketNo, /^FB-\d{5}$/);
  assert.equal(ticket.status, 'open');
  assert.ok(await Notification.exists({ template: 'feedback', subject: new RegExp(ticket.ticketNo) }));
  const list = await api().get('/api/v1/feedback?status=open').set(auth(rec));
  assert.equal(list.body.data.items[0].priority, 'high');
  assert.equal(list.body.data.counts.open, 1);
  assert.equal((await api().get('/api/v1/feedback').set(auth(trainer))).status, 403);
  const one = await api().get(`/api/v1/feedback/${ticket._id}`).set(auth(rec));
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.data.memberId.name, 'Locker A');
});

test('staff reply moves it to in progress; the member sees the reply', async () => {
  const r = await api().post(`/api/v1/feedback/${ticket._id}/replies`).set(auth(rec)).send({ text: 'Thanks, technician coming tomorrow.' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.status, 'in-progress');
  const mine = await api().get('/api/v1/me/feedback').set(auth(memberToken));
  assert.equal(mine.body.data[0].replies[0].text, 'Thanks, technician coming tomorrow.');
  assert.equal(mine.body.data[0].replies[0].name, 'Rec');
  assert.equal(mine.body.data[0].assignedTo, undefined); // internal fields hidden
});

test('resolved -> member says not fixed -> reopened -> resolved -> member rates -> closed', async () => {
  await api().patch(`/api/v1/feedback/${ticket._id}`).set(auth(rec)).send({ status: 'resolved' });
  const rate0 = await api().post(`/api/v1/me/feedback/${ticket._id}/rate`).set(auth(memberToken)).send({ rating: 4 });
  assert.equal(rate0.status, 200);
  assert.equal(rate0.body.data.status, 'closed');
  // A closed ticket takes no replies.
  assert.equal((await api().post(`/api/v1/me/feedback/${ticket._id}/replies`).set(auth(memberToken)).send({ text: 'again' })).status, 400);

  const t2 = (await api().post('/api/v1/me/feedback').set(auth(memberToken)).send({ type: 'complaint', category: 'cleanliness', subject: 'Shower drain blocked', message: 'Men shower 2' })).body.data;
  await api().patch(`/api/v1/feedback/${t2._id}`).set(auth(owner)).send({ status: 'resolved' });
  const reopen = await api().post(`/api/v1/me/feedback/${t2._id}/replies`).set(auth(memberToken)).send({ text: 'Still blocked' });
  assert.equal(reopen.body.data.status, 'open');
  assert.equal((await api().post(`/api/v1/me/feedback/${t2._id}/rate`).set(auth(memberToken)).send({ rating: 5 })).status, 400);

  const list = await api().get('/api/v1/feedback').set(auth(owner));
  assert.deepEqual(list.body.data.satisfaction, { average: 4, ratings: 1 });
  const dash = await api().get('/api/v1/reports/dashboard').set(auth(rec));
  assert.equal(dash.body.data.openComplaints, 1);
});

test('desk logs feedback for a member; members only see their own tickets', async () => {
  const r = await api().post('/api/v1/feedback').set(auth(rec)).send({ memberId: members[1]._id, type: 'suggestion', category: 'timings', subject: 'Open at 5 on Sundays', message: 'Please' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.source, 'desk');
  assert.equal((await api().get('/api/v1/me/feedback').set(auth(memberToken))).body.data.length, 2);
  assert.equal((await api().post(`/api/v1/me/feedback/${r.body.data._id}/replies`).set(auth(memberToken)).send({ text: 'x' })).status, 404);
  const search = await api().get('/api/v1/feedback?search=sundays').set(auth(rec));
  assert.equal(search.body.data.items.length, 1);
});
