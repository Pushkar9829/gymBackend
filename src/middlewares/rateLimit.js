import rateLimit from 'express-rate-limit';

const skip = () => process.env.NODE_ENV === 'test';

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
