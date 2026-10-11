import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.js';
import { authLimiter } from '../../middlewares/rateLimit.js';
import { requireStaff, requireMember } from '../../middlewares/auth.js';
import { User } from '../users/user.model.js';
import { Member } from '../members/member.model.js';
import * as auth from './auth.service.js';
import { sendMemberOtp, verifyMemberOtp } from './otp.service.js';

const router = Router();
const meta = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });
const password = z.string().min(8, 'Password must be at least 8 characters').max(100);

function sendSession(res, type, { refreshToken, ...rest }) {
  res.cookie(auth.REFRESH_COOKIE[type], refreshToken, auth.refreshCookieOptions());
  res.json({ success: true, data: rest });
}
const clearSession = (res, type) =>
  res.clearCookie(auth.REFRESH_COOKIE[type], { ...auth.refreshCookieOptions(), maxAge: undefined });

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ login: z.string().trim().min(3), password: z.string().min(1) }) }),
  async (req, res) => sendSession(res, 'user', await auth.staffLogin(req.body, meta(req))),
);

router.post(
  '/member/login',
  authLimiter,
  validate({ body: z.object({ phone: z.string().trim().min(6), password: z.string().min(1) }) }),
  async (req, res) => sendSession(res, 'member', await auth.memberLogin(req.body, meta(req))),
);

for (const [type, prefix] of [['user', ''], ['member', '/member']]) {
  router.post(`${prefix}/refresh`, async (req, res) => {
    try {
      sendSession(res, type, await auth.refresh(req.cookies?.[auth.REFRESH_COOKIE[type]], meta(req), type));
    } catch (err) {
      clearSession(res, type);
      throw err;
    }
  });

  router.post(`${prefix}/logout`, async (req, res) => {
    await auth.logout(req.cookies?.[auth.REFRESH_COOKIE[type]]);
    clearSession(res, type);
    res.json({ success: true });
  });
}

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: z.object({ email: z.string().trim().email() }) }),
  async (req, res) => {
    await auth.forgotPassword(req.body.email);
    res.json({ success: true, message: 'If the email exists, a reset code has been sent' });
  },
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: z.object({ email: z.string().trim().email(), otp: z.string().length(6), newPassword: password }) }),
  async (req, res) => {
    await auth.resetPassword(req.body);
    res.json({ success: true, message: 'Password updated. Please log in again.' });
  },
);

const phoneSchema = z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number');
router.post('/member/otp/send', authLimiter, validate({ body: z.object({ phone: phoneSchema }) }), async (req, res) => {
  await sendMemberOtp(req.body.phone);
  res.json({ success: true, message: 'If the number is registered, a code has been sent' });
});
router.post(
  '/member/otp/verify',
  authLimiter,
  validate({ body: z.object({ phone: phoneSchema, otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }),
  async (req, res) => {
    const member = await verifyMemberOtp(req.body.phone, req.body.otp);
    sendSession(res, 'member', await auth.memberSession(member, meta(req)));
  },
);

// Staff: devices / browsers currently logged in
router.get('/sessions', requireStaff, async (req, res) => {
  res.json({ success: true, data: await auth.listSessions(req.user._id, req.cookies?.[auth.REFRESH_COOKIE.user]) });
});
router.post('/sessions/:id/revoke', requireStaff, async (req, res) => {
  await auth.revokeSession(req.user._id, req.params.id);
  res.json({ success: true });
});
router.post('/sessions/revoke-others', requireStaff, async (req, res) => {
  await auth.revokeOtherSessions(req.user._id, req.cookies?.[auth.REFRESH_COOKIE.user]);
  res.json({ success: true });
});

router.get('/me', requireStaff, (req, res) => res.json({ success: true, data: { user: auth.publicUser(req.user) } }));

const changeSchema = { body: z.object({ currentPassword: z.string().min(1), newPassword: password }) };
router.post('/change-password', requireStaff, validate(changeSchema), async (req, res) => {
  await auth.changePassword(User, req.user._id, req.body);
  res.json({ success: true, message: 'Password changed. Please log in again.' });
});
router.post('/member/change-password', requireMember, validate(changeSchema), async (req, res) => {
  await auth.changePassword(Member, req.member._id, req.body);
  res.json({ success: true, message: 'Password changed. Please log in again.' });
});

export default router;
