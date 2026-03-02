import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');

/**
 * List documents
 */
export function listDocuments(_req: Request, res: Response): Response {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            return res.json({ documents: [], dataDir: DATA_DIR });
        }
        const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.pdf'));
        return res.json({ documents: files, dataDir: DATA_DIR, count: files.length });
    } catch (err: unknown) {
        const error = err as Error;
        return res.status(500).json({ error: error.message });
    }
}

/**
 * Index documents
 */
export async function indexDocuments(_req: Request, res: Response): Promise<Response> {
    logger.info('[Indexer] Starting document indexing…');

    try {
        if (!fs.existsSync(DATA_DIR)) {
            return res.status(400).json({
                error: `Data directory not found: ${DATA_DIR}. Create it and add PDF files.`,
            });
        }

        const pdfFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.pdf'));
        if (pdfFiles.length === 0) {
            return res.status(400).json({
                error: `No PDF files found in ${DATA_DIR}. Add compliance PDFs and retry.`,
            });
        }

        logger.info(`Found ${pdfFiles.length} PDFs: ${pdfFiles.join(', ')}`);

        return res.json({
            message: 'Document indexing triggered.',
            files: pdfFiles,
            note: 'Run `npm run index-docs` (scripts/indexDocuments.ts) for full PDF → vector pipeline.',
        });
    } catch (err: unknown) {
        const error = err as Error;
        logger.error('Document indexing failed', { err: error });
        return res.status(500).json({ error: error.message });
    }
}
