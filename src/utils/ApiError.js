export class ApiError extends Error {
  constructor(status, message, errors, code) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code; // machine-readable reason the client can act on, e.g. DISCOUNT_APPROVAL_REQUIRED
  }
  static badRequest(msg = 'Bad request', errors) { return new ApiError(400, msg, errors); }
  static unauthorized(msg = 'Unauthorized') { return new ApiError(401, msg); }
  static forbidden(msg = 'You do not have permission for this action') { return new ApiError(403, msg); }
  static notFound(msg = 'Not found') { return new ApiError(404, msg); }
  static conflict(msg = 'Conflict') { return new ApiError(409, msg); }
}
