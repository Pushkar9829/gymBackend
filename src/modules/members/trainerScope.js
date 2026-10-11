import mongoose from 'mongoose';
import { Member } from './member.model.js';
import { PtPurchase } from '../pt/pt.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { assertBranchAccess } from '../../middlewares/branchScope.js';

/**
 * Members a trainer may see: the ones assigned to them plus their PT clients.
 * Returns {} (no restriction) for every other role.
 */
export async function trainerMemberFilter(user) {
  if (user.role !== 'trainer') return {};
  const ptClients = await PtPurchase.distinct('memberId', { trainerId: user._id });
  // Wrapped in $and so it combines with other $or conditions (e.g. search).
  return { $and: [{ $or: [{ trainerId: user._id }, { _id: { $in: ptClients } }] }] };
}

/** Loads a member the caller may access (branch + trainer rules) or throws 404/403. */
export async function loadAccessibleMember(req, id, { deleted = false } = {}) {
  if (!mongoose.isValidObjectId(String(id))) throw ApiError.notFound('Member not found');
  const member = await Member.findOne({ _id: id, isDeleted: deleted, ...(await trainerMemberFilter(req.user)) });
  if (!member) throw ApiError.notFound('Member not found');
  assertBranchAccess(req, member.branchId);
  return member;
}
