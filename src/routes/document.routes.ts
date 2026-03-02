import { Router } from 'express';
import { listDocuments, indexDocuments } from '../controllers/document.controller.js';

const router = Router();

/** GET  /api/documents       — list PDFs in data/ */
router.get('/', listDocuments);

/** POST /api/documents/index — trigger indexing pipeline */
router.post('/index', indexDocuments);

export default router;
