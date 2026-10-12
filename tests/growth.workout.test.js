import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { Attendance } from '../src/modules/attendance/attendance.model.js';
import { WorkoutLog } from '../src/modules/fitness/workoutLog.model.js';
import { Member } from '../src/modules/members/member.model.js';
import { computeStreaks, weekStart, badgesFor } from '../src/modules/fitness/streaks.js';
import { addDays, dayjs, tz, ymd } from '../src/utils/dates.js';

// Batch D: workout log in the member app, weekly visit streaks (Mon-Sun, IST) and badges.

let ctx;
let owner;
let trainer;
let rec;
let member;
let token;
let plan;

before(async () => {
  ctx = await setupDb();
  owner = await login('owner@t.com');
  trainer = await login('trainer@t.com');
  rec = await login('rec@t.com');
  member = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Lifting Lata', phone: '9700000001' })).body.data;
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: member._id, planId: String(ctx.monthly._id) });
  await api().post(`/api/v1/members/${member._id}/portal`).set(auth(owner)).send({ enabled: true, password: 'Member@123' });
  token = (await api().post('/api/v1/auth/member/login').send({ phone: '9700000001', password: 'Member@123' })).body.data.accessToken;
  plan = (
    await api()
      .post('/api/v1/fitness/workout-plans')
      .set(auth(owner))
      .send({
        memberId: member._id,
        name: 'Push Pull',
        days: [
          { name: 'Day 1 - Push', exercises: [{ name: 'Bench press', sets: 3, reps: '10', weight: '40 kg' }, { name: 'Shoulder press', sets: 3, reps: '12' }] },
          { name: 'Day 2 - Pull', exercises: [{ name: 'Rows', sets: 4, reps: '10' }] },
        ],
      })
  ).body.data;
});
after(teardown);

test('weeks run Monday to Sunday in gym time (IST)', () => {
  assert.equal(weekStart('2026-10-12'), '2026-10-12'); // Monday
  assert.equal(weekStart('2026-10-18'), '2026-10-12'); // Sunday belongs to the same week
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
  // 00:30 IST on Monday is still Sunday evening in UTC: it counts in the new week.
  const justAfterMidnight = new Date('2026-10-18T19:00:00Z');
  assert.equal(ymd(justAfterMidnight), '2026-10-19');
  assert.equal(weekStart(ymd(justAfterMidnight)), '2026-10-19');
  assert.equal(weekStart(ymd(new Date('2026-10-18T18:29:00Z'))), '2026-10-12'); // 23:59 IST Sunday
});

test('streak math: target per week, running week never breaks it, gaps do', () => {
  const today = '2026-10-21'; // Wednesday
  const w = (mon, n) => Array.from({ length: n }, (_, i) => dayjs.tz(mon, tz).add(i, 'day').format('YYYY-MM-DD'));
  const days = [...w('2026-09-21', 3), ...w('2026-09-28', 3), ...w('2026-10-05', 2), ...w('2026-10-12', 3), ...w('2026-10-19', 1)];
  let s = computeStreaks(days, { target: 3, today });
  assert.deepEqual(s, { current: 1, best: 2, thisWeek: 1 }); // week of 05-10 had only 2 visits
  s = computeStreaks([...days, '2026-10-20', '2026-10-21'], { target: 3, today });
  assert.equal(s.current, 2); // this week reached 3
  s = computeStreaks(days, { target: 2, today });
  assert.equal(s.current, 4);
  assert.equal(s.best, 4);
  assert.equal(computeStreaks(['2026-10-23'], { target: 1, today }).thisWeek, 0); // future days ignored
  const b = badgesFor({ visits: 26, bestStreak: 8, workouts: 1 });
  assert.deepEqual(b.filter((x) => x.earned).map((x) => x.key), ['first-workout', 'visits-10', 'visits-25', 'streak-4', 'streak-8']);
});

