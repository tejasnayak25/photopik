#!/usr/bin/env node
/*
Backfill face embeddings for existing images.

Defaults to dry-run. Use --apply to write changes.

Examples:
  node scripts/reembed_faces.js --dry-run --eventId wedding-2026 --limit 100
  node scripts/reembed_faces.js --apply --eventId wedding-2026
  node scripts/reembed_faces.js --apply --sinceDays 7 --resume
*/

const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')
const { google } = require('googleapis')
const { Client } = require('@gradio/client')

function loadLocalEnv() {
  // Next.js auto-loads env files for API routes, but standalone node scripts do not.
  // This keeps script usage simple: `npm run reembed:*` works with existing .env.local.
  const candidateFiles = ['.env.local', '.env']
  for (const file of candidateFiles) {
    const envPath = path.join(process.cwd(), file)
    if (!fs.existsSync(envPath)) continue
    const content = fs.readFileSync(envPath, 'utf8')
    const lines = content.split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex <= 0) continue
      const key = trimmed.slice(0, eqIndex).trim()
      let value = trimmed.slice(eqIndex + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] == null) {
        process.env[key] = value
      }
    }
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    eventId: null,
    limit: 200,
    embeddingVersion: 'v2-backfill',
    sinceDays: null,
    resume: false,
    checkpointFile: '.reembed_checkpoint.json',
    concurrency: 1,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') args.dryRun = false
    if (token === '--dry-run') args.dryRun = true
    if (token === '--eventId' && argv[i + 1]) args.eventId = argv[++i]
    if (token.startsWith('--eventId=')) args.eventId = token.split('=')[1]
    if (token === '--limit' && argv[i + 1]) args.limit = Number(argv[++i])
    if (token.startsWith('--limit=')) args.limit = Number(token.split('=')[1])
    if (token === '--embeddingVersion' && argv[i + 1]) args.embeddingVersion = argv[++i]
    if (token.startsWith('--embeddingVersion=')) args.embeddingVersion = token.split('=')[1]
    if (token === '--sinceDays' && argv[i + 1]) args.sinceDays = Number(argv[++i])
    if (token.startsWith('--sinceDays=')) args.sinceDays = Number(token.split('=')[1])
    if (token === '--resume') args.resume = true
    if (token === '--checkpointFile' && argv[i + 1]) args.checkpointFile = argv[++i]
    if (token.startsWith('--checkpointFile=')) args.checkpointFile = token.split('=')[1]
    if (token === '--concurrency' && argv[i + 1]) args.concurrency = Number(argv[++i])
    if (token.startsWith('--concurrency=')) args.concurrency = Number(token.split('=')[1])
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error('--limit must be a positive number')
  }

  if (args.sinceDays != null && (!Number.isFinite(args.sinceDays) || args.sinceDays <= 0)) {
    throw new Error('--sinceDays must be a positive number')
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    throw new Error('--concurrency must be a positive number')
  }

  args.concurrency = Math.max(1, Math.floor(args.concurrency))

  return args
}

function loadCheckpoint(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { processedImageIds: [] }
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.processedImageIds)) {
      return { processedImageIds: [] }
    }
    return parsed
  } catch {
    return { processedImageIds: [] }
  }
}

function saveCheckpoint(filePath, checkpoint) {
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8')
}

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env required')
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw)
    const content = fs.readFileSync(raw, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    throw new Error('Failed to load service account JSON: ' + err.message)
  }
}

function getDriveClient(serviceAccount) {
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    )
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
    return google.drive({ version: 'v3', auth: oauth2Client })
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive'],
  })
  return google.drive({ version: 'v3', auth })
}

function isUsableEmbedding(emb) {
  if (!Array.isArray(emb) || emb.length === 0) return false
  return !emb.every((v) => Number(v) === 0)
}

