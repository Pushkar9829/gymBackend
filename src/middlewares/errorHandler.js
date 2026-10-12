import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { captureError } from '../config/sentry.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Something went wrong';
  let errors = err.errors && err instanceof ApiError ? err.errors : undefined;

  if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    errors = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    message = errors[0]?.message || 'Validation failed';
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err?.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field ? `${field} already exists` : 'Duplicate value';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  }

  if (status >= 500) {
    logger.error({ err, url: req.originalUrl }, 'Unhandled error');
    captureError(err, { url: req.originalUrl, method: req.method });
    if (process.env.NODE_ENV === 'production') message = 'Something went wrong';
  }
  const code = err instanceof ApiError && typeof err.code === 'string' ? err.code : undefined;
  res.status(status).json({ success: false, message, ...(errors ? { errors } : {}), ...(code ? { code } : {}) });
}
