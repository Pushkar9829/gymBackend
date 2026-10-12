import { render } from './invoice.pdf.js';
import { formatINR } from '../../utils/money.js';
import { dayjs, tz } from '../../utils/dates.js';

// Thermal roll widths in PDF points (1 mm = 2.8346 pt). Height grows with the content.
export const PAPER_WIDTH = { '80mm': 226.77, '58mm': 164.4 };
export const receiptPaper = (gym) => (PAPER_WIDTH[gym?.settings?.receiptPaper] ? gym.settings.receiptPaper : 'a4');
export const isThermal = (gym) => receiptPaper(gym) !== 'a4';

/**
 * Narrow single-column receipt for 80 / 58 mm thermal printers.
 * lines: [{ name, qty?, rate?, amount }]; taxLines / extra: [{ label, amount | text }]
 */
export function thermalReceipt(gym, { title, number, date, party, lines = [], taxLines = [], totalLabel = 'TOTAL', total, extra = [], mode, receivedBy, note }) {
  const paper = receiptPaper(gym);
  const width = PAPER_WIDTH[paper];
  const margin = paper === '58mm' ? 6 : 8;
  const fs = paper === '58mm' ? 7 : 8;
  // Dashed rule as an empty one-cell table (canvas lines misplace on auto-height pages). A new node each
  // time: pdfmake keeps layout state on the node, so one object cannot be reused.
  const rule = () => ({
    table: { widths: ['*'], body: [[{ text: '', fontSize: 1 }]] },
    layout: { hLineWidth: (i) => (i === 0 ? 0.5 : 0), vLineWidth: () => 0, hLineStyle: () => ({ dash: { length: 2 } }), paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [0, 4, 0, 2],
  });
  const row = (label, value, style = {}) => ({
    columns: [
      { text: label, width: '*', ...style },
      { text: value, width: 'auto', alignment: 'right', ...style },
    ],
    columnGap: 4,
  });
  const money = (x) => (x.text != null ? x.text : formatINR(x.amount));
  const center = (text, extraStyle = {}) => ({ text, alignment: 'center', ...extraStyle });

  const content = [
    center(gym.name, { bold: true, fontSize: fs + 3 }),
    gym.address && center(gym.address),
    gym.gstin && center(`GSTIN: ${gym.gstin}`),
    gym.phone && center(`Ph: ${gym.phone}`),
    rule(),
    center(title, { bold: true, fontSize: fs + 1 }),
    { text: `No: ${number}` },
    { text: `Date: ${dayjs(date).tz(tz).format('DD-MM-YYYY hh:mm A')}` },
    party && { text: party, margin: [0, 1, 0, 0] },
    rule(),
    ...lines.flatMap((l) =>
      l.qty != null
        ? [{ text: l.name }, row(`  ${l.qty} x ${formatINR(l.rate)}`, formatINR(l.amount))]
        : [row(l.name, formatINR(l.amount))],
    ),
    ...(taxLines.length ? [rule(), ...taxLines.map((t) => row(t.label, money(t)))] : []),
    rule(),
    row(totalLabel, formatINR(total), { bold: true, fontSize: fs + 2 }),
    ...extra.map((x) => row(x.label, money(x))),
    mode && row('Paid by', String(mode).toUpperCase()),
    receivedBy && row('Received by', receivedBy),
    note && { text: note, italics: true, margin: [0, 2, 0, 0] },
    rule(),
    center('Thank you!', { bold: true }),
    gym.phone && center(`Questions? Call ${gym.phone}`),
  ].filter(Boolean);

  return render({
    pageSize: { width, height: 'auto' },
    pageMargins: [margin, margin, margin, margin + 4],
    defaultStyle: { font: 'Helvetica', fontSize: fs, lineHeight: 1.15 },
    info: { title: `${title} ${number}` },
    content,
  });
}

/** CGST + SGST halves of a tax amount (intra-state). */
export const gstLines = (taxAmount, taxPercent) => {
  if (!taxAmount) return [];
  const half = Math.round(taxAmount / 2);
  const p = taxPercent ? ` @ ${taxPercent / 2}%` : '';
  return [
    { label: `CGST${p}`, amount: half },
    { label: `SGST${p}`, amount: taxAmount - half },
  ];
};
