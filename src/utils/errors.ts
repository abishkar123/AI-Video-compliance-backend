import type { Request, Response, NextFunction } from 'express';
import logger from '../config/logger.js';

export interface ApiError {
  status: number;
  message: string;
  code?: string;
}

/**
 * Application error class
 */
export class AppError extends Error implements ApiError {
  status: number;
  code?: string;

  constructor(message: string, status: number = 500, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'AppError';

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Send standardized success response
 */
export function sendSuccess<T>(res: Response, data: T, status: number = 200): void {
  res.status(status).json({
    success: true,
    data,
  });
}

/**
 * Send standardized error response
 */
export function sendError(
  res: Response,
  error: unknown,
  defaultStatus: number = 500
): void {
  let status = defaultStatus;
  let message = 'An unexpected error occurred';

  if (error instanceof AppError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }

  res.status(status).json({
    statusCode: status,
    message,
    ...(process.env.NODE_ENV === 'development' && {
      stack: error instanceof Error ? error.stack : undefined,
    }),
  });
}

/**
 * Async route wrapper to handle errors
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validate request parameters
 */
export function validateParams(
  data: any,
  requiredFields: string[]
): { valid: boolean; error?: string } {
  for (const field of requiredFields) {
    if (!data[field]) {
      return {
        valid: false,
        error: `Missing required parameter: ${field}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Extract error message from various error types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }

  return 'An unexpected error occurred';
}
