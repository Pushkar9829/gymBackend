import ExcelJS from 'exceljs';

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);

/** columns: [{ key, label, value?(row) }] */
export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => cell(valueOf(c, r))).join(','));
  return [header, ...lines].join('\n');
}

export function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(rows, columns));
}

export async function sendXlsx(res, filename, rows, columns) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.columns = columns.map((c) => ({ header: c.label, key: c.label, width: Math.max(12, c.label.length + 4) }));
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c.label, valueOf(c, r) ?? ''])));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

export const isExport = (q) => q?.export === 'csv' || q?.export === 'xlsx';

/** ?export=csv | xlsx. `name` has no extension. */
export function sendExport(res, format, name, rows, columns) {
  return format === 'xlsx' ? sendXlsx(res, `${name}.xlsx`, rows, columns) : sendCsv(res, `${name}.csv`, rows, columns);
}
