import type { Request, Response, NextFunction, HttpError } from '../types/index.js';
import logger from '../config/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
    res.status(404).json({
        statusCode: 404,
        message: `Route ${req.method} ${req.path} does not exist`,
    });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, req: Request, res: Response, _next: NextFunction): void {
    const status = err.status || err.statusCode || 500;

    logger.error(`Error ${status}: ${err.message}`, {
        err,
        method: req.method,
        url: req.url,
        status,
    });

    res.status(status).json({
        statusCode: status,
        message: err.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}
