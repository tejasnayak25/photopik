# Face-Based Photo Retrieval — Detailed Roadmap

Last updated: 2026-05-23

Purpose: a single-source, implementation-focused roadmap that turns the high-level plan into phased epics, milestones, tasks, risks, and acceptance criteria. Includes a "free-only" path (Google Drive + Cloudflare + HF Space CPU) and migration notes to production-ready object storage and ANN search.

Overview
- Core idea: ingest event photos, extract face embeddings, allow users to find photos by uploading/scanning a selfie.
- Primary constraints: prioritize free resources for initial development (Drive 5TB, Firebase free tier limits), keep architecture migratable to cloud object storage + ANN later.

Goals & Success Metrics
- Functionality: users can upload selfies and retrieve matching images from an event with reasonable relevance (target initial recall > 0.7 at top-10 with tuned threshold).
- Performance: median search latency < 2s for single-event (prototype) using HF Space CPU + caching.
- Cost: bootstrap with zero storage bill by relying on free Drive quota and free-tier services.
- Privacy: consent capture + delete endpoint implemented before public beta.

High-level Phases
- Phase 0 — Planning & Architecture (1 week)
- Phase 1 — Project Setup (1–2 weeks)
- Phase 2 — Drive-based Upload & Metadata (2 weeks)
- Phase 3 — AI Face Processing (2 weeks)
- Phase 4 — Search & Selfie Flow (2 weeks)
- Phase 5 — Gallery + UI polish (2 weeks)
- Phase 6 — Event Management & Multi-event Isolation (1 week)
- Phase 7 — Security, Privacy & Compliance (1–2 weeks)
- Phase 8 — Optimization & Migration Roadmap (2 weeks)

Phase breakdown (tasks, deliverables, owners, acceptance)

Phase 0 — Planning & Architecture
- Objectives: finalize entities, dataflow, storage strategy (free-first), and vector search plan.
- Tasks:
  - Finalize data model: `users`, `events`, `images`, `faces` (include example Firestore shapes).
  - Define API contracts for upload, embed, search, and admin operations.
  - Decide initial storage approach: **Free-first**: Google Drive for originals + derivatives; derivatives cached via Cloudflare + Next.js proxy.
- Deliverables: architecture diagram, entity schemas, API contract doc.
- Acceptance: team sign-off; doc in repo.

Phase 1 — Project Setup
- Objectives: initialize repo, CI, Next.js + Tailwind skeleton, basic Firebase integration.
- Tasks:
  - Create Next.js app with Tailwind.
  - Add Firebase SDK and local emulators config for Firestore/auth.
  - Create environment secret patterns and sample `.env.local.example`.
  - Setup basic CI (GitHub Actions) to run lint/tests.
- Deliverables: working dev server, auth scaffold, README with setup steps.
- Acceptance: app runs locally; connects to Firestore emulator.

Phase 2 — Drive-based Upload & Metadata (Free-first)
- Objectives: allow photographers/admins to upload event photos into Drive and save Firestore metadata.
- Tasks:
  - Client-side pre-processing: generate WebP derivatives and a thumbnail in-browser (max width 1280px, plus 320px thumbnail).
  - Upload flow: derivatives + original upload to Drive via a server-signed upload endpoint.
  - Firestore metadata schema for `images`:
    {
      "id": "<uuid>",
      "eventId": "...",
      "driveFileId": "...",
      "derivativeDriveId": "...",
      "thumbnailDriveId": "...",
      "syncedToCloud": false,
      "uploadedAt": "..."
    }
  - Create `/api/upload` Next.js route that performs Drive uploads using Service Account credentials (server-side only).
  - Implement `syncStatus` / backoff logic to handle Drive rate limits.
- Deliverables: upload UI, `/api/upload` server route, metadata persisted in Firestore.
- Acceptance: upload an image via UI; derivative and original appear in Drive; Firestore record created.

Phase 3 — AI Face Processing (HF Space CPU)
- Objectives: detect faces and produce embeddings for each face; prefer sending derivatives to HF Space to reduce inference cost.
- Tasks:
  - HF Space endpoints: `/detect` and `/embed` (FastAPI) using InsightFace/ONNX.
  - Server job (Next.js API route or background worker) that calls HF `/detect` → crops → `/embed` and writes face docs to Firestore:
    `faces` doc:
    {
      "faceId": "...",
      "imageId": "...",
      "embedding": <float16 array>,
      "bbox": {x,y,w,h},
      "createdAt": "..."
    }
  - Use float16 arrays and store them as base64 or packed arrays in Firestore (or split into chunks) — note Firestore size limits and consider storing embeddings in compressed form or as external file if large.
