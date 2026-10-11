// All money is stored as integer paise to avoid floating point errors.
export const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
export const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;
export const formatINR = (paise) =>
  `Rs. ${toRupees(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Tax-inclusive split is not used: price is pre-tax, tax added on top.
export const calcTax = (amountPaise, taxPercent) => Math.round((amountPaise * Number(taxPercent || 0)) / 100);
