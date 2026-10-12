import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { PtPurchase } from '../src/modules/pt/pt.model.js';
import { ClassType, ClassSession, Booking } from '../src/modules/classes/class.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { addDays, startOfDay, dayjs, tz } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let main;
const m = {};

const newMember = async (name, phone) => (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: main, name, phone })).body.data;

before(async () => {
  ctx = await setupDb();
  main = String(ctx.main._id);
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
  await User.updateOne({ _id: ctx.trainer._id }, { ptCommissionPercent: 30 });
  for (const [k, phone] of [['one', '9320000001'], ['two', '9320000002'], ['a', '9320000011'], ['b', '9320000012'], ['c', '9320000013'], ['d', '9320000014'], ['e', '9320000015'], ['f', '9320000016']]) m[k] = await newMember(`Member ${k}`, phone);
});
after(teardown);

/* ---------------- Staff performance ---------------- */
test('staff performance: front desk and trainer numbers', async () => {
  const plan = String(ctx.monthly._id);
  const s1 = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m.one._id, planId: plan, discount: 10000, payment: { amount: 50000, mode: 'cash' } });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: s1.body.data.subscription._id, amount: 20000, mode: 'upi' });
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: m.two._id, planId: plan, payment: { amount: 141600, mode: 'upi' } });
  const renewal = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m.one._id, planId: plan });
  assert.equal(renewal.body.data.subscription.type, 'renewal');

  const pkg = (await api().post('/api/v1/pt/packages').set(auth(owner)).send({ name: '10 sessions', sessions: 10, validityDays: 30, price: 500000 })).body.data;
  // Two older packages that ended in the period: Member one renews (below), Member two does not.
  for (const [who, days] of [[m.one, 3], [m.two, 2]]) {
    const old = await PtPurchase.create({
      memberId: who._id, branchId: ctx.main._id, trainerId: ctx.trainer._id, packageId: pkg._id, package: { name: 'old' }, sessionsTotal: 10, sessionsUsed: 10,
      validFrom: addDays(startOfDay(), -40), validTo: addDays(startOfDay(), -days), price: 500000, totalAmount: 590000,
    });
    await PtPurchase.collection.updateOne({ _id: old._id }, { $set: { createdAt: addDays(new Date(), -40) } });
  }
  const pt = await api().post('/api/v1/pt/purchases').set(auth(rec)).send({ memberId: m.one._id, packageId: pkg._id, trainerId: String(ctx.trainer._id), discount: 5000, payment: { amount: 100000, mode: 'card' } });
  assert.equal(pt.status, 201, JSON.stringify(pt.body));
  const purchaseId = pt.body.data.purchase._id;
  await api().post(`/api/v1/pt/purchases/${purchaseId}/sessions`).set(auth(trainer)).send({});
  await api().post(`/api/v1/pt/purchases/${purchaseId}/sessions`).set(auth(trainer)).send({ status: 'no-show' });

  const p = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Bar', price: 10000, taxPercent: 12 })).body.data;
  await api().post(`/api/v1/shop/products/${p._id}/stock`).set(auth(owner)).send({ branchId: main, qty: 5, type: 'purchase' });
  await api().post('/api/v1/shop/sales').set(auth(rec)).send({ branchId: main, items: [{ productId: p._id, qty: 1 }], mode: 'cash' });

  const l1 = (await api().post('/api/v1/leads').set(auth(rec)).send({ branchId: main, name: 'Lead One', phone: '9320000101' })).body.data;
  await api().post('/api/v1/leads').set(auth(rec)).send({ branchId: main, name: 'Lead Two', phone: '9320000102' });
  await api().post(`/api/v1/leads/${l1._id}/convert`).set(auth(rec));

  const type = await ClassType.create({ name: 'Yoga', durationMin: 60, defaultCapacity: 10 });
  const cls = await ClassSession.create({ branchId: ctx.main._id, classTypeId: type._id, name: 'Yoga', trainerId: ctx.trainer._id, startsAt: new Date(Date.now() - 3600000), endsAt: new Date(), capacity: 10 });
  await Booking.create({ sessionId: cls._id, memberId: m.one._id, branchId: ctx.main._id, status: 'attended' });
  await Booking.create({ sessionId: cls._id, memberId: m.two._id, branchId: ctx.main._id, status: 'no-show' });

  assert.equal((await api().get('/api/v1/reports/staff').set(auth(rec))).status, 403);
  const r = await api().get('/api/v1/reports/staff').set(auth(owner));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const recRow = r.body.data.staff.find((s) => s.name === 'Rec');
  assert.deepEqual(recRow.payments, { count: 3, amount: 170000, byMode: { cash: 50000, upi: 20000, card: 100000, bank: 0, online: 0 } });
  assert.deepEqual(
    [recRow.newMemberships, recRow.renewals, recRow.ptSold, recRow.shopSales, recRow.shopAmount, recRow.leads, recRow.converted, recRow.conversion, recRow.discounts],
    [1, 1, 1, 1, 11200, 2, 1, 50, 15000],
  );
  const ownerRow = r.body.data.staff.find((s) => s.name === 'Owner');
  assert.deepEqual([ownerRow.payments.amount, ownerRow.newMemberships, ownerRow.discounts], [141600, 1, 0]);
  const t = r.body.data.trainers.find((x) => x.name === 'Trainer');
  // Commission per session: (5000 - 50) / 10 x 30% = Rs 148.50, no-shows included.
  assert.deepEqual(
    [t.sessions, t.noShows, t.activeClients, t.ptEnded, t.ptRenewed, t.renewalRate, t.classes, t.attendance, t.commission],
    [1, 1, 1, 2, 1, 50, 1, 50, 29700],
  );
  const x = await api().get('/api/v1/reports/staff?export=xlsx').set(auth(owner));
  assert.match(x.headers['content-type'], /spreadsheetml/);
});

