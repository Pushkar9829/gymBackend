import { Subscription } from '../subscriptions/subscription.model.js';
import { PtPurchase } from '../pt/pt.model.js';

/** The bill (membership or PT purchase) a payment / invoice belongs to. */
export function billOf(doc) {
  if (doc.ptPurchaseId) return { Model: PtPurchase, id: doc.ptPurchaseId._id || doc.ptPurchaseId, field: 'ptPurchaseId', kind: 'pt' };
  return { Model: Subscription, id: doc.subscriptionId._id || doc.subscriptionId, field: 'subscriptionId', kind: 'subscription' };
}

export async function loadBill(doc) {
  const b = billOf(doc);
  return { ...b, bill: await b.Model.findById(b.id).lean() };
}

/** Human description of what was billed. */
export function billLabel(bill, kind) {
  if (!bill) return '-';
  return kind === 'pt' ? `PT: ${bill.package?.name} (${bill.sessionsTotal} sessions)` : bill.plan?.name;
}
