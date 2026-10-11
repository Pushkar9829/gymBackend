import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Subscription } from '../src/modules/subscriptions/subscription.model.js';
import { Invoice } from '../src/modules/invoices/invoice.model.js';

let ctx;
let owner;
let rec;
let couple;
const m = {};

const newMember = async (name, phone, extra = {}) =>
  (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name, phone, ...extra })).body.data;

before(async () => {
  ctx = await setupDb();
  [owner, rec] = await Promise.all([login('owner@t.com'), login('rec@t.com')]);
  couple = (await api().post('/api/v1/plans').set(auth(owner)).send({ name: 'Couple Monthly', durationValue: 1, durationUnit: 'month', price: 180000, maxMembers: 2 })).body.data;
  m.a = await newMember('Husband', '9800100001');
  m.b = await newMember('Wife', '9800100002');
  m.c = await newMember('Friend', '9800100003');
});
after(teardown);

test('family plan: one bill, both members get access', async () => {
  const tooMany = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m.a._id, planId: couple._id, familyMemberIds: [m.b._id, m.c._id] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.message, /at most 2/);

  const r = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: m.a._id, planId: couple._id, familyMemberIds: [m.b._id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.subscription.totalAmount, 212400); // 1800 + 18%
  assert.match(r.body.data.invoice.items[0].description, /Husband .*Wife/);

  const wife = await Subscription.findOne({ memberId: m.b._id }).lean();
  assert.equal(String(wife.groupOf), r.body.data.subscription._id);
  assert.equal(wife.totalAmount, 0);
  const ci = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: m.b._id });
  assert.equal(ci.body.data.allowed, true);
});

test('family plans cannot be changed; cancelling cancels everyone', async () => {
  const primary = await Subscription.findOne({ memberId: m.a._id });
  const change = await api().post(`/api/v1/subscriptions/${primary._id}/change-plan`).set(auth(owner)).send({ planId: String(ctx.monthly._id) });
  assert.equal(change.status, 400);
  await api().post(`/api/v1/subscriptions/${primary._id}/cancel`).set(auth(owner)).send({ reason: 'Moving' });
  const ci = await api().post('/api/v1/attendance/check-in').set(auth(rec)).send({ memberId: m.b._id });
  assert.equal(ci.body.data.allowed, false);
});

test('corporate: auto discount, company-billed invoice and statement', async () => {
  const co = await api().post('/api/v1/companies').set(auth(owner)).send({ name: 'Acme Tech', gstin: '29ABCDE1234F1Z5', discountPercent: 10, billTo: 'company' });
  assert.equal(co.status, 201);
  assert.equal((await api().post('/api/v1/companies').set(auth(rec)).send({ name: 'Nope' })).status, 403);

  const emp = await newMember('Employee', '9800100004', { companyId: co.body.data._id });
  const r = await api().post('/api/v1/subscriptions').set(auth(rec)).send({ memberId: emp._id, planId: String(ctx.monthly._id) });
  // (1000 + 200 joining) = 1200 - 10% = 1080 + 18% = 1274.40
  assert.equal(r.body.data.subscription.companyDiscount, 12000);
  assert.equal(r.body.data.subscription.totalAmount, 127440);
  assert.equal(r.body.data.subscription.billTo, 'company');
  const inv = await Invoice.findById(r.body.data.invoice._id).lean();
  assert.equal(inv.billedTo.name, 'Acme Tech');
  assert.match(inv.billedTo.address, /GSTIN: 29ABCDE1234F1Z5/);

  const st = await api().get(`/api/v1/companies/${co.body.data._id}/statement`).set(auth(owner));
  assert.equal(st.body.data.members.length, 1);
  assert.equal(st.body.data.totals.due, 127440);
  const list = await api().get('/api/v1/companies').set(auth(rec));
  assert.equal(list.body.data[0].members, 1);
});
