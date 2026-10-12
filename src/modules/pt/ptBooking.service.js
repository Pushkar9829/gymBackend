import { ApiError } from '../../utils/ApiError.js';
import { addDays, dayjs, dmy, startOfDay, tz, ymd } from '../../utils/dates.js';
import { PtAvailability, PtBooking } from './ptBooking.model.js';
import { PtPurchase } from './pt.model.js';
import { logSession } from './pt.service.js';
import { Member } from '../members/member.model.js';
import { getGym } from '../settings/gym.model.js';
import { createAlert } from '../notifications/notification.service.js';
import { notifyMember } from '../messaging/messaging.service.js';

export const PT_DEFAULTS = { bookingWindowDays: 14, cancelHours: 4, maxPerDay: 1, noShowUsesSession: true };
export const ptSettings = (settings = {}) => ({ ...PT_DEFAULTS, ...(settings.pt || {}) });

const HOLDS_SLOT = ['booked', 'done', 'no-show'];
export const MARK_EARLY_MIN = 30; // done / no-show can be marked from 30 minutes before the start
const fmtSlot = (d) => `${dmy(d)} ${dayjs(d).tz(tz).format('hh:mm A')}`;
const at = (day, hhmm) => dayjs.tz(`${day} ${hhmm}`, tz);

