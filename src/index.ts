import 'dotenv/config';
import app from './app.js';
import logger from './config/logger.js';
import { initTelemetry } from './config/telemetry.js';

const PORT = process.env.PORT || 8000;

// Initialize Azure Monitor / Application Insights
initTelemetry();

const server = app.listen(PORT, () => {
    logger.info(`🚀 ComplianceQA Backend is LIVE!`);
    logger.info(`📡 Port:             ${PORT}`);
    logger.info(`🌍 NODE_ENV:         ${process.env.NODE_ENV || 'development'}`);
    logger.info(`📖 API info          →  http://localhost:${PORT}/api`);
    logger.info(`🏥 Health check      →  http://localhost:${PORT}/health`);
    logger.info(`📜 Audit history     →  http://localhost:${PORT}/api/audit/history`);
    logger.info(`📊 Graph monitoring  →  http://localhost:${PORT}/api/graph/stats`);
    logger.info('-'.repeat(50));
});

// Error handling for server instance
server.on('error', (err: Error) => logger.error('Server error', { err }));

// Graceful shutdown
function gracefulShutdown(signal: string) {
    logger.info(`[${signal}] Shutting down gracefully…`);
    server.close(() => {
        logger.info('HTTP server closed.');
        logger.info('Shutting down graph tracing stores…');
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('Force closing after 10s…');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err: Error) => {
    logger.error('🚨 UNCAUGHT EXCEPTION', { err });
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.error('🚨 UNHANDLED REJECTION', { reason });
    gracefulShutdown('unhandledRejection');
});
