/**
 * Azure Monitor OpenTelemetry Setup
 * Initializes Application Insights tracing for all HTTP requests,
 * dependencies, and errors.
 */
import logger from './logger.js';

export function initTelemetry(): void {
    const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    if (!connectionString) {
        logger.warn('No APPLICATIONINSIGHTS_CONNECTION_STRING found — telemetry DISABLED.');
        return;
    }

    try {
        // Dynamic import so the app still starts without the package
        import('@azure/monitor-opentelemetry')
            .then(({ useAzureMonitor }) => {
                useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
                logger.info('✓ Azure Monitor telemetry enabled & connected.');
            })
            .catch((err: unknown) => {
                logger.error('Failed to initialize Azure Monitor telemetry', { err });
            });
    } catch (err: unknown) {
        // Telemetry failure must never crash the app
        logger.error('Failed to initialize Azure Monitor telemetry', { err });
    }
}
