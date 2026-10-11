import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const FEEDBACK_TYPES = ['complaint', 'suggestion', 'praise'];
export const FEEDBACK_CATEGORIES = ['equipment', 'cleanliness', 'staff', 'trainer', 'classes', 'billing', 'timings', 'other'];
export const FEEDBACK_STATUS = ['open', 'in-progress', 'resolved', 'closed'];

const replySchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['staff', 'member'], required: true },
    userId: { type: ObjectId, ref: 'User' }, // staff author
    name: String,
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const feedbackSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, unique: true }, // FB-00012
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    memberId: { type: ObjectId, ref: 'Member', required: true },
    type: { type: String, enum: FEEDBACK_TYPES, required: true },
    category: { type: String, enum: FEEDBACK_CATEGORIES, default: 'other' },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5 }, // overall experience, given with the feedback
    priority: { type: String, enum: ['normal', 'high'], default: 'normal' },
    status: { type: String, enum: FEEDBACK_STATUS, default: 'open' },
    source: { type: String, enum: ['app', 'desk'], default: 'app' },
    createdBy: { type: ObjectId, ref: 'User' }, // staff who logged it at the desk
    assignedTo: { type: ObjectId, ref: 'User' },
    replies: [replySchema],
    resolvedAt: Date,
    memberRating: { type: Number, min: 1, max: 5 }, // how the member rated the handling
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
feedbackSchema.index({ branchId: 1, status: 1, createdAt: -1 });
feedbackSchema.index({ memberId: 1, createdAt: -1 });

export const Feedback = mongoose.model('Feedback', feedbackSchema);
