import './config/sentry.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { captureError } from './config/sentry.js';

await connectDb();
const server = createApp().listen(env.port, () => logger.info(`API listening on :${env.port} (${env.nodeEnv})`));

const shutdown = (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection');
  captureError(err);
});
