import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { countDenominations, cashMath } from '../src/modules/cash/cash.service.js';
import { addDays, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let otherRec;
let member;
let cashPayment;
const today = ymd(new Date());
const daysAgo = (n) => ymd(addDays(new Date(), -n));

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer, otherRec] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com'), login('rec2@t.com')]);
  const main = String(ctx.main._id);
  member = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: main, name: 'Cash Member', phone: '9300000001' })).body.data;
  // Membership: Rs 500 cash now + Rs 200 UPI later.
  const sub = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: member._id, planId: String(ctx.monthly._id), payment: { amount: 50000, mode: 'cash' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  cashPayment = sub.body.data.payment;
  await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub.body.data.subscription._id, amount: 20000, mode: 'upi' });
  // Shop: Rs 100 + 12% = Rs 112 cash
  const p = await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Bar', price: 10000, taxPercent: 12 });
  await api().post(`/api/v1/shop/products/${p.body.data._id}/stock`).set(auth(owner)).send({ branchId: main, qty: 10, type: 'purchase' });
  const sale = await api().post('/api/v1/shop/sales').set(auth(rec)).send({ branchId: main, items: [{ productId: p.body.data._id, qty: 1 }], mode: 'cash' });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  // Locker: Rs 300 rent + Rs 500 deposit in cash
  await api().post('/api/v1/lockers/bulk').set(auth(owner)).send({ branchId: main, prefix: 'L', from: 1, to: 1, monthlyFee: 30000 });
  const lockers = (await api().get('/api/v1/lockers').set(auth(owner))).body.data.items;
  const allot = await api().post(`/api/v1/lockers/${lockers[0]._id}/allot`).set(auth(rec)).send({ memberId: member._id, months: 1, rent: 30000, deposit: 50000, mode: 'cash' });
  assert.equal(allot.status, 201, JSON.stringify(allot.body));
  // Out: Rs 30 cash expense, Rs 50 cash refund
  await api().post('/api/v1/expenses').set(auth(rec)).send({ branchId: main, category: 'cleaning', amount: 3000, date: today, mode: 'cash' });
  await api().post('/api/v1/expenses').set(auth(rec)).send({ branchId: main, category: 'internet', amount: 99900, date: today, mode: 'bank' });
  const refund = await api().post(`/api/v1/payments/${cashPayment._id}/refund`).set(auth(owner)).send({ amount: 5000, mode: 'cash', reason: 'Overcharged' });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
});
after(teardown);

// cash in: 50000 + 11200 + 30000 + 50000 = 141200; out: 3000 + 5000 = 8000
const EXPECTED = 133200;

test('cash math and note counting', () => {
  assert.equal(countDenominations({ n500: 2, n200: 1, n100: 3, n50: 1, n20: 2, n10: 1, coins: 750 }), 100000 + 20000 + 30000 + 5000 + 4000 + 1000 + 750);
  assert.deepEqual(cashMath({ openingFloat: 1000, byMode: { cash: { in: 5000, out: 2000 } }, countedCash: 3500 }), { cashIn: 5000, cashOut: 2000, expectedCash: 4000, difference: -500 });
});

test('day figures by source and mode; who may see them', async () => {
  assert.equal((await api().get('/api/v1/cash/day').set(auth(trainer))).status, 403);
  const r = await api().get('/api/v1/cash/day').set(auth(rec));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.day, today);
  assert.equal(d.cashIn, 141200);
  assert.equal(d.cashOut, 8000);
  assert.equal(d.expectedCash, EXPECTED);
  assert.equal(d.figures.byMode.upi.in, 20000);
  assert.equal(d.figures.byMode.bank.out, 99900);
  const src = (key, mode) => d.figures.sources.find((s) => s.key === key && s.mode === mode);
  assert.deepEqual([src('payments', 'cash').in, src('payments', 'cash').out], [50000, 5000]);
  assert.equal(src('shop', 'cash').in, 11200);
  assert.equal(src('lockers', 'cash').in, 80000);
  assert.equal(src('expenses', 'cash').out, 3000);
  assert.equal(d.closing, null);
  // Reception works on today only; other branches are off limits.
  assert.equal((await api().get(`/api/v1/cash/day?day=${daysAgo(1)}`).set(auth(rec))).status, 403);
  assert.equal((await api().get(`/api/v1/cash/day?branchId=${ctx.main._id}`).set(auth(otherRec))).status, 403);
  // Owner sees two branches: must pick one.
  const pick = await api().get('/api/v1/cash/day').set(auth(owner));
  assert.equal(pick.status, 400);
  assert.match(pick.body.message, /Choose a branch/);
});

