import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureKeyCredential, SearchClient } from '@azure/search-documents';
import { AzureOpenAI } from 'openai';

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
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const openaiClient = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-01',
});

const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT!,
    INDEX_NAME,
    new AzureKeyCredential(process.env.AZURE_SEARCH_API_KEY!)
);

function chunkText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + chunkSize));
        start += chunkSize - overlap;
    }
    return chunks;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
    const response = await openaiClient.embeddings.create({
        model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
        input: texts,
    });
    return response.data.map((d) => d.embedding);
}

async function main() {
    console.log('='.repeat(60));
    console.log('ComplianceQA — Document Indexer');
    console.log('='.repeat(60));

    if (!fs.existsSync(DATA_DIR)) {
        console.error(`❌ Data directory not found: ${DATA_DIR}`);
        console.error('   Create backend/data/ and add your compliance PDF files.');
        process.exit(1);
    }

    let pdfParse: any;
    try {
        const mod = await import('pdf-parse');
        pdfParse = mod.default;
    } catch {
        console.warn('⚠️  pdf-parse not installed. Run: npm install pdf-parse');
        console.warn('   Skipping PDF text extraction.');
        process.exit(0);
    }

    const pdfFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.pdf'));
    if (!pdfFiles.length) {
        console.warn(`⚠️  No PDFs found in ${DATA_DIR}`);
        process.exit(0);
    }

    console.log(`Found ${pdfFiles.length} PDFs: ${pdfFiles.join(', ')}`);

    const allDocs: any[] = [];

    for (const file of pdfFiles) {
        const filePath = path.join(DATA_DIR, file);
        console.log(`\nProcessing: ${file}`);

        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        const chunks = chunkText(parsed.text);

        console.log(`  → ${chunks.length} chunks`);

        const vectors = await embedTexts(chunks);

        chunks.forEach((content, i) => {
            allDocs.push({
                id: `${file}_chunk_${i}`.replace(/[^a-zA-Z0-9_\-=]/g, '_'), // Clean ID
                content,
                source: file,
                contentVector: vectors[i],
            });
        });
    }

    console.log(`\nUploading ${allDocs.length} chunks to Azure AI Search (index: ${INDEX_NAME})…`);

    const BATCH = 100;
    for (let i = 0; i < allDocs.length; i += BATCH) {
        const batch = allDocs.slice(i, i + BATCH);
        await searchClient.uploadDocuments(batch);
        console.log(`  Uploaded ${Math.min(i + BATCH, allDocs.length)} / ${allDocs.length}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Indexing complete! Knowledge base is ready.');
    console.log(`   Total chunks indexed: ${allDocs.length}`);
    console.log('='.repeat(60));
}

main().catch((err) => {
    console.error('❌ Indexing failed:', err.message);
    process.exit(1);
});
