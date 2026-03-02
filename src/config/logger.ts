import { createLogger, format, transports } from 'winston';

const { combine, timestamp, errors, json, colorize, printf } = format;

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp as string} [${level}]: ${(stack as string) || message}${metaStr}`;
});

const logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(timestamp(), errors({ stack: true })),
    defaultMeta: { service: 'complianceqa-api' },
    transports: [
        new transports.Console({
            format:
                process.env.NODE_ENV === 'production'
                    ? combine(json())
                    : combine(colorize(), devFormat),
        }),
    ],
});

if (process.env.NODE_ENV === 'production') {
    logger.add(new transports.File({ filename: 'logs/error.log', level: 'error' }));
    logger.add(new transports.File({ filename: 'logs/combined.log' }));
}

export default logger;
