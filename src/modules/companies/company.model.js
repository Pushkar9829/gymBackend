import mongoose from 'mongoose';

/** Corporate tie-up: employees get a discount; the company can be invoiced instead of the employee. */
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    gstin: { type: String, trim: true, uppercase: true },
    contactName: String,
    phone: String,
    email: { type: String, lowercase: true, trim: true },
    address: String,
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    billTo: { type: String, enum: ['member', 'company'], default: 'member' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Company = mongoose.model('Company', companySchema);
