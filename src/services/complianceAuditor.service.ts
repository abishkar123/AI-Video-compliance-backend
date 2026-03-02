import { traceable } from 'langsmith/traceable';
import { getOpenAIClient } from '../config/openai.js';
import { getSearchClient } from '../config/search.js';
import logger from '../config/logger.js';
import type { AuditLLMResponse, AuditResult, VideoMetadata } from '../types/index.js';

const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o';
const EMBED_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';

interface AuditParams {
    transcript: string | undefined;
    ocrText?: string[];
    videoMetadata?: VideoMetadata;
}

class ComplianceAuditorService {
    /**
     * Embed text
     */
    async embedText(text: string): Promise<number[]> {
        const client = getOpenAIClient();
        const response = await client.embeddings.create({
            model: EMBED_DEPLOYMENT,
            input: text,
        });
        return response.data[0].embedding;
    }

    /**
     * Retrieves top-k compliance rules
     */
    /**
     * Retrieves top-k compliance rules
     */
    retrieveComplianceRules = traceable(async (queryText: string, topK: number = 3): Promise<string> => {
        const searchClient = getSearchClient();
        const queryVector = await this.embedText(queryText);

        const results = await searchClient.search('*', {
            vectorSearchOptions: {
                queries: [
                    {
                        kind: 'vector',
                        vector: queryVector,
                        fields: ['contentVector'],
                        kNearestNeighborsCount: topK,
                    },
                ],
            },
            select: ['content', 'source'],
            top: topK,
        });

        const docs: string[] = [];
        for await (const result of results.results) {
            docs.push((result.document as { content: string }).content || '');
        }

        logger.info(`Retrieved ${docs.length} compliance rule chunks from AI Search.`);
        return docs.join('\n\n');
    }, { name: "RAG_Search_Compliance_Rules" });

    /**
     * Send transcript + rules to GPT-4o
     */
    auditWithLLM = traceable(async (transcript: string, ocrText: string[], videoMetadata: VideoMetadata, retrievedRules: string): Promise<AuditLLMResponse> => {
        const client = getOpenAIClient();

        const systemPrompt = `
You are a Senior Brand Compliance Auditor.

OFFICIAL REGULATORY RULES:
${retrievedRules}

INSTRUCTIONS:
1. Analyze the Transcript and OCR text provided.
2. Identify ANY violations of the rules above.
3. Return STRICTLY valid JSON — no markdown fences, no preamble:

{
  "compliance_results": [
    {
      "category": "Claim Validation",
      "severity": "CRITICAL",
      "description": "Specific explanation of the violation detected."
    }
  ],
  "status": "FAIL",
  "final_report": "Plain-English summary of all findings."
}

If no violations are found, set "status" to "PASS" and "compliance_results" to [].
Valid severity values: "CRITICAL" | "WARNING"
`.trim();

        const userMessage = `
VIDEO METADATA: ${JSON.stringify(videoMetadata)}
TRANSCRIPT: ${transcript}
ON-SCREEN TEXT (OCR): ${JSON.stringify(ocrText)}
`.trim();

        const response = await client.chat.completions.create({
            model: DEPLOYMENT,
            temperature: 0,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
        });

        let rawContent = response.choices[0].message.content || '';

        const fenceMatch = rawContent.match(/```(?:json)?([\s\S]*?)```/);
        if (fenceMatch) rawContent = fenceMatch[1];

        try {
            return JSON.parse(rawContent.trim());
        } catch (e) {
            logger.error('Failed to parse LLM response: ' + rawContent);
            throw new Error('Audit reasoning failed — response format error');
        }
    }, { name: "LLM_Compliance_Reasoning" });

    /**
     * Full compliance audit pipeline
     */
    async audit({ transcript, ocrText = [], videoMetadata = { duration: null, platform: 'youtube' } }: AuditParams): Promise<AuditResult> {
        if (!transcript) {
            return {
                complianceResults: [],
                finalStatus: 'FAIL',
                finalReport: 'Audit skipped — no transcript available (video processing likely failed).',
            };
        }

        logger.info('[Auditor] Starting RAG compliance audit…');

        const queryText = `${transcript} ${ocrText.join(' ')}`;
        const retrievedRules = await this.retrieveComplianceRules(queryText);

        const auditData = await this.auditWithLLM(
            transcript,
            ocrText,
            videoMetadata,
            retrievedRules
        );

        logger.info(`[Auditor] Audit complete — status: ${auditData.status}`);

        return {
            complianceResults: auditData.compliance_results || [],
            finalStatus: auditData.status || 'FAIL',
            finalReport: auditData.final_report || 'No report generated.',
        };
    }
}

export default ComplianceAuditorService;
