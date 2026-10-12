import { ApiError } from '../../utils/ApiError.js';
import { calcTax } from '../../utils/money.js';
import { addDays, parseDay, startOfDay, ymd } from '../../utils/dates.js';
import { PtPackage, PtPurchase, PtSession } from './pt.model.js';
import { Member } from '../members/member.model.js';
import { User } from '../users/user.model.js';
import { Branch } from '../branches/branch.model.js';
import { Invoice } from '../invoices/invoice.model.js';
import { getGym } from '../settings/gym.model.js';
import { nextInvoiceNo, recordPayment } from '../subscriptions/subscription.service.js';
import { inBackground, sendInvoiceEmail } from '../notifications/emails.js';

export async function sellPackage({ memberId, packageId, trainerId, startDate, discount = 0, payment, user, approvalId }) {
  const [member, pkg, trainer, gym] = await Promise.all([
    Member.findOne({ _id: memberId, isDeleted: false }).lean(),
    PtPackage.findOne({ _id: packageId, isActive: true }).lean(),
    User.findOne({ _id: trainerId, role: 'trainer', isActive: true }).lean(),
    getGym(),
  ]);
  if (!member) throw ApiError.notFound('Member not found');
  if (!pkg) throw ApiError.notFound('PT package not found or inactive');
  if (!trainer) throw ApiError.badRequest('Choose an active trainer');
  if (!trainer.branchIds.map(String).includes(String(member.branchId))) throw ApiError.badRequest('Trainer does not work at the member’s branch');
  if (discount < 0 || discount > pkg.price) throw ApiError.badRequest('Discount cannot exceed the price');

  const validFrom = startDate ? parseDay(startDate) : startOfDay();
  const validTo = addDays(validFrom, pkg.validityDays - 1);
  const taxPercent = pkg.taxPercent ?? gym.taxPercent ?? 0;
  const taxable = pkg.price - discount;
  const taxAmount = calcTax(taxable, taxPercent);

  const purchase = await PtPurchase.create({
    memberId: member._id,
    branchId: member.branchId,
    trainerId: trainer._id,
    packageId: pkg._id,
    package: { name: pkg.name, sessions: pkg.sessions, validityDays: pkg.validityDays, price: pkg.price },
    sessionsTotal: pkg.sessions,
    validFrom,
    validTo,
    price: pkg.price,
    discount,
    taxPercent,
    taxAmount,
    totalAmount: taxable + taxAmount,
    dueAmount: taxable + taxAmount,
    approvalId,
    createdBy: user?._id,
  });

  const branch = await Branch.findById(member.branchId).lean();
  const invoice = await Invoice.create({
    invoiceNo: await nextInvoiceNo(gym),
    memberId: member._id,
    branchId: member.branchId,
    ptPurchaseId: purchase._id,
    items: [{ description: `Personal training: ${pkg.name} - ${pkg.sessions} sessions with ${trainer.name} (valid ${ymd(validFrom)} to ${ymd(validTo)})`, amount: pkg.price }],
    subTotal: pkg.price,
    discount,
    taxPercent,
    taxAmount,
    total: purchase.totalAmount,
    billedTo: { name: member.name, phone: member.phone, email: member.email, memberCode: member.memberCode, address: member.address },
    seller: { name: gym.name, gstin: gym.gstin, address: branch?.address || gym.address, phone: branch?.phone || gym.phone, email: gym.email, branchName: branch?.name },
  });
  purchase.invoiceId = invoice._id;
  await purchase.save();

  let firstPayment = null;
  if (payment?.amount > 0) ({ payment: firstPayment } = await recordPayment({ sub: purchase, ...payment, user, gym, kind: 'pt' }));
  await inBackground('pt-invoice-email', () => sendInvoiceEmail(invoice._id));
  return { purchase: await PtPurchase.findById(purchase._id).lean(), invoice, payment: firstPayment };
}

/** Per-session trainer commission (paise): pre-tax price share x trainer's commission %. */
const sessionCommission = (purchase, trainer) =>
  Math.round(((purchase.price - purchase.discount) / purchase.sessionsTotal) * ((trainer?.ptCommissionPercent || 0) / 100));

/** Logs a session (done or no-show) and consumes one session atomically. */
export async function logSession({ purchaseId, at = new Date(), status = 'done', notes, user }) {
  const today = ymd(at);
  const purchase = await PtPurchase.findOneAndUpdate(
    { _id: purchaseId, status: 'active', $expr: { $lt: ['$sessionsUsed', '$sessionsTotal'] } },
    { $inc: { sessionsUsed: 1 } },
    { returnDocument: 'after' },
  );
  if (!purchase) throw ApiError.badRequest('No sessions left on this package, or it is cancelled');
  if (today < ymd(purchase.validFrom) || today > ymd(purchase.validTo)) {
    await PtPurchase.updateOne({ _id: purchase._id }, { $inc: { sessionsUsed: -1 } });
    throw ApiError.badRequest(`Package is valid from ${ymd(purchase.validFrom)} to ${ymd(purchase.validTo)}`);
  }
  const trainer = await User.findById(purchase.trainerId).lean();
  const session = await PtSession.create({
    ptPurchaseId: purchase._id,
    memberId: purchase.memberId,
    trainerId: purchase.trainerId,
    branchId: purchase.branchId,
    at,
    status,
    notes,
    commission: sessionCommission(purchase, trainer),
    createdBy: user?._id,
  });
  return { session, purchase };
}

/** Undo a wrongly logged session (within 48 hours) and give the session back. */
export async function undoSession({ sessionId }) {
  const s = await PtSession.findById(sessionId);
  if (!s) throw ApiError.notFound('Session not found');
  if (Date.now() - s.createdAt.getTime() > 48 * 3600 * 1000) throw ApiError.badRequest('Sessions can only be undone within 48 hours');
  await s.deleteOne();
  await PtPurchase.updateOne({ _id: s.ptPurchaseId, sessionsUsed: { $gt: 0 } }, { $inc: { sessionsUsed: -1 } });
}
