import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Member } from '../src/modules/members/member.model.js';

let ctx;
let owner;
let trainer;
let rec;
let member;
let other;
let tpl;

before(async () => {
  ctx = await setupDb();
  [owner, trainer, rec] = await Promise.all([login('owner@t.com'), login('trainer@t.com'), login('rec@t.com')]);
  member = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Fit One', phone: '9300000001' })).body.data;
  other = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Not Mine', phone: '9300000002' })).body.data;
  await Member.updateOne({ _id: member._id }, { trainerId: ctx.trainer._id });
});
after(teardown);

test('starter exercise library loads once', async () => {
  const r = await api().post('/api/v1/fitness/exercises/defaults').set(auth(trainer));
  assert.ok(r.body.data.added > 30);
  const again = await api().post('/api/v1/fitness/exercises/defaults').set(auth(trainer));
  assert.equal(again.body.data.added, 0);
  assert.equal((await api().post('/api/v1/fitness/exercises/defaults').set(auth(rec))).status, 403);
});

test('trainer builds a workout template and assigns it to their client', async () => {
  const r = await api()
    .post('/api/v1/fitness/workout-plans')
    .set(auth(trainer))
    .send({
      name: 'Beginner 3-day split',
      goal: 'muscle-gain',
      days: [
        { name: 'Day 1 - Push', exercises: [{ name: 'Push-up', sets: 3, reps: '12' }, { name: 'Overhead Press', sets: 3, reps: '8-10', weight: '20 kg' }] },
        { name: 'Day 2 - Pull', exercises: [{ name: 'Lat Pulldown', sets: 4, reps: '10' }] },
      ],
    });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tpl = r.body.data;
  const a = await api().post(`/api/v1/fitness/workout-plans/${tpl._id}/assign`).set(auth(trainer)).send({ memberId: member._id });
  assert.equal(a.status, 201);
  assert.equal(a.body.data.memberId, member._id);
  // Assigning again keeps a single active plan
  await api().post(`/api/v1/fitness/workout-plans/${tpl._id}/assign`).set(auth(trainer)).send({ memberId: member._id });
  const list = await api().get(`/api/v1/fitness/workout-plans?memberId=${member._id}`).set(auth(trainer));
  assert.equal(list.body.data.filter((p) => p.isActive).length, 1);
  assert.equal(list.body.data.length, 2);
});

test('trainer cannot touch members who are not their clients', async () => {
  const r = await api().post(`/api/v1/fitness/workout-plans/${tpl._id}/assign`).set(auth(trainer)).send({ memberId: other._id });
  assert.equal(r.status, 404);
  assert.equal((await api().get(`/api/v1/fitness/measurements?memberId=${other._id}`).set(auth(trainer))).status, 404);
});

test('diet plan for a member', async () => {
  const r = await api()
    .post('/api/v1/fitness/diet-plans')
    .set(auth(trainer))
    .send({
      memberId: member._id,
      name: 'Veg 1800 kcal',
      dailyCalories: 1800,
      proteinGrams: 90,
      meals: [{ time: '08:00', name: 'Breakfast', items: [{ food: 'Oats', quantity: '60 g', calories: 230, protein: 8 }] }],
    });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('measurements with BMI, and member logs weight from the app', async () => {
  const m = await api().post('/api/v1/fitness/measurements').set(auth(trainer)).send({ memberId: member._id, date: '2026-09-01', weightKg: 80, heightCm: 175, waistCm: 90 });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.data.bmi, 26.1);

  await api().post(`/api/v1/members/${member._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  const t = (await api().post('/api/v1/auth/member/login').send({ phone: '9300000001', password: 'Member@123' })).body.data.accessToken;
  const own = await api().post('/api/v1/me/measurements').set(auth(t)).send({ date: '2026-10-01', weightKg: 78 });
  assert.equal(own.status, 201);
  const f = await api().get('/api/v1/me/fitness').set(auth(t));
  assert.equal(f.body.data.workout.name, 'Beginner 3-day split');
  assert.equal(f.body.data.diet.dailyCalories, 1800);
  assert.equal(f.body.data.measurements.length, 2);
});

test('trainer sees PT clients too (not only assigned members)', async () => {
  const pkg = (await api().post('/api/v1/pt/packages').set(auth(owner)).send({ name: '4 sessions', sessions: 4, validityDays: 30, price: 100000 })).body.data;
  await api().post('/api/v1/pt/purchases').set(auth(owner)).send({ memberId: other._id, packageId: pkg._id, trainerId: String(ctx.trainer._id) });
  assert.equal((await api().get(`/api/v1/members/${other._id}`).set(auth(trainer))).status, 200);
  const list = await api().get('/api/v1/members?search=Not').set(auth(trainer));
  assert.equal(list.body.data.total, 1);
});
