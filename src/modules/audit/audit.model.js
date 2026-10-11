import mongoose from 'mongoose';
import { logger } from '../../config/logger.js';

const auditSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    action: { type: String, required: true }, // e.g. payment.refund
    entity: String,
    entityId: mongoose.Schema.Types.ObjectId,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    details: mongoose.Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditSchema.index({ entity: 1, entityId: 1 });
auditSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);

/** Never let an audit write failure break the main action. */
export async function audit(req, action, { entity, entityId, branchId, details } = {}) {
  try {
    await AuditLog.create({
      actorId: req?.user?._id,
      actorName: req?.user?.name,
      action,
      entity,
      entityId,
      branchId,
      details,
      ip: req?.ip,
    });
  } catch (err) {
    logger.error({ err, action }, 'audit write failed');
  }
}
