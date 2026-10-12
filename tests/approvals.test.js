import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { DiscountApproval } from '../src/modules/approvals/approval.model.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

let ctx;
let owner;
let rec;
let trainer;
let manager;
const m = {};
let main;

const newMember = async (name, phone) => (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: main, name, phone })).body.data;
const sell = (token, body) => api().post('/api/v1/subscriptions').set(auth(token)).send({ planId: String(ctx.monthly._id), ...body });
const request = (body, token = rec) => api().post('/api/v1/approvals').set(auth(token)).send({ kind: 'subscription', planId: String(ctx.monthly._id), reason: 'Long time member', ...body });

before(async () => {
  ctx = await setupDb();
  main = String(ctx.main._id);
  await User.create({ name: 'Manny', email: 'mgr@t.com', role: 'manager', passwordHash: await hashPassword('Password@1'), branchIds: [ctx.main._id] });
  [owner, rec, trainer, manager] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com'), login('mgr@t.com')]);
  for (const [k, phone] of [['a', '9310000001'], ['b', '9310000002'], ['c', '9310000003'], ['d', '9310000004'], ['e', '9310000005'], ['f', '9310000006']]) m[k] = await newMember(`Member ${k.toUpperCase()}`, phone);
});
after(teardown);

// Monthly plan: Rs 1000 + Rs 200 joining = Rs 1200 list price; 10% = Rs 120.
test('reception may give up to the limit; above it the API asks for approval', async () => {
  const ok = await sell(rec, { memberId: m.a._id, discount: 12000 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.subscription.manualDiscount, 12000);
  const over = await sell(rec, { memberId: m.b._id, discount: 12001 });
  assert.equal(over.status, 403);
  assert.equal(over.body.code, 'DISCOUNT_APPROVAL_REQUIRED');
  assert.match(over.body.message, /above 10%.*Rs\. 120\.00/);
  // Owner and manager are never blocked.
  assert.equal((await sell(owner, { memberId: m.c._id, discount: 60000 })).status, 201);
  assert.equal((await sell(manager, { memberId: m.d._id, discount: 60000 })).status, 201);
});

test('the limit follows the setting', async () => {
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { discountLimitPercent: 20 } });
  const r = await api().post('/api/v1/pt/packages').set(auth(owner)).send({ name: '10 sessions', sessions: 10, validityDays: 30, price: 500000 });
  const pkg = r.body.data;
  const ptSell = (discount, extra = {}) => api().post('/api/v1/pt/purchases').set(auth(rec)).send({ memberId: m.a._id, packageId: pkg._id, trainerId: String(ctx.trainer._id), discount, ...extra });
  assert.equal((await ptSell(100001)).body.code, 'DISCOUNT_APPROVAL_REQUIRED'); // > 20% of Rs 5000
  assert.equal((await ptSell(100000)).status, 201);
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { discountLimitPercent: 10 } });
});

