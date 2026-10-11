import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import { notFound, errorHandler } from './middlewares/errorHandler.js';
import { ApiError } from './utils/ApiError.js';

import authRoutes from './modules/auth/auth.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import branchRoutes from './modules/branches/branch.routes.js';
import userRoutes from './modules/users/user.routes.js';
import memberRoutes from './modules/members/member.routes.js';
import planRoutes from './modules/plans/plan.routes.js';
import subscriptionRoutes from './modules/subscriptions/subscription.routes.js';
import paymentRoutes from './modules/payments/payment.routes.js';
import invoiceRoutes from './modules/invoices/invoice.routes.js';
import attendanceRoutes from './modules/attendance/attendance.routes.js';
import deviceRoutes from './modules/devices/device.routes.js';
import iclockRoutes from './modules/devices/iclock.routes.js';
import leadRoutes from './modules/leads/lead.routes.js';
import expenseRoutes from './modules/expenses/expense.routes.js';
import reportRoutes from './modules/reports/report.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import uploadRoutes from './modules/uploads/upload.routes.js';
import portalRoutes from './modules/portal/portal.routes.js';
import { runDailyJob } from './jobs/daily.service.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render / Vercel sit behind one proxy hop
  app.disable('x-powered-by');

  if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' || req.url.startsWith('/iclock/getrequest') } }));

  // Biometric devices: plain-text protocol, no CORS/JSON. Mounted before JSON parsing.
  app.use('/iclock', iclockRoutes);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.clientUrls.includes(origin)),
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ success: db, status: db ? 'ok' : 'db-down', time: new Date().toISOString() });
  });

  // Optional HTTP trigger for the daily job (e.g. from an external scheduler) protected by a secret.
  app.post('/api/internal/jobs/daily', async (req, res) => {
    const given = Buffer.from(String(req.get('x-cron-secret') || ''));
    const expected = Buffer.from(env.cronSecret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw ApiError.unauthorized();
    res.json({ success: true, data: await runDailyJob() });
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', authRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/branches', branchRoutes);
  api.use('/users', userRoutes);
  api.use('/members', memberRoutes);
  api.use('/plans', planRoutes);
  api.use('/subscriptions', subscriptionRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/invoices', invoiceRoutes);
  api.use('/attendance', attendanceRoutes);
  api.use('/devices', deviceRoutes);
  api.use('/leads', leadRoutes);
  api.use('/expenses', expenseRoutes);
  api.use('/reports', reportRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/audit', auditRoutes);
  api.use('/uploads', uploadRoutes);
  api.use('/me', portalRoutes);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
