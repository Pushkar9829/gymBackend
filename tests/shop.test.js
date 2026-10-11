import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Stock, StockMovement } from '../src/modules/shop/shop.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';

let ctx;
let owner;
let rec;
let whey;
let bottle;
let saleId;

before(async () => {
  ctx = await setupDb();
  [owner, rec] = await Promise.all([login('owner@t.com'), login('rec@t.com')]);
});
after(teardown);

test('owner adds products; receptionist cannot', async () => {
  assert.equal((await api().post('/api/v1/shop/products').set(auth(rec)).send({ name: 'X', price: 100 })).status, 403);
  whey = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Whey 1kg', sku: 'WHEY1', category: 'supplement', price: 200000, costPrice: 150000, taxPercent: 18, lowStockAt: 2 })).body.data;
  bottle = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Shaker', category: 'accessory', price: 30000, costPrice: 10000, taxPercent: 12 })).body.data;
  assert.ok(whey._id && bottle._id);
});

test('stock in per branch', async () => {
  const r = await api().post(`/api/v1/shop/products/${whey._id}/stock`).set(auth(owner)).send({ branchId: String(ctx.main._id), qty: 4, type: 'purchase', unitCost: 155000 });
  assert.equal(r.body.data.qty, 4);
  await api().post(`/api/v1/shop/products/${bottle._id}/stock`).set(auth(owner)).send({ branchId: String(ctx.main._id), qty: 10, type: 'purchase' });
  assert.equal((await api().post(`/api/v1/shop/products/${whey._id}/stock`).set(auth(owner)).send({ branchId: String(ctx.main._id), qty: -1, type: 'purchase' })).status, 400);
  const list = await api().get('/api/v1/shop/products').set(auth(rec));
  assert.equal(list.body.data.find((p) => p.name === 'Whey 1kg').stock, 4);
});

test('POS sale: GST per item, discount, stock goes down, low-stock alert', async () => {
  const m = (await api().post('/api/v1/members').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'Buyer', phone: '9000000001' })).body.data;
  const r = await api()
    .post('/api/v1/shop/sales')
    .set(auth(rec))
    .send({ branchId: String(ctx.main._id), memberId: m._id, items: [{ productId: whey._id, qty: 2 }, { productId: bottle._id, qty: 1 }], discount: 0, mode: 'upi' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  saleId = r.body.data._id;
  // 4000 + 18% = 720 ; 300 + 12% = 36 -> 4300 + 756 = 5056
  assert.equal(r.body.data.subTotal, 430000);
  assert.equal(r.body.data.taxAmount, 75600);
  assert.equal(r.body.data.total, 505600);
  assert.equal(r.body.data.cost, 155000 * 2 + 10000);
  assert.equal((await Stock.findOne({ productId: whey._id })).qty, 2);
  assert.equal(await StockMovement.countDocuments({ saleId }), 2);
  assert.ok(await Notification.exists({ template: 'low-stock' }));
});

test('cannot sell more than in stock; nothing is taken on failure', async () => {
  const r = await api().post('/api/v1/shop/sales').set(auth(rec)).send({ branchId: String(ctx.main._id), items: [{ productId: bottle._id, qty: 1 }, { productId: whey._id, qty: 5 }], mode: 'cash' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Not enough stock for Whey/);
  assert.equal((await Stock.findOne({ productId: bottle._id })).qty, 9); // rolled back
});

test('sales list summary, receipt PDF, refund restores stock; P&L includes shop profit', async () => {
  const list = await api().get('/api/v1/shop/sales').set(auth(owner));
  assert.equal(list.body.data.summary.count, 1);
  assert.equal(list.body.data.summary.profit, 430000 - 320000);
  assert.equal((await api().get(`/api/v1/shop/sales/${saleId}/receipt.pdf`).set(auth(rec))).status, 200);

  const pnl = await api().get('/api/v1/reports/pnl').set(auth(owner));
  assert.equal(pnl.body.data.shopProfit, 110000);

  assert.equal((await api().post(`/api/v1/shop/sales/${saleId}/refund`).set(auth(rec)).send({ reason: 'Wrong flavour' })).status, 403);
  const r = await api().post(`/api/v1/shop/sales/${saleId}/refund`).set(auth(owner)).send({ reason: 'Wrong flavour' });
  assert.equal(r.body.data.status, 'refunded');
  assert.equal((await Stock.findOne({ productId: whey._id })).qty, 4);
  assert.equal((await api().post(`/api/v1/shop/sales/${saleId}/refund`).set(auth(owner)).send({ reason: 'again' })).status, 400);
});