/* ---------------- Retention ---------------- */
test('retention by month: renewed within the grace window, lost, still pending', async () => {
  const ago = dayjs().tz(tz).subtract(2, 'month');
  const day = (d) => startOfDay(ago.date(d).toDate());
  const sub = (member, startDate, endDate) =>
    Subscription.create({ memberId: member._id, branchId: ctx.main._id, planId: ctx.monthly._id, plan: { name: 'Monthly' }, startDate, endDate, totalAmount: 0 });
  await sub(m.a, addDays(day(10), -30), day(10));
  await sub(m.a, addDays(day(10), 1), addDays(startOfDay(), 60)); // renewed the next day
  await sub(m.b, addDays(day(12), -30), day(12)); // lost
  await sub(m.c, addDays(day(14), -30), day(14));
  await sub(m.c, addDays(day(14), 20), addDays(startOfDay(), 90)); // came back after 20 days
  await sub(m.d, addDays(startOfDay(), -30), addDays(startOfDay(), -1)); // ended yesterday: still in the window
  await sub(m.e, addDays(startOfDay(), -29), addDays(startOfDay(), 1)); // still running: not counted

  const r = await api().get('/api/v1/reports/retention?months=3').set(auth(owner));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.data.months[0];
  assert.equal(row.month, ago.format('YYYY-MM'));
  assert.deepEqual([row.ended, row.renewed, row.lost, row.pending, row.retention, row.churn], [3, 1, 2, 0, 33.3, 66.7]);
  assert.equal(r.body.data.totals.pending, 1);
  assert.equal(r.body.data.totals.ended, 4);
  assert.equal(r.body.data.graceDays, 15);
  const wide = await api().get('/api/v1/reports/retention?months=3&graceDays=30').set(auth(owner));
  assert.deepEqual([wide.body.data.months[0].renewed, wide.body.data.months[0].lost], [2, 1]);
  assert.equal((await api().get('/api/v1/reports/retention').set(auth(rec))).status, 403);
});

test('at-risk lists: no visit in N days, expiring in 7 days', async () => {
  const today = startOfDay();
  await Member.updateOne({ _id: m.e._id }, { membershipStatus: 'active', membershipStart: addDays(today, -60), membershipEnd: addDays(today, 30), lastVisitAt: addDays(today, -20), currentPlanName: 'Monthly' });
  await Member.updateOne({ _id: m.f._id }, { membershipStatus: 'active', membershipStart: addDays(today, -27), membershipEnd: addDays(today, 3), lastVisitAt: addDays(today, -1), currentPlanName: 'Monthly' });
  const r = (await api().get('/api/v1/reports/retention?inactiveDays=14').set(auth(owner))).body.data;
  assert.deepEqual(r.atRisk.inactive.map((x) => x.name), ['Member e']);
  assert.equal(r.atRisk.inactive[0].daysAway, 20);
  assert.deepEqual(r.atRisk.expiring.map((x) => x.name), ['Member f']);
  const r30 = (await api().get('/api/v1/reports/retention?inactiveDays=30').set(auth(owner))).body.data;
  assert.equal(r30.atRisk.inactive.length, 0);
  const x = await api().get('/api/v1/reports/retention?export=xlsx').set(auth(owner));
  assert.match(x.headers['content-type'], /spreadsheetml/);
});

test('send reminder respects the gym channel switches and sends once a day', async () => {
  const send = (memberId, reason) => api().post('/api/v1/reports/retention/remind').set(auth(owner)).send({ memberId, reason });
  const off = await send(m.e._id, 'inactive');
  assert.equal(off.status, 400);
  assert.equal(off.body.code, 'CHANNELS_OFF');
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { channels: { sms: true } } });
  const ok = await send(m.e._id, 'inactive');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data, { sent: 1, channels: ['sms'] });
  const n = await Notification.findOne({ template: 'miss_you' }).lean();
  assert.match(n.body, /not seen you at Test Gym for 20 days/);
  assert.equal((await send(m.e._id, 'inactive')).status, 409);
  const exp = await send(m.f._id, 'expiring');
  assert.equal(exp.status, 200);
  assert.ok(await Notification.exists({ template: 'renewal_reminder', memberId: m.f._id }));
});
