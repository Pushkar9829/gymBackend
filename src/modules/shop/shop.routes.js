import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { branchFilter, assertBranchAccess, findInBranch } from '../../middlewares/branchScope.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate, escapeRegex } from '../../utils/pagination.js';
import { parseDay, addDays } from '../../utils/dates.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees } from '../../utils/money.js';
import { Product, Stock, StockMovement, Sale, PRODUCT_CATEGORIES } from './shop.model.js';
import { moveStock, createSale, refundSale } from './shop.service.js';
import { saleReceiptPdf } from './sale.pdf.js';
import { getGym } from '../settings/gym.model.js';
import { audit } from '../audit/audit.model.js';
import { withDiscountGuard } from '../approvals/approval.service.js';

const router = Router();
router.use(requireStaff);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const productBody = z.object({
  name: z.string().trim().min(2).max(80),
  sku: z.string().trim().max(30).optional().or(z.literal('').transform(() => undefined)),
  category: z.enum(PRODUCT_CATEGORIES).optional(),
  price: z.number().int().min(0),
  costPrice: z.number().int().min(0).optional(),
  taxPercent: z.number().min(0).max(50).optional(),
  lowStockAt: z.number().int().min(0).optional(),
  imageUrl: z.string().url().optional().or(z.literal('')),
  hsn: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})?$/, 'HSN code is 4, 6 or 8 digits').optional(),
  isActive: z.boolean().optional(),
});

/* ---------- Products + stock ---------- */
router.get('/products', permit('shop.sell'), async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(String(req.query.search)), 'i');
    filter.$or = [{ name: rx }, { sku: rx }];
  }
  const products = await Product.find(filter).sort({ name: 1 }).lean();
  // Stock for the branches in view
  const stocks = await Stock.find({ productId: { $in: products.map((p) => p._id) }, ...branchFilter(req) }).lean();
  const qty = {};
  for (const s of stocks) qty[String(s.productId)] = (qty[String(s.productId)] || 0) + s.qty;
  res.json({ success: true, data: products.map((p) => ({ ...p, stock: qty[String(p._id)] || 0, low: (qty[String(p._id)] || 0) <= p.lowStockAt })) });
});

router.post('/products', permit('shop.manage'), validate({ body: productBody }), async (req, res) => {
  const p = await Product.create(req.body);
  await audit(req, 'shop.product.create', { entity: 'Product', entityId: p._id });
  res.status(201).json({ success: true, data: p });
});

router.put('/products/:id', permit('shop.manage'), validate({ body: productBody.partial() }), async (req, res) => {
  const p = await Product.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
  if (!p) throw ApiError.notFound('Product not found');
  res.json({ success: true, data: p });
});

// Stock in (purchase from supplier) or adjustment (count correction, damage)
router.post(
  '/products/:id/stock',
  permit('shop.manage'),
  validate({
    body: z.object({
      branchId: objectId,
      qty: z.number().int().refine((n) => n !== 0, 'Quantity cannot be 0'),
      type: z.enum(['purchase', 'adjustment']),
      unitCost: z.number().int().min(0).optional(),
      note: z.string().max(200).optional(),
    }),
  }),
  async (req, res) => {
    assertBranchAccess(req, req.body.branchId);
    if (req.body.type === 'purchase' && req.body.qty < 0) throw ApiError.badRequest('Purchase quantity must be positive');
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    await moveStock({ productId: product._id, ...req.body, by: req.user._id });
    if (req.body.type === 'purchase' && req.body.unitCost != null) {
      product.costPrice = req.body.unitCost;
      await product.save();
    }
    await audit(req, 'shop.stock', { entity: 'Product', entityId: product._id, branchId: req.body.branchId, details: req.body });
    const stock = await Stock.findOne({ productId: product._id, branchId: req.body.branchId }).lean();
    res.json({ success: true, data: { qty: stock?.qty || 0 } });
  },
);

router.get('/products/:id/movements', permit('shop.manage'), async (req, res) => {
  const data = await paginate(StockMovement, { productId: req.params.id, ...branchFilter(req) }, req.query, { sort: { createdAt: -1 }, populate: { path: 'by', select: 'name' } });
  res.json({ success: true, data });
});

