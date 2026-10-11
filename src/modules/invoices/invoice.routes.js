import { Router } from 'express';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { branchFilter, findInBranch } from '../../middlewares/branchScope.js';
import { paginate } from '../../utils/pagination.js';
import { Invoice } from './invoice.model.js';
import { invoicePdf } from './invoice.pdf.js';
import { loadBill } from '../payments/billing.js';

const router = Router();
router.use(requireStaff, permit('payments.read'));

router.get('/', async (req, res) => {
  const filter = { ...branchFilter(req) };
  if (req.query.memberId && mongoose.isValidObjectId(req.query.memberId)) filter.memberId = req.query.memberId;
  res.json({ success: true, data: await paginate(Invoice, filter, req.query, { sort: { issuedAt: -1 } }) });
});

router.get('/:id', async (req, res) => {
  const invoice = await findInBranch(req, Invoice, req.params.id, { notFound: 'Invoice not found' });
  const { bill } = await loadBill(invoice);
  res.json({ success: true, data: { invoice, paid: bill?.paidAmount || 0, due: bill?.dueAmount || 0 } });
});

export async function sendInvoicePdf(res, invoice) {
  const { bill } = await loadBill(invoice);
  const pdf = await invoicePdf(invoice.toObject ? invoice.toObject() : invoice, { paid: bill?.paidAmount || 0, due: bill?.dueAmount || 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNo.replace(/\//g, '-')}.pdf"`);
  res.send(pdf);
}

router.get('/:id/pdf', async (req, res) => {
  const invoice = await findInBranch(req, Invoice, req.params.id, { notFound: 'Invoice not found' });
  await sendInvoicePdf(res, invoice);
});

export default router;
