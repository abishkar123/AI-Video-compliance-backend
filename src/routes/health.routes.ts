import { Router } from 'express';
import type { Request, Response } from '../types/index.js';

const router = Router();

/**
 * GET /health
 * Service health + Azure config check
 */
router.get('/', (_req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        service: 'ComplianceQA API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV,
        azure: {
            openai: !!process.env.AZURE_OPENAI_API_KEY,
            search: !!process.env.AZURE_SEARCH_API_KEY,
            videoIndexer: !!process.env.AZURE_VI_ACCOUNT_ID,
            monitor: !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
        },
    });
});

export default router;
