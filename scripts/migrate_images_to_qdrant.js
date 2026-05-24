#!/usr/bin/env node
/*
Migrate images to Qdrant by running the same indexing flow used on upload.
This script iterates `images` documents (optionally filtered by --eventId or --sinceDays)
and calls `processImageIndexJob` from `lib/faceIndexing.js` for each image.

Usage examples:
  # dry-run (no writes to Firestore/Qdrant)
  node scripts/migrate_images_to_qdrant.js --dry-run --eventId wedding-2026 --limit 100

  # apply changes (writes metadata and upserts vectors)
  node scripts/migrate_images_to_qdrant.js --apply --eventId wedding-2026 --limit 100

  # resume using checkpoint
  node scripts/migrate_images_to_qdrant.js --apply --resume --checkpointFile .migrate_checkpoint.json
*/

const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')
const { google } = require('googleapis')

function loadLocalEnv() {
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
    limit: 0,
    sinceDays: null,
    resume: false,
    checkpointFile: '.migrate_checkpoint.json',
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
    if (token === '--sinceDays' && argv[i + 1]) args.sinceDays = Number(argv[++i])
    if (token.startsWith('--sinceDays=')) args.sinceDays = Number(token.split('=')[1])
    if (token === '--resume') args.resume = true
    if (token === '--checkpointFile' && argv[i + 1]) args.checkpointFile = argv[++i]
    if (token.startsWith('--checkpointFile=')) args.checkpointFile = token.split('=')[1]
    if (token === '--concurrency' && argv[i + 1]) args.concurrency = Number(argv[++i])
    if (token.startsWith('--concurrency=')) args.concurrency = Number(token.split('=')[1])
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('--limit must be a non-negative number')
  }
  if (args.sinceDays != null && (!Number.isFinite(args.sinceDays) || args.sinceDays <= 0)) {
    throw new Error('--sinceDays must be a positive number')
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    throw new Error('--concurrency must be a positive number')
  }

  args.concurrency = Math.max(1, Math.floor(args.concurrency))
  args.limit = Math.floor(args.limit)
  return args
}

function loadCheckpoint(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { processedImageIds: [] }
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.processedImageIds)) return { processedImageIds: [] }
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

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const serviceAccount = loadServiceAccount()

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()
  const drive = getDriveClient(serviceAccount)

  const checkpointPath = path.isAbsolute(args.checkpointFile) ? args.checkpointFile : path.join(process.cwd(), args.checkpointFile)
  const checkpoint = args.resume ? loadCheckpoint(checkpointPath) : { processedImageIds: [] }
  const processedSet = new Set(checkpoint.processedImageIds)

  const cutoffDate = args.sinceDays != null ? new Date(Date.now() - args.sinceDays * 24 * 60 * 60 * 1000) : null

  // Dynamic import to use ES module exports from lib/faceIndexing.js
  const faceIndexing = await import('../lib/faceIndexing.js')
  const processImageIndexJob = faceIndexing.processImageIndexJob

  // Query images
  let imagesSnap
  try {
    let query = db.collection('images')
    if (args.eventId) query = query.where('eventId', '==', args.eventId)
    if (cutoffDate) query = query.where('uploadedAt', '>=', cutoffDate)
    query = query.orderBy('uploadedAt', 'desc')
    if (args.limit > 0) query = query.limit(args.limit)
    imagesSnap = await query.get()
  } catch (err) {
    const needsIndex = String(err?.details || err?.message || '').includes('requires an index')
    if (!needsIndex) throw err

    console.warn('[migrate] Firestore composite index missing; falling back to simple query')
    let fallbackQuery = db.collection('images')
    if (args.eventId) fallbackQuery = fallbackQuery.where('eventId', '==', args.eventId)
    if (args.limit > 0) fallbackQuery = fallbackQuery.limit(args.limit)
    const snap = await fallbackQuery.get()
    let docs = snap.docs
    if (cutoffDate) {
      docs = docs.filter((doc) => {
        const ts = doc.data()?.uploadedAt
        if (!ts || typeof ts.toDate !== 'function') return false
        return ts.toDate() >= cutoffDate
      })
    }
    imagesSnap = { size: docs.length, docs }
  }

  console.log(`[migrate] mode=${args.dryRun ? 'dry-run' : 'apply'} images=${imagesSnap.size} event=${args.eventId || 'ALL'} sinceDays=${args.sinceDays ?? 'ALL'} resume=${args.resume}`)

  let processedImages = 0
  let failedImages = 0

  for (const imgDoc of imagesSnap.docs) {
    const imageId = imgDoc.id
    if (args.resume && processedSet.has(imageId)) continue

    const data = imgDoc.data() || {}
    const eventId = data.eventId
    const fileId = data.derivativeDriveId || data.driveFileId
    const mimeType = data.derivativeMimeType || data.mimeType || 'image/jpeg'

    if (!fileId) {
      console.warn(`[migrate] image=${imageId} missing drive file id; skipping`)
      failedImages += 1
      continue
    }

    try {
      if (args.dryRun) {
        console.log(`[migrate] dry-run image=${imageId} event=${eventId}`)
      } else {
        await processImageIndexJob({
          db,
          admin,
          drive,
          imageId,
          eventId,
          driveFileId: fileId,
          mimeType,
          embeddingVersion: process.env.EMBEDDING_VERSION || 'v2',
          hfSpaceUrl: process.env.HF_SPACE_URL,
        })
        console.log(`[migrate] applied image=${imageId}`)
      }

      processedImages += 1
      if (args.resume) {
        processedSet.add(imageId)
        checkpoint.processedImageIds = Array.from(processedSet)
        checkpoint.updatedAt = new Date().toISOString()
        saveCheckpoint(checkpointPath, checkpoint)
      }

      if (args.limit > 0 && processedImages >= args.limit) break
    } catch (err) {
      console.error(`[migrate] failed image=${imageId}: ${err.message}`)
      failedImages += 1
    }
  }

  console.log('\n[migrate] summary')
  console.log(`processedImages=${processedImages}`)
  console.log(`failedImages=${failedImages}`)
  if (args.resume) {
    console.log(`checkpointFile=${checkpointPath}`)
    console.log(`checkpointProcessedImages=${processedSet.size}`)
  }
}

run().catch((err) => {
  console.error('[migrate] fatal:', err.message)
  process.exit(1)
})
