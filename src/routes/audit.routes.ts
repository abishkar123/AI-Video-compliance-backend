import { Router } from 'express';
import multer from 'multer';
import * as auditController from '../controllers/audit.controller.js';

const router = Router();
const upload = multer({ dest: 'uploads/' });

// ... existing routes ...
router.post('/', auditController.startAudit);
router.post('/upload', upload.single('video'), auditController.startAudit); // Unified controller
router.get('/history', auditController.getHistory);
router.get('/:sessionId', auditController.getJobStatus);
router.post('/:sessionId/feedback', auditController.submitFeedback);

export default router;
