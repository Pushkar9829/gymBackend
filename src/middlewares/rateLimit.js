import rateLimit from 'express-rate-limit';

// Off in automated tests (DISABLE_RATE_LIMIT is only for local E2E runs, never production).
const skip = () => process.env.NODE_ENV === 'test' || (process.env.DISABLE_RATE_LIMIT === '1' && process.env.NODE_ENV !== 'production');

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});
