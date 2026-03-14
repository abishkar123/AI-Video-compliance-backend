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
            const errorMsg = 
                'ARM access token cannot be obtained.\n' +
                'The application is using Service Principal authentication but credentials are not available.\n\n' +
                'Troubleshooting:\n' +
                '1. If running locally, authenticate with: az login\n' +
                '2. If using Service Principal, ensure these environment variables are set:\n' +
                '   - AZURE_CLIENT_ID\n' +
                '   - AZURE_CLIENT_SECRET\n' +
                '   - AZURE_TENANT_ID\n' +
                '3. Alternatively, configure AZURE_VI_API_KEY instead';
            logger.error('Credential initialization failed', { errorMsg });
            throw new Error(errorMsg);
        }

        try {
            logger.info('Attempting to get ARM access token for Azure management API...');
            const tokenObj = await credential.getToken(
                'https://management.azure.com/.default'
            );
            if (!tokenObj) throw new Error('Failed to get ARM access token');
            logger.info('ARM access token obtained successfully');
            return tokenObj.token;
        } catch (err: unknown) {
            logger.error('Failed to get ARM access token', { 
                error: err instanceof Error ? err.message : String(err),
                hint: 'Verify Service Principal credentials (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)'
            });
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
            logger.warn('No armToken provided, attempting to get ARM access token...');
            try {
                armToken = await this.getArmAccessToken();
                logger.info('Successfully obtained ARM token for Video Indexer access');
            } catch (err) {
                logger.error('Failed to get ARM token, cannot proceed with ARM-based Video Indexer access', { err });
                throw err;
            }
        }

        const url =
            `https://management.azure.com/subscriptions/${this.subscriptionId}` +
            `/resourceGroups/${this.resourceGroup}` +
            `/providers/Microsoft.VideoIndexer/accounts/${this.viName}` +
            `/generateAccessToken?api-version=2024-01-01`;

        logger.info('Requesting Video Indexer account token via ARM', { 
            url: url.substring(0, url.indexOf('generateAccessToken')), 
            viName: this.viName 
        });

        try {
            const response = await axios.post(
                url,
                { permissionType: 'Contributor', scope: 'Account' },
                { headers: { Authorization: `Bearer ${armToken}` } }
            );

            if (response.status !== 200) {
                logger.error('Unexpected status code from ARM token generation', { 
                    status: response.status,
                    data: response.data 
                });
                throw new Error(`Failed to get VI account token: ${JSON.stringify(response.data)}`);
            }
            
            logger.info('Video Indexer account token obtained via ARM successfully');
            return response.data.accessToken;
        } catch (err: any) {
            if (err.response?.status === 401) {
                logger.error('ARM token is invalid or expired', { 
                    status: err.response?.status,
                    hint: 'Service Principal credentials may be invalid' 
                });
                throw new Error(
                    'Service Principal authentication failed (401)\n' +
                    'Your Azure credentials are invalid or expired.\n' +
                    'Troubleshooting:\n' +
                    '1. Verify AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID\n' +
                    '2. Ensure the Service Principal has "Contributor" role on the Video Indexer account\n' +
                    '3. Re-authenticate: az login'
                );
            } else if (err.response?.status === 403) {
                logger.error('Service Principal does not have required permissions', { 
                    status: err.response?.status,
                    viName: this.viName 
                });
                throw new Error(
                    'Insufficient permissions (403)\n' +
                    'Your Service Principal doesn\'t have "Contributor" role on the Video Indexer account.\n' +
                    'Contact your Azure administrator to grant the necessary permissions.'
                );
            } else if (err.response?.status === 404) {
                logger.error('Video Indexer account not found in ARM', { 
                    viName: this.viName,
                    resourceGroup: this.resourceGroup,
                    subscriptionId: this.subscriptionId 
                });
                throw new Error(
                    'Video Indexer account not found (404)\n' +
                    `Account name: ${this.viName} not found in resource group: ${this.resourceGroup}\n` +
                    'Verify your AZURE_VI_NAME and AZURE_RESOURCE_GROUP in .env'
                );
            } else {
                logger.error('Failed to get Video Indexer account token via ARM', {
                    status: err.response?.status,
                    message: err.response?.data?.message || err.message,
                    viName: this.viName
                });
                throw new Error(
                    `Failed to get Video Indexer account token\n` +
                    `Status: ${err.response?.status || 'Unknown'}\n` +
                    `Error: ${err.response?.data?.message || err.message || 'Unknown error'}`
                );
            }
        }
    }

    /**
     * Downloads a YouTube video
     */
    async downloadYouTubeVideo(url: string, outputPath: string = 'temp_audit_video.mp4'): Promise<string> {
        logger.info(`Downloading YouTube video: ${url}`);

        try {
            await ytDlp(url, {
                format: 'best',
                output: outputPath,
                // @ts-ignore - ytDlp types might be slightly off
                extractorArgs: 'youtube:player_client=android,web',
            });
        } catch (err: any) {
            const errMsg = err?.stderr || err?.message || String(err);

            if (errMsg.includes('Failed to resolve') || errMsg.includes('getaddrinfo failed')) {
                logger.error('YouTube download failed — DNS resolution error', { url });
                throw new Error(
                    'YouTube Download Failed — Network Error\n' +
                    'Could not resolve www.youtube.com. Please check your internet connection and DNS settings.'
                );
            }

            if (errMsg.includes('Video unavailable') || errMsg.includes('Private video')) {
                logger.error('YouTube video is unavailable or private', { url });
                throw new Error(
                    'YouTube Download Failed — Video Unavailable\n' +
                    'The video may be private, age-restricted, or removed.'
                );
            }

            logger.error('YouTube download failed', { url, error: errMsg });
            throw new Error(
                `YouTube Download Failed\n` +
                `Error: ${errMsg.slice(0, 500)}`
            );
        }

        logger.info('✓ YouTube download complete.');
        return outputPath;
    }

    /**
     * Upload video with 409 conflict handling and retry
     */
    async uploadVideo(videoPath: string, videoName: string): Promise<string> {
        // Validate file exists and is readable
        try {
            const stats = fs.statSync(videoPath);
            logger.info(`Video file: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            
            // Check for reasonable file size (less than 1GB for safety)
            if (stats.size > 1024 * 1024 * 1024) {
                throw new Error('Video file exceeds 1GB limit for Azure Video Indexer');
            }
        } catch (err: any) {
            logger.error('Failed to access video file', { err });
            throw new Error(`Failed to access video file: ${err.message}`);
        }

        // Retry loop with exponential backoff
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                // Generate completely unique random video name on each attempt
                // Format: vi_XXXXXX (short and random to minimize conflicts)
                const randomName = `vi_${Math.random().toString(36).substring(2, 12)}${Date.now().toString(36)}`;
                
                const result = await this.attemptUpload(videoPath, randomName);
                logger.info(`Upload succeeded on attempt ${attempt}`, { randomName });
                return result;
            } catch (err: any) {
                const status = err.response?.status;
                const message = err.response?.data?.message || err.message;
                const isConflict = status === 409;
                const isRateLimit = status === 429;

                logger.warn(`Upload attempt ${attempt} failed`, { status, message });

                // Only retry for transient errors
                if ((isConflict || isRateLimit) && attempt < 5) {
                    const waitMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s, 32s exponential backoff
                    logger.info(`Waiting ${waitMs}ms before retry attempt ${attempt + 1}...`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    continue;
                }

                // Final error handling
                if (status === 409) {
                    logger.error('Upload failed - Video name conflict after all retries', { attempts: attempt });
                    throw new Error(
                        'Video Upload Failed (409 After Retries)\n' +
                        '\n✗ Azure Video Indexer is rejecting all upload attempts.\n' +
                        '\n📋 This may indicate:\n' +
                        '  • Account quota exceeded\n' +
                        '  • Account in quarantine/suspension\n' +
                        '  • Concurrent upload limit reached\n' +
                        '  • API token invalid or expired\n' +
                        '\n🔧 Troubleshooting steps:\n' +
                        '  1. Visit https://www.videoindexer.ai/settings/usage\n' +
                        '  2. Check if your account has quota remaining\n' +
                        '  3. Delete old/failed videos if quota is full\n' +
                        '  4. Verify API key in settings: https://www.videoindexer.ai/settings/apis\n' +
                        '  5. Try manually uploading a video via the portal\n' +
                        '  6. Wait 10 minutes and retry\n' +
                        '\nIf issues persist, contact Azure support.'
                    );
                } else if (status === 401) {
                    logger.error('Upload failed - Authentication Error', { attempt });
                    throw new Error(
                        'Video Upload Failed (401 - Authentication)\n' +
                        '\n✗ Your Video Indexer credentials are invalid.\n' +
                        '\n🔧 Fix:\n' +
                        '  1. Get new API key: https://www.videoindexer.ai/settings/apis\n' +
                        '  2. Update AZURE_VI_API_KEY in your .env file\n' +
                        '  3. Restart the server\n' +
                        '  4. Try upload again'
                    );
                } else if (status === 400) {
                    logger.error('Upload failed - Invalid Request', { attempt, message });
                    throw new Error(
                        `Video Upload Failed (400 - Invalid Request)\n` +
                        `\n✗ The upload request was malformed.\n` +
                        `\nDetails: ${message || 'Check server logs for more info'}\n` +
                        `\nThis may indicate:\n` +
                        `  • Video format not supported\n` +
                        `  • File is corrupted\n` +
                        `  • API parameter mismatch`
                    );
                } else if (status === 429) {
                    logger.error('Upload failed - Rate Limit After Retries', { attempt });
                    throw new Error(
                        'Video Upload Failed (429 - Rate Limited)\n' +
                        '\n✗ Azure Video Indexer rate limit exceeded.\n' +
                        '\n⏳ Please wait 10-15 minutes before retrying.\n' +
                        '\nIf this happens frequently, your account may have\n' +
                        'hit subscription limits. Check your account tier.'
                    );
                } else {
                    logger.error('Upload failed - Unexpected Error', { status, message, attempt });
                    throw new Error(
                        `Video Upload Failed (${status})\n` +
                        `\n✗ Unexpected error from Azure Video Indexer.\n` +
                        `\nError: ${message}\n` +
                        `\nPlease check the server logs for more details.`
                    );
                }
            }
        }

        // This should never be reached due to throws, but satisfies TypeScript
        throw new Error('Video upload failed: exhausted all retry attempts');
    }

    /**
     * Attempt a single upload with stream (better for large files than buffer)
     */
    private async attemptUpload(videoPath: string, videoName: string): Promise<string> {
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
            throw err;
        }

        const apiUrl =
            `https://api.videoindexer.ai/${this.location}` +
            `/Accounts/${this.accountId}/Videos`;

        logger.info(`Upload details:`, {
            url: apiUrl,
            videoName,
            location: this.location,
            accountId: this.accountId,
            hasApiKey: !!this.apiKey,
        });

        // Use ReadStream instead of Buffer for better memory management
        const fileStream = fs.createReadStream(videoPath);
        const form = new FormData();
        form.append('file', fileStream, { filename: 'video.mp4' });

        const params = new URLSearchParams({
            accessToken: viToken,
            name: videoName,
            privacy: 'Private',
            // Try 'AudioOnly' preset first - less resource intensive
            indexingPreset: 'AudioOnly',
        });

        logger.info(`Uploading video as: ${videoName} | Preset: AudioOnly`);

        try {
            const response = await axios.post(`${apiUrl}?${params}`, form, {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 300000, // 5 minute timeout for large files
            });

            if (response.status !== 200) {
                logger.error('Upload returned non-200 status', {
                    status: response.status,
                    data: response.data
                });
                throw new Error(`Unexpected response: ${JSON.stringify(response.data)}`);
            }

            logger.info(`Upload successful. Video ID: ${response.data.id}`);
            return response.data.id;
        } catch (err: any) {
            // Capture full error details for 409
            if (err.response?.status === 409) {
                logger.error('409 Conflict - Full Response:', {
                    status: err.response.status,
                    statusText: err.response.statusText,
                    data: err.response.data,
                    headers: err.response.headers,
                });
            }
            // Re-throw to let caller handle retry logic
            throw err;
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