/** All slots of a trainer on one day (gym time), before removing booked ones. branchId limits to one branch. */
export function slotsForDay(av, day, branchId) {
  if (!av) return [];
  const weekday = dayjs.tz(day, tz).day();
  const slotMin = av.slotMin || 60;
  const out = new Map();
  for (const r of av.weekly || []) {
    if (r.day !== weekday) continue;
    if (branchId && String(r.branchId) !== String(branchId)) continue;
    const end = at(day, r.end);
    for (let t = at(day, r.start); !t.add(slotMin, 'minute').isAfter(end); t = t.add(slotMin, 'minute')) {
      const startsAt = t.toDate();
      out.set(startsAt.getTime(), { startsAt, endsAt: t.add(slotMin, 'minute').toDate(), branchId: r.branchId });
    }
  }
  const off = av.timeOff || [];
  return [...out.values()]
    .filter((s) => !off.some((o) => new Date(o.from) < s.endsAt && new Date(o.to) > s.startsAt))
    .sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Days with their slots for a trainer. Each slot: { startsAt, endsAt, free }. Past slots are left out.
 * Booked slots stay in the list (free: false) so staff see the full day; members get free ones only.
 */
export async function trainerSlots({ trainerId, from, days, branchId, now = new Date() }) {
  const av = await PtAvailability.findOne({ trainerId }).lean();
  const first = dayjs.tz(from, tz).startOf('day');
  const rangeEnd = first.add(days, 'day').toDate();
  const taken = await PtBooking.find({ trainerId, status: { $in: HOLDS_SLOT }, startsAt: { $lt: rangeEnd }, endsAt: { $gt: first.toDate() } }).select('startsAt endsAt').lean();
  const result = [];
  for (let i = 0; i < days; i += 1) {
    const day = first.add(i, 'day').format('YYYY-MM-DD');
    const slots = slotsForDay(av, day, branchId)
      .filter((s) => s.startsAt > now)
      .map((s) => ({ ...s, free: !taken.some((b) => b.startsAt < s.endsAt && b.endsAt > s.startsAt) }));
    result.push({ day, slots });
  }
  return { slotMin: av?.slotMin || 60, hasHours: Boolean(av?.weekly?.length), days: result };
}

/** Sessions on the package that are still free to book (not used, not already booked). */
export async function bookableSessions(purchase) {
  const booked = await PtBooking.countDocuments({ ptPurchaseId: purchase._id, status: 'booked' });
  return purchase.sessionsTotal - purchase.sessionsUsed - booked;
}

/** Books a slot on a member's PT package with the package's trainer. source: member | staff */
export async function bookSlot({ purchase, startsAt, source = 'member', user, now = new Date(), gym }) {
  gym = gym || (await getGym());
  const cfg = ptSettings(gym.settings);
  if (purchase.status !== 'active') throw ApiError.badRequest('This PT package is cancelled');
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw ApiError.badRequest('Choose a time slot');
  if (start <= now) throw ApiError.badRequest('Choose a time in the future');
  const day = ymd(start);
  if (source === 'member' && day > ymd(addDays(now, cfg.bookingWindowDays))) {
    throw ApiError.badRequest(`You can book up to ${cfg.bookingWindowDays} days ahead`);
  }
  if (day < ymd(purchase.validFrom) || day > ymd(purchase.validTo)) {
    throw ApiError.badRequest(`The PT package is valid from ${dmy(purchase.validFrom)} to ${dmy(purchase.validTo)}`);
  }
  if ((await bookableSessions(purchase)) <= 0) throw ApiError.badRequest('No sessions left to book on this package');
  const sameDay = await PtBooking.countDocuments({ memberId: purchase.memberId, day, status: { $in: HOLDS_SLOT } });
  if (sameDay >= cfg.maxPerDay) throw ApiError.badRequest(`Only ${cfg.maxPerDay} PT session(s) can be booked per day`);

  const av = await PtAvailability.findOne({ trainerId: purchase.trainerId }).lean();
  const slot = slotsForDay(av, day, purchase.branchId).find((s) => s.startsAt.getTime() === start.getTime());
  if (!slot) throw ApiError.badRequest('The trainer is not available at this time');
  const clash = await PtBooking.exists({ trainerId: purchase.trainerId, status: { $in: HOLDS_SLOT }, startsAt: { $lt: slot.endsAt }, endsAt: { $gt: slot.startsAt } });
  if (clash) throw ApiError.conflict('This slot is already booked. Choose another time.');

  let booking;
  try {
    booking = await PtBooking.create({
      trainerId: purchase.trainerId,
      memberId: purchase.memberId,
      ptPurchaseId: purchase._id,
      branchId: purchase.branchId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      day,
      source,
      bookedBy: source === 'staff' ? user?._id : undefined,
      slotKey: `${purchase.trainerId}:${slot.startsAt.toISOString()}`,
    });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('This slot was just booked by someone else. Choose another time.');
    throw err;
  }
  const member = await Member.findById(purchase.memberId).select('name memberCode').lean();
  await createAlert({
    branchId: purchase.branchId,
    memberId: purchase.memberId,
    template: 'pt-booking',
    subject: `New PT booking: ${member?.name} (#${member?.memberCode}) on ${fmtSlot(slot.startsAt)}`,
    body: source === 'staff' ? `Booked by ${user?.name || 'staff'}` : 'Booked in the member app',
    userIds: [purchase.trainerId],
    dedupeKey: `pt-book:${booking._id}`,
  });
  return booking;
}

/** Cancels an upcoming booking. Members must cancel before the cut-off; staff can cancel any time (marked late). */
export async function cancelPtBooking({ booking, byStaff = false, user, reason, now = new Date(), gym }) {
  gym = gym || (await getGym());
  const cfg = ptSettings(gym.settings);
  if (booking.status !== 'booked') throw ApiError.badRequest('Only upcoming bookings can be cancelled');
  const late = now.getTime() > booking.startsAt.getTime() - cfg.cancelHours * 3600000;
  if (!byStaff && late) {
    throw ApiError.badRequest(cfg.cancelHours ? `Bookings can be cancelled in the app up to ${cfg.cancelHours} hour(s) before. Please call the gym.` : 'This session has already started');
  }
  const updated = await PtBooking.findOneAndUpdate(
    { _id: booking._id, status: 'booked' },
    {
      $set: { status: 'cancelled', cancelledAt: now, cancelledBy: byStaff ? 'staff' : 'member', cancelledByUser: byStaff ? user?._id : undefined, cancelReason: reason, lateCancel: late || undefined },
      $unset: { slotKey: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.conflict('This booking was just changed. Refresh and try again.');
  const member = await Member.findById(booking.memberId).select('name memberCode').lean();
  await createAlert({
    branchId: booking.branchId,
    memberId: booking.memberId,
    template: 'pt-booking-cancelled',
    subject: `PT booking cancelled: ${member?.name} (#${member?.memberCode}) on ${fmtSlot(booking.startsAt)}`,
    body: byStaff ? `By ${user?.name || 'staff'}${late ? ' (late cancel)' : ''}${reason ? `: ${reason}` : ''}` : `By the member in the app${reason ? `: ${reason}` : ''}`,
    userIds: [booking.trainerId],
    dedupeKey: `pt-cancel:${booking._id}`,
  });
  return updated;
}

/**
 * Done / no-show for a booking. "Done" (and "no-show" when the gym counts no-shows) logs the session with the
 * normal session logic, so sessions left and the trainer's commission stay correct.
 */
export async function markPtBooking({ booking, status, notes, user, now = new Date(), gym }) {
  gym = gym || (await getGym());
  const cfg = ptSettings(gym.settings);
  if (booking.status !== 'booked') throw ApiError.badRequest('This booking is already closed');
  if (booking.startsAt.getTime() - now.getTime() > MARK_EARLY_MIN * 60000) {
    throw ApiError.badRequest(`You can mark this from ${MARK_EARLY_MIN} minutes before the session`);
  }
  // Claim the booking first so two people marking at once cannot log two sessions.
  const claimed = await PtBooking.findOneAndUpdate(
    { _id: booking._id, status: 'booked' },
    { status, markedAt: now, markedBy: user?._id, notes },
    { returnDocument: 'after' },
  );
  if (!claimed) throw ApiError.conflict('This booking was just marked by someone else');
  const usesSession = status === 'done' || cfg.noShowUsesSession;
  if (!usesSession) return { booking: claimed, purchase: await PtPurchase.findById(booking.ptPurchaseId).lean() };
  try {
    const r = await logSession({ purchaseId: booking.ptPurchaseId, at: booking.startsAt <= now ? booking.startsAt : now, status, notes, user });
    claimed.sessionId = r.session._id;
    await claimed.save();
    return { booking: claimed, session: r.session, purchase: r.purchase };
  } catch (err) {
    await PtBooking.updateOne({ _id: booking._id }, { status: 'booked', $unset: { markedAt: 1, markedBy: 1, notes: 1 } });
    throw err;
  }
}

/** Morning reminder for today's PT bookings (daily job). SMS / WhatsApp when switched on. */
export async function sendPtReminders({ now = new Date(), gym }) {
  const from = startOfDay(now);
  const bookings = await PtBooking.find({ status: 'booked', startsAt: { $gte: from, $lt: addDays(from, 1) } }).populate('trainerId', 'name').lean();
  let sent = 0;
  for (const b of bookings) {
    const member = await Member.findOne({ _id: b.memberId, isDeleted: false }).lean();
    if (!member) continue;
    const r = await notifyMember({
      member,
      gym,
      template: 'pt_reminder',
      vars: { trainer: b.trainerId?.name || 'your trainer', time: dayjs(b.startsAt).tz(tz).format('hh:mm A') },
      dedupeKey: `pt-reminder:${b._id}`,
    });
    if (r.length) sent += 1;
  }
  return sent;
}
