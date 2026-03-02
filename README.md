# ComplianceQA — Backend API

Express.js API server for the AI-powered YouTube video compliance auditing system.

---

## Architecture

```
backend/
├── src/
│   ├── index.js                        # Entry point + graceful shutdown
│   ├── app.js                          # Express setup (CORS, helmet, rate-limiting)
│   ├── config/
│   │   ├── logger.js                   # Winston logger
│   │   ├── telemetry.js                # Azure Monitor OpenTelemetry
│   │   ├── openai.js                   # Azure OpenAI singleton
│   │   └── search.js                   # Azure AI Search singleton
│   ├── services/
│   │   ├── videoIndexer.service.js      # Video download + Azure indexing
│   │   └── complianceAuditor.service.js # RAG retrieval + GPT-4o audit
│   ├── controllers/
│   │   ├── audit.controller.js          # /audit endpoint + async pipeline
│   │   └── document.controller.js       # Document management
│   ├── routes/
│   │   ├── audit.routes.js
│   │   ├── health.routes.js
│   │   └── document.routes.js
│   └── middleware/
│       ├── error.middleware.js
│       └── logging.middleware.js
├── scripts/
│   └── indexDocuments.js                # Index compliance PDFs into Azure AI Search
├── data/                                # Drop compliance PDFs here
├── .env.example
└── package.json
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all Azure credentials in .env
```

### 3. Index compliance documents

```bash
# Drop PDFs into data/
cp your-ftc-guidelines.pdf data/

npm run index-docs
```

### 4. Start the server

```bash
# Development (with hot-reload)
npm run dev

# Production
npm start
```

The API will be available at **http://localhost:8000**

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET`  | `/health` | Service health + Azure config check |
| `GET`  | `/api` | API info |
| `POST` | `/api/audit` | Start compliance audit `{ videoUrl }` |
| `GET`  | `/api/audit/:sessionId` | Poll job status |
| `GET`  | `/api/audit/history` | Last 50 audits |
| `GET`  | `/api/documents` | List PDFs in data/ |
| `POST` | `/api/documents/index` | Trigger indexing |

---

## Pipeline Stages

```
POST /api/audit
      │
      ▼ (async — returns 202 immediately)
┌─────────────────────────────────────────────┐
│ Stage 1 — Video Indexer                     │
│  downloading → uploading → indexing         │
│  (VideoIndexerService)                      │
├─────────────────────────────────────────────┤
│ Stage 2 — Compliance Auditor                │
│  RAG retrieval → GPT-4o → parse violations  │
│  (ComplianceAuditorService)                 │
└─────────────────────────────────────────────┘
      │
      ▼
GET /api/audit/:sessionId  ←  frontend polls every 3s
```

---

## Required Azure Services

| Service | Purpose |
|---|---|
| Azure OpenAI (gpt-4o) | Compliance reasoning |
| Azure OpenAI (text-embedding-3-small) | RAG embeddings |
| Azure Video Indexer | Transcript + OCR extraction |
| Azure AI Search | Vector knowledge base |
| Azure Monitor | Telemetry (optional) |

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with nodemon (hot-reload) |
| `npm start` | Start production server |
| `npm run index-docs` | Index PDFs from `data/` into Azure AI Search |
| `npm run lint` | Run ESLint |
| `npm test` | Run Jest tests with coverage |
