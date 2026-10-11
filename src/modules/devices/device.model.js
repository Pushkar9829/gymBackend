import mongoose from 'mongoose';

/**
 * Biometric device using ZKTeco / eSSL cloud push (ADMS).
 * dialect:
 *   'security'   - access-control "Security PUSH" firmware (SpeedFace, ProFace, inBio...).
 *                  Supports per-user StartTime/EndTime + Disable, so the device itself enforces validity.
 *   'attendance' - attendance "iclock" push firmware (K-series, MB-series...). Access is switched by
 *                  moving the user between an "allowed" group and a "blocked" group configured on the device.
 */
const deviceSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true },
    serialNo: { type: String, required: true, trim: true, unique: true },
    location: { type: String, enum: ['entry', 'exit', 'both'], default: 'entry' },
    dialect: { type: String, enum: ['security', 'attendance'], default: 'security' },
    allowedGroup: { type: Number, default: 1 },
    blockedGroup: { type: Number, default: 99 },
    doorId: { type: Number, default: 1 },
    timezoneOffset: { type: Number, default: 5.5 },
    // Optional: only accept pushes from these IPs (gym's static public IP).
    allowedIps: [String],
    isActive: { type: Boolean, default: true },

    lastSeenAt: Date,
    lastIp: String,
    firmware: String,
    attStamp: { type: String, default: '0' },
    opStamp: { type: String, default: '0' },
    lastFullSyncAt: Date,
  },
  { timestamps: true },
);

export const Device = mongoose.model('Device', deviceSchema);

// What the server believes the device has for each member.
const deviceUserSchema = new mongoose.Schema(
  {
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    pin: { type: String, required: true },
    name: String,
    enabled: Boolean,
    validFrom: Date,
    validTo: Date,
    stateHash: String, // hash of the last desired state queued
    lastQueuedAt: Date,
    lastConfirmedAt: Date,
  },
  { timestamps: true },
);
deviceUserSchema.index({ deviceId: 1, memberId: 1 }, { unique: true });
deviceUserSchema.index({ deviceId: 1, pin: 1 });

export const DeviceUser = mongoose.model('DeviceUser', deviceUserSchema);

const deviceCommandSchema = new mongoose.Schema(
  {
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    cmdId: { type: Number, required: true }, // id sent to the device as C:<id>:...
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
    kind: { type: String, required: true }, // USER_SYNC | USER_DELETE | REBOOT | RAW
    command: { type: String, required: true }, // may contain several lines
    status: { type: String, enum: ['pending', 'sent', 'done', 'failed', 'superseded'], default: 'pending' },
    sentAt: Date,
    doneAt: Date,
    returnCode: String,
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
deviceCommandSchema.index({ deviceId: 1, status: 1, createdAt: 1 });
deviceCommandSchema.index({ deviceId: 1, cmdId: 1 }, { unique: true });

export const DeviceCommand = mongoose.model('DeviceCommand', deviceCommandSchema);
