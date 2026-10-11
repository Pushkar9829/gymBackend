import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { RefreshToken, PasswordReset } from './token.model.js';
import { User } from '../users/user.model.js';
import { Member } from '../members/member.model.js';
import { ROLES } from '../../config/permissions.js';
import { sendEmail } from '../notifications/mailer.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashPassword = (p) => bcrypt.hash(p, 12);

export const REFRESH_COOKIE = { user: 'gym_rt', member: 'gym_mrt' };
export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  domain: env.cookieDomain,
  path: '/api/v1/auth',
  maxAge: env.refreshTokenDays * 24 * 60 * 60 * 1000,
});

function signAccess(subjectId, typ) {
  return jwt.sign({ sub: String(subjectId), typ }, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl });
}

async function issueRefresh(subjectId, subjectType, meta) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    subjectId,
    subjectType,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + env.refreshTokenDays * 86400000),
    userAgent: meta?.userAgent,
    ip: meta?.ip,
  });
  return raw;
}

const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  branchIds: u.branchIds,
  permissions: ROLES[u.role],
});

const publicMember = (m) => ({
  _id: m._id,
  name: m.name,
  phone: m.phone,
  email: m.email,
  memberCode: m.memberCode,
  photoUrl: m.photoUrl,
  branchId: m.branchId,
});

export async function staffLogin({ login, password }, meta) {
  const q = login.includes('@') ? { email: login.toLowerCase() } : { phone: login };
  const user = await User.findOne(q).select('+passwordHash');
  // Same message for unknown user and wrong password.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw ApiError.unauthorized('Invalid login or password');
  if (!user.isActive) throw ApiError.forbidden('Account is disabled');
  user.lastLoginAt = new Date();
  await user.save();
  return {
    accessToken: signAccess(user._id, 'user'),
    refreshToken: await issueRefresh(user._id, 'user', meta),
    user: publicUser(user),
  };
}

export async function memberLogin({ phone, password }, meta) {
  const member = await Member.findOne({ phone, isDeleted: false, portalEnabled: true }).select('+passwordHash');
  if (!member || !member.passwordHash || !(await bcrypt.compare(password, member.passwordHash))) {
    throw ApiError.unauthorized('Invalid phone or password');
  }
  return memberSession(member, meta);
}

export async function memberSession(member, meta) {
  return {
    accessToken: signAccess(member._id, 'member'),
    refreshToken: await issueRefresh(member._id, 'member', meta),
    member: publicMember(member),
  };
}

/** Active sessions (refresh tokens) of a staff user; `current` marks the one making the request. */
export async function listSessions(subjectId, currentRaw) {
  const currentHash = currentRaw ? sha256(currentRaw) : null;
  const rows = await RefreshToken.find({ subjectId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .select('userAgent ip createdAt tokenHash')
    .lean();
  return rows.map(({ tokenHash, ...r }) => ({ ...r, current: tokenHash === currentHash }));
}

export async function revokeSession(subjectId, sessionId) {
  await RefreshToken.updateOne({ _id: sessionId, subjectId }, { revokedAt: new Date() });
}

export async function revokeOtherSessions(subjectId, currentRaw) {
  const keep = currentRaw ? sha256(currentRaw) : null;
  await RefreshToken.updateMany({ subjectId, revokedAt: null, tokenHash: { $ne: keep } }, { revokedAt: new Date() });
}

/** Rotates the refresh token. Re-use of a revoked token revokes the whole family for that subject. */
export async function refresh(raw, meta, subjectType) {
  if (!raw) throw ApiError.unauthorized('No session');
  const doc = await RefreshToken.findOne({ tokenHash: sha256(raw), subjectType });
  if (!doc || doc.expiresAt < new Date()) throw ApiError.unauthorized('Session expired');
  if (doc.revokedAt) {
    await RefreshToken.updateMany({ subjectId: doc.subjectId, revokedAt: null }, { revokedAt: new Date() });
    throw ApiError.unauthorized('Session expired');
  }
  doc.revokedAt = new Date();
  await doc.save();

  if (doc.subjectType === 'user') {
    const user = await User.findById(doc.subjectId);
    if (!user || !user.isActive) throw ApiError.unauthorized('Account disabled');
    return {
      accessToken: signAccess(user._id, 'user'),
      refreshToken: await issueRefresh(user._id, 'user', meta),
      user: publicUser(user),
    };
  }
  const member = await Member.findOne({ _id: doc.subjectId, isDeleted: false, portalEnabled: true });
  if (!member) throw ApiError.unauthorized('Portal access disabled');
  return {
    accessToken: signAccess(member._id, 'member'),
    refreshToken: await issueRefresh(member._id, 'member', meta),
    member: publicMember(member),
  };
}

export async function logout(raw) {
  if (raw) await RefreshToken.updateOne({ tokenHash: sha256(raw) }, { revokedAt: new Date() });
}

export async function revokeAllSessions(subjectId) {
  await RefreshToken.updateMany({ subjectId, revokedAt: null }, { revokedAt: new Date() });
}

export async function forgotPassword(email) {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  // Always respond the same way so emails cannot be enumerated.
  if (!user) return;
  const otp = String(crypto.randomInt(100000, 1000000));
  await PasswordReset.deleteMany({ userId: user._id });
  await PasswordReset.create({ userId: user._id, otpHash: sha256(otp), expiresAt: new Date(Date.now() + 10 * 60000) });
  await sendEmail({
    to: user.email,
    subject: 'Your password reset code',
    text: `Your password reset code is ${otp}. It expires in 10 minutes.`,
  });
}

export async function resetPassword({ email, otp, newPassword }) {
  const user = await User.findOne({ email: email.toLowerCase() });
  const reset = user && (await PasswordReset.findOne({ userId: user._id, usedAt: null }));
  if (!reset || reset.expiresAt < new Date() || reset.attempts >= 5) throw ApiError.badRequest('Invalid or expired code');
  if (reset.otpHash !== sha256(String(otp))) {
    reset.attempts += 1;
    await reset.save();
    throw ApiError.badRequest('Invalid or expired code');
  }
  reset.usedAt = new Date();
  await reset.save();
  await User.updateOne({ _id: user._id }, { passwordHash: await hashPassword(newPassword) });
  await revokeAllSessions(user._id);
}

export async function changePassword(Model, id, { currentPassword, newPassword }) {
  const doc = await Model.findById(id).select('+passwordHash');
  if (!doc?.passwordHash || !(await bcrypt.compare(currentPassword, doc.passwordHash))) {
    throw ApiError.badRequest('Current password is incorrect');
  }
  doc.passwordHash = await hashPassword(newPassword);
  await doc.save();
  await revokeAllSessions(id);
}

export { publicUser, publicMember };
