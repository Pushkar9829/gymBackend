import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { can } from '../config/permissions.js';
import { ApiError } from '../utils/ApiError.js';
import { User } from '../modules/users/user.model.js';
import { Member } from '../modules/members/member.model.js';

function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Staff authentication. Loads the user so deactivation takes effect immediately. */
export async function requireStaff(req, _res, next) {
  const token = readToken(req);
  if (!token) throw ApiError.unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtAccessSecret);
  } catch {
    throw ApiError.unauthorized('Session expired');
  }
  if (payload.typ !== 'user') throw ApiError.unauthorized();
  const user = await User.findById(payload.sub).lean();
  if (!user || !user.isActive) throw ApiError.unauthorized('Account disabled');
  req.user = user;
  // null = all branches (owner)
  req.allowedBranchIds = user.role === 'owner' ? null : (user.branchIds || []).map(String);
  next();
}

export async function requireMember(req, _res, next) {
  const token = readToken(req);
  if (!token) throw ApiError.unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtAccessSecret);
  } catch {
    throw ApiError.unauthorized('Session expired');
  }
  if (payload.typ !== 'member') throw ApiError.unauthorized();
  const member = await Member.findOne({ _id: payload.sub, isDeleted: false }).lean();
  if (!member || !member.portalEnabled) throw ApiError.unauthorized('Portal access disabled');
  req.member = member;
  next();
}

export const permit = (...perms) => (req, _res, next) => {
  if (!req.user) throw ApiError.unauthorized();
  if (!perms.every((p) => can(req.user.role, p))) throw ApiError.forbidden();
  next();
};
