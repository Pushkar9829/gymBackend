export function getPagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export async function paginate(model, filter, query, { sort = { createdAt: -1 }, populate, select, lean = true } = {}) {
  const { page, limit, skip } = getPagination(query);
  let q = model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, model.countDocuments(filter)]);
  return { items, page, limit, total, pages: Math.ceil(total / limit) || 1 };
}

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
