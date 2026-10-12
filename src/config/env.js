const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

// Optional Web Push (member app notifications): both keys or neither; the subject must be a mailto: or https: URL.
const vapid = { publicKey: process.env.VAPID_PUBLIC_KEY || '', privateKey: process.env.VAPID_PRIVATE_KEY || '', subject: process.env.VAPID_SUBJECT || '' };
if (Boolean(vapid.publicKey) !== Boolean(vapid.privateKey)) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
if (vapid.subject && !/^(mailto:|https:\/\/)/.test(vapid.subject)) throw new Error('VAPID_SUBJECT must start with mailto: or https://');

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
  pushEnabled: Boolean(vapid.publicKey && vapid.privateKey),
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
};
