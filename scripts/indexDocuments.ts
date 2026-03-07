import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AzureKeyCredential, SearchClient, SearchIndexClient } from '@azure/search-documents';
import { AzureOpenAI } from 'openai';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
const INDEX_NAME = process.env.AZURE_SEARCH_INDEX_NAME!;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

const required = [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_KEY',
    'AZURE_SEARCH_ENDPOINT',
    'AZURE_SEARCH_API_KEY',
    'AZURE_SEARCH_INDEX_NAME',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`ERROR: Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please check your .env file and ensure all Azure credentials are set.');
    process.exit(1);
}

const openaiClient = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-01',
});

const indexClient = new SearchIndexClient(
    process.env.AZURE_SEARCH_ENDPOINT!,
    new AzureKeyCredential(process.env.AZURE_SEARCH_API_KEY!)
);

const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT!,
    INDEX_NAME,
    new AzureKeyCredential(process.env.AZURE_SEARCH_API_KEY!)
);

async function ensureIndex() {
    console.log(`Checking if index "${INDEX_NAME}" exists...`);
    try {
        await indexClient.getIndex(INDEX_NAME);
        console.log(`  -> Index exists.`);
    } catch (err: any) {
        if (err.statusCode === 404) {
            console.log(`  -> Index not found. Creating it now...`);
            await indexClient.createIndex({
                name: INDEX_NAME,
                fields: [
                    { name: 'id', type: 'Edm.String', key: true, filterable: true },
                    { name: 'content', type: 'Edm.String', searchable: true },
                    { name: 'source', type: 'Edm.String', searchable: true, filterable: true, facetable: true },
                    {
                        name: 'contentVector',
                        type: 'Collection(Edm.Single)',
                        searchable: true,
                        vectorSearchDimensions: 1536,
                        vectorSearchProfileName: 'my-vector-profile',
                    },
                ],
                vectorSearch: {
                    algorithms: [{ name: 'my-algorithms-config', kind: 'hnsw' }],
                    profiles: [{ name: 'my-vector-profile', algorithmConfigurationName: 'my-algorithms-config' }],
                },
            });
            console.log(`  -> Index created successfully.`);
        } else {
            console.error(`ERROR: Failed to check or create index: ${err.message}`);
            throw err;
        }
    }
}

async function embedTexts(texts: string[]): Promise<number[][]> {
    try {
        const response = await openaiClient.embeddings.create({
            model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
            input: texts,
        });
        return response.data.map((d) => d.embedding);
    } catch (err: any) {
        console.error(`ERROR: Failed to generate embeddings: ${err.message}`);
        throw err;
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('ComplianceQA - Document Indexer');
    console.log('='.repeat(60));

    if (!fs.existsSync(DATA_DIR)) {
        console.error(`ERROR: Data directory not found: ${DATA_DIR}`);
        console.error('Please create the "backend/data/" folder and place your compliance PDF files there.');
        process.exit(1);
    }

    let pdfParse: any;
    try {
        pdfParse = require('pdf-parse');
    } catch {
        console.error('ERROR: "pdf-parse" library is not installed.');
        console.error('Please run: npm install pdf-parse@1.1.1');
        process.exit(1);
    }

    await ensureIndex();

    const pdfFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.pdf'));
    if (!pdfFiles.length) {
        console.warn(`WARNING: No PDF files found in directory: ${DATA_DIR}`);
        process.exit(0);
    }

    console.log(`Found ${pdfFiles.length} PDF files: ${pdfFiles.join(', ')}`);

    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
    });

    const allDocs: any[] = [];

    for (const file of pdfFiles) {
        const filePath = path.join(DATA_DIR, file);
        console.log(`\nProcessing file: ${file}`);

        try {
            const buffer = fs.readFileSync(filePath);
            const parsed = await pdfParse(buffer);

            // Using LangChain's RecursiveCharacterTextSplitter
            const chunks = await splitter.splitText(parsed.text);

            console.log(`  -> Created ${chunks.length} chunks`);

            const vectors = await embedTexts(chunks);

            chunks.forEach((content, i) => {
                allDocs.push({
                    id: `${file}_chunk_${i}`.replace(/[^a-zA-Z0-9_\-=]/g, '_'),
                    content,
                    source: file,
                    contentVector: vectors[i],
                });
            });
        } catch (err: any) {
            console.error(`ERROR: Failed to process file "${file}": ${err.message}`);
            // Continue processing other files
        }
    }

    if (allDocs.length === 0) {
        console.warn('WARNING: No chunks were generated from the provided documents.');
        process.exit(0);
    }

    console.log(`\nUploading ${allDocs.length} chunks to Azure AI Search (index: ${INDEX_NAME})...`);

    const BATCH_SIZE = 100;
    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
        try {
            const batch = allDocs.slice(i, i + BATCH_SIZE);
            await searchClient.uploadDocuments(batch);
            console.log(`  Uploaded ${Math.min(i + BATCH_SIZE, allDocs.length)} / ${allDocs.length}`);
        } catch (err: any) {
            console.error(`ERROR: Failed to upload batch starting at index ${i}: ${err.message}`);
            throw err;
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS: Indexing complete! The knowledge base is now updated.');
    console.log(`Total chunks indexed: ${allDocs.length}`);
    console.log('='.repeat(60));
}

main().catch((err) => {
    console.error('\nCRITICAL ERROR: The indexing process failed prematurely.');
    console.error(err.message);
    process.exit(1);
});