async function downloadFileBuffer(drive, fileId) {
  const driveRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  )
  const chunks = []
  await new Promise((resolve, reject) => {
    driveRes.data.on('data', (chunk) => chunks.push(chunk))
    driveRes.data.on('end', resolve)
    driveRes.data.on('error', reject)
  })
  return Buffer.concat(chunks)
}

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const HF_SPACE_URL = process.env.HF_SPACE_URL
  if (!HF_SPACE_URL) throw new Error('HF_SPACE_URL env required')

  const serviceAccount = loadServiceAccount()
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()
  const drive = getDriveClient(serviceAccount)
  const client = await Client.connect(HF_SPACE_URL)
  const BlobCtor = globalThis.Blob || require('buffer').Blob

  const checkpointPath = path.isAbsolute(args.checkpointFile)
    ? args.checkpointFile
    : path.join(process.cwd(), args.checkpointFile)
  const checkpoint = args.resume ? loadCheckpoint(checkpointPath) : { processedImageIds: [] }
  const processedSet = new Set(checkpoint.processedImageIds)

  const cutoffDate = args.sinceDays != null
    ? new Date(Date.now() - args.sinceDays * 24 * 60 * 60 * 1000)
    : null

  let imagesSnap
  try {
    // Preferred query: sorted by uploadedAt for deterministic, recent-first processing.
    let query = db.collection('images')
    if (args.eventId) {
      query = query.where('eventId', '==', args.eventId)
    }
    if (cutoffDate) {
      query = query.where('uploadedAt', '>=', cutoffDate)
    }
    query = query.orderBy('uploadedAt', 'desc').limit(args.limit)
    imagesSnap = await query.get()
  } catch (err) {
    const needsIndex = String(err?.details || err?.message || '').includes('requires an index')
    if (!needsIndex) {
      throw err
    }

    // Fallback query to avoid blocking runs when composite index is missing.
    // This may be less optimal/less recent-first than the preferred query.
    console.warn('[reembed] Firestore composite index missing for preferred query; falling back to simpler query.')
    if (err?.details) {
      console.warn('[reembed] index hint:', err.details)
    }

    let fallbackQuery = db.collection('images')
    if (args.eventId) {
      fallbackQuery = fallbackQuery.where('eventId', '==', args.eventId)
    }
    fallbackQuery = fallbackQuery.limit(args.limit)
    const fallbackSnap = await fallbackQuery.get()

    // Post-filter by sinceDays if needed.
    let docs = fallbackSnap.docs
    if (cutoffDate) {
      docs = docs.filter((doc) => {
        const ts = doc.data()?.uploadedAt
        if (!ts || typeof ts.toDate !== 'function') return false
        return ts.toDate() >= cutoffDate
      })
    }

    imagesSnap = { size: docs.length, docs }
  }

  console.log(`[reembed] mode=${args.dryRun ? 'dry-run' : 'apply'} images=${imagesSnap.size} event=${args.eventId || 'ALL'} sinceDays=${args.sinceDays ?? 'ALL'} resume=${args.resume} concurrency=${args.concurrency}`)

  let processedImages = 0
  let failedImages = 0
  let deletedFaces = 0
  let insertedFaces = 0
  let skippedFaces = 0

  const docs = imagesSnap.docs
  let cursor = 0

  async function processImage(imgDoc) {
    const imageId = imgDoc.id
    if (args.resume && processedSet.has(imageId)) {
      console.log(`[reembed] skip image=${imageId} (already in checkpoint)`)
      return
    }
    const data = imgDoc.data()
    const eventId = data.eventId
    const fileId = data.derivativeDriveId || data.driveFileId

    if (!fileId) {
      console.warn(`[reembed] image=${imageId} missing derivativeDriveId/driveFileId; skipping`)
      failedImages += 1
      return
    }

    try {
      const buffer = await downloadFileBuffer(drive, fileId)
      const blob = new BlobCtor([buffer], { type: 'image/jpeg' })

      const result = await client.predict('/process', { image: blob })
      const faces = result?.data?.[1] || []

      const usable = []
      for (const item of faces) {
        const emb = item?.embedding
        if (!isUsableEmbedding(emb)) {
          skippedFaces += 1
          continue
        }
        usable.push({ emb, bbox: item?.bbox || null })
      }

      if (args.dryRun) {
        console.log(`[reembed] image=${imageId} event=${eventId} detected=${faces.length} usable=${usable.length}`)
        processedImages += 1
        if (args.resume) {
          processedSet.add(imageId)
          checkpoint.processedImageIds = Array.from(processedSet)
          checkpoint.updatedAt = new Date().toISOString()
          saveCheckpoint(checkpointPath, checkpoint)
        }
        return
      }

      // Replace existing face embeddings for this image atomically per image.
      const existingSnap = await db.collection('faces').where('imageId', '==', imageId).get()
      const batch = db.batch()
      existingSnap.forEach((doc) => {
        batch.delete(doc.ref)
        deletedFaces += 1
      })
      for (const item of usable) {
        const ref = db.collection('faces').doc()
        batch.set(ref, {
          imageId,
          eventId,
          embedding: item.emb,
          bbox: item.bbox,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          embeddingVersion: args.embeddingVersion,
          reembeddedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        insertedFaces += 1
      }
      await batch.commit()
      console.log(`[reembed] updated image=${imageId} deleted=${existingSnap.size} inserted=${usable.length}`)
      processedImages += 1
      if (args.resume) {
        processedSet.add(imageId)
        checkpoint.processedImageIds = Array.from(processedSet)
        checkpoint.updatedAt = new Date().toISOString()
        saveCheckpoint(checkpointPath, checkpoint)
      }
    } catch (err) {
      console.error(`[reembed] failed image=${imageId}: ${err.message}`)
      failedImages += 1
    }
  }

  async function workerLoop() {
    while (true) {
      if (cursor >= docs.length) {
        return
      }
      const next = docs[cursor]
      cursor += 1
      await processImage(next)
    }
  }

  const workers = []
  const workerCount = Math.min(args.concurrency, docs.length || 1)
  for (let i = 0; i < workerCount; i++) {
    workers.push(workerLoop())
  }
  await Promise.all(workers)

  console.log('\n[reembed] summary')
  console.log(`processedImages=${processedImages}`)
  console.log(`failedImages=${failedImages}`)
  console.log(`deletedFaces=${deletedFaces}`)
  console.log(`insertedFaces=${insertedFaces}`)
  console.log(`skippedFaces=${skippedFaces}`)
  if (args.resume) {
    console.log(`checkpointFile=${checkpointPath}`)
    console.log(`checkpointProcessedImages=${processedSet.size}`)
  }
}

run().catch((err) => {
  console.error('[reembed] fatal:', err)
  process.exit(1)
})
