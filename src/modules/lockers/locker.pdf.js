import { render, header } from '../invoices/invoice.pdf.js';
import { isThermal, thermalReceipt } from '../invoices/thermal.pdf.js';
import { formatINR } from '../../utils/money.js';
import { dmy } from '../../utils/dates.js';

const LABEL = { rent: 'Rent', deposit: 'Deposit (refundable)', 'deposit-return': 'Deposit returned' };

/** Receipt for the charges that share one receipt number on a locker allotment (allot / extend / deposit return). */
export function lockerReceiptPdf(allotment, receiptNo, gym) {
  const charges = allotment.charges.filter((c) => c.receiptNo === receiptNo);
  const locker = allotment.lockerId || {};
  const m = allotment.memberId || {};
  const isReturn = charges.every((c) => c.kind === 'deposit-return');
  const title = isReturn ? 'DEPOSIT REFUND' : 'LOCKER RECEIPT';
  const lineName = (c) => `Locker ${locker.number || ''} ${LABEL[c.kind]}${c.kind === 'rent' && c.from ? ` (${dmy(c.from)} to ${dmy(c.to)})` : ''}`.replace(/\s+/g, ' ');
  const total = charges.reduce((s, c) => s + c.amount, 0);
  const first = charges[0] || {};
  if (isThermal(gym)) {
    return thermalReceipt(gym, {
      title,
      number: receiptNo,
      date: first.at,
      party: `Member: ${m.name || '-'} (#${m.memberCode || '-'})`,
      lines: charges.map((c) => ({ name: lineName(c), amount: c.amount })),
      totalLabel: isReturn ? 'RETURNED' : 'TOTAL',
      total,
      mode: first.mode,
      receivedBy: first.by?.name,
      note: first.reference ? `Ref: ${first.reference}` : undefined,
    });
  }
  return render({
    content: [
      ...header({ name: gym.name, address: gym.address, phone: gym.phone, email: gym.email, gstin: gym.gstin }, title, receiptNo, first.at),
      { text: `Member: ${m.name} (#${m.memberCode})`, margin: [0, 0, 0, 10] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 110],
          body: [
            [{ text: 'Description', bold: true }, { text: 'Amount', bold: true, alignment: 'right' }],
            ...charges.map((c) => [lineName(c), { text: formatINR(c.amount), alignment: 'right' }]),
            [{ text: isReturn ? 'Total returned' : 'Total received', bold: true }, { text: formatINR(total), bold: true, alignment: 'right' }],
          ],
        },
        layout: 'lightHorizontalLines',
      },
      { text: `Mode: ${String(first.mode || '-').toUpperCase()}${first.reference ? ` (${first.reference})` : ''}${first.by?.name ? `  |  Received by ${first.by.name}` : ''}`, margin: [0, 12, 0, 0] },
      { text: 'Thank you!', margin: [0, 16, 0, 0] },
    ],
  });
}
