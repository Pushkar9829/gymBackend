import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { api, setupDb, login, auth, teardown } from './helpers.js';
import { stateOf, splitTax, allocate, gstinFromInvoice, buildSupplies, gstr1, posLabel } from '../src/modules/reports/gst.js';
import { Gym } from '../src/modules/settings/gym.model.js';

/* ---------------- Pure GST helpers ---------------- */
test('state code from GSTIN; invalid GSTINs are ignored', () => {
  assert.equal(stateOf('29ABCDE1234F1Z5'), '29');
  assert.equal(stateOf('27aaaca1234a1z5'), '27');
  assert.equal(stateOf('ABC'), null);
  assert.equal(stateOf(''), null);
  assert.equal(posLabel('29'), '29-Karnataka');
});

test('intra-state: CGST + SGST (odd paisa to CGST); inter-state: IGST', () => {
  assert.deepEqual(splitTax(18001, { gymState: '29' }), { pos: '29', intra: true, igst: 0, cgst: 9001, sgst: 9000 });
  assert.deepEqual(splitTax(18001, { gymState: '29', customerGstin: '29AAACA1234A1Z5' }), { pos: '29', intra: true, igst: 0, cgst: 9001, sgst: 9000 });
  assert.deepEqual(splitTax(18001, { gymState: '29', customerGstin: '27AAACA1234A1Z5' }), { pos: '27', intra: false, igst: 18001, cgst: 0, sgst: 0 });
  // Unknown gym state (no GSTIN in settings): treated as local.
  assert.equal(splitTax(100, { gymState: null, customerGstin: '27AAACA1234A1Z5' }).cgst, 50);
});

test('allocation always adds up exactly', () => {
  for (const [total, w] of [[1000, [1, 1, 1]], [7, [3, 0, 5]], [99999, [12345, 67890, 1]], [0, [1, 2]]]) {
    const parts = allocate(total, w);
    assert.equal(parts.reduce((s, p) => s + p, 0), total);
    w.forEach((x, i) => x === 0 && assert.equal(parts[i], 0));
  }
});

test('customer GSTIN on old invoices is read from the billed-to address', () => {
  assert.equal(gstinFromInvoice({ billedTo: { address: 'Pune | GSTIN: 27AAACA1234A1Z5' } }), '27AAACA1234A1Z5');
  assert.equal(gstinFromInvoice({ billedTo: { gstin: '29AAACA1234A1Z5', address: 'x' } }), '29AAACA1234A1Z5');
  assert.equal(gstinFromInvoice({ billedTo: { address: 'MG Road' } }), null);
});

test('GSTR-1 sections and totals from invoices and shop sales', () => {
  const invoices = [
    { invoiceNo: 'INV/1', subTotal: 120000, discount: 20000, taxPercent: 18, taxAmount: 18000, total: 118000, billedTo: { name: 'Asha' }, subscriptionId: 'x' },
    { invoiceNo: 'INV/2', subTotal: 100000, discount: 0, taxPercent: 18, taxAmount: 18000, total: 118000, billedTo: { name: 'Acme', gstin: '27AAACA1234A1Z5' }, subscriptionId: 'y' },
    { invoiceNo: 'INV/3', subTotal: 500000, discount: 0, taxPercent: 18, taxAmount: 90000, total: 590000, billedTo: { name: 'Ravi' }, ptPurchaseId: 'z' },
  ];
  const sales = [
    {
      saleNo: 'POS/1', subTotal: 30000, discount: 3000, taxAmount: 4320, total: 31320, mode: 'cash',
      items: [{ name: 'Whey', qty: 1, amount: 20000, taxAmount: 3600, taxPercent: 18, hsn: '2106' }, { name: 'Bar', qty: 2, amount: 10000, taxAmount: 1200, taxPercent: 12 }],
    },
  ];
  const docs = buildSupplies({ invoices, sales, gymState: '29' });
  const sale = docs.find((d) => d.no === 'POS/1');
  assert.equal(sale.lines.reduce((s, l) => s + l.taxable, 0), 27000);
  assert.equal(sale.lines.reduce((s, l) => s + l.tax, 0), 4320);
  const r = gstr1(docs);
  assert.equal(r.b2b.length, 1);
  assert.deepEqual([r.b2b[0].gstin, r.b2b[0].pos, r.b2b[0].taxable, r.b2b[0].rate], ['27AAACA1234A1Z5', '27', 100000, 18]);
  assert.equal(r.totals.igst, 18000);
  assert.equal(r.totals.cgst + r.totals.sgst, 18000 + 90000 + 4320);
  assert.equal(r.totals.taxable, 100000 + 100000 + 500000 + 27000);
  assert.equal(r.totals.invoiceValue, 118000 * 2 + 590000 + 31320);
  const b2cs18 = r.b2cs.find((x) => x.rate === 18);
  assert.equal(b2cs18.pos, '29');
  assert.equal(b2cs18.taxable, 100000 + 500000 + sale.lines[0].taxable);
  const sac = r.hsn.find((h) => h.hsn === '999723');
  assert.deepEqual([sac.qty, sac.taxable, sac.igst], [3, 700000, 18000]);
  assert.ok(r.hsn.some((h) => h.hsn === '' && h.desc === 'HSN not set on product'));
  // Columns add up across the hsn sheet too.
  assert.equal(r.hsn.reduce((s, h) => s + h.cgst + h.sgst + h.igst, 0), 18000 * 2 + 90000 + 4320);
});

