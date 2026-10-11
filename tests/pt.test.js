import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { addDays } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let trainer;
let member;
let pkg;
let purchase;

before(async () => {
  ctx = await setupDb();
  await User.updateOne({ _id: ctx.trainer._id }, { ptCommissionPercent: 40 });
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
  member = (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'PT Client', phone: '9400000001' })).body.data;
});
after(teardown);

test('owner creates a PT package; receptionist cannot', async () => {
  const body = { name: '3 sessions', sessions: 3, validityDays: 30, price: 300000 };
  assert.equal((await api().post('/api/v1/pt/packages').set(auth(rec)).send(body)).status, 403);
  const r = await api().post('/api/v1/pt/packages').set(auth(owner)).send(body);
  assert.equal(r.status, 201);
  pkg = r.body.data;
});

test('receptionist sells a package with partial payment -> invoice + due', async () => {
  const r = await api()
    .post('/api/v1/pt/purchases')
    .set(auth(rec))
    .send({ memberId: member._id, packageId: pkg._id, trainerId: String(ctx.trainer._id), discount: 30000, payment: { amount: 100000, mode: 'upi' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  purchase = r.body.data.purchase;
  // (3000 - 300) + 18% = 3186
  assert.equal(purchase.totalAmount, 318600);
  assert.equal(purchase.dueAmount, 218600);
  assert.ok(r.body.data.invoice.invoiceNo);
  const pdf = await api().get(`/api/v1/invoices/${r.body.data.invoice._id}/pdf`).set(auth(rec));
  assert.equal(pdf.status, 200);

  const pay = await api().post(`/api/v1/pt/purchases/${purchase._id}/payments`).set(auth(rec)).send({ amount: 218600, mode: 'cash' });
  assert.equal(pay.status, 201);
  const receipt = await api().get(`/api/v1/payments/${pay.body.data.payment._id}/receipt.pdf`).set(auth(rec));
  assert.equal(receipt.status, 200);
});

test('trainer logs sessions until none are left; commission recorded', async () => {
  for (let i = 0; i < 3; i += 1) {
    const r = await api().post(`/api/v1/pt/purchases/${purchase._id}/sessions`).set(auth(trainer)).send({ notes: `Day ${i + 1}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.purchase.sessionsUsed, i + 1);
    // (3000 - 300) / 3 = 900 per session x 40% = 360
    assert.equal(r.body.data.session.commission, 36000);
  }
  const extra = await api().post(`/api/v1/pt/purchases/${purchase._id}/sessions`).set(auth(trainer)).send({});
  assert.equal(extra.status, 400);

  const report = await api().get('/api/v1/pt/commission').set(auth(owner));
  assert.equal(report.body.data[0].sessions, 3);
  assert.equal(report.body.data[0].commission, 108000);
});

test('undo a session gives it back', async () => {
  const list = await api().get(`/api/v1/pt/sessions?purchaseId=${purchase._id}`).set(auth(trainer));
  assert.equal(list.body.data.total, 3);
  assert.equal((await api().delete(`/api/v1/pt/sessions/${list.body.data.items[0]._id}`).set(auth(trainer))).status, 200);
  const p = await api().get(`/api/v1/pt/purchases?memberId=${member._id}`).set(auth(owner));
  assert.equal(p.body.data.items[0].sessionsUsed, 2);
});

test('other trainers cannot see or log on this package', async () => {
  const { hashPassword } = await import('../src/modules/auth/auth.service.js');
  await User.create({ name: 'T2', email: 't2@t.com', role: 'trainer', passwordHash: await hashPassword('Password@1'), branchIds: [ctx.main._id] });
  const t2 = await login('t2@t.com');
  assert.equal((await api().get('/api/v1/pt/purchases').set(auth(t2))).body.data.total, 0);
  assert.equal((await api().post(`/api/v1/pt/purchases/${purchase._id}/sessions`).set(auth(t2)).send({})).status, 404);
});

test('expired package cannot be used', async () => {
  const r = await api()
    .post('/api/v1/pt/purchases')
    .set(auth(owner))
    .send({ memberId: member._id, packageId: pkg._id, trainerId: String(ctx.trainer._id), startDate: addDays(new Date(), -60).toISOString().slice(0, 10) });
  const s = await api().post(`/api/v1/pt/purchases/${r.body.data.purchase._id}/sessions`).set(auth(trainer)).send({});
  assert.equal(s.status, 400);
  assert.match(s.body.message, /valid from/);
});

test('refund on a PT payment re-opens the package due', async () => {
  const pays = await api().get(`/api/v1/payments?memberId=${member._id}`).set(auth(owner));
  const p = pays.body.data.items.find((x) => x.type === 'payment' && x.amount === 218600);
  const r = await api().post(`/api/v1/payments/${p._id}/refund`).set(auth(owner)).send({ amount: 10000, mode: 'cash', reason: 'Goodwill' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const list = await api().get(`/api/v1/pt/purchases?memberId=${member._id}`).set(auth(owner));
  const mine = list.body.data.items.find((x) => x._id === purchase._id);
  assert.equal(mine.dueAmount, 10000);
});

test('member portal shows PT packages and sessions', async () => {
  await api().post(`/api/v1/members/${member._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  const t = (await api().post('/api/v1/auth/member/login').send({ phone: '9400000001', password: 'Member@123' })).body.data.accessToken;
  const r = await api().get('/api/v1/me/pt').set(auth(t));
  assert.equal(r.body.data.purchases.length, 2);
  assert.equal(r.body.data.sessions.length, 2);
});
