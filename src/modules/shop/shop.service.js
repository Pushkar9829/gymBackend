import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { calcTax } from '../../utils/money.js';
import { nextSeq, financialYear } from '../../utils/counter.js';
import { Product, Stock, StockMovement, Sale } from './shop.model.js';
import { Member } from '../members/member.model.js';
import { createAlert } from '../notifications/notification.service.js';

/** Adds (or removes, with negative qty) stock and records the movement. Never lets stock go below zero. */
export async function moveStock({ productId, branchId, qty, type, unitCost, saleId, note, by }) {
  const filter = { productId, branchId };
  if (qty < 0) {
    const r = await Stock.findOneAndUpdate({ ...filter, qty: { $gte: -qty } }, { $inc: { qty } }, { returnDocument: 'after' });
    if (!r) {
      const p = await Product.findById(productId).select('name').lean();
      throw ApiError.badRequest(`Not enough stock for ${p?.name || 'product'}`);
    }
  } else {
    await Stock.updateOne(filter, { $inc: { qty } }, { upsert: true });
  }
  await StockMovement.create({ productId, branchId, qty, type, unitCost, saleId, note, by });
}

/** Point-of-sale checkout: validates items, takes stock atomically, rolls back on failure. */
export async function createSale({ branchId, memberId, customerName, items, discount = 0, mode, reference, user, approvalId }) {
  if (!items?.length) throw ApiError.badRequest('Add at least one product');
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) }, isActive: true }).lean();
  const byId = Object.fromEntries(products.map((p) => [String(p._id), p]));
  const lines = items.map((i) => {
    const p = byId[String(i.productId)];
    if (!p) throw ApiError.badRequest('A product in the cart is not available');
    const amount = p.price * i.qty;
    return { productId: p._id, name: p.name, qty: i.qty, unitPrice: p.price, unitCost: p.costPrice, taxPercent: p.taxPercent, hsn: p.hsn || undefined, amount, taxAmount: calcTax(amount, p.taxPercent) };
  });
  const subTotal = lines.reduce((s, l) => s + l.amount, 0);
  if (discount < 0 || discount > subTotal) throw ApiError.badRequest('Discount cannot exceed the amount');
  // Discount reduces tax proportionally.
  const ratio = subTotal ? (subTotal - discount) / subTotal : 0;
  const taxAmount = Math.round(lines.reduce((s, l) => s + l.taxAmount, 0) * ratio);
  if (memberId && !(await Member.exists({ _id: memberId, isDeleted: false }))) throw ApiError.notFound('Member not found');

  const saleId = new mongoose.Types.ObjectId();
  const taken = [];
  try {
    for (const l of lines) {
      await moveStock({ productId: l.productId, branchId, qty: -l.qty, type: 'sale', unitCost: l.unitCost, saleId, note: 'POS sale', by: user?._id });
      taken.push(l);
    }
  } catch (err) {
    for (const l of taken) await moveStock({ productId: l.productId, branchId, qty: l.qty, type: 'adjustment', note: 'Rollback of failed sale', by: user?._id });
    throw err;
  }

  const sale = await Sale.create({
    _id: saleId,
    saleNo: `POS/${financialYear()}/${String(await nextSeq(`sale:${financialYear()}`)).padStart(5, '0')}`,
    branchId,
    memberId,
    customerName,
    items: lines,
    subTotal,
    discount,
    taxAmount,
    total: subTotal - discount + taxAmount,
    cost: lines.reduce((s, l) => s + (l.unitCost || 0) * l.qty, 0),
    mode,
    reference,
    approvalId,
    soldBy: user?._id,
  });
  await checkLowStock(branchId, lines.map((l) => l.productId));
  return sale;
}

export async function refundSale({ sale, reason, user }) {
  if (sale.status !== 'paid') throw ApiError.badRequest('Sale already refunded');
  for (const l of sale.items) await moveStock({ productId: l.productId, branchId: sale.branchId, qty: l.qty, type: 'return', saleId: sale._id, note: `Refund: ${reason}`, by: user?._id });
  sale.status = 'refunded';
  sale.refundedAt = new Date();
  sale.refundReason = reason;
  await sale.save();
  return sale;
}

async function checkLowStock(branchId, productIds) {
  const rows = await Stock.find({ branchId, productId: { $in: productIds } }).populate('productId', 'name lowStockAt').lean();
  for (const r of rows) {
    if (r.productId && r.qty <= r.productId.lowStockAt) {
      await createAlert({
        branchId,
        template: 'low-stock',
        subject: `Low stock: ${r.productId.name} (${r.qty} left)`,
        body: 'Shop → Products → Stock in',
        dedupeKey: `lowstock:${branchId}:${r.productId._id}:${r.qty}`,
      });
    }
  }
}
