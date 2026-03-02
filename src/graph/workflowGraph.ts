import { EventEmitter } from 'node:events';
import { traceable } from 'langsmith/traceable';
import logger from '../config/logger.js';
import type { VideoAuditState, NodeStatus, NodeTrace, GraphTrace, GraphDefinition, NodeEntry, NodeFunction, NodeMeta } from '../types/index.js';

export const NODE_STATUS: Record<string, NodeStatus> = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
};

export class WorkflowGraph extends EventEmitter {
    public name: string;
    private nodes: Map<string, NodeEntry>;
    private edges: Map<string, string>;
    private entryPoint: string | null;
    private _compiled: boolean = false;

    constructor(name: string = 'workflow') {
        super();
        this.name = name;
        this.nodes = new Map();
        this.edges = new Map();
        this.entryPoint = null;
    }

    /**
     * Register a node
     */
    addNode(id: string, fn: NodeFunction, meta: Partial<NodeMeta> = {}): this {
        this.nodes.set(id, {
            fn,
            meta: {
                label: meta.label || id,
                description: meta.description || '',
                icon: meta.icon || 'cpu',
            },
        });
        return this;
    }

    /** Connect nodeA → nodeB */
    addEdge(fromId: string, toId: string): this {
        this.edges.set(fromId, toId);
        return this;
    }

    /** Set the first node to run */
    setEntryPoint(id: string): this {
        this.entryPoint = id;
        return this;
    }

    /** Validate and freeze the graph */
    compile(): this {
        if (!this.entryPoint) throw new Error('[WorkflowGraph] No entry point set.');
        if (!this.nodes.has(this.entryPoint)) {
            throw new Error(`[WorkflowGraph] Entry point "${this.entryPoint}" not registered.`);
        }
        this._compiled = true;
        return this;
    }

