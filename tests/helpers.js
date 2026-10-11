// Test bootstrap: always uses a throwaway LOCAL database, never the .env one.
process.env.NODE_ENV = 'test';
let mem = null;
if (process.env.USE_MEMORY_MONGO === '1') {
  // CI: throwaway in-memory MongoDB (no local install needed).
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mem = await MongoMemoryServer.create();
  process.env.MONGO_URI = mem.getUri('gym_mgmt_test');
} else {
  process.env.MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/gym_mgmt_test';
}

const { default: request } = await import('supertest');
const { default: mongoose } = await import('mongoose');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { Gym } = await import('../src/modules/settings/gym.model.js');
const { Branch } = await import('../src/modules/branches/branch.model.js');
const { User } = await import('../src/modules/users/user.model.js');
const { Plan } = await import('../src/modules/plans/plan.model.js');
const { hashPassword } = await import('../src/modules/auth/auth.service.js');

if (!/127\.0\.0\.1|localhost/.test(process.env.MONGO_URI)) throw new Error('Tests must run against a local MongoDB');

export const app = createApp();
export const api = () => request(app);

export async function setupDb() {
  if (mongoose.connection.readyState !== 1) await connectDb(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  const gym = await Gym.create({ name: 'Test Gym', taxPercent: 18 });
  const main = await Branch.create({ name: 'Main', code: 'MAIN' });
  const other = await Branch.create({ name: 'Other', code: 'OTHER' });
  const pw = await hashPassword('Password@1');
  const owner = await User.create({ name: 'Owner', email: 'owner@t.com', role: 'owner', passwordHash: pw, branchIds: [main._id] });
  const reception = await User.create({ name: 'Rec', email: 'rec@t.com', role: 'receptionist', passwordHash: pw, branchIds: [main._id] });
  const trainer = await User.create({ name: 'Trainer', email: 'trainer@t.com', role: 'trainer', passwordHash: pw, branchIds: [main._id] });
  const otherRec = await User.create({ name: 'Other Rec', email: 'rec2@t.com', role: 'receptionist', passwordHash: pw, branchIds: [other._id] });
  const monthly = await Plan.create({ name: 'Monthly', durationValue: 1, durationUnit: 'month', price: 100000, joiningFee: 20000, freezeDaysAllowed: 10, maxFreezes: 2 });
  const day = await Plan.create({ name: 'Day', durationValue: 1, durationUnit: 'day', price: 10000 });
  const quarterly = await Plan.create({ name: 'Quarterly', durationValue: 3, durationUnit: 'month', price: 270000 });
  return { gym, main, other, owner, reception, trainer, otherRec, monthly, day, quarterly };
}

export async function login(email, password = 'Password@1') {
  const res = await api().post('/api/v1/auth/login').send({ login: email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

export async function teardown() {
  await mongoose.disconnect();
  if (mem) await mem.stop();
}