let reqB;
test('request -> owner/manager alert -> approve; usable once for the same member and item', async () => {
  assert.equal((await request({ memberId: m.b._id, discount: 30000 }, trainer)).status, 403);
  const tooMuch = await request({ memberId: m.b._id, discount: 999999 });
  assert.match(tooMuch.body.message, /cannot exceed/);
  const r = await request({ memberId: m.b._id, discount: 30000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  reqB = r.body.data;
  assert.deepEqual([reqB.status, reqB.listPrice, reqB.requestedDiscount, reqB.itemKey], ['pending', 120000, 30000, `plan:${ctx.monthly._id}`]);
  // The alert is for owner/manager only.
  const alert = await Notification.findOne({ template: 'discount-approval' }).lean();
  assert.deepEqual(alert.roles, ['owner', 'manager']);
  const recBell = await api().get('/api/v1/notifications').set(auth(rec));
  assert.ok(!recBell.body.data.items.some((n) => n.template === 'discount-approval'));
  const ownerBell = await api().get('/api/v1/notifications').set(auth(owner));
  assert.ok(ownerBell.body.data.items.some((n) => n.template === 'discount-approval'));

  const pending = await sell(rec, { memberId: m.b._id, discount: 30000, approvalId: reqB._id });
  assert.equal(pending.body.code, 'APPROVAL_INVALID');
  assert.match(pending.body.message, /waiting/);
  assert.equal((await api().post(`/api/v1/approvals/${reqB._id}/approve`).set(auth(rec)).send({})).status, 403);

  const list = await api().get('/api/v1/approvals?status=pending').set(auth(owner));
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.pending, 1);
  const dash = await api().get('/api/v1/reports/dashboard').set(auth(owner));
  assert.equal(dash.body.data.approvals.pending, 1);
  assert.equal((await api().get('/api/v1/reports/dashboard').set(auth(rec))).body.data.approvals, null);

  const ok = await api().post(`/api/v1/approvals/${reqB._id}/approve`).set(auth(manager)).send({ note: 'Fine this once' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'approved');
  assert.equal(ok.body.data.decidedBy.name, 'Manny');
  const hours = (new Date(ok.body.data.expiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24);
  assert.equal((await api().post(`/api/v1/approvals/${reqB._id}/reject`).set(auth(owner)).send({})).status, 400); // already decided
  assert.ok(await Notification.exists({ template: 'discount-approved', roles: 'receptionist' }));

  const usable = await api().get(`/api/v1/approvals/usable?kind=subscription&memberId=${m.b._id}`).set(auth(rec));
  assert.equal(usable.body.data.length, 1);
  const mine = await api().get(`/api/v1/approvals/${reqB._id}`).set(auth(rec));
  assert.equal(mine.body.data.state, 'approved');

  const otherMember = await sell(rec, { memberId: m.e._id, discount: 30000, approvalId: reqB._id });
  assert.match(otherMember.body.message, /different member or item/);
  const more = await sell(rec, { memberId: m.b._id, discount: 30001, approvalId: reqB._id });
  assert.match(more.body.message, /up to Rs\. 300\.00/);
  const done = await sell(rec, { memberId: m.b._id, discount: 30000, approvalId: reqB._id });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(String(done.body.data.subscription.approvalId), reqB._id);
  assert.equal(done.body.data.subscription.manualDiscount, 30000);
  const used = await DiscountApproval.findById(reqB._id).lean();
  assert.equal(used.status, 'used');
  assert.equal(String(used.usedOn.id), done.body.data.subscription._id);
  const reuse = await sell(rec, { memberId: m.b._id, discount: 30000, approvalId: reqB._id });
  assert.match(reuse.body.message, /already used/);
});

test('expired and rejected approvals cannot be used', async () => {
  const r1 = (await request({ memberId: m.e._id, discount: 40000 })).body.data;
  await api().post(`/api/v1/approvals/${r1._id}/approve`).set(auth(owner)).send({ approvedDiscount: 35000 });
  const lower = await sell(rec, { memberId: m.e._id, discount: 40000, approvalId: r1._id });
  assert.match(lower.body.message, /up to Rs\. 350\.00/); // owner approved less than asked
  await DiscountApproval.updateOne({ _id: r1._id }, { expiresAt: new Date(Date.now() - 1000) });
  const expired = await sell(rec, { memberId: m.e._id, discount: 35000, approvalId: r1._id });
  assert.match(expired.body.message, /expired/);
  const listExpired = await api().get('/api/v1/approvals?status=expired').set(auth(owner));
  assert.equal(listExpired.body.data.items[0].state, 'expired');

  const r2 = (await request({ memberId: m.f._id, discount: 40000 })).body.data;
  const rej = await api().post(`/api/v1/approvals/${r2._id}/reject`).set(auth(owner)).send({ note: 'Too much' });
  assert.equal(rej.body.data.status, 'rejected');
  const useRejected = await sell(rec, { memberId: m.f._id, discount: 40000, approvalId: r2._id });
  assert.match(useRejected.body.message, /rejected/);
  // Reception sees only their own requests.
  const mine = await api().get('/api/v1/approvals').set(auth(rec));
  assert.ok(mine.body.data.items.every((a) => a.requestedBy.name === 'Rec'));
});

test('shop: approval is tied to the cart; a failed sale gives the approval back', async () => {
  const p = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Shaker', price: 10000, taxPercent: 18 })).body.data;
  await api().post(`/api/v1/shop/products/${p._id}/stock`).set(auth(owner)).send({ branchId: main, qty: 3, type: 'purchase' });
  const cart = (qty) => [{ productId: p._id, qty }];
  const sale = (body) => api().post('/api/v1/shop/sales').set(auth(rec)).send({ branchId: main, mode: 'cash', ...body });
  assert.equal((await sale({ items: cart(2), discount: 2000 })).status, 201); // 10%
  const over = await sale({ items: cart(1), discount: 5000 });
  assert.equal(over.body.code, 'DISCOUNT_APPROVAL_REQUIRED');
  const big = (await request({ kind: 'shop', branchId: main, items: cart(5), discount: 20000, memberId: undefined, planId: undefined })).body.data;
  assert.equal(big.listPrice, 50000);
  await api().post(`/api/v1/approvals/${big._id}/approve`).set(auth(owner)).send({});
  const noStock = await sale({ items: cart(5), discount: 20000, approvalId: big._id });
  assert.match(noStock.body.message, /Not enough stock/);
  assert.equal((await DiscountApproval.findById(big._id).lean()).status, 'approved'); // released
  const small = (await request({ kind: 'shop', branchId: main, items: cart(1), discount: 5000, memberId: undefined, planId: undefined })).body.data;
  await api().post(`/api/v1/approvals/${small._id}/approve`).set(auth(owner)).send({});
  assert.match((await sale({ items: cart(1), discount: 5000, approvalId: big._id })).body.message, /different member or item/);
  const ok = await sale({ items: cart(1), discount: 5000, approvalId: small._id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(String(ok.body.data.approvalId), small._id);
});

test('every step is in the audit log', async () => {
  for (const action of ['discount.request', 'discount.approve', 'discount.reject', 'discount.use']) assert.ok(await AuditLog.exists({ action }), action);
});
