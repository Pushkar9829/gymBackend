import mongoose from 'mongoose';

export const MEMBERSHIP_STATUS = ['none', 'upcoming', 'active', 'frozen', 'expired', 'cancelled'];

const memberSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    // Numeric code; also used as the biometric device user ID (PIN).
    memberCode: { type: Number, required: true, unique: true },
    // RFID card number (written to biometric devices; tap to check in at reception).
    cardNo: { type: String, trim: true, unique: true, sparse: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    dob: Date,
    photoUrl: String,
    address: String,
    emergencyContact: { name: String, phone: String, relation: String },
    healthNotes: String,
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, default: 'walk-in' },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' }, // corporate tie-up
    // Refer a friend: own short code (made on first use) and who referred this member.
    referralCode: { type: String, uppercase: true, trim: true, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    notes: String,
    documents: [
      {
        name: { type: String, required: true },
        kind: { type: String, enum: ['id-proof', 'medical', 'waiver', 'photo', 'other'], default: 'other' },
        url: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    joinedAt: { type: Date, default: Date.now },

    // Access block set by staff (overrides any active membership).
    isBlocked: { type: Boolean, default: false },
    blockReason: String,

    // Member portal
    portalEnabled: { type: Boolean, default: false },
    passwordHash: { type: String, select: false },

    // Biometric
    biometric: {
      consentAt: Date,
      consentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      fingerEnrolled: { type: Boolean, default: false },
      faceEnrolled: { type: Boolean, default: false },
    },

    // Denormalised membership state for fast lists/filters. Maintained by member.state.js.
    membershipStatus: { type: String, enum: MEMBERSHIP_STATUS, default: 'none' },
    membershipStart: Date,
    membershipEnd: Date,
    currentPlanName: String,
    dueAmount: { type: Number, default: 0 },
    lastVisitAt: Date,

    // Trial / guest pass visitor: same record type so check-in, QR and the biometric devices work unchanged,
    // but kept out of member counts, reports and messaging. Converting clears isTrial and keeps the history.
    isTrial: { type: Boolean, default: false },
    trial: {
      from: Date, // first day
      to: Date, // last day included
      days: Number,
      fee: Number, // paise
      paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
      leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
      issuedAt: Date,
      issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      override: Boolean, // repeat rule overridden by owner/manager
      overrideReason: String,
      count: Number, // trials given to this number so far
      endedAt: Date, // ended early by staff
      endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      convertedAt: Date,
      convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },

    // Latest signed waiver (details and the signature image are in WaiverSignature / PrivateFile).
    waiver: {
      version: Number,
      signedAt: Date,
      signatureId: { type: mongoose.Schema.Types.ObjectId, ref: 'WaiverSignature' },
    },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

memberSchema.index({ branchId: 1, membershipStatus: 1 });
memberSchema.index({ branchId: 1, membershipEnd: 1 });
memberSchema.index({ phone: 1 });
memberSchema.index({ isTrial: 1, branchId: 1, 'trial.to': -1 });
memberSchema.index({ name: 'text', phone: 'text', email: 'text' });

memberSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

export const Member = mongoose.model('Member', memberSchema);
