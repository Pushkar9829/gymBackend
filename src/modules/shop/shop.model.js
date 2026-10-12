import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const PRODUCT_CATEGORIES = ['supplement', 'beverage', 'snack', 'merchandise', 'accessory', 'other'];

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    category: { type: String, enum: PRODUCT_CATEGORIES, default: 'other' },
    price: { type: Number, required: true, min: 0 }, // selling price per unit, paise, before GST
    costPrice: { type: Number, default: 0, min: 0 }, // purchase cost per unit, paise
    taxPercent: { type: Number, default: 18, min: 0, max: 50 },
    lowStockAt: { type: Number, default: 5, min: 0 },
    hsn: { type: String, trim: true }, // HSN code for the GST return (optional)
    imageUrl: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
productSchema.index({ name: 'text', sku: 'text' });
export const Product = mongoose.model('Product', productSchema);

/** Stock on hand per branch. */
const stockSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: 'Product', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    qty: { type: Number, default: 0 },
  },
  { timestamps: true },
);
stockSchema.index({ productId: 1, branchId: 1 }, { unique: true });
export const Stock = mongoose.model('Stock', stockSchema);

/** Every stock change, for audit and stock history. */
const movementSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: 'Product', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    qty: { type: Number, required: true }, // + in, - out
    type: { type: String, enum: ['purchase', 'sale', 'return', 'adjustment'], required: true },
    unitCost: Number,
    saleId: { type: ObjectId, ref: 'Sale' },
    note: String,
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
movementSchema.index({ productId: 1, createdAt: -1 });
movementSchema.index({ branchId: 1, createdAt: -1 });
export const StockMovement = mongoose.model('StockMovement', movementSchema);

const saleSchema = new mongoose.Schema(
  {
    saleNo: { type: String, required: true, unique: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    memberId: { type: ObjectId, ref: 'Member' }, // optional: walk-in customers
    customerName: String,
    items: [
      {
        productId: { type: ObjectId, ref: 'Product', required: true },
        name: String,
        qty: { type: Number, required: true, min: 1 },
        unitPrice: Number,
        unitCost: Number,
        taxPercent: Number,
        hsn: String,
        amount: Number, // qty x unitPrice (pre-tax)
        taxAmount: Number,
        _id: false,
      },
    ],
    subTotal: Number,
    discount: { type: Number, default: 0 },
    taxAmount: Number,
    total: Number,
    cost: Number, // cost of goods sold
    mode: { type: String, enum: ['cash', 'upi', 'card', 'bank'], required: true },
    reference: String,
    status: { type: String, enum: ['paid', 'refunded'], default: 'paid' },
    refundedAt: Date,
    refundReason: String,
    approvalId: { type: ObjectId, ref: 'DiscountApproval' },
    soldBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
saleSchema.index({ branchId: 1, createdAt: -1 });
saleSchema.index({ memberId: 1, createdAt: -1 });
export const Sale = mongoose.model('Sale', saleSchema);
