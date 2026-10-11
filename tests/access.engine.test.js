import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccess } from '../src/modules/access/access.engine.js';
import { parseDay, addDays, ymd } from '../src/utils/dates.js';

const today = parseDay('2026-10-11');
const now = new Date(today.getTime() + 10 * 3600 * 1000); // 10:00 local-ish
const sub = (start, end, extra = {}) => ({
  _id: Math.random().toString(36),
  startDate: parseDay(start),
  endDate: parseDay(end),
  status: 'active',
  dueAmount: 0,
  freezes: [],
  plan: { name: 'Monthly' },
  ...extra,
});
const run = (subscriptions, member = {}, settings = {}) => computeAccess({ member, subscriptions, settings, now });

test('no membership -> deny, device disabled', () => {
  const a = run([]);
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'NO_MEMBERSHIP');
  assert.equal(a.device.enabled, false);
});

test('active membership -> allow, device window = membership dates', () => {
  const a = run([sub('2026-10-01', '2026-10-31')]);
  assert.equal(a.allowed, true);
  assert.equal(a.daysLeft, 20);
  assert.equal(a.device.enabled, true);
  assert.equal(ymd(a.device.validFrom), '2026-10-01');
  assert.equal(ymd(a.device.validTo), '2026-10-31');
});

test('last day of membership -> still allowed', () => {
  const a = run([sub('2026-09-12', '2026-10-11')]);
  assert.equal(a.allowed, true);
  assert.equal(a.daysLeft, 0);
});

test('membership ended yesterday -> NO ENTRY (0 grace days)', () => {
  const a = run([sub('2026-09-11', '2026-10-10')]);
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'EXPIRED');
  assert.match(a.reason, /expired on 10-10-2026/);
  assert.equal(a.device.enabled, false);
  assert.equal(a.membershipStatus, 'expired');
});

test('grace days setting allows entry for N days after end', () => {
  const a = run([sub('2026-09-11', '2026-10-10')], {}, { graceDays: 1 });
  assert.equal(a.allowed, true);
  assert.equal(a.code, 'GRACE');
  assert.equal(ymd(a.device.validTo), '2026-10-11');
  assert.equal(run([sub('2026-09-10', '2026-10-09')], {}, { graceDays: 1 }).allowed, false);
});

test('future membership -> deny today, but device enabled with future start date', () => {
  const a = run([sub('2026-10-15', '2026-11-14')]);
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'NOT_STARTED');
  assert.equal(a.device.enabled, true);
  assert.equal(ymd(a.device.validFrom), '2026-10-15');
});

test('frozen today -> deny and device disabled', () => {
  const s = sub('2026-10-01', '2026-11-10', { freezes: [{ from: parseDay('2026-10-10'), to: parseDay('2026-10-19'), days: 10 }] });
  const a = run([s]);
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'FROZEN');
  assert.equal(a.device.enabled, false);
});

test('freeze ended early -> allowed again', () => {
  const s = sub('2026-10-01', '2026-11-10', {
    freezes: [{ from: parseDay('2026-10-05'), to: parseDay('2026-10-14'), days: 6, endedEarlyAt: parseDay('2026-10-11') }],
  });
  assert.equal(run([s]).allowed, true);
});

test('blocked member -> deny even with valid membership', () => {
  const a = run([sub('2026-10-01', '2026-10-31')], { isBlocked: true, blockReason: 'Misbehaviour' });
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'BLOCKED');
  assert.equal(a.device.enabled, false);
});

test('cancelled membership is ignored', () => {
  const a = run([sub('2026-10-01', '2026-10-31', { status: 'cancelled' })]);
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'CANCELLED');
});

test('dues: allowed by default, blocked when blockOnDues is on', () => {
  const s = [sub('2026-10-01', '2026-10-31', { dueAmount: 50000 })];
  assert.equal(run(s).allowed, true);
  const a = run(s, {}, { blockOnDues: true });
  assert.equal(a.allowed, false);
  assert.equal(a.code, 'DUES');
  assert.equal(a.device.enabled, false);
});

test('back-to-back renewal extends the device window', () => {
  const a = run([sub('2026-10-01', '2026-10-31'), sub('2026-11-01', '2026-11-30')]);
  assert.equal(ymd(a.device.validTo), '2026-11-30');
  // A gap breaks the chain: device only gets the current period.
  const b = run([sub('2026-10-01', '2026-10-31'), sub('2026-11-05', '2026-12-04')]);
  assert.equal(ymd(b.device.validTo), '2026-10-31');
});

test('ymd/addDays sanity in gym timezone', () => {
  assert.equal(ymd(addDays(parseDay('2026-03-31'), 1)), '2026-04-01');
});