- Deliverables: HF Space with endpoints; face docs created in Firestore.
- Acceptance: upload image → face docs appear with embeddings.

Phase 4 — Search & Selfie Flow
- Objectives: enable users to capture/upload selfie, embed it, and run similarity search against event faces.
- Tasks:
  - Selfie capture page with webcam + upload.
  - Selfie → HF `/embed` → embedding vector.
  - Fetch event face embeddings (paged) and compute cosine similarity server-side in `/api/search`.
  - For free-first: do linear scan on single-event; implement pagination and early exit heuristics for performance.
  - Add threshold tuning config and telemetry to log search results for future threshold tuning.
- Deliverables: selfie search page, `/api/search` implementation.
- Acceptance: selfie search returns relevant images in top results for test cases.

Phase 5 — Gallery & UI polish
- Objectives: present results in responsive gallery with image viewer, download, and consent UI.
- Tasks:
  - Masonry grid, lazy-loading, infinite scroll.
  - Fullscreen viewer with zoom, metadata, and download button (download streams via `/api/image/:id`).
  - Per-person gallery route `/gallery/:personId` (optional grouping by cluster id).
- Acceptance: responsive UI, images load quickly via cached derivatives.

Phase 6 — Event Management
- Objectives: support event creation, visibility controls, and search scoping.
- Tasks:
  - Event CRUD UI and Firestore `events` schema.
  - Visibility: public/private/invite-only flags + invitation flow.
  - Ensure `/api/search` filters embeddings by `eventId`.
- Acceptance: admin can create events and users can search within selected event only.

Phase 7 — Security & Privacy
- Objectives: ensure biometric data protection and allow deletion/consent flows.
- Tasks:
  - Implement consent checkbox during upload and store consent record.
  - Implement `/api/delete-my-data` that removes embeddings, metadata, and derivative references (and marks originals for deletion/sync).
  - Implement server-side proxy `/api/image/:id` to serve Drive files to authenticated users (avoid public Drive links).
  - Draft Firebase security rules for collections: `users`, `events`, `images`, `faces` (role-based access).
  - Audit logging for deletion and consent changes.
- Acceptance: deletion flow verified; Firebase rules block unauthorized access.

Phase 8 — Optimization & Migration Roadmap
- Objectives: prepare to move from Drive-based prototype to scalable production (object store + ANN).
- Tasks:
  - Add an ANN option plan: evaluate Pinecone, Milvus, or in-app FAISS + small ANN host. Recommendation: Pinecone (managed) or Milvus (self-host) for larger scales.
  - Migration plan: periodically copy originals to a cheap object store (Backblaze B2 or Cloudflare R2) and store derivatives there for serving.
  - Replace linear scan with ANN when faces > ~50k per event or cross-event search required.
  - Add GPU inference option for HF Space or move embedding service to an affordable GPU host.
- Acceptance: documented migration steps + prototype ANN integration plan.

Operational & Implementation Notes (practical free-only approach)
- In-browser pre-processing:
  - Use `createImageBitmap` or canvas to resize and convert to WebP; produce thumbnail and one derivative at 1280px width.
  - Benefits: reduces upload size drastically, reduces HF inference cost, and reduces storage used in Drive.
- Drive usage patterns & proxy:
  - Upload via server route using Google Service Account; store Drive `fileId` in Firestore.
  - Serve images through `/api/image/:id` which fetches via Drive API and returns with `Cache-Control: public, max-age=3600` so Cloudflare/CDN caches responses.
- Embedding storage:
  - Firestore has document size limits — consider storing embeddings as compressed base64 strings or as separate small files in Drive/Firestore Storage if large.
  - Keep `faces` reference to `imageId` and `embeddingVersion` to allow re-embedding later.

