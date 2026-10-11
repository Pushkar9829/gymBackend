import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';

/**
 * Mongo filter limiting a query to branches the staff user may see.
 * Honors ?branchId= when given (and allowed).
 */
export function branchFilter(req, field = 'branchId') {
  const requested = req.query?.branchId;
  if (requested) {
    assertBranchAccess(req, requested);
    return { [field]: new mongoose.Types.ObjectId(String(requested)) };
  }
  if (req.allowedBranchIds === null || req.allowedBranchIds === undefined) return {};
  return { [field]: { $in: req.allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } };
}

export function assertBranchAccess(req, branchId) {
  if (!branchId || !mongoose.isValidObjectId(String(branchId))) throw ApiError.badRequest('Invalid branch');
  if (req.allowedBranchIds === null) return;
  if (!req.allowedBranchIds.includes(String(branchId))) throw ApiError.forbidden('No access to this branch');
}

/** Loads a branch-owned document and checks the caller may access it. */
export async function findInBranch(req, Model, id, { notFound = 'Not found', extra = {} } = {}) {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.notFound(notFound);
  const doc = await Model.findOne({ _id: id, ...extra });
  if (!doc) throw ApiError.notFound(notFound);
  assertBranchAccess(req, doc.branchId);
  return doc;
}
