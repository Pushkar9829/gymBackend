import { render, header } from '../invoices/invoice.pdf.js';
import { formatINR } from '../../utils/money.js';
import { dayjs } from '../../utils/dates.js';

export function payslipPdf(p, gym) {
  const u = p.userId || {};
  const earnings = [
    [`Basic pay (${p.salaryType === 'per-day' ? `${formatINR(p.rate)} x days` : `${formatINR(p.rate)} / month`})`, p.basePay],
    ...(p.ptCommission ? [[`PT commission (${p.ptSessions} sessions)`, p.ptCommission]] : []),
    ...(p.additions || []).map((a) => [a.label, a.amount]),
  ];
  const deductions = (p.deductions || []).map((d) => [d.label, d.amount]);
  const rows = (list) => list.map(([l, v]) => [l, { text: formatINR(v), alignment: 'right' }]);
  const month = dayjs(`${p.month}-01`).format('MMMM YYYY');
  return render({
    content: [
      ...header({ name: gym.name, address: gym.address, phone: gym.phone, email: gym.email, gstin: gym.gstin }, 'PAYSLIP', month, new Date()),
      {
        table: {
          widths: [140, '*'],
          body: [
            ['Employee', `${u.name || '-'}${u.role ? ` (${u.role})` : ''}`],
            ['Staff ID', String(u.devicePin || '-')],
            ['Working days', String(p.workingDays)],
            ['Days present', `${p.daysPresent}${p.paidLeaveDays ? ` + ${p.paidLeaveDays} paid leave` : ''}`],
          ],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 12],
      },
      {
        columns: [
          { width: '*', stack: [{ text: 'Earnings', bold: true, margin: [0, 0, 0, 4] }, { table: { widths: ['*', 90], body: rows(earnings) }, layout: 'lightHorizontalLines' }] },
          { width: 20, text: '' },
          {
            width: '*',
            stack: [
              { text: 'Deductions', bold: true, margin: [0, 0, 0, 4] },
              deductions.length ? { table: { widths: ['*', 90], body: rows(deductions) }, layout: 'lightHorizontalLines' } : { text: 'None', color: '#888' },
            ],
          },
        ],
      },
      {
        table: {
          widths: ['*', 120],
          body: [
            ['Gross pay', { text: formatINR(p.grossPay), alignment: 'right' }],
            [{ text: 'Net pay', bold: true }, { text: formatINR(p.netPay), bold: true, alignment: 'right' }],
          ],
        },
        layout: 'noBorders',
        margin: [250, 16, 0, 0],
      },
      p.status === 'paid'
        ? { text: `Paid on ${dayjs(p.paidAt).format('DD MMM YYYY')} via ${String(p.paymentMode).toUpperCase()}${p.reference ? ` (${p.reference})` : ''}`, margin: [0, 20, 0, 0] }
        : { text: `Status: ${p.status}`, color: '#B45309', margin: [0, 20, 0, 0] },
      { text: 'This is a computer generated payslip.', color: '#888', fontSize: 8, margin: [0, 20, 0, 0] },
    ],
  });
}
