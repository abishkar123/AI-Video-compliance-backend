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
    private apiKey: string | undefined;
    private credential: DefaultAzureCredential | null | undefined = undefined;
    private credentialPromise: Promise<DefaultAzureCredential | null> | null = null;

    constructor() {
        this.accountId = process.env.AZURE_VI_ACCOUNT_ID;
        this.location = process.env.AZURE_VI_LOCATION || 'trial';
        this.subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
        this.resourceGroup = process.env.AZURE_RESOURCE_GROUP;
        this.viName = process.env.AZURE_VI_NAME;
        this.apiKey = process.env.AZURE_VI_API_KEY; // Support direct API Key auth

        // Validate required configuration
        if (!this.accountId) {
            logger.warn('WARNING: AZURE_VI_ACCOUNT_ID not configured');
        }

        // If API key is available, we don't need DefaultAzureCredential
        if (!this.apiKey) {
            logger.warn('WARNING: AZURE_VI_API_KEY not configured. Falling back to DefaultAzureCredential authentication.');
        } else {
            logger.info('Video Indexer authentication using API key configured');
        }
    }

    private async initializeCredential(): Promise<DefaultAzureCredential | null> {
        // If API key is configured, skip credential initialization
        if (this.apiKey) {
            return null;
        }

        // If already initialized, return cached value
        if (this.credential !== undefined) {
            return this.credential;
        }

        // If already initializing, wait for that promise
        if (this.credentialPromise) {
            return this.credentialPromise;
        }

        // Initialize credential with error handling
        this.credentialPromise = (async () => {
            try {
                const cred = new DefaultAzureCredential();
                this.credential = cred;
                return cred;
            } catch (err: unknown) {
                logger.error('Failed to initialize DefaultAzureCredential', { err });
                this.credential = null;
                return null;
            }
        })();

        return this.credentialPromise;
    }

    async getArmAccessToken(): Promise<string> {
        const credential = await this.initializeCredential();

        if (!credential) {
            throw new Error(
                'ARM access token cannot be obtained. ' +
                'Please configure AZURE_VI_API_KEY in your .env file, or ensure Azure CLI is authenticated (az login).'
            );
        }

        try {
            const tokenObj = await credential.getToken(
                'https://management.azure.com/.default'
            );
            if (!tokenObj) throw new Error('Failed to get ARM access token');
            return tokenObj.token;
        } catch (err: unknown) {
            logger.error('Failed to get ARM access token', { err });
            throw err;
        }
    }

    async getAccountToken(armToken?: string): Promise<string> {
        // If we have an API Key, we can get the token directly from the VI Auth API
        if (this.apiKey) {
            try {
                const url = `https://api.videoindexer.ai/auth/${this.location}/Accounts/${this.accountId}/AccessToken?allowEdit=true`;
                logger.info(`Requesting Video Indexer account token from: ${url}`);

                const response = await axios.get(url, {
                    headers: { 'Ocp-Apim-Subscription-Key': this.apiKey }
                });

                logger.info('Video Indexer account token obtained successfully');
                return response.data;
            } catch (err: any) {
                if (err.response?.status === 401) {
                    logger.error('Authentication failed with Video Indexer (401 Unauthorized)', {
                        message: 'Your AZURE_VI_API_KEY is invalid, expired, or doesn\'t match your account',
                        location: this.location,
                        accountId: this.accountId
                    });
                    throw new Error(
                        'Video Indexer Authentication Failed (401 Unauthorized)\n' +
                        'Your AZURE_VI_API_KEY appears to be invalid or expired.\n' +
                        'Please verify:\n' +
                        '1. API key is correct (from https://www.videoindexer.ai/settings/apis)\n' +
                        '2. API key hasn\'t expired\n' +
                        '3. Account ID matches your Video Indexer account\n' +
                        '4. Location is set to "trial"'
                    );
                } else if (err.response?.status === 403) {
                    logger.error('Access forbidden - API key does not have required permissions', { err });
                    throw new Error(
                        'Video Indexer Access Forbidden (403)\n' +
                        'Your API key doesn\'t have permission to access this account.\n' +
                        'Check that the API key is associated with the correct Video Indexer account.'
                    );
                } else if (err.response?.status === 404) {
                    logger.error('Video Indexer account not found', { accountId: this.accountId });
                    throw new Error(
                        'Video Indexer Account Not Found (404)\n' +
                        `Account ID: ${this.accountId} not found.\n` +
                        'Please verify your AZURE_VI_ACCOUNT_ID in .env'
                    );
                } else {
                    logger.error('Unexpected error getting Video Indexer token', {
                        status: err.response?.status,
                        message: err.response?.data?.message || err.message
                    });
                    throw new Error(
                        `Video Indexer Token Request Failed\n` +
                        `Status: ${err.response?.status || 'Unknown'}\n` +
                        `Error: ${err.response?.data?.message || err.message}`
                    );
                }
            }
        }

        // Fallback to ARM-based token generation (requires armToken)
        if (!armToken) {
            throw new Error('ARM token required if AZURE_VI_API_KEY is not provided');
        }

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
        let viToken: string;

        try {
            if (this.apiKey) {
                viToken = await this.getAccountToken();
            } else {
                const armToken = await this.getArmAccessToken();
                viToken = await this.getAccountToken(armToken);
            }
        } catch (err: any) {
            logger.error('Failed to obtain Video Indexer token', { err: err.message });
            throw err; // Re-throw with better error context already added
        }

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

        try {
            const response = await axios.post(`${apiUrl}?${params}`, form, {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            if (response.status !== 200) {
                logger.error('Video upload failed', {
                    status: response.status,
                    data: response.data
                });
                throw new Error(`Azure upload failed: ${JSON.stringify(response.data)}`);
            }

            logger.info(`Upload accepted. Azure video ID: ${response.data.id}`);
            return response.data.id;
        } catch (err: any) {
            if (err.response?.status === 401) {
                logger.error('Upload failed - Token expired or invalid', { err });
                throw new Error(
                    'Video Upload Failed - Authentication Error (401)\n' +
                    'The access token expired or became invalid during upload.\n' +
                    'This can happen with large files. Please try again.'
                );
            } else if (err.response?.status === 400) {
                logger.error('Upload failed - Invalid request', { data: err.response.data });
                throw new Error(
                    'Video Upload Failed - Invalid Request (400)\n' +
                    `Details: ${err.response.data?.message || err.message}`
                );
            } else if (err.response?.status === 429) {
                logger.error('Rate limit exceeded', { err });
                throw new Error(
                    'Rate Limit Exceeded (429)\n' +
                    'You\'ve reached the upload limit. Please wait a moment and try again.'
                );
            } else {
                logger.error('Unexpected upload error', {
                    status: err.response?.status,
                    message: err.message
                });
                throw new Error(
                    `Video Upload Failed\n` +
                    `Status: ${err.response?.status || 'Unknown'}\n` +
                    `Error: ${err.message}`
                );
            }
        }
    }

    /**
     * Poll wait processing
     */
    async waitForProcessing(videoId: string, onProgress?: (state: string) => void): Promise<VideoIndexerInsights> {
        logger.info(`Polling Video Indexer for video ${videoId}…`);

        while (true) {
            let viToken: string;

            try {
                if (this.apiKey) {
                    viToken = await this.getAccountToken();
                } else {
                    const armToken = await this.getArmAccessToken();
                    viToken = await this.getAccountToken(armToken);
                }
            } catch (err: any) {
                logger.error('Failed to refresh token during polling', { err: err.message });
                throw new Error(
                    'Token Refresh Failed During Processing\n' +
                    'Unable to check video processing status.\n' +
                    err.message
                );
            }

            try {
                const url =
                    `https://api.videoindexer.ai/${this.location}` +
                    `/Accounts/${this.accountId}/Videos/${videoId}/Index`;

                const response = await axios.get(url, {
                    params: { accessToken: viToken },
                });

                const { state } = response.data;
                logger.info(`Video Indexer status: ${state}`);

                if (onProgress) onProgress(state);

                if (state === 'Processed') {
                    logger.info('Video processing completed successfully');
                    return response.data;
                }
                if (state === 'Failed') {
                    logger.error('Video indexing failed in Azure');
                    throw new Error('Video Indexing Failed\nThe video could not be indexed. This may be due to:\n- Unsupported video format\n- Corrupted video file\n- Service error');
                }
                if (state === 'Quarantined') {
                    logger.error('Video quarantined - likely copyright violation');
                    throw new Error('Video Quarantined\nThe video appears to contain copyrighted content and was quarantined for policy reasons.');
                }

                // Still processing, wait before next poll
                await new Promise((r) => setTimeout(r, 30_000));
            } catch (err: any) {
                if (err.response?.status === 401) {
                    logger.error('Token expired during polling', { err });
                    throw new Error(
                        'Authentication Expired During Processing\n' +
                        'Your access token expired. Please try uploading the video again.'
                    );
                } else if (err.response?.status === 404) {
                    logger.error('Video not found during polling', { videoId });
                    throw new Error(
                        `Video Not Found\n` +
                        `Video ID ${videoId} could not be found. It may have been deleted.`
                    );
                } else if (err.message?.includes('Video Indexing Failed') || err.message?.includes('Quarantined') || err.message?.includes('Authentication Expired')) {
                    // Re-throw our formatted errors
                    throw err;
                } else {
                    logger.error('Unexpected error during polling', {
                        status: err.response?.status,
                        message: err.message
                    });
                    throw new Error(
                        `Processing Status Check Failed\n` +
                        `Status: ${err.response?.status || 'Unknown'}\n` +
                        `Error: ${err.message}`
                    );
                }
            }
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
