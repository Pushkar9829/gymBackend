const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT || 5020),
  mongoUri: required('MONGO_URI', isProd ? undefined : 'mongodb://127.0.0.1:27017/gym_mgmt_dev'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET', isProd ? undefined : 'dev-access-secret-change-me'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET', isProd ? undefined : 'dev-refresh-secret-change-me'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 30),
  clientUrls: (process.env.CLIENT_URLS || 'http://localhost:5173').split(',').map((s) => s.trim()),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  cronSecret: process.env.CRON_SECRET || 'dev-cron-secret',
  mail: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'Gym <no-reply@example.com>',
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
};
