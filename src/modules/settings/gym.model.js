import mongoose from 'mongoose';

// Single-gym deployment: exactly one Gym document holds global settings.
const gymSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    logoUrl: String,
    gstin: { type: String, trim: true, uppercase: true },
    address: String,
    phone: String,
    email: { type: String, lowercase: true, trim: true },
    taxPercent: { type: Number, default: 18, min: 0, max: 50 },
    invoicePrefix: { type: String, default: 'INV', trim: true },
    receiptPrefix: { type: String, default: 'RCP', trim: true },
    settings: {
      // Days of entry allowed after membership end date. 0 = no entry from the next day.
      graceDays: { type: Number, default: 0, min: 0, max: 3 },
      // Block entry when an active membership still has unpaid dues.
      blockOnDues: { type: Boolean, default: false },
      reminderDays: { type: [Number], default: [7, 3, 1] },
      sendEmails: { type: Boolean, default: true },
      // SMS / WhatsApp: off until a provider is configured.
      channels: {
        sms: { type: Boolean, default: false },
        whatsapp: { type: Boolean, default: false },
        // Member app notifications (Web Push). Works only when VAPID keys are set on the server.
        push: { type: Boolean, default: true },
      },
      // Members can log in to the app with a one-time code sent by SMS/WhatsApp.
      memberOtpLogin: { type: Boolean, default: true },
      payroll: {
        weeklyOff: { type: [Number], default: [0] }, // 0 = Sunday
        prorateByAttendance: { type: Boolean, default: true },
      },
      // Owner controls
      discountLimitPercent: { type: Number, default: 10, min: 0, max: 100 }, // receptionist max without approval
      cashShortAlert: { type: Number, default: 10000, min: 0 }, // paise: alert when the drawer is short by more
      retentionGraceDays: { type: Number, default: 15, min: 0, max: 90 }, // renewal window after a membership ends
      // Receipt PDFs: A4 page or a thermal roll (80 / 58 mm).
      receiptPaper: { type: String, enum: ['a4', '80mm', '58mm'], default: 'a4' },
      // Free / paid trial passes for leads and walk-ins.
      trial: {
        enabled: { type: Boolean, default: true },
        defaultDays: { type: Number, default: 1, min: 1, max: 3 },
        maxDays: { type: Number, default: 3, min: 1, max: 3 },
        repeatDays: { type: Number, default: 90, min: 0, max: 365 }, // one trial per phone number in this many days
        allowClassBooking: { type: Boolean, default: true }, // trial visitors can be booked into classes
      },
      // Personal training slot booking.
      pt: {
        bookingWindowDays: { type: Number, default: 14, min: 1, max: 60 }, // members book up to this many days ahead
        cancelHours: { type: Number, default: 4, min: 0, max: 72 }, // members cancel up to this many hours before
        maxPerDay: { type: Number, default: 1, min: 1, max: 5 }, // bookings per member per day
        noShowUsesSession: { type: Boolean, default: true },
      },
      // Digital waiver / joining form. Texts are versioned in the WaiverVersion collection.
      waiver: {
        askMembers: { type: Boolean, default: false }, // ask members to sign in the app and at the desk
        requireForEntry: { type: Boolean, default: false }, // deny entry until signed
        currentVersion: { type: Number, default: 0 }, // 0 = no waiver text yet
        minVersion: { type: Number, default: 0 }, // members must have signed at least this version
      },
      // Refer a friend: the referrer gets free days once the friend's first membership is paid.
      referral: {
        enabled: { type: Boolean, default: true },
        rewardDays: { type: Number, default: 15, min: 0, max: 90 },
        newMemberDiscountPercent: { type: Number, default: 0, min: 0, max: 50 }, // friend's first membership
        maxPerYear: { type: Number, default: 12, min: 0, max: 100 }, // rewards per referrer per calendar year
      },
      // Member app streaks: a week counts when the member visits at least this many days (Mon-Sun).
      streaks: {
        weeklyVisits: { type: Number, default: 3, min: 1, max: 7 },
      },
    },
  },
  { timestamps: true },
);

export const Gym = mongoose.model('Gym', gymSchema);

export async function getGym() {
  const gym = await Gym.findOne().lean();
  if (!gym) throw new Error('Gym is not set up. Run the seed script first.');
  return gym;
}
