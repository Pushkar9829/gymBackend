/**
 * Visit streaks and badges for the member app.
 * A visit is a day with a gym check-in (Attendance, trial visits excluded) or a logged workout.
 * A week (Monday to Sunday, gym time) counts when it has at least `weeklyVisits` visits.
 */
import { dayjs, tz, ymd } from '../../utils/dates.js';
import { Attendance } from '../attendance/attendance.model.js';
import { WorkoutLog } from './workoutLog.model.js';

export const STREAK_DEFAULTS = { weeklyVisits: 3 };
export const streakSettings = (settings = {}) => ({ ...STREAK_DEFAULTS, ...(settings.streaks || {}) });

const VISIT_BADGES = [10, 25, 50, 100, 250];
const STREAK_BADGES = [4, 8, 12];

/** Monday (YYYY-MM-DD) of the week a gym day belongs to. */
export function weekStart(day) {
  const d = dayjs.tz(String(day).slice(0, 10), tz);
  return d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD');
}
const shiftWeek = (week, n) => dayjs.tz(week, tz).add(7 * n, 'day').format('YYYY-MM-DD');

/**
 * days: visit days (YYYY-MM-DD). The running week never breaks a streak: it adds one once the target is met.
 * Returns { current, best, thisWeek } (weeks, weeks, visits this week).
 */
export function computeStreaks(days, { target = STREAK_DEFAULTS.weeklyVisits, today = ymd(new Date()) } = {}) {
  const perWeek = new Map();
  for (const d of new Set(days)) {
    if (d > today) continue;
    const w = weekStart(d);
    perWeek.set(w, (perWeek.get(w) || 0) + 1);
  }
  const met = (w) => (perWeek.get(w) || 0) >= target;
  const thisWeek = weekStart(today);

  let current = met(thisWeek) ? 1 : 0;
  for (let w = shiftWeek(thisWeek, -1); met(w); w = shiftWeek(w, -1)) current += 1;

  let best = 0;
  let run = 0;
  const weeks = [...perWeek.keys()].sort();
  if (weeks.length) {
    for (let w = weeks[0]; w <= thisWeek; w = shiftWeek(w, 1)) {
      run = met(w) ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  return { current, best: Math.max(best, current), thisWeek: perWeek.get(thisWeek) || 0 };
}

export function badgesFor({ visits = 0, bestStreak = 0, workouts = 0 }) {
  return [
    { key: 'first-workout', label: 'First workout logged', earned: workouts >= 1 },
    { key: 'workouts-10', label: '10 workouts logged', earned: workouts >= 10 },
    ...VISIT_BADGES.map((n) => ({ key: `visits-${n}`, label: `${n} gym visits`, earned: visits >= n })),
    ...STREAK_BADGES.map((n) => ({ key: `streak-${n}`, label: `${n}-week streak`, earned: bestStreak >= n })),
  ];
}

/** Everything the "My progress" card shows. */
export async function progressSummary(memberId, { now = new Date(), settings } = {}) {
  const target = streakSettings(settings).weeklyVisits;
  const today = ymd(now);
  const [checkIns, logDays, workouts] = await Promise.all([
    Attendance.distinct('day', { memberId, isTrial: { $ne: true } }),
    WorkoutLog.distinct('day', { memberId }),
    WorkoutLog.countDocuments({ memberId }),
  ]);
  const days = [...new Set([...checkIns, ...logDays])].filter((d) => d <= today);
  const s = computeStreaks(days, { target, today });
  const badges = badgesFor({ visits: days.length, bestStreak: s.best, workouts });
  return {
    visits: days.length,
    workouts,
    weeklyTarget: target,
    thisWeekVisits: s.thisWeek,
    currentStreak: s.current,
    bestStreak: s.best,
    badges,
    earned: badges.filter((b) => b.earned).length,
  };
}
