import { ApiError } from '../utils/ApiError.js';

/** validate({ body, query, params }) using zod schemas; replaces req.body with parsed data. */
export const validate = (schemas) => (req, _res, next) => {
  for (const key of ['params', 'query', 'body']) {
    if (!schemas[key]) continue;
    const result = schemas[key].safeParse(req[key] ?? {});
    if (!result.success) {
      const errors = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw ApiError.badRequest(errors[0] ? `${errors[0].path || key}: ${errors[0].message}` : 'Invalid input', errors);
    }
    if (key === 'query') req.validQuery = result.data; // req.query is read-only in Express 5
    else req[key] = result.data;
  }
  next();
};
