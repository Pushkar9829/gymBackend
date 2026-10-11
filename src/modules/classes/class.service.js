import { ApiError } from '../../utils/ApiError.js';
import { dayjs, tz, startOfDay, addDays, dmy } from '../../utils/dates.js';
import { ClassSchedule, ClassSession, ClassType, Booking } from './class.model.js';
import { Member } from '../members/member.model.js';
import { loadAccess } from '../members/member.state.js';
import { notifyMember } from '../messaging/messaging.service.js';
import { createAlert } from '../notifications/notification.service.js';
import { logger } from '../../config/logger.js';

const MAX_GENERATE_DAYS = 31;
export const CANCEL_CUTOFF_MIN = 60; // members can cancel up to 1 hour before start

/** Creates ClassSession documents for every schedule slot between from and to (idempotent). */
export async function ensureSessions({ branchFilter = {}, from, to }) {
  const start = dayjs(startOfDay(from)).tz(tz);
  const days = Math.min(MAX_GENERATE_DAYS, Math.max(1, Math.ceil((to - from) / 86400000)));
  const schedules = await ClassSchedule.find({ ...branchFilter, isActive: true }).lean();
  if (!schedules.length) return;
  const types = Object.fromEntries((await ClassType.find({ _id: { $in: schedules.map((s) => s.classTypeId) } }).lean()).map((t) => [String(t._id), t]));

  const ops = [];
  for (let i = 0; i < days; i += 1) {
    const day = start.add(i, 'day');
    for (const s of schedules) {
      if (!s.weekdays.includes(day.day())) continue;
      if (day.isBefore(dayjs(s.validFrom).tz(tz), 'day')) continue;
      if (s.validTo && day.isAfter(dayjs(s.validTo).tz(tz), 'day')) continue;
      const [h, m] = s.startTime.split(':').map(Number);
      const startsAt = day.hour(h).minute(m).second(0).millisecond(0).toDate();
      const type = types[String(s.classTypeId)];
      ops.push({
        updateOne: {
          filter: { scheduleId: s._id, startsAt },
          update: {
            $setOnInsert: {
              scheduleId: s._id,
              branchId: s.branchId,
              classTypeId: s.classTypeId,
              name: type?.name,
              color: type?.color,
              trainerId: s.trainerId,
              room: s.room,
              startsAt,
              endsAt: new Date(startsAt.getTime() + s.durationMin * 60000),
              capacity: s.capacity,
            },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await ClassSession.bulkWrite(ops, { ordered: false }).catch((err) => {
    if (err?.code !== 11000 && !err?.writeErrors?.every((e) => e.code === 11000)) throw err;
  });
}

/**
 * Books a member into a class: a seat if available, else the waitlist.
 * The member must have valid gym access on the day of the class.
 */
export async function bookClass({ sessionId, member, source = 'member', user }) {
  const session = await ClassSession.findById(sessionId).lean();
  if (!session || session.status !== 'scheduled') throw ApiError.notFound('Class not available');
  if (session.startsAt <= new Date()) throw ApiError.badRequest('This class has already started');
  if (String(session.branchId) !== String(member.branchId)) throw ApiError.badRequest('This class is at another branch');

  const { access } = await loadAccess(member, { now: session.startsAt });
  if (!access.allowed) throw ApiError.badRequest(`Cannot book: ${access.reason}`);

  const existing = await Booking.findOne({ sessionId, memberId: member._id, status: { $in: ['booked', 'waitlisted'] } }).lean();
  if (existing) throw ApiError.conflict(existing.status === 'booked' ? 'Already booked' : 'Already on the waitlist');

  // Atomically take a seat if one is free.
  const seat = await ClassSession.findOneAndUpdate(
    { _id: sessionId, status: 'scheduled', $expr: { $lt: ['$bookedCount', '$capacity'] } },
    { $inc: { bookedCount: 1 } },
    { returnDocument: 'after' },
  );
  const base = { sessionId, memberId: member._id, branchId: session.branchId, source, bookedBy: user?._id };
  try {
    if (seat) return { booking: await Booking.create({ ...base, status: 'booked' }), session: seat };
    await ClassSession.updateOne({ _id: sessionId }, { $inc: { waitlistCount: 1 } });
    const booking = await Booking.create({ ...base, status: 'waitlisted', waitlistedAt: new Date() });
    return { booking, session: await ClassSession.findById(sessionId).lean() };
  } catch (err) {
    // Lost a race with a duplicate booking: give the seat / waitlist slot back.
    await ClassSession.updateOne({ _id: sessionId }, { $inc: seat ? { bookedCount: -1 } : { waitlistCount: -1 } });
    if (err?.code === 11000) throw ApiError.conflict('Already booked');
    throw err;
  }
}

/** Gives a freed seat to the first person on the waitlist (if any) and tells them. */
async function promoteFromWaitlist(session) {
  const seat = await ClassSession.findOneAndUpdate(
    { _id: session._id, status: 'scheduled', waitlistCount: { $gt: 0 }, $expr: { $lt: ['$bookedCount', '$capacity'] } },
    { $inc: { bookedCount: 1, waitlistCount: -1 } },
    { returnDocument: 'after' },
  );
  if (!seat) return null;
  const next = await Booking.findOneAndUpdate(
    { sessionId: session._id, status: 'waitlisted' },
    { status: 'booked' },
    { sort: { waitlistedAt: 1 }, returnDocument: 'after' },
  );
  if (!next) {
    await ClassSession.updateOne({ _id: session._id }, { $inc: { bookedCount: -1, waitlistCount: 1 } });
    return null;
  }
  const member = await Member.findById(next.memberId).lean();
  if (member) {
    const time = dayjs(seat.startsAt).tz(tz).format('DD MMM, hh:mm A');
    notifyMember({ member, template: 'class_reminder', vars: { className: `${seat.name} (you got a seat from the waitlist)`, time }, dedupeKey: `promoted:${next._id}` }).catch((err) =>
      logger.error({ err }, 'waitlist promotion message failed'),
    );
  }
  return next;
}

export async function cancelBooking({ bookingId, byStaff = false }) {
  const booking = await Booking.findById(bookingId);
  if (!booking || !['booked', 'waitlisted'].includes(booking.status)) throw ApiError.notFound('Booking not found');
  const session = await ClassSession.findById(booking.sessionId);
  if (!byStaff && session.startsAt.getTime() - Date.now() < CANCEL_CUTOFF_MIN * 60000) {
    throw ApiError.badRequest(`Bookings can be cancelled up to ${CANCEL_CUTOFF_MIN} minutes before the class`);
  }
  const wasBooked = booking.status === 'booked';
  booking.status = 'cancelled';
  booking.cancelledAt = new Date();
  await booking.save();
  await ClassSession.updateOne({ _id: session._id }, { $inc: wasBooked ? { bookedCount: -1 } : { waitlistCount: -1 } });
  if (wasBooked) await promoteFromWaitlist(session);
  return booking;
}

export async function cancelSession({ sessionId, reason }) {
  const session = await ClassSession.findOneAndUpdate({ _id: sessionId, status: 'scheduled' }, { status: 'cancelled', cancelReason: reason }, { returnDocument: 'after' });
  if (!session) throw ApiError.notFound('Class not found or already cancelled');
  const bookings = await Booking.find({ sessionId, status: { $in: ['booked', 'waitlisted'] } }).lean();
  await Booking.updateMany({ sessionId, status: { $in: ['booked', 'waitlisted'] } }, { status: 'cancelled', cancelledAt: new Date() });
  const time = dayjs(session.startsAt).tz(tz).format('DD MMM, hh:mm A');
  for (const b of bookings) {
    const member = await Member.findById(b.memberId).lean();
    if (member) {
      await notifyMember({
        member,
        template: 'announcement',
        vars: { text: `Sorry, ${session.name} on ${time} is cancelled${reason ? `: ${reason}` : ''}.` },
        dedupeKey: `class-cancel:${session._id}:${member._id}`,
      });
    }
  }
  await createAlert({ branchId: session.branchId, template: 'class-cancelled', subject: `${session.name} on ${time} cancelled`, body: `${bookings.length} member(s) informed` });
  return { session, informed: bookings.length };
}

export async function markAttendance({ bookingId, status }) {
  const booking = await Booking.findById(bookingId);
  if (!booking || !['booked', 'attended', 'no-show'].includes(booking.status)) throw ApiError.badRequest('Only confirmed bookings can be marked');
  const session = await ClassSession.findById(booking.sessionId).lean();
  if (session.startsAt.getTime() - Date.now() > 30 * 60000) {
    throw ApiError.badRequest('Attendance can be marked from 30 minutes before the class');
  }
  booking.status = status;
  await booking.save();
  return booking;
}

/** Reminders for today's classes (called from the daily job). */
export async function sendClassReminders({ now = new Date(), gym }) {
  const from = startOfDay(now);
  const bookings = await Booking.find({ status: 'booked' })
    .populate({ path: 'sessionId', match: { startsAt: { $gte: from, $lt: addDays(from, 1) }, status: 'scheduled' } })
    .lean();
  let sent = 0;
  for (const b of bookings.filter((x) => x.sessionId)) {
    const member = await Member.findById(b.memberId).lean();
    if (!member) continue;
    const r = await notifyMember({
      member,
      gym,
      template: 'class_reminder',
      vars: { className: b.sessionId.name, time: dayjs(b.sessionId.startsAt).tz(tz).format('hh:mm A') },
      dedupeKey: `class-reminder:${b._id}:${dmy(from)}`,
    });
    if (r.length) sent += 1;
  }
  return sent;
}