API Contract (minimum)
- POST `/api/upload` — multipart/form-data: `image`, `eventId`, `originalName`, `consent=true|false` → returns `imageId`.
- POST `/api/embed` — body: `{ imageDriveId | imageUrl }` → returns `{ faces: [{ bbox, embeddingId, faceId }] }`.
- POST `/api/search` — body: `{ eventId, embedding, topK=20 }` → returns ranked `faceId` results with `imageId` and `score`.
- GET `/api/image/:id` — streams image (derivative preferred) — enforces auth and sets caching headers.
- POST `/api/delete-my-data` — body: `{ userId }` — deletes user-linked embeddings and marks records.

Firestore Schemas (examples)
- `images/{imageId}`:
  - `eventId:string`, `driveFileId:string`, `derivativeDriveId:string`, `thumbnailDriveId:string`, `uploadedAt:timestamp`, `uploaderId:string`, `syncedToCloud:bool`
- `faces/{faceId}`:
  - `imageId:string`, `embedding:[number] or base64`, `bbox:map`, `createdAt:timestamp`, `embeddingVersion:string`

Risks & Mitigations
- Drive API quotas: implement exponential backoff, queue uploads, and delay non-critical copy tasks (sync to cloud) to off-peak times.
- Firestore document size limits: compress embeddings; consider storing vectors externally if needed.
- HF Space CPU latency: keep derivatives small, batch embeddings when possible, and cache results for repeated searches.
- Privacy/compliance: record consent, provide delete endpoint, and do not expose raw Drive links publicly.

Immediate 2-week Sprint (free-only MVP)
1. Setup repo, Next.js + Tailwind, Firebase emulator, and CI (3 days).
2. Implement client-side WebP derivative generation and basic upload UI (3 days).
3. Implement `/api/upload` with Drive upload and Firestore metadata (2 days).
4. Deploy HF Space with `/embed` and `/detect` endpoints; wire an API job to call them (3 days).
5. Implement selfie search page and `/api/search` linear scan for single-event (3 days).

Owners & Roles (suggested)
- Product / PM: define dataset and evaluation criteria.
- Backend: Next.js API routes, Drive integration, security rules.
- AI Engineer: HF Space, embedding model, threshold tuning.
- Frontend: upload UI, selfie page, gallery UI.

References & Next Steps
- Prototype priority: follow the Immediate 2-week Sprint.
- When ready to spend money: migrate derivatives to Cloudflare R2 or Backblaze B2 and add ANN service.

Appendix: cost-minimizing tips
- Always generate WebP derivatives client-side to avoid storing huge raws in active serving storage.
- Cache aggressively at CDN (Cloudflare free tier) using strong Cache-Control headers from the Next.js proxy.
- Delay and batch non-user-facing work (archival copy, heavy re-embedding).

---

## Appendix B: Personal Google Drive Setup (OAuth2 Flow)

If you are using a personal Google Account (e.g. `@gmail.com`) instead of a Workspace Shared Drive, the Service Account will fail with a `Service Accounts do not have storage quota` error because it cannot own files. To bypass this, follow these steps to use OAuth2 client credentials and act directly on behalf of your personal Google account.

### Step 1: Create OAuth Credentials in Google Cloud Console
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and select your project.
2. Go to **APIs & Services** > **OAuth consent screen**:
   - Set User Type to **External** and fill in required app contact fields.
   - Under **Test Users**, add your personal Gmail address.
3. Go to **APIs & Services** > **Credentials**:
   - Click **+ Create Credentials** > **OAuth client ID**.
   - Select **Web application** as the type.
   - Under **Authorized redirect URIs**, add `https://developers.google.com/oauthplayground`
   - Copy the generated **Client ID** and **Client Secret**.

### Step 2: Acquire the Refresh Token via Google OAuth Playground
1. Go to the [Google OAuth2 Playground](https://developers.google.com/oauthplayground/).
2. Click the **Gear icon (⚙️)** in the top-right:
   - Check the **Use your own OAuth credentials** box.
   - Paste your Client ID and Client Secret, then click **Close**.
3. In Step 1 (Select & authorize APIs), paste `https://www.googleapis.com/auth/drive` into the input bar and click **Authorize APIs**.
4. Log in using your test Gmail account and click through the safety warnings to grant permissions.
5. In Step 2 (Exchange authorization code), click **Exchange authorization code for tokens** and copy the resulting **Refresh token**.

### Step 3: Configure Env Variables
Add the following to your `.env.local` file and restart your Next.js dev server:
```ini
GOOGLE_REFRESH_TOKEN=your_refresh_token
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```

---

File created: face_based_photo_retrieval_detailed_roadmap.md

