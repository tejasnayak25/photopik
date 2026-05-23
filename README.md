# PhotoPik — Face-Based Photo Retrieval (prototype)

Quick start (dev):

```bash
npm install
npm run dev
```

This repo is scaffolded for a free-first MVP using Google Drive for storage, Firestore for metadata, and a Hugging Face Space for embeddings.

See [face_based_photo_retrieval_detailed_roadmap.md](face_based_photo_retrieval_detailed_roadmap.md) for the roadmap.

## Re-embed Existing Faces (Backfill)

If earlier uploads were processed before the embedding model fix, you can backfill face embeddings:

```bash
# dry-run (default): prints what would change
npm run reembed:dry -- --eventId wedding-2026 --limit 100

# apply mode: replaces existing face docs per image with newly generated embeddings
npm run reembed:apply -- --eventId wedding-2026 --limit 100 --embeddingVersion v2-backfill

# incremental run: only recently uploaded images
npm run reembed:apply -- --sinceDays 7 --limit 200 --embeddingVersion v2-backfill

# resumable run: persists processed image IDs in checkpoint file
npm run reembed:apply -- --eventId wedding-2026 --resume --checkpointFile .reembed_checkpoint.json

# faster run: process multiple images in parallel
npm run reembed:apply -- --eventId wedding-2026 --limit 200 --resume --concurrency 3
```

Required environment variables:

- `HF_SPACE_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON string or path)
- Optional Drive OAuth flow: `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Async Face Indexing Queue

Uploads now support async indexing to reduce API latency.

- `INDEX_ASYNC_UPLOAD=true` (default): upload enqueues a Firestore job in `indexJobs` and returns immediately.
- `INDEX_ASYNC_UPLOAD=false`: upload indexes faces inline (legacy behavior).
- `INDEX_WORKER_SECRET`: required by the worker endpoint/script.
- `EMBEDDING_VERSION` (optional, default `v2`): version tag applied to stored face docs.

Run the worker after uploads (or on a cron):

```bash
# one batch against local app server
npm run index:worker -- --limit 30

# run multiple batches until queue is drained
npm run index:worker -- --limit 30 --iterations 10
```

Worker endpoint (for external schedulers):

- `POST /api/index/worker`
- Header: `Authorization: Bearer $INDEX_WORKER_SECRET`
- Body: `{ "limit": 30 }`

Queue health is available in `GET /api/metrics` under `indexQueue`.

## Optional Vector Search Backend (Qdrant)

Search APIs can use Qdrant for faster similarity lookup:

- `POST /api/search`
- `POST /api/search-by-selfie`

When configured, responses include `backend: "vector"`; otherwise they fallback to Firestore brute-force.

### Environment Variables

- `QDRANT_URL` (example: `https://your-cluster.qdrant.io`)
- `QDRANT_API_KEY` (if your Qdrant deployment requires auth)
- `QDRANT_COLLECTION` (optional, default `photopik_faces`)

### Rollout Notes

- New/updated images indexed through the async worker are automatically synced to Qdrant.
- If you already have historical faces, run re-embedding/indexing workflows so vectors are populated before switching fully to vector search.

### One-Command Qdrant Setup

Bootstrap collection + payload indexes:

```bash
npm run qdrant:setup
```

This creates/validates:

- Collection: `QDRANT_COLLECTION` (default `photopik_faces`)
- Vector config: size `512`, distance `Cosine`
- Payload indexes: `eventId`, `imageId`, `embeddingVersion`

Optional overrides:

```bash
# different embedding dimension
npm run qdrant:setup -- --dim 512

# customize HNSW settings
npm run qdrant:setup -- --hnswM 16 --efConstruct 256

# only payload indexes
npm run qdrant:setup -- --skipCollection

# only collection
npm run qdrant:setup -- --skipIndexes
```

### Sync Existing Faces to Qdrant (No Re-embedding)

If you already have vectors in Firestore `faces`, push them to Qdrant directly:

```bash
# safe dry-run (default script behavior)
npm run qdrant:sync -- --eventId hackothsava-2k26 --limit 500

# apply: actually upsert points into Qdrant
npm run qdrant:sync -- --apply --eventId hackothsava-2k26 --limit 500

# resumable large sync
npm run qdrant:sync -- --apply --resume --checkpointFile .qdrant_sync_checkpoint.json --batchSize 200 --upsertBatchSize 128
```

Notes:

- Requires `GOOGLE_SERVICE_ACCOUNT_JSON`, `QDRANT_URL`, and optional `QDRANT_API_KEY`.
- Skips missing/all-zero embeddings automatically.
- Uses deterministic UUID point IDs derived from `face` doc IDs for idempotent re-runs.

### Deployment Setup (Index Worker)

You have two common production patterns:

1) **Platform cron hits the worker endpoint** (recommended)
2) **Background process runs `npm run index:worker`** in a loop

#### Option A: Vercel Cron (recommended for Next.js on Vercel)

1. Set env vars in deployment:

- `INDEX_ASYNC_UPLOAD=true`
- `HF_SPACE_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (or OAuth vars)
- `CRON_SECRET` (or `INDEX_WORKER_SECRET`)

2. Add `vercel.json` in project root:

```json
{
	"crons": [
		{
			"path": "/api/index/worker?limit=30",
			"schedule": "*/1 * * * *"
		}
	]
}
```

Vercel includes `Authorization: Bearer $CRON_SECRET` automatically. The worker accepts either `INDEX_WORKER_SECRET` or `CRON_SECRET`.

#### Option B: Generic Scheduler (Cloud Scheduler / GitHub Actions / cron-job.org)

Schedule a `POST` every 1-2 minutes to your deployed URL:

```bash
curl -X POST "https://YOUR_DOMAIN/api/index/worker?limit=30" \
	-H "Authorization: Bearer YOUR_INDEX_WORKER_SECRET" \
	-H "Content-Type: application/json" \
	-d '{}'
```

#### Option C: Long-running worker process (Render/Railway/Fly sidecar)

Run periodic batches directly:

```bash
npm run index:worker -- --baseUrl https://YOUR_DOMAIN --limit 30 --iterations 20
```

Use your platform scheduler/supervisor to rerun this command repeatedly.

#### Sizing Tips

- Start with `limit=20` or `30`.
- If `indexQueue.pending` keeps growing, increase cron frequency or run multiple worker invocations.
- If HF space rate-limits, lower `limit` and run more often.
