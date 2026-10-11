import crypto from 'node:crypto';
import { env } from '../../config/env.js';

// Printed / in-app QR card. Signed so a QR cannot be forged from a member code.
const key = () => crypto.createHash('sha256').update(`qr:${env.jwtAccessSecret}`).digest();
const sign = (code) => crypto.createHmac('sha256', key()).update(String(code)).digest('base64url').slice(0, 16);

export const qrPayload = (memberCode) => `GYM1:${memberCode}:${sign(memberCode)}`;

export function parseQr(payload) {
  const m = /^GYM1:(\d+):([\w-]{16})$/.exec(String(payload || '').trim());
  if (!m) return null;
  const expected = sign(m[1]);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) return null;
  return Number(m[1]);
}
