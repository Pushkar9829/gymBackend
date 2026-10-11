/**
 * Public (no login) endpoints for the gym's website / "Join" page.
 * Rate limited; only safe, non-personal data is exposed.
 */
import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { addDays } from '../../utils/dates.js';
import { Gym } from '../settings/gym.model.js';
import { Branch } from '../branches/branch.model.js';
import { Plan } from '../plans/plan.model.js';
import { ClassType } from '../classes/class.model.js';
import { Lead } from '../leads/lead.model.js';
import { createAlert } from '../notifications/notification.service.js';

const router = Router();

const enquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Too many enquiries from this network. Please call us instead.' },
});

router.get('/info', async (_req, res) => {
  const [gym, branches, plans, classTypes] = await Promise.all([
    Gym.findOne().select('name logoUrl phone email address').lean(),
    Branch.find({ isActive: true }).select('name address phone openingTime closingTime').sort({ name: 1 }).lean(),
    Plan.find({ isActive: true, isDeleted: false }).select('name description durationValue durationUnit price joiningFee accessStart accessEnd').sort({ durationUnit: 1, durationValue: 1 }).lean(),
    ClassType.find({ isActive: true }).select('name description color').sort({ name: 1 }).lean(),
  ]);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: { gym, branches, plans, classTypes } });
});

router.post(
  '/enquiry',
  enquiryLimiter,
  validate({
    body: z.object({
      branchId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Choose a branch'),
      name: z.string().trim().min(2).max(80),
      phone: z.string().trim().regex(/^\+?\d{10,13}$/, 'Enter a valid phone number'),
      email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
      interest: z.string().trim().max(80).optional(),
      message: z.string().trim().max(500).optional(),
      website: z.string().optional(), // honeypot: real users never fill this hidden field
    }),
  }),
  async (req, res) => {
    const { branchId, name, phone, email, interest, message, website } = req.body;
    const ok = { success: true, message: 'Thank you! Our team will call you shortly.' };
    if (website) return res.json(ok); // bot: pretend success, store nothing
    const branch = await Branch.findOne({ _id: branchId, isActive: true }).lean();
    if (!branch) throw ApiError.badRequest('Choose a branch');

    const note = [interest && `Interested in: ${interest}`, message].filter(Boolean).join('\n') || undefined;
    // Same person enquiring again within 30 days: add to the existing lead instead of duplicating.
    const open = await Lead.findOne({ phone, isDeleted: false, status: { $in: ['new', 'contacted', 'trial'] }, createdAt: { $gte: addDays(new Date(), -30) } });
    if (open) {
      open.followUps.push({ note: `Enquired again on the website${note ? `: ${note}` : ''}` });
      open.nextFollowUpAt = new Date();
      await open.save();
    } else {
      await Lead.create({ branchId, name, phone, email, source: 'website', notes: note, nextFollowUpAt: new Date() });
    }
    await createAlert({ branchId, template: 'website-enquiry', subject: `New website enquiry: ${name}`, body: `${phone}${interest ? ` · ${interest}` : ''}` });
    res.status(201).json(ok);
  },
);

export default router;