    /**
     * Execute the graph
     */
    async invoke(initialState: VideoAuditState, runId: string = 'run'): Promise<{ state: VideoAuditState; traces: GraphTrace }> {
        // Trace the entire graph run
        const graphRun = traceable(async (iState: VideoAuditState) => {
            if (!this._compiled) this.compile();

            const state = { ...iState };
            const traces: NodeTrace[] = [];

            const graphTrace: GraphTrace = {
                runId,
                graphName: this.name,
                startedAt: new Date().toISOString(),
                completedAt: null,
                durationMs: null,
                status: 'running',
                nodes: traces,
            };

            this.emit('graph:start', { runId, graphName: this.name });
            logger.info(`[Graph:${this.name}] Run ${runId} started`);

            const graphStart = Date.now();
            let currentNodeId: string | null = this.entryPoint;

            while (currentNodeId && currentNodeId !== '__end__') {
                const nodeEntry = this.nodes.get(currentNodeId);
                if (!nodeEntry) {
                    throw new Error(`[WorkflowGraph] Unknown node: "${currentNodeId}"`);
                }

                const { fn, meta } = nodeEntry;

                const nodeTrace: NodeTrace = {
                    nodeId: currentNodeId,
                    label: meta.label,
                    description: meta.description,
                    icon: meta.icon,
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    completedAt: null,
                    durationMs: null,
                    error: null,
                    stateSnapshot: null,
                };

                traces.push(nodeTrace);
                this.emit('node:start', { runId, nodeId: currentNodeId, label: meta.label });
                logger.info(`[Graph:${this.name}] ▶ Node "${currentNodeId}" started`);

                const nodeStart = Date.now();

                try {
                    // Trace each node call
                    const tracedFn = traceable(fn, {
                        name: `${this.name}:${currentNodeId}`,
                        metadata: { runId, sessionId: runId, videoUrl: state.videoUrl }
                    });

                    const patch = await tracedFn(state);

                    if (patch && typeof patch === 'object') {
                        for (const [key, value] of Object.entries(patch)) {
                            const currentVal = state[key];
                            if (Array.isArray(currentVal) && Array.isArray(value)) {
                                state[key] = [...(currentVal as unknown[]), ...(value as unknown[])] as any;
                            } else {
                                state[key] = value as any;
                            }
                        }
                    }

                    nodeTrace.status = 'completed';
                    nodeTrace.completedAt = new Date().toISOString();
                    nodeTrace.durationMs = Date.now() - nodeStart;
                    nodeTrace.stateSnapshot = sanitizeSnapshot(state);

                    this.emit('node:complete', {
                        runId,
                        nodeId: currentNodeId,
                        label: meta.label,
                        durationMs: nodeTrace.durationMs,
                    });

                    logger.info(
                        `[Graph:${this.name}] ✓ Node "${currentNodeId}" completed in ${nodeTrace.durationMs}ms`
                    );
                } catch (err: unknown) {
                    const error = err as Error;
                    nodeTrace.status = 'failed';
                    nodeTrace.completedAt = new Date().toISOString();
                    nodeTrace.durationMs = Date.now() - nodeStart;
                    nodeTrace.error = error.message;

                    this.emit('node:error', { runId, nodeId: currentNodeId, error: error.message });
                    logger.error(`[Graph:${this.name}] ✗ Node "${currentNodeId}" failed`, { err });

                    let next: string | undefined = this.edges.get(currentNodeId!);
                    while (next && next !== '__end__') {
                        const skippedMeta = this.nodes.get(next)?.meta;
                        traces.push({
                            nodeId: next,
                            label: skippedMeta?.label || next,
                            description: skippedMeta?.description || '',
                            icon: skippedMeta?.icon || 'cpu',
                            status: 'skipped',
                            startedAt: null,
                            completedAt: null,
                            durationMs: null,
                            error: 'Skipped due to upstream failure',
                            stateSnapshot: null,
                        });
                        next = this.edges.get(next);
                    }

                    graphTrace.status = 'failed';
                    graphTrace.completedAt = new Date().toISOString();
                    graphTrace.durationMs = Date.now() - graphStart;

                    this.emit('graph:error', { runId, error: error.message });
                    return { state, traces: graphTrace };
                }

                currentNodeId = this.edges.get(currentNodeId) || null;
            }

            graphTrace.status = 'completed';
            graphTrace.completedAt = new Date().toISOString();
            graphTrace.durationMs = Date.now() - graphStart;

            this.emit('graph:complete', {
                runId,
                durationMs: graphTrace.durationMs,
                nodeCount: traces.length,
            });

            logger.info(
                `[Graph:${this.name}] ✓ Run ${runId} complete in ${graphTrace.durationMs}ms ` +
                `(${traces.length} nodes)`
            );

            return { state, traces: graphTrace };
        }, {
            name: `WorkflowGraph:${this.name}`,
            metadata: { runId, sessionId: runId, videoUrl: initialState.videoUrl }
        });

        return graphRun(initialState);
    }

    toDefinition(): GraphDefinition {
        const nodes: Array<{ id: string } & NodeMeta> = [];
        const edges: Array<{ from: string; to: string }> = [];

        for (const [id, { meta }] of this.nodes) {
            nodes.push({ id, ...meta });
        }
        for (const [from, to] of this.edges) {
            if (to !== '__end__') edges.push({ from, to });
        }

        return {
            name: this.name,
            entryPoint: this.entryPoint!,
            nodes,
            edges,
        };
    }
}

function sanitizeSnapshot(state: VideoAuditState): Record<string, unknown> {
    const snap = { ...state } as Record<string, unknown>;
    const trans = snap.transcript as string | undefined;
    if (trans && trans.length > 500) {
        snap.transcript = trans.slice(0, 500) + '…[truncated]';
    }
    const ocr = snap.ocrText as string[] | undefined;
    if (Array.isArray(ocr) && ocr.length > 10) {
        snap.ocrText = [...ocr.slice(0, 10), `…+${ocr.length - 10} more`];
    }
    return snap;
}
