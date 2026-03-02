/**
 * Azure AI Search client (singleton)
 * Used for RAG retrieval of compliance rules.
 */
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import logger from './logger.js';

let _searchClient: SearchClient<Record<string, unknown>> | null = null;

export function getSearchClient(): SearchClient<Record<string, unknown>> {
    if (_searchClient) return _searchClient;

    const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const apiKey = process.env.AZURE_SEARCH_API_KEY;
    const indexName = process.env.AZURE_SEARCH_INDEX_NAME;

    if (!endpoint || !apiKey || !indexName) {
        throw new Error(
            'Missing one of: AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_API_KEY, AZURE_SEARCH_INDEX_NAME'
        );
    }

    _searchClient = new SearchClient(endpoint, indexName, new AzureKeyCredential(apiKey));
    logger.info(`✓ Azure AI Search client initialized (index: ${indexName}).`);
    return _searchClient;
}