test('closing with a shortfall needs a note, raises an alert and locks the day', async () => {
  const send = (b, token = rec) => api().post('/api/v1/cash/close').set(auth(token)).send(b);
  const noNote = await send({ countedCash: EXPECTED - 25000 });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.message, /short by Rs\. 250\.00/);
  const r = await send({ countedCash: EXPECTED - 25000, note: 'Gave change twice by mistake' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.difference, -25000);
  assert.equal(r.body.data.expectedCash, EXPECTED);
  assert.equal(r.body.data.status, 'closed');
  const alert = await Notification.findOne({ template: 'cash-short' }).lean();
  assert.match(alert.subject, /Cash short by Rs\. 250\.00/);
  const again = await send({ countedCash: EXPECTED });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already closed/);
  const day = await api().get('/api/v1/cash/day').set(auth(rec));
  assert.equal(day.body.data.closing.closedBy.name, 'Rec');
  assert.equal(day.body.data.canReopen, false);
  const dash = await api().get('/api/v1/reports/dashboard').set(auth(rec));
  assert.deepEqual([dash.body.data.dayClose.closed, dash.body.data.dayClose.total, dash.body.data.dayClose.difference], [1, 1, -25000]);
  const ownerDash = await api().get('/api/v1/reports/dashboard').set(auth(owner));
  assert.deepEqual([ownerDash.body.data.dayClose.closed, ownerDash.body.data.dayClose.total], [1, 2]);
});

