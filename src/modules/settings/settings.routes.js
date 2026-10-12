import { Router } from 'express';
import { z } from 'zod';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { Gym } from './gym.model.js';
import { audit } from '../audit/audit.model.js';
import { Member } from '../members/member.model.js';
import { refreshMember } from '../members/member.state.js';

const router = Router();
router.use(requireStaff);

router.get('/', async (_req, res) => {
  res.json({ success: true, data: await Gym.findOne().lean() });
});

const schema = z
  .object({
    name: z.string().trim().min(2),
    logoUrl: z.string().url().or(z.literal('')),
    gstin: z.string().trim().max(15).or(z.literal('')),
    address: z.string().max(300),
    phone: z.string().max(20),
    email: z.string().email().or(z.literal('')),
    taxPercent: z.number().min(0).max(50),
    invoicePrefix: z.string().trim().min(1).max(10),
    receiptPrefix: z.string().trim().min(1).max(10),
    settings: z
      .object({
        graceDays: z.number().int().min(0).max(3),
        blockOnDues: z.boolean(),
        reminderDays: z.array(z.number().int().min(0).max(60)).max(5),
        sendEmails: z.boolean(),
        channels: z.object({ sms: z.boolean(), whatsapp: z.boolean() }).partial(),
        memberOtpLogin: z.boolean(),
        payroll: z.object({ weeklyOff: z.array(z.number().int().min(0).max(6)).max(3), prorateByAttendance: z.boolean() }).partial(),
        discountLimitPercent: z.number().min(0).max(100),
        cashShortAlert: z.number().int().min(0).max(100000000),
        retentionGraceDays: z.number().int().min(0).max(90),
        receiptPaper: z.enum(['a4', '80mm', '58mm']),
        trial: z
          .object({
            enabled: z.boolean(),
            defaultDays: z.number().int().min(1).max(3),
            maxDays: z.number().int().min(1).max(3),
            repeatDays: z.number().int().min(0).max(365),
          })
          .partial(),
      })
      .partial(),
  })
  .partial();

router.put('/', permit('settings.write'), validate({ body: schema }), async (req, res) => {
  const gym = await Gym.findOne();
  const before = { ...gym.settings.toObject() };
  const { settings, ...rest } = req.body;
  Object.assign(gym, rest);
  if (settings) {
    const { channels, payroll, trial, ...rest } = settings;
    Object.assign(gym.settings, rest);
    if (channels) Object.assign(gym.settings.channels, channels);
    if (payroll) Object.assign(gym.settings.payroll, payroll);
    if (trial) {
      gym.settings.trial ||= {};
      Object.assign(gym.settings.trial, trial);
      if (gym.settings.trial.defaultDays > gym.settings.trial.maxDays) gym.settings.trial.defaultDays = gym.settings.trial.maxDays;
    }
  }
  await gym.save();
  await audit(req, 'settings.update', { entity: 'Gym', entityId: gym._id, details: req.body });

  // Access rules changed -> re-evaluate every member so devices follow immediately.
  const accessChanged =
    settings &&
    (('graceDays' in settings && settings.graceDays !== before.graceDays) ||
      ('blockOnDues' in settings && settings.blockOnDues !== before.blockOnDues));
  if (accessChanged) {
    const gymSettings = gym.settings.toObject();
    const cursor = Member.find({ isDeleted: false }).lean().cursor();
    for await (const m of cursor) await refreshMember(m, { settings: gymSettings });
  }
  res.json({ success: true, data: gym });
});

export default router;
