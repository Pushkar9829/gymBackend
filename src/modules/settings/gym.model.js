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