test('only owner/manager reopen, with a reason; then the day can be closed again by notes', async () => {
  const closing = (await api().get('/api/v1/cash/day').set(auth(rec))).body.data.closing;
  assert.equal((await api().post(`/api/v1/cash/${closing._id}/reopen`).set(auth(rec)).send({ reason: 'Recount' })).status, 403);
  assert.equal((await api().post(`/api/v1/cash/${closing._id}/reopen`).set(auth(owner)).send({})).status, 400);
  const r = await api().post(`/api/v1/cash/${closing._id}/reopen`).set(auth(owner)).send({ reason: 'Found Rs 250 in the cash box' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'reopened');
  assert.ok(await AuditLog.exists({ action: 'cash.reopen', entityId: closing._id }));
  assert.equal((await api().post(`/api/v1/cash/${closing._id}/reopen`).set(auth(owner)).send({ reason: 'Again' })).status, 400);

  // 2 x 500 + 3 x 100 + 20 + 10 + Rs 2 in coins = Rs 1332 exactly: no note needed.
  const again = await api().post('/api/v1/cash/close').set(auth(rec)).send({ denominations: { n500: 2, n100: 3, n20: 1, n10: 1, coins: 200 }, floatKept: 2000, statement: { upi: 19000 } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.data.countedCash, EXPECTED);
  assert.equal(again.body.data.difference, 0);
  assert.equal(again.body.data.closeCount, 2);
  const reopened = await api().post(`/api/v1/cash/${again.body.data._id}/reopen`).set(auth(owner)).send({ reason: 'test float' });
  assert.equal(reopened.status, 200);
  const bad = await api().post('/api/v1/cash/close').set(auth(rec)).send({ countedCash: 100, floatKept: 200, note: 'x' });
  assert.match(bad.body.message, /Float kept/);
  await api().post('/api/v1/cash/close').set(auth(rec)).send({ denominations: { n500: 2, n100: 3, n20: 1, n10: 1, coins: 200 }, floatKept: 2000, statement: { upi: 19000 } });

  const day = (await api().get('/api/v1/cash/day').set(auth(rec))).body.data;
  const upi = day.statement.find((s) => s.mode === 'upi');
  assert.deepEqual([upi.system, upi.statement, upi.difference], [20000, 19000, -1000]);
  assert.equal(day.changedSinceClose, null);
});

test('money recorded after closing is flagged', async () => {
  const sub = (await api().get(`/api/v1/subscriptions?memberId=${member._id}`).set(auth(rec))).body.data.items[0];
  await api().post('/api/v1/payments').set(auth(rec)).send({ subscriptionId: sub._id, amount: 1000, mode: 'cash' });
  const day = (await api().get('/api/v1/cash/day').set(auth(rec))).body.data;
  assert.equal(day.changedSinceClose.cash, 1000);
  assert.equal(day.closing.expectedCash, EXPECTED); // snapshot kept
});

test('owner closes past days; the float kept carries forward as the next opening', async () => {
  const close = (b) => api().post('/api/v1/cash/close').set(auth(owner)).send({ branchId: String(ctx.main._id), ...b });
  const future = await close({ day: ymd(addDays(new Date(), 1)), countedCash: 0 });
  assert.equal(future.status, 400);
  const d3 = await close({ day: daysAgo(3), countedCash: 0, openingFloat: 5000, note: 'Petty cash used' });
  assert.equal(d3.status, 201, JSON.stringify(d3.body));
  assert.equal(d3.body.data.difference, -5000); // below the Rs 100 alert limit
  const d2 = await close({ day: daysAgo(2), openingFloat: 0, countedCash: 5000, floatKept: 5000, note: 'Owner added float' });
  assert.equal(d2.body.data.difference, 5000);
  const view = await api().get(`/api/v1/cash/day?day=${daysAgo(1)}&branchId=${ctx.main._id}`).set(auth(owner));
  assert.deepEqual(view.body.data.opening, { suggested: 5000, fromDay: daysAgo(2) });
  const d1 = await close({ day: daysAgo(1), openingFloat: 5000, countedCash: 0, note: 'Cash missing' });
  assert.equal(d1.body.data.difference, -5000);
  assert.equal(await Notification.countDocuments({ template: 'cash-short' }), 1); // Rs 50 short: no new alert
  const big = await api().post(`/api/v1/cash/${d1.body.data._id}/reopen`).set(auth(owner)).send({ reason: 'Recount' });
  assert.equal(big.status, 200);
  await close({ day: daysAgo(1), openingFloat: 50000, countedCash: 0, note: 'Drawer empty' });
  assert.equal(await Notification.countDocuments({ template: 'cash-short' }), 2);
});

test('closing history: filters, totals, Excel; reception cannot open it', async () => {
  assert.equal((await api().get('/api/v1/cash/closings').set(auth(rec))).status, 403);
  const all = await api().get('/api/v1/cash/closings').set(auth(owner));
  assert.equal(all.body.data.items.length, 4);
  assert.equal(all.body.data.items[0].day, today);
  const short = await api().get('/api/v1/cash/closings?result=short').set(auth(owner));
  assert.deepEqual(short.body.data.items.map((c) => c.day).sort(), [daysAgo(3), daysAgo(1)].sort());
  assert.equal(short.body.data.summary.short, -55000);
  const ranged = await api().get(`/api/v1/cash/closings?from=${daysAgo(2)}&to=${daysAgo(1)}`).set(auth(owner));
  assert.equal(ranged.body.data.items.length, 2);
  const x = await api().get('/api/v1/cash/closings?export=xlsx').set(auth(owner));
  assert.equal(x.status, 200);
  assert.match(x.headers['content-type'], /spreadsheetml/);
  assert.equal((await api().get('/api/v1/cash/closings').set(auth(otherRec))).status, 403);
});
