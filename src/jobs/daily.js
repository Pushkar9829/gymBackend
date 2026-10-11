// Entry point for the Render Cron Job:  node src/jobs/daily.js
import { connectDb, disconnectDb } from '../config/db.js';
import { logger } from '../config/logger.js';
import { runDailyJob } from './daily.service.js';
import { captureError, flushSentry } from '../config/sentry.js';

try {
  await connectDb();
  const report = await runDailyJob();
  logger.info({ report }, 'daily job done');
  await disconnectDb();
  process.exit(0);
} catch (err) {
  logger.error({ err }, 'daily job failed');
  captureError(err, { job: 'daily' });
  await flushSentry();
  await disconnectDb().catch(() => {});
  process.exit(1);
}
