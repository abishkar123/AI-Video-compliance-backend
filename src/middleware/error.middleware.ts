import type { Request, Response, NextFunction, HttpError } from '../types/index.js';
import logger from '../config/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} does not exist`,
    });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, req: Request, res: Response, _next: NextFunction): void {
    const status = err.status || err.statusCode || 500;

    logger.error({
        err,
        method: req.method,
        url: req.url,
        status,
    });

    res.status(status).json({
        error: err.name || 'InternalServerError',
        message: err.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}
