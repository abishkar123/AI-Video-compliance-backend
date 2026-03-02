import { v4 as uuidv4 } from 'uuid';
import { validationResult } from 'express-validator';
import type { Request, Response } from 'express';
import { Client } from 'langsmith';
import { graph } from '../graph/complianceWorkflow.js';
import graphRunStore from '../graph/graphRunStore.js';
import logger from '../config/logger.js';
import type { AuditJob, VideoAuditState } from '../types/index.js';

// ── In-memory job store (replace with Redis for production) ───────────────────
const jobs = new Map<string, AuditJob>();

// LangSmith client for feedback
const lsClient = new Client();

function createJob(sessionId: string, videoUrl: string, videoPath?: string): AuditJob {
    const job: AuditJob = {
        sessionId,
        videoUrl,
        videoPath,
        status: 'queued',
        stage: null,
        progress: 0,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    jobs.set(sessionId, job);
    return job;
}

function updateJob(sessionId: string, patch: Partial<AuditJob>): void {
    const job = jobs.get(sessionId);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

// ── Stage → progress % map ────────────────────────────────────────────────────
const STAGE_PROGRESS: Record<string, number> = {
    downloading: 15,
    uploading: 30,
    Uploading: 30,
    indexing: 55,
    Processing: 55,
    Processed: 70,
    auditing: 85,
    completed: 100,
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/audit
 */
export async function startAudit(req: Request, res: Response): Promise<Response> {
    const { videoUrl: bodyUrl } = req.body;
    const file = (req as any).file;

    if (!bodyUrl && !file) {
        return res.status(400).json({ error: 'Please provide a video URL or upload a file.' });
    }

    const videoUrl = bodyUrl || file?.originalname || 'Uploaded Video';
    const videoPath = file?.path; // Mutex temp path
    const sessionId = uuidv4();
    const videoId = `vid_${sessionId.slice(0, 8)}`;

    logger.info(`[Audit] New job ${sessionId} — Source: ${videoUrl}`);
    createJob(sessionId, videoUrl, videoPath);

    _attachGraphListeners(sessionId);

    runGraphPipeline(sessionId, videoId, videoUrl, videoPath).catch((err: Error) => {
        logger.error('Graph pipeline crashed', { err, sessionId });
        updateJob(sessionId, { status: 'failed', error: err.message });
    });

    return res.status(202).json({
        sessionId,
        videoId,
        message: 'Audit job queued. Poll /api/audit/:sessionId for status.',
    });
}

/** GET /api/audit/:sessionId */
export function getJobStatus(req: Request, res: Response): Response {
    const job = jobs.get(req.params.sessionId as string);
    if (!job) return res.status(404).json({ error: `No job: ${req.params.sessionId}` });
    return res.json(job);
}

/** GET /api/audit/history */
export function getHistory(req: Request, res: Response): Response {
    const history = Array.from(jobs.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50)
        .map(({ sessionId, videoUrl, status, finalStatus, createdAt, updatedAt }) => ({
            sessionId,
            videoUrl,
            status,
            finalStatus,
            createdAt,
            updatedAt,
        }));
    return res.json({ total: history.length, jobs: history });
}

/** 
 * POST /api/audit/:sessionId/feedback
 * Submit LangSmith feedback for a specific run
 */
export async function submitFeedback(req: Request, res: Response): Promise<Response> {
    const { sessionId } = req.params;
    const { score, comment, key = 'user_feedback' } = req.body;

    logger.info(`[Feedback] Job ${sessionId} | Score: ${score}`);

    try {
        // Find the run in LangSmith by our internal sessionId metadata
        const runIterator = lsClient.listRuns({
            filter: `and(eq(metadata.sessionId, "${sessionId}"), eq(name, "WorkflowGraph:compliance-audit"))`,
            limit: 1
        });

        let run = null;
        for await (const r of runIterator) {
            run = r;
            break;
        }

        if (!run) {
            return res.status(404).json({ error: 'LangSmith trace not found yet. Try again in a moment.' });
        }

        await lsClient.createFeedback(run.id, key, {
            score: score ?? 1,
            comment: comment || '',
        });

        return res.json({ success: true, message: 'Feedback synced to LangSmith.' });
    } catch (err: unknown) {
        logger.error('Failed to submit LangSmith feedback', { err });
        return res.status(500).json({ error: 'Feedback sync failed.' });
    }
}

// ── Graph pipeline ────────────────────────────────────────────────────────────

async function runGraphPipeline(sessionId: string, videoId: string, videoUrl: string, videoPath?: string): Promise<void> {
    updateJob(sessionId, { status: 'processing', progress: 5, stage: videoPath ? 'uploading' : 'downloading' });

    const initialState: VideoAuditState = {
        videoUrl,
        videoPath,
        videoId,
        complianceResults: [],
        errors: [],
        _onProgress: (stage: string) => {
            updateJob(sessionId, {
                stage,
                progress: STAGE_PROGRESS[stage] ?? 50,
            });
        },
    };

    const { state, traces } = await graph.invoke(initialState, sessionId);

    graphRunStore.save({
        ...traces,
        videoUrl,
        videoId,
        finalStatus: state.finalStatus,
    });

    if (traces.status === 'failed') {
        const failedNode = (traces.nodes as any[]).find((n: any) => n.status === 'failed');
        updateJob(sessionId, {
            status: 'failed',
            error: failedNode?.error || 'Pipeline failed',
        });
        return;
    }

    updateJob(sessionId, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        finalStatus: state.finalStatus,
        finalReport: state.finalReport,
        complianceResults: state.complianceResults,
        videoId,
        transcript: state.transcript,
        ocrText: state.ocrText,
        videoMetadata: state.videoMetadata,
        graphRunId: sessionId,
    });

    logger.info(
        `[Audit:${sessionId}] ✓ ${state.finalStatus} — ` +
        `${(state.complianceResults || []).length} violation(s)`
    );
}

function _attachGraphListeners(sessionId: string): void {
    const onNodeStart = ({ runId, label }: { runId: string; label: string }) => {
        if (runId !== sessionId) return;
        updateJob(sessionId, { stage: label });
    };

    const onNodeComplete = ({ runId, nodeId }: { runId: string; nodeId: string; durationMs: number }) => {
        if (runId !== sessionId) return;
        const progressMap: Record<string, number> = { indexer: 70, auditor: 95 };
        updateJob(sessionId, { progress: progressMap[nodeId] ?? 70 });
    };

    graph.once(`node:start`, onNodeStart);
    graph.once(`node:complete`, onNodeComplete);
}
