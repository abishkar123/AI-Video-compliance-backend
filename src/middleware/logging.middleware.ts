import type { Request, Response, NextFunction } from '../types/index.js';
import logger from '../config/logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();

    res.on('finish', () => {
        const ms = Date.now() - start;
        logger.info(`${req.method} ${req.url} ${res.statusCode} — ${ms}ms`, {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            ms,
        });
    });

    next();
}