/* ---------------- API ---------------- */
let ctx;
let owner;
let rec;
before(async () => {
  ctx = await setupDb();
  [owner, rec] = await Promise.all([login('owner@t.com'), login('rec@t.com')]);
  await Gym.updateOne({}, { gstin: '29ABCDE1234F1Z5' });
  const main = String(ctx.main._id);
  const co = await api().post('/api/v1/companies').set(auth(owner)).send({ name: 'Mumbai Corp', gstin: '27AAACA1234A1Z5', discountPercent: 0, billTo: 'company' });
  const emp = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: main, name: 'Employee', phone: '9330000001', companyId: co.body.data._id })).body.data;
  const walk = (await api().post('/api/v1/members').set(auth(owner)).send({ branchId: main, name: 'Walk In', phone: '9330000002' })).body.data;
  // Rs 1200 each (Rs 1000 plan + Rs 200 joining) + 18%
  await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: emp._id, planId: String(ctx.monthly._id), payment: { amount: 141600, mode: 'bank' } });
  const s2 = await api().post('/api/v1/subscriptions').set(auth(owner)).send({ memberId: walk._id, planId: String(ctx.monthly._id), payment: { amount: 141600, mode: 'upi' } });
  await api().post(`/api/v1/payments/${s2.body.data.payment._id}/refund`).set(auth(owner)).send({ amount: 10000, mode: 'upi', reason: 'Goodwill' });
  const bad = await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Bad', price: 100, hsn: 'abc' });
  assert.equal(bad.status, 400);
  const whey = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Whey', price: 200000, taxPercent: 18, hsn: '2106' })).body.data;
  const bar = (await api().post('/api/v1/shop/products').set(auth(owner)).send({ name: 'Bar', price: 10000, taxPercent: 12 })).body.data;
  for (const p of [whey, bar]) await api().post(`/api/v1/shop/products/${p._id}/stock`).set(auth(owner)).send({ branchId: main, qty: 10, type: 'purchase' });
  const sale = await api().post('/api/v1/shop/sales').set(auth(owner)).send({ branchId: main, items: [{ productId: whey._id, qty: 1 }, { productId: bar._id, qty: 2 }], discount: 1000, mode: 'cash' });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
});
after(teardown);

const readBook = async (res) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
};
const binary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

test('GSTR-1: company GSTIN from another state is B2B with IGST; others CGST + SGST', async () => {
  assert.equal((await api().get('/api/v1/reports/gstr1').set(auth(rec))).status, 403);
  const r = await api().get('/api/v1/reports/gstr1').set(auth(owner));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.gymState, '29-Karnataka');
  assert.equal(d.b2b, 1);
  assert.equal(d.totals.igst, 21600);
  // Walk-in membership tax 21600 + shop tax: whey 36000 + bars 2400, less the discount share
  assert.equal(d.totals.cgst + d.totals.sgst, 21600 + Math.round((36000 + 2400) * (219000 / 220000)));
  assert.equal(d.totals.documents, 3);
  assert.deepEqual(d.refunds, { count: 1, amount: 10000 });
  assert.ok(d.hsn.some((h) => h.hsn === '2106'));

  const x = await binary(api().get('/api/v1/reports/gstr1?export=xlsx').set(auth(owner)));
  assert.match(x.headers['content-type'], /spreadsheetml/);
  const wb = await readBook(x);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['summary', 'b2b', 'b2cs', 'hsn', 'docs', 'refunds']);
  const b2b = wb.getWorksheet('b2b');
  assert.equal(b2b.getRow(2).getCell(1).value, '27AAACA1234A1Z5');
  assert.equal(b2b.getRow(2).getCell(6).value, '27-Maharashtra');
  assert.equal(b2b.getRow(2).getCell(12).value, 1200);
  assert.equal(wb.getWorksheet('refunds').getRow(2).getCell(6).value, 100);
});

test('Tally: one sales voucher per invoice / sale, plus receipts', async () => {
  const r = await api().get('/api/v1/reports/tally').set(auth(owner));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.vouchers, 3);
  const ledgers = Object.fromEntries(r.body.data.byLedger.map((l) => [l.ledger, l]));
  assert.equal(ledgers.Membership.count, 2);
  assert.equal(ledgers.Membership.total, 283200);
  assert.equal(ledgers.Shop.taxable, 219000);
  assert.equal(r.body.data.received, 141600 * 2 - 10000);
  const x = await binary(api().get('/api/v1/reports/tally?export=xlsx').set(auth(owner)));
  const wb = await readBook(x);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Sales register', 'Receipts']);
  const sheet = wb.getWorksheet('Sales register');
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header, ['Date', 'Voucher No', 'Party Name', 'Party GSTIN', 'Ledger', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total', 'Payment Mode']);
  const company = sheet.getRows(2, 3).find((row) => row.getCell(4).value === '27AAACA1234A1Z5');
  assert.deepEqual([company.getCell(3).value, company.getCell(9).value, company.getCell(10).value, company.getCell(11).value], ['Mumbai Corp', 216, 1416, 'bank']);
  const csv = await api().get('/api/v1/reports/tally?export=csv').set(auth(owner));
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Voucher No/);
});
