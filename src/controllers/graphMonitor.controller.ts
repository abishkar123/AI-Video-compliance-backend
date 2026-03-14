import type { Request, Response } from 'express';
import { graph } from '../graph/complianceWorkflow.js';
import graphRunStore from '../graph/graphRunStore.js';
import type { GraphTrace } from '../types/index.js';

/** GET /api/graph/definition */
export function getDefinition(_req: Request, res: Response): void {
    res.json(graph.toDefinition());
}

/** GET /api/graph/runs?limit=50 */
export function listRuns(req: Request, res: Response): void {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const runs = graphRunStore.list(limit).map((r: GraphTrace) => ({
        runId: r.runId,
        graphName: r.graphName,
        status: r.status,
        finalStatus: r.finalStatus,
        videoUrl: r.videoUrl,
        videoId: r.videoId,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMs: r.durationMs,
        nodeCount: (r.nodes || []).length,
    }));
    res.json({ total: runs.length, runs });
}

/** GET /api/graph/runs/:runId */
export function getRun(req: Request, res: Response): void {
    const run = graphRunStore.get(req.params.runId as string);
    if (!run) {
        res.status(404).json({
            statusCode: 404,
            message: `No run found: ${req.params.runId}`,
        });
        return;
    }
    res.json(run);
}

/** GET /api/graph/stats */
export function getStats(_req: Request, res: Response): void {
    res.json(graphRunStore.stats());
}
