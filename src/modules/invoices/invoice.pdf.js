import { createRequire } from 'node:module';
import { formatINR } from '../../utils/money.js';
import { dmy } from '../../utils/dates.js';

const require = createRequire(import.meta.url);
const PdfPrinter = require('pdfmake');

// Built-in PDF fonts: no font files needed on the server.
const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

function render(docDefinition) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument({ defaultStyle: { font: 'Helvetica', fontSize: 10 }, pageMargins: [40, 40, 40, 50], ...docDefinition });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const header = (seller, title, number, date) => [
  {
    columns: [
      [
        { text: seller.name, fontSize: 16, bold: true },
        seller.branchName ? { text: seller.branchName, color: '#555' } : '',
        { text: seller.address || '', color: '#555' },
        { text: [seller.phone, seller.email].filter(Boolean).join('  |  '), color: '#555' },
        seller.gstin ? { text: `GSTIN: ${seller.gstin}`, bold: true, margin: [0, 2, 0, 0] } : '',
      ],
      [
        { text: title, fontSize: 18, bold: true, alignment: 'right', color: '#0F766E' },
        { text: `No: ${number}`, alignment: 'right' },
        { text: `Date: ${dmy(date)}`, alignment: 'right' },
      ],
    ],
  },
  { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 0.5, lineColor: '#ccc' }], margin: [0, 0, 0, 12] },
];

export function invoicePdf(invoice, { paid = 0, due = 0 } = {}) {
  const b = invoice.billedTo || {};
  const halfTax = Math.round((invoice.taxAmount || 0) / 2);
  const rows = [
    [{ text: '#', bold: true }, { text: 'Description', bold: true }, { text: 'Amount', bold: true, alignment: 'right' }],
    ...invoice.items.map((it, i) => [String(i + 1), it.description, { text: formatINR(it.amount), alignment: 'right' }]),
  ];
  const totals = [
    ['Sub total', formatINR(invoice.subTotal)],
    ...(invoice.discount ? [['Discount', `- ${formatINR(invoice.discount)}`]] : []),
    ...(invoice.taxAmount
      ? [
          [`CGST @ ${invoice.taxPercent / 2}%`, formatINR(halfTax)],
          [`SGST @ ${invoice.taxPercent / 2}%`, formatINR(invoice.taxAmount - halfTax)],
        ]
      : []),
    [{ text: 'Total', bold: true }, { text: formatINR(invoice.total), bold: true }],
    ['Paid', formatINR(paid)],
    [{ text: 'Balance due', bold: true, color: due ? '#B91C1C' : '#000' }, { text: formatINR(due), bold: true, color: due ? '#B91C1C' : '#000' }],
  ];
  return render({
    content: [
      ...header(invoice.seller || {}, 'TAX INVOICE', invoice.invoiceNo, invoice.issuedAt),
      { text: 'Billed to', bold: true },
      { text: `${b.name} (Member #${b.memberCode})` },
      { text: [b.phone, b.email].filter(Boolean).join('  |  '), color: '#555', margin: [0, 0, 0, 12] },
      { table: { headerRows: 1, widths: [20, '*', 100], body: rows }, layout: 'lightHorizontalLines' },
      {
        columns: [
          { width: '*', text: '' },
          {
            width: 230,
            table: { widths: ['*', 100], body: totals.map(([l, v]) => [l, typeof v === 'string' ? { text: v, alignment: 'right' } : { ...v, alignment: 'right' }]) },
            layout: 'noBorders',
            margin: [0, 10, 0, 0],
          },
        ],
      },
      { text: 'This is a computer generated invoice.', color: '#888', fontSize: 8, margin: [0, 30, 0, 0] },
    ],
  });
}

export function receiptPdf(payment, gym) {
  const m = payment.memberId || {};
  const s = payment.subscriptionId || {};
  const isRefund = payment.type === 'refund';
  return render({
    content: [
      ...header({ name: gym.name, address: gym.address, phone: gym.phone, email: gym.email, gstin: gym.gstin }, isRefund ? 'REFUND RECEIPT' : 'PAYMENT RECEIPT', payment.receiptNo, payment.paidAt),
      {
        table: {
          widths: [140, '*'],
          body: [
            ['Member', `${m.name} (#${m.memberCode})`],
            ['Membership', s.plan?.name ? `${s.plan.name} (${dmy(s.startDate)} to ${dmy(s.endDate)})` : '-'],
            [isRefund ? 'Amount refunded' : 'Amount received', { text: formatINR(payment.amount), bold: true }],
            ['Mode', String(payment.mode).toUpperCase()],
            ['Reference', payment.reference || '-'],
            ...(isRefund ? [['Reason', payment.note || '-']] : []),
            ['Balance due on membership', formatINR(s.dueAmount || 0)],
          ],
        },
        layout: 'lightHorizontalLines',
      },
      { text: 'Thank you!', margin: [0, 20, 0, 0] },
    ],
  });
}
