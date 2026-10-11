import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    address: String,
    phone: String,
    openingTime: { type: String, default: '05:00' },
    closingTime: { type: String, default: '23:00' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Branch = mongoose.model('Branch', branchSchema);
