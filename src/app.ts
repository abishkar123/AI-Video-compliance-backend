import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import auditRoutes from './routes/audit.routes.js';
import healthRoutes from './routes/health.routes.js';
import documentRoutes from './routes/document.routes.js';
import graphRoutes from './routes/graph.routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/logging.middleware.js';
import logger from './config/logger.js';

const app = express();

// Security
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// Rate limiting
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
}));

const auditLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Audit rate limit exceeded. Max 20 audits per hour.' },
});

// Body & compression
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP logging
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined', {
        stream: { write: (msg: string) => logger.info(msg.trim()) },
    }));
}
app.use(requestLogger);

// Routes
app.use('/health', healthRoutes);
app.use('/api/audit', auditLimiter, auditRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/graph', graphRoutes);

app.get('/api', (_req, res) => {
    res.json({
        name: 'ComplianceQA API',
        version: '1.0.0',
        description: 'AI-powered video compliance auditing system',
        endpoints: {
            health: 'GET  /health',
            startAudit: 'POST /api/audit',
            auditStatus: 'GET  /api/audit/:sessionId',
            auditHistory: 'GET  /api/audit/history',
            listDocs: 'GET  /api/documents',
            indexDocs: 'POST /api/documents/index',
            graphDefinition: 'GET  /api/graph/definition',
            graphRuns: 'GET  /api/graph/runs',
            graphRun: 'GET  /api/graph/runs/:runId',
            graphStats: 'GET  /api/graph/stats',
        },
    });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
