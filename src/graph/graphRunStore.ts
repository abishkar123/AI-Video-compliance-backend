import type { GraphTrace, GraphStats, NodeStatEntry } from '../types/index.js';

const MAX_RUNS = 200;

class GraphRunStore {
    private _runs: Map<string, GraphTrace>;
    private _order: string[];

    constructor() {
        this._runs = new Map();
        this._order = [];
    }

    save(trace: GraphTrace): void {
        const { runId } = trace;
        if (!this._runs.has(runId)) {
            this._order.push(runId);
            if (this._order.length > MAX_RUNS) {
                const evict = this._order.shift();
                if (evict) this._runs.delete(evict);
            }
        }
        this._runs.set(runId, trace);
    }

    get(runId: string): GraphTrace | null {
        return this._runs.get(runId) || null;
    }

    list(limit: number = 50): GraphTrace[] {
        return this._order
            .slice()
            .reverse()
            .slice(0, limit)
            .map((id) => this._runs.get(id))
            .filter((r): r is GraphTrace => !!r);
    }

    stats(): GraphStats {
        const runs = Array.from(this._runs.values());
        const total = runs.length;
        const passed = runs.filter((r) => r.finalStatus === 'PASS').length;
        const failed = runs.filter((r) => r.status === 'failed').length;
        const avgMs = total
            ? Math.round(runs.reduce((s, r) => s + (r.durationMs || 0), 0) / total)
            : 0;

        const nodeStatsMap: Record<string, NodeStatEntry> = {};
        for (const run of runs) {
            for (const node of (run.nodes || [])) {
                if (!nodeStatsMap[node.nodeId]) {
                    nodeStatsMap[node.nodeId] = { total: 0, failed: 0, totalMs: 0 };
                }
                const s = nodeStatsMap[node.nodeId];
                s.total++;
                s.totalMs += node.durationMs || 0;
                if (node.status === 'failed') s.failed++;
            }
        }

        const nodeAverages = Object.entries(nodeStatsMap).map(([nodeId, s]) => ({
            nodeId,
            avgMs: Math.round(s.totalMs / s.total),
            failureRate: s.total ? Math.round((s.failed / s.total) * 100) : 0,
        }));

        return { total, passed, failed, avgMs, nodeAverages };
    }
}

export default new GraphRunStore();
