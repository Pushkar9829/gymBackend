import { render, header } from '../invoices/invoice.pdf.js';
import { formatINR } from '../../utils/money.js';

export function saleReceiptPdf(sale, gym) {
  const half = Math.round(sale.taxAmount / 2);
  const rows = [
    [{ text: 'Item', bold: true }, { text: 'Qty', bold: true, alignment: 'right' }, { text: 'Rate', bold: true, alignment: 'right' }, { text: 'Amount', bold: true, alignment: 'right' }],
    ...sale.items.map((i) => [i.name, { text: String(i.qty), alignment: 'right' }, { text: formatINR(i.unitPrice), alignment: 'right' }, { text: formatINR(i.amount), alignment: 'right' }]),
  ];
  const totals = [
    ['Sub total', formatINR(sale.subTotal)],
    ...(sale.discount ? [['Discount', `- ${formatINR(sale.discount)}`]] : []),
    ['CGST', formatINR(half)],
    ['SGST', formatINR(sale.taxAmount - half)],
    [{ text: 'Total', bold: true }, { text: formatINR(sale.total), bold: true }],
  ];
  return render({
    content: [
      ...header({ name: gym.name, address: gym.address, phone: gym.phone, email: gym.email, gstin: gym.gstin }, sale.status === 'refunded' ? 'SALE (REFUNDED)' : 'TAX INVOICE', sale.saleNo, sale.createdAt),
      { text: `Customer: ${sale.memberId ? `${sale.memberId.name} (#${sale.memberId.memberCode})` : sale.customerName || 'Walk-in'}`, margin: [0, 0, 0, 10] },
      { table: { headerRows: 1, widths: ['*', 40, 80, 90], body: rows }, layout: 'lightHorizontalLines' },
      {
        table: { widths: ['*', 100], body: totals.map(([l, v]) => [l, typeof v === 'string' ? { text: v, alignment: 'right' } : { ...v, alignment: 'right' }]) },
        layout: 'noBorders',
        margin: [280, 10, 0, 0],
      },
      { text: `Paid via ${String(sale.mode).toUpperCase()}${sale.reference ? ` (${sale.reference})` : ''}`, margin: [0, 16, 0, 0] },
      { text: 'Thank you!', margin: [0, 10, 0, 0] },
    ],
  });
}
