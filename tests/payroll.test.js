import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { StaffAttendance } from '../src/modules/staff/staff.model.js';
import { PtSession } from '../src/modules/pt/pt.model.js';
import { Expense } from '../src/modules/expenses/expense.model.js';
import { workingDaysIn } from '../src/modules/payroll/payroll.service.js';
import mongoose from 'mongoose';

let ctx;
let owner;
let rec;
let trainer;
const MONTH = '2026-09'; // 30 days, 4 Sundays -> 26 working days

before(async () => {
  ctx = await setupDb();
  [owner, rec, trainer] = await Promise.all([login('owner@t.com'), login('rec@t.com'), login('trainer@t.com')]);
  // Receptionist: monthly 26,000; trainer: 500/day + PT commission
  await User.updateOne({ _id: ctx.reception._id }, { salary: { type: 'monthly', amount: 2600000 } });
  await User.updateOne({ _id: ctx.trainer._id }, { salary: { type: 'per-day', amount: 50000 } });
  const days = (n) => [...Array(n)].map((_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
  for (const day of days(20)) await StaffAttendance.create({ userId: ctx.reception._id, branchId: ctx.main._id, day, checkInAt: new Date(`${day}T04:00:00Z`), method: 'manual' });
  for (const day of days(10)) await StaffAttendance.create({ userId: ctx.trainer._id, branchId: ctx.main._id, day, checkInAt: new Date(`${day}T04:00:00Z`), method: 'manual' });
  const oid = () => new mongoose.Types.ObjectId();
  await PtSession.create({ ptPurchaseId: oid(), memberId: oid(), trainerId: ctx.trainer._id, branchId: ctx.main._id, at: new Date(`${MONTH}-15T05:00:00Z`), commission: 36000 });
});
after(teardown);

test('working days exclude Sundays', () => {
  assert.equal(workingDaysIn(MONTH, [0]), 26);
  assert.equal(workingDaysIn(MONTH, []), 30);
});

test('only payroll managers can set salaries and run payroll', async () => {
  const r = await api().put(`/api/v1/users/${ctx.trainer._id}`).set(auth(rec)).send({ salary: { type: 'monthly', amount: 1 } });
  assert.equal(r.status, 403);
  assert.equal((await api().post('/api/v1/payroll/generate').set(auth(rec)).send({ month: MONTH })).status, 403);
  const list = await api().get('/api/v1/users').set(auth(owner));
  assert.ok(list.body.data.some((u) => u.salary?.amount === 2600000));
});

test('generate payroll: attendance proration, per-day pay and PT commission', async () => {
  const g = await api().post('/api/v1/payroll/generate').set(auth(owner)).send({ month: MONTH });
  assert.equal(g.body.data.created, 2);
  const list = await api().get(`/api/v1/payroll?month=${MONTH}`).set(auth(owner));
  const recSlip = list.body.data.items.find((p) => p.userId.name === 'Rec');
  const trSlip = list.body.data.items.find((p) => p.userId.name === 'Trainer');
  assert.equal(recSlip.basePay, 2000000); // 26,000 x 20/26
  assert.equal(trSlip.basePay, 500000); // 500 x 10 days
  assert.equal(trSlip.ptCommission, 36000);
  assert.equal(trSlip.netPay, 536000);
});

test('edit draft (leave, bonus, advance), finalize, pay -> salary expense', async () => {
  const list = await api().get(`/api/v1/payroll?month=${MONTH}`).set(auth(owner));
  const slip = list.body.data.items.find((p) => p.userId.name === 'Rec');
  const e = await api()
    .put(`/api/v1/payroll/${slip._id}`)
    .set(auth(owner))
    .send({ paidLeaveDays: 2, additions: [{ label: 'Bonus', amount: 100000 }], deductions: [{ label: 'Advance', amount: 300000 }] });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  // 26,000 x 22/26 = 22,000 + 1,000 - 3,000 = 20,000
  assert.equal(e.body.data.basePay, 2200000);
  assert.equal(e.body.data.netPay, 2000000);

  assert.equal((await api().post(`/api/v1/payroll/${slip._id}/pay`).set(auth(owner)).send({ mode: 'bank' })).status, 400);
  assert.equal((await api().post(`/api/v1/payroll/${slip._id}/finalize`).set(auth(owner))).status, 200);
  assert.equal((await api().put(`/api/v1/payroll/${slip._id}`).set(auth(owner)).send({ additions: [] })).status, 400);
  // Regenerating does not touch finalized slips
  const g = await api().post('/api/v1/payroll/generate').set(auth(owner)).send({ month: MONTH });
  assert.equal(g.body.data.locked, 1);

  const pay = await api().post(`/api/v1/payroll/${slip._id}/pay`).set(auth(owner)).send({ mode: 'bank', reference: 'NEFT123' });
  assert.equal(pay.body.data.status, 'paid');
  const exp = await Expense.findById(pay.body.data.expenseId);
  assert.equal(exp.category, 'salary');
  assert.equal(exp.amount, 2000000);

  const pdf = await api().get(`/api/v1/payroll/${slip._id}/pdf`).set(auth(owner));
  assert.equal(pdf.headers['content-type'], 'application/pdf');
});

test('staff see only their own finalized payslips', async () => {
  const mine = await api().get('/api/v1/payroll/mine').set(auth(rec));
  assert.equal(mine.body.data.length, 1);
  assert.equal((await api().get('/api/v1/payroll/mine').set(auth(trainer))).body.data.length, 0); // still draft
  assert.equal((await api().get(`/api/v1/payroll/mine/${mine.body.data[0]._id}/pdf`).set(auth(rec))).status, 200);
  assert.equal((await api().get(`/api/v1/payroll/mine/${mine.body.data[0]._id}/pdf`).set(auth(trainer))).status, 404);
});
