import mongoose from 'mongoose';
import { addDays, parseDay, ymd } from '../../utils/dates.js';
import { Payment } from '../payments/payment.model.js';
import { Sale } from '../shop/shop.model.js';
import { LockerAllotment } from '../lockers/locker.model.js';
import { Expense } from '../expenses/expense.model.js';
import { CashClosing, CASH_MODES, DENOMINATIONS } from './cash.model.js';

const SOURCES = [
  { key: 'payments', label: 'Memberships & PT' },
  { key: 'shop', label: 'Shop sales' },
  { key: 'lockers', label: 'Locker rent & deposits' },
  { key: 'expenses', label: 'Expenses paid' },
];

/**
 * Money the system recorded for a branch on a day, by source and payment mode (paise).
 * In: payments, shop sales, locker rent/deposits. Out: refunds, shop refunds, deposits returned, expenses.
 */
export async function dayFigures(branchId, day) {
  const from = parseDay(day);
  const to = addDays(from, 1);
  const bid = new mongoose.Types.ObjectId(String(branchId));
  const [payments, sales, refundedSales, lockers, expenses] = await Promise.all([
    Payment.aggregate([
      { $match: { branchId: bid, paidAt: { $gte: from, $lt: to } } },
      { $group: { _id: { mode: '$mode', type: '$type' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
    Sale.aggregate([{ $match: { branchId: bid, createdAt: { $gte: from, $lt: to } } }, { $group: { _id: '$mode', amount: { $sum: '$total' }, n: { $sum: 1 } } }]),
    Sale.aggregate([{ $match: { branchId: bid, status: 'refunded', refundedAt: { $gte: from, $lt: to } } }, { $group: { _id: '$mode', amount: { $sum: '$total' }, n: { $sum: 1 } } }]),
    LockerAllotment.aggregate([
      { $match: { branchId: bid, 'charges.at': { $gte: from, $lt: to } } },
      { $unwind: '$charges' },
      { $match: { 'charges.at': { $gte: from, $lt: to } } },
      { $group: { _id: { mode: { $ifNull: ['$charges.mode', 'cash'] }, kind: '$charges.kind' }, amount: { $sum: '$charges.amount' }, n: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { branchId: bid, isDeleted: false, date: { $gte: from, $lt: to } } },
      { $group: { _id: { $ifNull: ['$mode', 'cash'] }, amount: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
  ]);

  const rows = {};
  const add = (key, mode, inAmt, outAmt, n) => {
    const r = (rows[`${key}:${mode}`] ||= { key, label: SOURCES.find((s) => s.key === key).label, mode, in: 0, out: 0, count: 0 });
    r.in += inAmt;
    r.out += outAmt;
    r.count += n;
  };
  for (const p of payments) add('payments', p._id.mode, p._id.type === 'payment' ? p.amount : 0, p._id.type === 'refund' ? p.amount : 0, p.n);
  for (const s of sales) add('shop', s._id, s.amount, 0, s.n);
  for (const s of refundedSales) add('shop', s._id, 0, s.amount, s.n);
  for (const l of lockers) add('lockers', l._id.mode, l._id.kind === 'deposit-return' ? 0 : l.amount, l._id.kind === 'deposit-return' ? l.amount : 0, l.n);
  for (const e of expenses) add('expenses', e._id, 0, e.amount, e.n);

  const sources = Object.values(rows).sort((a, b) => SOURCES.findIndex((s) => s.key === a.key) - SOURCES.findIndex((s) => s.key === b.key) || CASH_MODES.indexOf(a.mode) - CASH_MODES.indexOf(b.mode));
  const byMode = Object.fromEntries(CASH_MODES.map((m) => [m, { in: 0, out: 0, count: 0 }]));
  for (const r of sources) {
    const t = (byMode[r.mode] ||= { in: 0, out: 0, count: 0 });
    t.in += r.in;
    t.out += r.out;
    t.count += r.count;
  }
  return { sources, byMode };
}

/** Opening float suggestion: what was kept in the drawer at the last closing before this day. */
export async function suggestedFloat(branchId, day) {
  const prev = await CashClosing.findOne({ branchId, day: { $lt: day }, status: 'closed' }).sort({ day: -1 }).lean();
  return prev ? { amount: prev.floatKept || 0, fromDay: prev.day } : { amount: 0, fromDay: null };
}

/** Total of counted notes and coins (paise). */
export function countDenominations(d = {}) {
  return DENOMINATIONS.reduce((s, n) => s + (Number(d[`n${n}`]) || 0) * n * 100, 0) + (Number(d.coins) || 0);
}

/** Expected cash and difference for a count. */
export function cashMath({ openingFloat = 0, byMode, countedCash }) {
  const cashIn = byMode.cash?.in || 0;
  const cashOut = byMode.cash?.out || 0;
  const expectedCash = openingFloat + cashIn - cashOut;
  return { cashIn, cashOut, expectedCash, difference: countedCash - expectedCash };
}

/** Net per non-cash mode vs. what the statement says. */
export function statementMatch(byMode, statement = {}) {
  return ['upi', 'card', 'bank', 'online'].map((mode) => {
    const net = (byMode[mode]?.in || 0) - (byMode[mode]?.out || 0);
    const entered = statement?.[mode];
    return { mode, system: net, statement: entered ?? null, difference: entered == null ? null : entered - net };
  });
}

export const todayYmd = () => ymd(new Date());
