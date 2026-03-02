/**
 * Azure OpenAI client (singleton)
 * Wraps the official openai SDK pointed at your Azure deployment.
 */
import { AzureOpenAI } from 'openai';
import logger from './logger.js';

let _client: AzureOpenAI | null = null;

export function getOpenAIClient(): AzureOpenAI {
    if (_client) return _client;

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

    if (!endpoint || !apiKey) {
        throw new Error('Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY');
    }

    _client = new AzureOpenAI({ endpoint, apiKey, apiVersion });
    logger.info('✓ Azure OpenAI client initialized.');
    return _client;
}