test("today's workout suggests the next plan day; finish saves a log", async () => {
  let w = await api().get('/api/v1/me/workout').set(auth(token));
  assert.equal(w.status, 200);
  assert.equal(w.body.data.plan.name, 'Push Pull');
  assert.equal(w.body.data.suggestedDayIndex, 0);

  const none = await api().post('/api/v1/me/workout-logs').set(auth(token)).send({ planId: plan._id, dayIndex: 0, entries: [{ name: 'Bench press', done: false }] });
  assert.equal(none.status, 400);
  assert.match(none.body.message, /Tick at least one/);
  const future = await api().post('/api/v1/me/workout-logs').set(auth(token)).send({ planId: plan._id, dayIndex: 0, date: ymd(addDays(new Date(), 1)), entries: [{ name: 'Bench press', done: true }] });
  assert.equal(future.status, 400);

  const log = await api()
    .post('/api/v1/me/workout-logs')
    .set(auth(token))
    .send({ planId: plan._id, dayIndex: 0, durationMin: 45, note: 'Felt strong', entries: [{ name: 'Bench press', done: true, sets: 3, reps: '10', weight: '42.5 kg' }, { name: 'Shoulder press', done: false }] });
  assert.equal(log.status, 201, JSON.stringify(log.body));
  assert.equal(log.body.data.dayName, 'Day 1 - Push');
  assert.equal(log.body.data.day, ymd(new Date()));
  assert.equal(log.body.data.entries[0].planned.weight, '40 kg');
  assert.equal(log.body.data.entries[0].weight, '42.5 kg');

  w = await api().get('/api/v1/me/workout').set(auth(token));
  assert.equal(w.body.data.suggestedDayIndex, 1);
  assert.equal(w.body.data.today.length, 1);
  // After the last day it goes round to day 1 again.
  await api().post('/api/v1/me/workout-logs').set(auth(token)).send({ planId: plan._id, dayIndex: 1, entries: [{ name: 'Rows', done: true }] });
  assert.equal((await api().get('/api/v1/me/workout').set(auth(token))).body.data.suggestedDayIndex, 0);

  const hist = await api().get('/api/v1/me/workout-logs').set(auth(token));
  assert.equal(hist.body.data.total, 2);
  assert.equal(hist.body.data.items[1].note, 'Felt strong');
  // Another member's plan cannot be used.
  const other = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: String(ctx.main._id), name: 'Other Om', phone: '9700000002' })).body.data;
  const otherPlan = (await api().post('/api/v1/fitness/workout-plans').set(auth(owner)).send({ memberId: other._id, name: 'Other', days: [{ name: 'A', exercises: [{ name: 'Squat' }] }] })).body.data;
  assert.equal((await api().post('/api/v1/me/workout-logs').set(auth(token)).send({ planId: otherPlan._id, entries: [{ name: 'Squat', done: true }] })).status, 404);
});

test('progress: gym check-ins count as visits (trial visits do not), streak and badges', async () => {
  // 3 check-ins in each of the last 3 full weeks + 1 extra day = 10 visit days (today has a workout log).
  const thisMonday = weekStart(ymd(new Date()));
  const rows = [];
  for (let k = 1; k <= 3; k += 1) {
    const mon = dayjs.tz(thisMonday, tz).subtract(7 * k, 'day');
    for (let d = 0; d < 3; d += 1) rows.push(mon.add(d, 'day').format('YYYY-MM-DD'));
  }
  rows.push(dayjs.tz(thisMonday, tz).subtract(30, 'day').format('YYYY-MM-DD'));
  await Attendance.insertMany(rows.map((day) => ({ memberId: member._id, branchId: ctx.main._id, day, checkInAt: dayjs.tz(`${day} 07:00`, tz).toDate(), method: 'manual' })));
  // A visit flagged as a trial visit is not counted.
  await Attendance.create({ memberId: member._id, branchId: ctx.main._id, day: dayjs.tz(thisMonday, tz).subtract(60, 'day').format('YYYY-MM-DD'), checkInAt: new Date(Date.now() - 60 * 86400000), method: 'manual', isTrial: true });

  const p = await api().get('/api/v1/me/progress-summary').set(auth(token));
  assert.equal(p.status, 200);
  const d = p.body.data;
  const expectedVisits = new Set([...rows, ymd(new Date())]).size;
  assert.equal(d.visits, expectedVisits);
  assert.equal(d.workouts, 2);
  assert.equal(d.weeklyTarget, 3);
  assert.equal(d.currentStreak, 3);
  assert.ok(d.badges.find((b) => b.key === 'first-workout').earned);
  assert.ok(d.badges.find((b) => b.key === 'visits-10').earned);
  assert.equal(d.badges.find((b) => b.key === 'streak-4').earned, false);

  // Owner raises the weekly target: the same weeks no longer count.
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { streaks: { weeklyVisits: 4 } } });
  const p4 = await api().get('/api/v1/me/progress-summary').set(auth(token));
  assert.equal(p4.body.data.weeklyTarget, 4);
  assert.equal(p4.body.data.currentStreak, 0);
  await api().put('/api/v1/settings').set(auth(owner)).send({ settings: { streaks: { weeklyVisits: 3 } } });
});

test('staff see workout logs read-only; trainers only for their own clients', async () => {
  const r = await api().get('/api/v1/fitness/workout-logs').query({ memberId: member._id }).set(auth(rec));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.logs.length, 2);
  assert.equal(r.body.data.summary.workouts, 2);
  assert.equal((await api().get('/api/v1/fitness/workout-logs').query({ memberId: member._id }).set(auth(trainer))).status, 404);
  await Member.updateOne({ _id: member._id }, { trainerId: ctx.trainer._id });
  assert.equal((await api().get('/api/v1/fitness/workout-logs').query({ memberId: member._id }).set(auth(trainer))).status, 200);
  // Member can delete their own log only.
  const log = await WorkoutLog.findOne({ memberId: member._id }).lean();
  assert.equal((await api().delete(`/api/v1/me/workout-logs/${log._id}`).set(auth(token))).status, 200);
  assert.equal(await WorkoutLog.countDocuments({ memberId: member._id }), 1);
});
