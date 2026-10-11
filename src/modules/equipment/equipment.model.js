import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const EQUIPMENT_CATEGORIES = ['cardio', 'strength-machine', 'free-weights', 'rack-bench', 'functional', 'other'];
export const EQUIPMENT_STATUS = ['working', 'needs-repair', 'out-of-order', 'retired'];

const equipmentSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true }, // "Treadmill #2"
    category: { type: String, enum: EQUIPMENT_CATEGORIES, default: 'other' },
    brand: String,
    model: String,
    serialNo: String,
    location: String, // area of the floor
    purchaseDate: Date,
    cost: { type: Number, min: 0 }, // paise
    vendor: String,
    vendorPhone: String,
    warrantyUntil: Date,
    serviceIntervalDays: { type: Number, min: 0, default: 90 }, // 0 = no regular service
    lastServiceAt: Date,
    nextServiceDue: Date,
    status: { type: String, enum: EQUIPMENT_STATUS, default: 'working' },
    issue: String, // what is wrong when not working
    notes: String,
  },
  { timestamps: true },
);
equipmentSchema.index({ branchId: 1, status: 1 });
equipmentSchema.index({ nextServiceDue: 1 });
export const Equipment = mongoose.model('Equipment', equipmentSchema);

const maintenanceSchema = new mongoose.Schema(
  {
    equipmentId: { type: ObjectId, ref: 'Equipment', required: true },
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: ['service', 'repair', 'inspection', 'issue-reported'], required: true },
    cost: { type: Number, default: 0, min: 0 },
    vendor: String,
    notes: String,
    statusAfter: { type: String, enum: EQUIPMENT_STATUS },
    expenseId: { type: ObjectId, ref: 'Expense' },
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
maintenanceSchema.index({ equipmentId: 1, date: -1 });
export const MaintenanceLog = mongoose.model('MaintenanceLog', maintenanceSchema);
