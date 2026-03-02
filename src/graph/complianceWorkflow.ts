import { WorkflowGraph } from './workflowGraph.js';
import { indexVideoNode, auditContentNode } from './nodes.js';

export function createGraph(): WorkflowGraph {
    const graph = new WorkflowGraph('compliance-audit');

    graph.addNode('indexer', indexVideoNode, {
        label: 'Video Indexer',
        description: 'Downloads YouTube video, uploads to Azure Video Indexer, extracts transcript & OCR',
        icon: 'video',
    });

    graph.addNode('auditor', auditContentNode, {
        label: 'Compliance Auditor',
        description: 'RAG retrieval from Azure AI Search + GPT-4o compliance reasoning',
        icon: 'shield',
    });

    graph
        .setEntryPoint('indexer')
        .addEdge('indexer', 'auditor')
        .addEdge('auditor', '__end__');

    return graph.compile();
}

export const graph = createGraph();
