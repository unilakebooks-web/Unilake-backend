export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;

    constructor(message: string, statusCode: number, code: string) {

        super(message);
        this.statusCode = statusCode;
        this.code = code;

        Error.captureStackTrace(this, this.constructor)
    }
}
/**
* 400 Bad Request - Used when the user sends invalid data
 */
export class ValidationError extends AppError {
  constructor(message = "Invalid input data") {
    super(message, 400, "VALIDATION_ERROR");
  }
}

/**
 * 401 Unauthorized - Used when a user is not logged in
 */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required to access this route") {
    super(message, 401, "UNAUTHORIZED");
  }
}

/**
 * 403 Forbidden - Used when a user is logged in, but lacks permissions (e.g., not an admin)
 */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super(message, 403, "FORBIDDEN");
  }
}

/**
 * 404 Not Found - Used when a requested resource doesn't exist in the database
 */
export class NotFoundError extends AppError {
  constructor(message = "The requested resource could not be found") {
    super(message, 404, "NOT_FOUND");
  }
}

/**
 * 409 Conflict - Used for things like duplicate emails during signup
 */
export class ConflictError extends AppError {
  constructor(message = "A conflict occurred with the current state of the resource") {
    super(message, 409, "CONFLICT");
  }
}