/* ---------- Sales (POS) ---------- */
router.post(
  '/sales',
  permit('shop.sell'),
  validate({
    body: z.object({
      branchId: objectId,
      memberId: objectId.optional().nullable(),
      customerName: z.string().trim().max(80).optional(),
      items: z.array(z.object({ productId: objectId, qty: z.number().int().min(1).max(500) })).min(1).max(50),
      discount: z.number().int().min(0).default(0),
      mode: z.enum(['cash', 'upi', 'card', 'bank']),
      reference: z.string().trim().max(100).optional(),
      approvalId: objectId.optional(),
    }),
  }),
  async (req, res) => {
    assertBranchAccess(req, req.body.branchId);
    const { approvalId, ...body } = req.body;
    const memberId = body.memberId || undefined;
    const { result: sale, done } = await withDiscountGuard(
      req,
      { kind: 'shop', branchId: body.branchId, memberId, discount: body.discount, approvalId, items: body.items },
      (approval) => createSale({ ...body, memberId, approvalId: approval?._id, user: req.user }),
      'Sale',
    );
    await done(sale._id);
    res.status(201).json({ success: true, data: sale });
  },
);

function salesFilter(req) {
  const q = req.query;
  const filter = { ...branchFilter(req) };
  if (q.memberId && mongoose.isValidObjectId(q.memberId)) filter.memberId = q.memberId;
  if (q.status) filter.status = String(q.status);
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = parseDay(String(q.from));
    if (q.to) filter.createdAt.$lt = addDays(parseDay(String(q.to)), 1);
  }
  return filter;
}

router.get('/sales', permit('shop.sell'), async (req, res) => {
  const filter = salesFilter(req);
  if (isExport(req.query)) {
    const rows = await Sale.find(filter).sort({ createdAt: -1 }).limit(20000).populate('memberId', 'name memberCode').lean();
    return sendExport(res, req.query.export, 'shop-sales', rows, [
      { label: 'Sale', key: 'saleNo' },
      { label: 'Date', value: (r) => r.createdAt },
      { label: 'Customer', value: (r) => r.memberId?.name || r.customerName || 'Walk-in' },
      { label: 'Items', value: (r) => r.items.map((i) => `${i.name} x${i.qty}`).join('; ') },
      { label: 'Total (Rs)', value: (r) => toRupees(r.total) },
      { label: 'Mode', key: 'mode' },
      { label: 'Status', key: 'status' },
    ]);
  }
  const paid = { ...filter, status: 'paid' };
  const [data, summary, top] = await Promise.all([
    paginate(Sale, filter, req.query, { sort: { createdAt: -1 }, populate: [{ path: 'memberId', select: 'name memberCode' }, { path: 'soldBy', select: 'name' }] }),
    Sale.aggregate([{ $match: paid }, { $group: { _id: null, revenue: { $sum: '$total' }, tax: { $sum: '$taxAmount' }, cost: { $sum: '$cost' }, count: { $sum: 1 } } }]),
    Sale.aggregate([
      { $match: paid },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', qty: { $sum: '$items.qty' }, amount: { $sum: '$items.amount' } } },
      { $sort: { qty: -1 } },
      { $limit: 5 },
    ]),
  ]);
  const s = summary[0] || { revenue: 0, tax: 0, cost: 0, count: 0 };
  res.json({ success: true, data: { ...data, summary: { ...s, profit: s.revenue - s.tax - s.cost }, top } });
});

router.post('/sales/:id/refund', permit('payments.refund'), validate({ body: z.object({ reason: z.string().trim().min(2).max(200) }) }), async (req, res) => {
  const sale = await findInBranch(req, Sale, req.params.id, { notFound: 'Sale not found' });
  const r = await refundSale({ sale, reason: req.body.reason, user: req.user });
  await audit(req, 'shop.refund', { entity: 'Sale', entityId: sale._id, branchId: sale.branchId, details: { reason: req.body.reason, total: sale.total } });
  res.json({ success: true, data: r });
});

router.get('/sales/:id/receipt.pdf', permit('shop.sell'), async (req, res) => {
  const sale = await findInBranch(req, Sale, req.params.id, { notFound: 'Sale not found' });
  await sale.populate('memberId', 'name memberCode');
  const pdf = await saleReceiptPdf(sale.toObject(), await getGym());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sale.saleNo.replace(/\//g, '-')}.pdf"`);
  res.send(pdf);
});

export default router;
