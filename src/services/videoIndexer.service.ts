import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { DefaultAzureCredential } from '@azure/identity';
import ytDlp from 'yt-dlp-exec';
import FormData from 'form-data';
import { traceable } from 'langsmith/traceable';
import logger from '../config/logger.js';
import type { VideoExtraction, VideoIndexerInsights } from '../types/index.js';

class VideoIndexerService {
    private accountId: string | undefined;
    private location: string;
    private subscriptionId: string | undefined;
    private resourceGroup: string | undefined;
    private viName: string | undefined;
    private credential: DefaultAzureCredential;

    constructor() {
        this.accountId = process.env.AZURE_VI_ACCOUNT_ID;
        this.location = process.env.AZURE_VI_LOCATION || 'trial';
        this.subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
        this.resourceGroup = process.env.AZURE_RESOURCE_GROUP;
        this.viName = process.env.AZURE_VI_NAME;
        this.credential = new DefaultAzureCredential();
    }

    async getArmAccessToken(): Promise<string> {
        try {
            const tokenObj = await this.credential.getToken(
                'https://management.azure.com/.default'
            );
            if (!tokenObj) throw new Error('Failed to get ARM access token');
            return tokenObj.token;
        } catch (err: unknown) {
            logger.error('Failed to get ARM access token', { err });
            throw err;
        }
    }

    async getAccountToken(armToken: string): Promise<string> {
        const url =
            `https://management.azure.com/subscriptions/${this.subscriptionId}` +
            `/resourceGroups/${this.resourceGroup}` +
            `/providers/Microsoft.VideoIndexer/accounts/${this.viName}` +
            `/generateAccessToken?api-version=2024-01-01`;

        const response = await axios.post(
            url,
            { permissionType: 'Contributor', scope: 'Account' },
            { headers: { Authorization: `Bearer ${armToken}` } }
        );

        if (response.status !== 200) {
            throw new Error(`Failed to get VI account token: ${JSON.stringify(response.data)}`);
        }
        return response.data.accessToken;
    }

    /**
     * Downloads a YouTube video
     */
    async downloadYouTubeVideo(url: string, outputPath: string = 'temp_audit_video.mp4'): Promise<string> {
        logger.info(`Downloading YouTube video: ${url}`);

        await ytDlp(url, {
            format: 'best',
            output: outputPath,
            noWarnings: false,
            // @ts-ignore - ytDlp types might be slightly off
            extractorArgs: 'youtube:player_client=android,web',
        });

        logger.info('✓ YouTube download complete.');
        return outputPath;
    }

    /**
     * Upload video
     */
    async uploadVideo(videoPath: string, videoName: string): Promise<string> {
        const armToken = await this.getArmAccessToken();
        const viToken = await this.getAccountToken(armToken);

        const apiUrl =
            `https://api.videoindexer.ai/${this.location}` +
            `/Accounts/${this.accountId}/Videos`;

        const form = new FormData();
        form.append('file', fs.createReadStream(videoPath));

        const params = new URLSearchParams({
            accessToken: viToken,
            name: videoName,
            privacy: 'Private',
            indexingPreset: 'Default',
        });

        logger.info(`Uploading ${videoPath} to Azure Video Indexer…`);

        const response = await axios.post(`${apiUrl}?${params}`, form, {
            headers: form.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        if (response.status !== 200) {
            throw new Error(`Azure upload failed: ${JSON.stringify(response.data)}`);
        }

        logger.info(`✓ Upload accepted. Azure video ID: ${response.data.id}`);
        return response.data.id;
    }

    /**
     * Poll wait processing
     */
    async waitForProcessing(videoId: string, onProgress?: (state: string) => void): Promise<VideoIndexerInsights> {
        logger.info(`Polling Video Indexer for video ${videoId}…`);

        while (true) {
            const armToken = await this.getArmAccessToken();
            const viToken = await this.getAccountToken(armToken);

            const url =
                `https://api.videoindexer.ai/${this.location}` +
                `/Accounts/${this.accountId}/Videos/${videoId}/Index`;

            const response = await axios.get(url, {
                params: { accessToken: viToken },
            });

            const { state } = response.data;
            logger.info(`Video Indexer status: ${state}`);

            if (onProgress) onProgress(state);

            if (state === 'Processed') return response.data;
            if (state === 'Failed') throw new Error('Video indexing failed in Azure.');
            if (state === 'Quarantined') throw new Error('Quarantined — copyright violation.');

            await new Promise((r) => setTimeout(r, 30_000));
        }
    }

    /**
     * Extract data
     */
    extractData(viJson: VideoIndexerInsights): VideoExtraction {
        const transcriptLines: string[] = [];
        const ocrLines: string[] = [];

        for (const video of viJson.videos || []) {
            const insights = video.insights || {};

            for (const t of insights.transcript || []) {
                if (t.text) transcriptLines.push(t.text);
            }
            for (const o of insights.ocr || []) {
                if (o.text) ocrLines.push(o.text);
            }
        }

        const duration = viJson.summarizedInsights?.duration?.seconds ?? null;

        return {
            transcript: transcriptLines.join(' '),
            ocrText: ocrLines,
            videoMetadata: { duration, platform: 'youtube' },
        };
    }

    /**
     * Process video (Full Pipeline)
     */
    processVideo = traceable(async (videoUrl: string, videoId: string, onProgress?: (state: string) => void, existingLocalPath?: string): Promise<VideoExtraction> => {
        const localPath = existingLocalPath || path.resolve(`temp_${videoId}.mp4`);
        const isTemporary = !existingLocalPath;

        try {
            if (isTemporary) {
                if (onProgress) onProgress('downloading');
                await this.downloadYouTubeVideo(videoUrl, localPath);
            }

            if (onProgress) onProgress('uploading');
            const azureVideoId = await this.uploadVideo(localPath, videoId);

            if (onProgress) onProgress('indexing');
            const rawInsights = await this.waitForProcessing(azureVideoId, onProgress);

            return this.extractData(rawInsights);
        } finally {
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
                logger.info(`Cleaned up file: ${localPath}`);
            }
        }
    }, { name: "Azure_VideoIndexer_Processing" });
}

export default VideoIndexerService;
