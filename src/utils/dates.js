import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { env } from '../config/env.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const tz = env.timezone;

/** Start of the given day in the gym timezone, returned as a UTC Date. */
export const startOfDay = (d = new Date()) => dayjs(d).tz(tz).startOf('day').toDate();
export const endOfDay = (d = new Date()) => dayjs(d).tz(tz).endOf('day').toDate();
export const addDays = (d, n) => dayjs(d).tz(tz).add(n, 'day').toDate();
/** Calendar date string YYYY-MM-DD in gym timezone. */
export const ymd = (d) => dayjs(d).tz(tz).format('YYYY-MM-DD');
export const dmy = (d) => dayjs(d).tz(tz).format('DD-MM-YYYY');
/** Parse a YYYY-MM-DD (or any date) as a calendar day in gym timezone. */
export const parseDay = (s) => dayjs.tz(typeof s === 'string' ? s.slice(0, 10) : ymd(s), tz).startOf('day').toDate();
/** Whole days from a to b (calendar days in gym tz). */
export const diffDays = (a, b) => dayjs(parseDay(b)).diff(dayjs(parseDay(a)), 'day');
export { dayjs };
