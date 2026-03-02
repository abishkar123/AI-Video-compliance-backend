import VideoIndexerService from '../services/videoIndexer.service.js';
import ComplianceAuditorService from '../services/complianceAuditor.service.js';
import logger from '../config/logger.js';
import type { VideoAuditState } from '../types/index.js';

/**
 * Node 1: Video Indexer
 */
export async function indexVideoNode(state: VideoAuditState): Promise<Partial<VideoAuditState>> {
    const { videoUrl, videoPath, videoId = 'vid_demo', _onProgress } = state;

    if (!videoUrl && !videoPath) {
        return {
            errors: ['Missing video source in state'],
            finalStatus: 'FAIL',
        };
    }

    logger.info(`[Node:Indexer] Processing: ${videoUrl || videoPath}`);

    // If it's a URL but NOT a file, check if it's YouTube
    if (!videoPath && (!videoUrl.includes('youtube.com') && !videoUrl.includes('youtu.be') && !videoUrl.includes('tiktok.com'))) {
        return {
            errors: ['Please provide a valid YouTube or TikTok URL.'],
            finalStatus: 'FAIL',
            transcript: '',
            ocrText: [],
        };
    }

    const viService = new VideoIndexerService();

    const onProgress = (stage: string) => {
        if (typeof _onProgress === 'function') _onProgress(stage);
    };

    const extracted = await viService.processVideo(videoUrl, videoId, onProgress, videoPath);

    logger.info('[Node:Indexer] Extraction complete');

    return {
        transcript: extracted.transcript,
        ocrText: extracted.ocrText,
        videoMetadata: extracted.videoMetadata,
    };
}

/**
 * Node 2: Compliance Auditor
 */
export async function auditContentNode(state: VideoAuditState): Promise<Partial<VideoAuditState>> {
    const { transcript, ocrText = [], videoMetadata = { duration: null, platform: 'youtube' } } = state;

    logger.info('[Node:Auditor] Querying knowledge base & LLM');

    const auditor = new ComplianceAuditorService();
    const result = await auditor.audit({ transcript, ocrText, videoMetadata });

    logger.info(`[Node:Auditor] Audit complete — status: ${result.finalStatus}`);

    return {
        complianceResults: result.complianceResults,
        finalStatus: result.finalStatus,
        finalReport: result.finalReport,
    };
}
