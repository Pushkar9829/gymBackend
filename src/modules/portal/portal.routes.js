import { Router } from 'express';
import QRCode from 'qrcode';
import { requireMember } from '../../middlewares/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { Branch } from '../branches/branch.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Payment } from '../payments/payment.model.js';
import { Invoice } from '../invoices/invoice.model.js';
import { Attendance } from '../attendance/attendance.model.js';
import { loadAccess } from '../members/member.state.js';
import { qrPayload } from '../access/qr.js';
import { sendInvoicePdf } from '../invoices/invoice.routes.js';
import { getGym } from '../settings/gym.model.js';

// Member-facing API (PWA). Everything is scoped to the logged-in member.
const router = Router();
router.use(requireMember);

router.get('/', async (req, res) => {
  const m = req.member;
  const [{ access, subscriptions }, branch, gym] = await Promise.all([
    loadAccess(m),
    Branch.findById(m.branchId).select('name address phone openingTime closingTime').lean(),
    getGym(),
  ]);
  const payload = qrPayload(m.memberCode);
  res.json({
    success: true,
    data: {
      member: {
        _id: m._id, name: m.name, phone: m.phone, email: m.email, memberCode: m.memberCode,
        photoUrl: m.photoUrl, joinedAt: m.joinedAt, dueAmount: m.dueAmount,
      },
      gym: { name: gym.name, logoUrl: gym.logoUrl, phone: gym.phone },
      branch,
      access: {
        allowed: access.allowed, code: access.code, reason: access.reason, membershipStatus: access.membershipStatus,
        daysLeft: access.daysLeft, validFrom: access.window?.from, validTo: access.window?.to, dueAmount: access.dueAmount,
      },
      subscriptions: subscriptions
        .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
        .map((s) => ({
          _id: s._id, plan: s.plan, type: s.type, startDate: s.startDate, endDate: s.endDate, status: s.status,
          totalAmount: s.totalAmount, paidAmount: s.paidAmount, dueAmount: s.dueAmount, freezes: s.freezes, invoiceId: s.invoiceId,
        })),
      card: { payload, qr: await QRCode.toDataURL(payload, { margin: 1, width: 300 }) },
    },
  });
});

router.get('/payments', async (req, res) => {
  const data = await paginate(Payment, { memberId: req.member._id }, req.query, { sort: { paidAt: -1 }, select: '-receivedBy -note' });
  res.json({ success: true, data });
});

router.get('/attendance', async (req, res) => {
  const data = await paginate(Attendance, { memberId: req.member._id }, req.query, { sort: { checkInAt: -1 }, select: 'day checkInAt checkOutAt method' });
  res.json({ success: true, data });
});

router.get('/invoices/:id/pdf', async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, memberId: req.member._id });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  await sendInvoicePdf(res, invoice);
});

router.get('/subscriptions/:id', async (req, res) => {
  const sub = await Subscription.findOne({ _id: req.params.id, memberId: req.member._id }).lean();
  if (!sub) throw ApiError.notFound('Membership not found');
  res.json({ success: true, data: sub });
});

export default router;
