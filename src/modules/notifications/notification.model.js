import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['email', 'inapp', 'sms', 'whatsapp'], required: true },
    template: { type: String, required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    to: String,
    subject: String,
    body: String,
    status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
    error: String,
    sentAt: Date,
    readAt: Date, // in-app only
    // Prevents duplicate reminders, e.g. "renewal-7:<subscriptionId>"
    dedupeKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

notificationSchema.index({ channel: 1, branchId: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
