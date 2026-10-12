import mongoose from 'mongoose';

/** Every waiver text ever published. Old versions are kept so signed copies can always be reprinted. */
const waiverVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true },
    text: { type: String, required: true },
    hash: { type: String, required: true }, // sha256 of the text
    requireResign: { type: Boolean, default: false }, // members who signed older versions must sign again
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const WaiverVersion = mongoose.model('WaiverVersion', waiverVersionSchema);

/** One signature by a member on one waiver version. */
const waiverSignatureSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    version: { type: Number, required: true },
    textHash: { type: String, required: true }, // hash of the exact text shown when signing
    signatureFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', required: true },
    signedAt: { type: Date, required: true },
    via: { type: String, enum: ['app', 'desk'], required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // staff present for a desk signature
    ip: String,
    userAgent: String,
  },
  { timestamps: true },
);
waiverSignatureSchema.index({ memberId: 1, signedAt: -1 });
export const WaiverSignature = mongoose.model('WaiverSignature', waiverSignatureSchema);
