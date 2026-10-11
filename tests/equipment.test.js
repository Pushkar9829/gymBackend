import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Expense } from '../src/modules/expenses/expense.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { equipmentServiceAlerts } from '../src/modules/equipment/equipment.routes.js';
import { addDays, ymd } from '../src/utils/dates.js';

let ctx;
let owner;
let rec;
let treadmill;

before(async () => {
  ctx = await setupDb();
  [owner, rec] = await Promise.all([login('owner@t.com'), login('rec@t.com')]);
});
after(teardown);

test('owner registers equipment; next service date is computed', async () => {
  assert.equal((await api().post('/api/v1/equipment').set(auth(rec)).send({ branchId: String(ctx.main._id), name: 'X' })).status, 403);
  const r = await api()
    .post('/api/v1/equipment')
    .set(auth(owner))
    .send({ branchId: String(ctx.main._id), name: 'Treadmill #1', category: 'cardio', brand: 'Life Fitness', lastServiceAt: ymd(addDays(new Date(), -88)), serviceIntervalDays: 90, cost: 25000000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  treadmill = r.body.data;
  assert.equal(ymd(treadmill.nextServiceDue), ymd(addDays(new Date(), 2)));
});

test('service due alert from the daily job (once)', async () => {
  assert.equal(await equipmentServiceAlerts(), 1);
  assert.equal(await equipmentServiceAlerts(), 0);
  const list = await api().get('/api/v1/equipment?due=true').set(auth(rec));
  assert.equal(list.body.data.items.length, 1);
});

test('receptionist reports an issue -> needs repair + alert; cannot log a repair', async () => {
  const r = await api().post(`/api/v1/equipment/${treadmill._id}/logs`).set(auth(rec)).send({ type: 'issue-reported', notes: 'Belt slipping', statusAfter: 'out-of-order' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.equipment.status, 'out-of-order');
  assert.ok(await Notification.exists({ template: 'equipment-issue' }));
  assert.equal((await api().post(`/api/v1/equipment/${treadmill._id}/logs`).set(auth(rec)).send({ type: 'repair', cost: 100 })).status, 403);
});

test('owner logs service with cost -> working again, maintenance expense, next service moved', async () => {
  const r = await api().post(`/api/v1/equipment/${treadmill._id}/logs`).set(auth(owner)).send({ type: 'service', cost: 350000, vendor: 'FitServe', notes: 'Belt replaced' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.equipment.status, 'working');
  assert.equal(ymd(r.body.data.equipment.nextServiceDue), ymd(addDays(new Date(), 90)));
  const exp = await Expense.findById(r.body.data.log.expenseId);
  assert.equal(exp.category, 'maintenance');
  assert.equal(exp.amount, 350000);
  const logs = await api().get(`/api/v1/equipment/${treadmill._id}/logs`).set(auth(rec));
  assert.equal(logs.body.data.total, 2);
});
