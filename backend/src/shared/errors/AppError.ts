export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
  static badRequest(message: string, details?: unknown) { return new AppError(400, 'BAD_REQUEST', message, details); }
  static unauthorized(message = 'Authentication required') { return new AppError(401, 'UNAUTHORIZED', message); }
  static forbidden(message = 'You do not have permission to do this') { return new AppError(403, 'FORBIDDEN', message); }
  static notFound(message = 'Resource not found') { return new AppError(404, 'NOT_FOUND', message); }
  static conflict(message: string, code = 'CONFLICT', details?: unknown) { return new AppError(409, code, message, details); }
  static tooMany(message = 'Too many requests') { return new AppError(429, 'RATE_LIMITED', message); }
}
