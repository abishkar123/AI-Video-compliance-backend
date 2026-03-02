import { Router } from 'express';
import {
    getDefinition, listRuns, getRun, getStats,
} from '../controllers/graphMonitor.controller.js';

const router = Router();

/** GET /api/graph/definition — DAG node + edge schema */
router.get('/definition', getDefinition);

/** GET /api/graph/stats — aggregate per-node metrics */
router.get('/stats', getStats);

/** GET /api/graph/runs?limit=50 */
router.get('/runs', listRuns);

/** GET /api/graph/runs/:runId — full trace */
router.get('/runs/:runId', getRun);

export default router;
