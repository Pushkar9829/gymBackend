import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { Member } from '../members/member.model.js';
import { getGym } from '../settings/gym.model.js';
import { sendMessage } from '../messaging/messaging.service.js';

const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: true },
);
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const MemberOtp = mongoose.model('MemberOtp', otpSchema);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;

/** Sends a login code to a registered member's phone. Same response whether or not the phone exists. */
export async function sendMemberOtp(phone) {
  const gym = await getGym();
  if (gym.settings?.memberOtpLogin === false) throw ApiError.forbidden('OTP login is disabled. Use your password.');
  // Trial visitors have no member app.
  const member = await Member.findOne({ phone, isDeleted: false, isTrial: { $ne: true } }).lean();
  if (!member) return { sent: true };

  const recent = await MemberOtp.findOne({ phone, usedAt: null, createdAt: { $gt: new Date(Date.now() - RESEND_AFTER_MS) } });
  if (recent) throw new ApiError(429, 'Please wait 30 seconds before asking for another code');

  const otp = String(crypto.randomInt(100000, 1000000));
  await MemberOtp.deleteMany({ phone });
  await MemberOtp.create({ phone, otpHash: sha(`${phone}:${otp}`), expiresAt: new Date(Date.now() + OTP_TTL_MS) });

  // Prefer WhatsApp when it is on, else SMS. With no provider configured the code is only logged (dev).
  const channel = gym.settings?.channels?.whatsapp && !gym.settings?.channels?.sms ? 'whatsapp' : 'sms';
  await sendMessage({ to: phone, member, channel, template: 'otp', vars: { otp, gym: gym.name } });
  return { sent: true };
}

/** Verifies the code and returns the member (portal access is switched on by a successful OTP login). */
export async function verifyMemberOtp(phone, otp) {
  const rec = await MemberOtp.findOne({ phone, usedAt: null });
  if (!rec || rec.expiresAt < new Date() || rec.attempts >= 5) throw ApiError.badRequest('Invalid or expired code');
  if (rec.otpHash !== sha(`${phone}:${otp}`)) {
    rec.attempts += 1;
    await rec.save();
    throw ApiError.badRequest('Invalid or expired code');
  }
  rec.usedAt = new Date();
  await rec.save();
  const member = await Member.findOneAndUpdate({ phone, isDeleted: false, isTrial: { $ne: true } }, { portalEnabled: true }, { returnDocument: 'after' });
  if (!member) throw ApiError.badRequest('Invalid or expired code');
  return member;
}
