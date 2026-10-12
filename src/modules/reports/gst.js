// GST helpers for the GSTR-1 and Tally exports. All money is integer paise.

export const STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli & Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

// SAC for gym / health club services (memberships and personal training).
export const GYM_SAC = '999723';

const GSTIN_RX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
export const isGstin = (v) => GSTIN_RX.test(String(v || '').trim().toUpperCase());

/** Two-digit state code from a GSTIN, or null. */
export const stateOf = (gstin) => (isGstin(gstin) ? String(gstin).trim().slice(0, 2) : null);

/** "29-Karnataka" as the GST offline tool writes the place of supply. */
export const posLabel = (code) => (code ? `${code}-${STATES[code] || 'Unknown'}` : '');

/** GSTIN printed on older invoices only inside the billed-to address ("... | GSTIN: 29ABC..."). */
export function gstinFromInvoice(inv) {
  if (isGstin(inv?.billedTo?.gstin)) return inv.billedTo.gstin.trim().toUpperCase();
  const m = String(inv?.billedTo?.address || '').match(/GSTIN:\s*([0-9A-Z]{15})/i);
  return m && isGstin(m[1]) ? m[1].toUpperCase() : null;
}

/**
 * Splits the tax of one supply. Place of supply = customer's GSTIN state, else the gym's state.
 * Same state as the gym: CGST + SGST (halves, the odd paisa goes to CGST); other state: IGST.
 */
export function splitTax(tax, { gymState, customerGstin }) {
  const pos = stateOf(customerGstin) || gymState || null;
  const intra = !gymState || !pos || pos === gymState;
  if (!intra) return { pos, intra, igst: tax, cgst: 0, sgst: 0 };
  const sgst = Math.floor(tax / 2);
  return { pos, intra, igst: 0, cgst: tax - sgst, sgst };
}

/**
 * Spreads a whole-bill amount (e.g. a sale discount) over lines in proportion to their value,
 * so the parts always add up to the total exactly.
 */
export function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((s, p) => s + p, 0);
  for (let i = 0; left > 0; i = (i + 1) % parts.length) {
    if (weights[i]) {
      parts[i] += 1;
      left -= 1;
    }
  }
  return parts;
}

/**
 * Turns invoices and shop sales into GST lines: one line per (document, rate, HSN).
 * docs: [{ kind: 'invoice'|'sale', no, date, party, gstin, ledger, lines: [{ hsn, desc, uqc, qty, taxable, tax, rate }], total, mode }]
 */
export function buildSupplies({ invoices = [], sales = [], gymState }) {
  const docs = [];
  for (const inv of invoices) {
    const gstin = gstinFromInvoice(inv);
    const taxable = (inv.subTotal || 0) - (inv.discount || 0);
    const split = splitTax(inv.taxAmount || 0, { gymState, customerGstin: gstin });
    docs.push({
      kind: 'invoice',
      no: inv.invoiceNo,
      date: inv.issuedAt || inv.createdAt,
      party: inv.billedTo?.name,
      gstin,
      ledger: inv.ptPurchaseId ? 'Personal training' : 'Membership',
      total: inv.total || 0,
      ...split,
      lines: [{ hsn: GYM_SAC, desc: inv.ptPurchaseId ? 'Personal training' : 'Gym membership', uqc: 'NA', qty: 1, taxable, tax: inv.taxAmount || 0, rate: inv.taxPercent || 0, ...split }],
    });
  }
  for (const s of sales) {
    // The bill discount and the bill's rounded GST are spread over the items so every column adds up to the bill.
    const amounts = s.items.map((i) => i.amount || 0);
    const disc = allocate(s.discount || 0, amounts);
    const taxes = allocate(s.taxAmount || 0, s.items.map((i) => i.taxAmount || 0));
    const lines = s.items.map((i, k) => {
      const tax = taxes[k];
      return { hsn: i.hsn || '', desc: i.name, uqc: 'NOS', qty: i.qty, taxable: amounts[k] - disc[k], tax, rate: i.taxPercent || 0, ...splitTax(tax, { gymState }) };
    });
    const split = splitTax(s.taxAmount || 0, { gymState });
    docs.push({ kind: 'sale', no: s.saleNo, date: s.createdAt, party: s.memberId?.name || s.customerName || 'Walk-in', gstin: null, ledger: 'Shop', total: s.total || 0, mode: s.mode, ...split, lines });
  }
  return docs;
}

const add = (o, k, init) => (o[k] ||= init());

/** GSTR-1 sections from the supplies. */
export function gstr1(docs) {
  const b2b = [];
  const b2cs = {};
  const hsn = {};
  const totals = { taxable: 0, igst: 0, cgst: 0, sgst: 0, invoiceValue: 0, documents: docs.length };
  for (const d of docs) {
    totals.invoiceValue += d.total;
    // One b2b row per invoice and rate.
    const byRate = {};
    for (const l of d.lines) {
      totals.taxable += l.taxable;
      totals.igst += l.igst;
      totals.cgst += l.cgst;
      totals.sgst += l.sgst;
      const r = add(byRate, l.rate, () => ({ rate: l.rate, taxable: 0, tax: 0 }));
      r.taxable += l.taxable;
      r.tax += l.tax;
      const h = add(hsn, `${l.hsn || 'unspecified'}|${l.rate}`, () => ({ hsn: l.hsn || '', desc: l.hsn ? l.desc : 'HSN not set on product', uqc: l.uqc, qty: 0, value: 0, rate: l.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 }));
      h.qty += l.qty;
      h.value += l.taxable + l.tax;
      h.taxable += l.taxable;
      h.igst += l.igst;
      h.cgst += l.cgst;
      h.sgst += l.sgst;
      if (l.hsn === GYM_SAC) h.desc = 'Gym / fitness services';
    }
    if (d.gstin) {
      for (const r of Object.values(byRate)) b2b.push({ gstin: d.gstin, party: d.party, no: d.no, date: d.date, value: d.total, pos: d.pos, rate: r.rate, taxable: r.taxable });
    } else {
      for (const r of Object.values(byRate)) {
        const row = add(b2cs, `${d.pos}|${r.rate}`, () => ({ pos: d.pos, rate: r.rate, taxable: 0, tax: 0 }));
        row.taxable += r.taxable;
        row.tax += r.tax;
      }
    }
  }
  return { b2b, b2cs: Object.values(b2cs), hsn: Object.values(hsn).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate), totals };
}

/** Paise to rupees with exactly two decimals as a number (for Excel cells). */
export const rs = (p) => Math.round(Number(p || 0)) / 100;
