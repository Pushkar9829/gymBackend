import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Shift handover board: notes and tasks the front desk leaves for the next shift.
const handoverSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    isTask: { type: Boolean, default: false },
    dueDate: Date, // tasks: day it should be done by
    assignedTo: { type: ObjectId, ref: 'User' },
    important: { type: Boolean, default: false },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    editedAt: Date,
    doneAt: Date,
    doneBy: { type: ObjectId, ref: 'User' },
    // "Got it": each staff member acknowledges once.
    acks: [{ userId: { type: ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }],
    isDeleted: { type: Boolean, default: false },
    deletedBy: { type: ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);

handoverSchema.index({ branchId: 1, isDeleted: 1, createdAt: -1 });
handoverSchema.index({ branchId: 1, isTask: 1, doneAt: 1 });

export const HandoverNote = mongoose.model('HandoverNote', handoverSchema);
