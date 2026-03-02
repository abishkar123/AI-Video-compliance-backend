/**
 * Shared type definitions for the ComplianceQA backend.
 */

import type { Request, Response, NextFunction } from 'express';

// ── Compliance & Audit ────────────────────────────────────────────────────────

export interface ComplianceResult {
    category: string;
    severity: 'CRITICAL' | 'WARNING';
    description: string;
}

export interface AuditLLMResponse {
    compliance_results: ComplianceResult[];
    status: 'PASS' | 'FAIL';
    final_report: string;
}

export interface AuditResult {
    complianceResults: ComplianceResult[];
    finalStatus: string;
    finalReport: string;
}

// ── Video ─────────────────────────────────────────────────────────────────────

export interface VideoMetadata {
    duration: number | null;
    platform: string;
}

export interface VideoExtraction {
    transcript: string;
    ocrText: string[];
    videoMetadata: VideoMetadata;
}

export interface VideoIndexerInsights {
    videos?: Array<{
        insights?: {
            transcript?: Array<{ text?: string }>;
            ocr?: Array<{ text?: string }>;
        };
    }>;
    summarizedInsights?: {
        duration?: { seconds?: number };
    };
}

// ── Graph State ───────────────────────────────────────────────────────────────

export interface VideoAuditState {
    videoUrl: string;
    videoPath?: string; // Local path if uploaded
    videoId: string;
    complianceResults: ComplianceResult[];
    errors: string[];
    transcript?: string;
    ocrText?: string[];
    videoMetadata?: VideoMetadata;
    finalStatus?: string;
    finalReport?: string;
    _onProgress?: (stage: string) => void;
    [key: string]: unknown;
}

// ── Graph Traces ──────────────────────────────────────────────────────────────

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface NodeTrace {
    nodeId: string;
    label: string;
    description: string;
    icon: string;
    status: NodeStatus;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    error: string | null;
    stateSnapshot: Record<string, unknown> | null;
}

export interface GraphTrace {
    runId: string;
    graphName: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    status: 'running' | 'completed' | 'failed';
    nodes: NodeTrace[];
    videoUrl?: string;
    videoId?: string;
    finalStatus?: string;
}

// ── Graph Definition ──────────────────────────────────────────────────────────

export interface NodeMeta {
    label: string;
    description: string;
    icon: string;
}

export interface NodeEntry {
    fn: NodeFunction;
    meta: NodeMeta;
}

export type NodeFunction = (state: VideoAuditState) => Promise<Partial<VideoAuditState>>;

export interface GraphDefinition {
    name: string;
    entryPoint: string;
    nodes: Array<{ id: string } & NodeMeta>;
    edges: Array<{ from: string; to: string }>;
}

export interface GraphInvokeResult {
    state: VideoAuditState;
    traces: GraphTrace;
}

// ── Job Store ─────────────────────────────────────────────────────────────────

export interface AuditJob {
    sessionId: string;
    videoUrl: string;
    videoPath?: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    stage: string | null;
    progress: number;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    finalStatus?: string;
    finalReport?: string;
    complianceResults?: ComplianceResult[];
    videoId?: string;
    transcript?: string;
    ocrText?: string[];
    videoMetadata?: VideoMetadata;
    graphRunId?: string;
}

// ── Graph Run Store ───────────────────────────────────────────────────────────

export interface NodeStatEntry {
    total: number;
    failed: number;
    totalMs: number;
}

export interface NodeAverage {
    nodeId: string;
    avgMs: number;
    failureRate: number;
}

export interface GraphStats {
    total: number;
    passed: number;
    failed: number;
    avgMs: number;
    nodeAverages: NodeAverage[];
}

// ── Express helpers ───────────────────────────────────────────────────────────

export type { Request, Response, NextFunction };

export interface HttpError extends Error {
    status?: number;
    statusCode?: number;
}
