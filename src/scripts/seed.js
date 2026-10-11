/**
 * Creates the gym, a main branch, the owner account and starter plans.
 * Safe to re-run: existing records are kept.
 *
 *   SEED_OWNER_EMAIL=owner@gym.com SEED_OWNER_PASSWORD=... npm run seed
 *   npm run seed -- --demo     (local only: adds demo staff, members, memberships and a test device)
 */
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { Gym } from '../modules/settings/gym.model.js';
import { Branch } from '../modules/branches/branch.model.js';
import { User } from '../modules/users/user.model.js';
import { Plan } from '../modules/plans/plan.model.js';
import { Member } from '../modules/members/member.model.js';
import { Device } from '../modules/devices/device.model.js';
import { hashPassword } from '../modules/auth/auth.service.js';
import { createSubscription } from '../modules/subscriptions/subscription.service.js';
import { nextSeq } from '../utils/counter.js';
import { addDays, ymd } from '../utils/dates.js';

const demo = process.argv.includes('--demo');
if (demo && env.isProd) throw new Error('Refusing to load demo data in production');

await connectDb();

const gymExists = await Gym.exists({});
if (!gymExists) await Gym.create({ name: process.env.SEED_GYM_NAME || 'My Fitness Gym', taxPercent: 18 });

let branch = await Branch.findOne({ code: 'MAIN' });
if (!branch) branch = await Branch.create({ name: 'Main Branch', code: 'MAIN' });

const ownerEmail = (process.env.SEED_OWNER_EMAIL || 'owner@gym.local').toLowerCase();
const ownerPassword = process.env.SEED_OWNER_PASSWORD || (env.isProd ? null : 'Owner@12345');
if (!ownerPassword) throw new Error('Set SEED_OWNER_PASSWORD');
if (!(await User.exists({ email: ownerEmail }))) {
  await User.create({ name: 'Gym Owner', email: ownerEmail, role: 'owner', passwordHash: await hashPassword(ownerPassword), branchIds: [branch._id] });
  console.log(`Owner created: ${ownerEmail}`);
}

if (!(await Plan.exists({}))) {
  await Plan.insertMany([
    { name: 'Monthly', durationValue: 1, durationUnit: 'month', price: 150000, joiningFee: 50000, freezeDaysAllowed: 0, maxFreezes: 0 },
    { name: 'Quarterly', durationValue: 3, durationUnit: 'month', price: 400000, joiningFee: 50000, freezeDaysAllowed: 10, maxFreezes: 1 },
    { name: 'Half Yearly', durationValue: 6, durationUnit: 'month', price: 700000, joiningFee: 0, freezeDaysAllowed: 20, maxFreezes: 2 },
    { name: 'Yearly', durationValue: 12, durationUnit: 'month', price: 1200000, joiningFee: 0, freezeDaysAllowed: 30, maxFreezes: 3 },
    { name: 'Day Pass', durationValue: 1, durationUnit: 'day', price: 20000, joiningFee: 0 },
  ]);
  console.log('Starter plans created');
}

if (demo) {
  const staff = [
    { name: 'Riya Reception', email: 'reception@gym.local', role: 'receptionist' },
    { name: 'Arjun Trainer', email: 'trainer@gym.local', role: 'trainer' },
    { name: 'Meera Manager', email: 'manager@gym.local', role: 'manager' },
  ];
  for (const s of staff) {
    if (!(await User.exists({ email: s.email }))) {
      await User.create({ ...s, passwordHash: await hashPassword('Staff@12345'), branchIds: [branch._id] });
    }
  }
  if (!(await Device.exists({ serialNo: 'DEMO0000001' }))) {
    await Device.create({ branchId: branch._id, name: 'Main Entrance (demo)', serialNo: 'DEMO0000001', dialect: 'security' });
  }
  if (!(await Member.exists({}))) {
    const plans = Object.fromEntries((await Plan.find().lean()).map((p) => [p.name, p]));
    const owner = await User.findOne({ role: 'owner' });
    const people = [
      ['Rahul Sharma', '9876500001', 'Quarterly', -20, 'full'],
      ['Priya Verma', '9876500002', 'Monthly', -28, 'full'],
      ['Amit Patel', '9876500003', 'Monthly', -45, 'full'], // expired
      ['Sneha Iyer', '9876500004', 'Yearly', -100, 'partial'],
      ['Vikram Singh', '9876500005', 'Monthly', -5, 'none'],
      ['Neha Gupta', '9876500006', 'Quarterly', 3, 'full'], // starts in future
    ];
    for (const [name, phone, planName, startOffset, pay] of people) {
      const m = await Member.create({ branchId: branch._id, memberCode: await nextSeq('memberCode', 1001), name, phone, email: `${phone}@example.com` });
      const plan = plans[planName];
      const total = Math.round((plan.price + plan.joiningFee) * 1.18);
      const amount = pay === 'full' ? total : pay === 'partial' ? Math.round(total / 2) : 0;
      await createSubscription({
        memberId: m._id,
        planId: plan._id,
        startDate: ymd(addDays(new Date(), startOffset)),
        payment: amount ? { amount, mode: 'upi' } : undefined,
        user: owner,
        allowBackdate: true,
      }).catch((e) => console.warn(name, e.message));
    }
    console.log('Demo members created');
  }
  console.log('Demo staff password: Staff@12345');
}

console.log('Seed complete');
await disconnectDb();
