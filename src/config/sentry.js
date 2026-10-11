import * as Sentry from '@sentry/node';

// Error monitoring is optional: enabled only when SENTRY_DSN is set.
const enabled = Boolean(process.env.SENTRY_DSN);
if (enabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

export function captureError(err, context) {
  if (enabled) Sentry.captureException(err, context ? { extra: context } : undefined);
}

export const flushSentry = () => (enabled ? Sentry.flush(2000) : Promise.resolve());
