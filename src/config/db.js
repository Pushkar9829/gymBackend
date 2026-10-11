import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri, { autoIndex: !env.isProd || process.env.MONGO_AUTO_INDEX === 'true' });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
