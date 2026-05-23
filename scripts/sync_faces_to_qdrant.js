#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')
const admin = require('firebase-admin')
const { createHash } = require('crypto')

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
      const splitIndex = trimmed.indexOf('=')
      if (splitIndex <= 0) continue
      const key = trimmed.slice(0, splitIndex).trim()
      let value = trimmed.slice(splitIndex + 1).trim()
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
    batchSize: 200,
    upsertBatchSize: 128,
    resume: false,
    checkpointFile: '.qdrant_sync_checkpoint.json',
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') args.dryRun = false
    if (token === '--dry-run') args.dryRun = true
    if (token === '--eventId' && argv[i + 1]) args.eventId = argv[++i]
    if (token.startsWith('--eventId=')) args.eventId = token.split('=')[1]
    if (token === '--limit' && argv[i + 1]) args.limit = Number(argv[++i])
    if (token.startsWith('--limit=')) args.limit = Number(token.split('=')[1])
    if (token === '--batchSize' && argv[i + 1]) args.batchSize = Number(argv[++i])
    if (token.startsWith('--batchSize=')) args.batchSize = Number(token.split('=')[1])
    if (token === '--upsertBatchSize' && argv[i + 1]) args.upsertBatchSize = Number(argv[++i])
    if (token.startsWith('--upsertBatchSize=')) args.upsertBatchSize = Number(token.split('=')[1])
    if (token === '--resume') args.resume = true
    if (token === '--checkpointFile' && argv[i + 1]) args.checkpointFile = argv[++i]
    if (token.startsWith('--checkpointFile=')) args.checkpointFile = token.split('=')[1]
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('--limit must be a non-negative number')
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
    throw new Error('--batchSize must be a positive number')
  }
  if (!Number.isFinite(args.upsertBatchSize) || args.upsertBatchSize <= 0) {
    throw new Error('--upsertBatchSize must be a positive number')
  }

  args.limit = Math.floor(args.limit)
  args.batchSize = Math.floor(args.batchSize)
  args.upsertBatchSize = Math.floor(args.upsertBatchSize)

  return args
}

function loadCheckpoint(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { lastDocId: null, syncedCount: 0 }
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      lastDocId: parsed.lastDocId || null,
      syncedCount: Number(parsed.syncedCount || 0),
    }
  } catch {
    return { lastDocId: null, syncedCount: 0 }
  }
}

function saveCheckpoint(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
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

function getQdrantConfig() {
  const url = process.env.QDRANT_URL
  if (!url) throw new Error('QDRANT_URL env required')
  return {
    url: url.replace(/\/$/, ''),
    apiKey: process.env.QDRANT_API_KEY || null,
    collection: process.env.QDRANT_COLLECTION || 'photopik_faces',
  }
}

async function qdrantRequest(config, { method, pathName, body, allow404 = false }) {
  const headers = { 'content-type': 'application/json' }
  if (config.apiKey) headers['api-key'] = config.apiKey

  const response = await fetch(`${config.url}${pathName}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))

  if (response.status === 404 && allow404) {
    return { ok: false, status: response.status, payload }
  }
  if (!response.ok) {
    throw new Error(`Qdrant ${method} ${pathName} failed (${response.status}): ${JSON.stringify(payload)}`)
  }

  return { ok: true, status: response.status, payload }
}

function isUsableEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return false
  return !embedding.every((value) => Number(value) === 0)
}

function toQdrantPointId(rawId) {
  const input = String(rawId || '')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    return input
  }
  const rawHex = createHash('sha256').update(input).digest('hex').slice(0, 32)
  const withVersion = `${rawHex.slice(0, 12)}4${rawHex.slice(13)}`
  const variantNibble = ((parseInt(withVersion[16], 16) & 0x3) | 0x8).toString(16)
  const withVariant = `${withVersion.slice(0, 16)}${variantNibble}${withVersion.slice(17)}`
  return `${withVariant.slice(0, 8)}-${withVariant.slice(8, 12)}-${withVariant.slice(12, 16)}-${withVariant.slice(16, 20)}-${withVariant.slice(20, 32)}`
}

function toPoint(doc) {
  const data = doc.data() || {}
  return {
    id: toQdrantPointId(doc.id),
    vector: data.embedding,
    payload: {
      faceId: doc.id,
      eventId: data.eventId || null,
      imageId: data.imageId || null,
      bbox: data.bbox || null,
      embeddingVersion: data.embeddingVersion || null,
    },
  }
}

async function ensureCollectionExists(config) {
  const response = await qdrantRequest(config, {
    method: 'GET',
    pathName: `/collections/${config.collection}`,
    allow404: true,
  })
  if (!response.ok) {
    throw new Error(`Collection '${config.collection}' not found. Run: npm run qdrant:setup`)
  }
}

async function upsertPoints(config, points) {
  if (!points.length) return
  await qdrantRequest(config, {
    method: 'PUT',
    pathName: `/collections/${config.collection}/points`,
    body: { points },
  })
}

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const serviceAccount = loadServiceAccount()
  const qdrant = getQdrantConfig()

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()
  const docIdField = admin.firestore.FieldPath.documentId()

  await ensureCollectionExists(qdrant)

  const checkpointPath = path.isAbsolute(args.checkpointFile)
    ? args.checkpointFile
    : path.join(process.cwd(), args.checkpointFile)

  const checkpoint = args.resume ? loadCheckpoint(checkpointPath) : { lastDocId: null, syncedCount: 0 }
  let lastDocId = checkpoint.lastDocId

  let scannedFaces = 0
  let syncedFaces = 0
  let skippedFaces = 0
  let pageCount = 0

  console.log(`[qdrant-sync] mode=${args.dryRun ? 'dry-run' : 'apply'} event=${args.eventId || 'ALL'} limit=${args.limit || 'ALL'} batchSize=${args.batchSize} resume=${args.resume}`)

  while (true) {
    let query = db.collection('faces')
    if (args.eventId) {
      query = query.where('eventId', '==', args.eventId)
    }
    query = query.orderBy(docIdField).limit(args.batchSize)
    if (lastDocId) {
      query = query.startAfter(lastDocId)
    }

    const snap = await query.get()
    if (snap.empty) {
      break
    }

    pageCount += 1
    const points = []

    for (const doc of snap.docs) {
      if (args.limit > 0 && scannedFaces >= args.limit) {
        break
      }

      scannedFaces += 1
      const data = doc.data() || {}
      if (!isUsableEmbedding(data.embedding)) {
        skippedFaces += 1
        lastDocId = doc.id
        continue
      }

      points.push(toPoint(doc))
      lastDocId = doc.id
    }

    if (points.length > 0 && !args.dryRun) {
      for (let i = 0; i < points.length; i += args.upsertBatchSize) {
        const chunk = points.slice(i, i + args.upsertBatchSize)
        await upsertPoints(qdrant, chunk)
        syncedFaces += chunk.length
      }
    } else if (points.length > 0) {
      syncedFaces += points.length
    }

    if (args.resume) {
      saveCheckpoint(checkpointPath, {
        lastDocId,
        syncedCount: syncedFaces,
        updatedAt: new Date().toISOString(),
      })
    }

    console.log(`[qdrant-sync] page=${pageCount} scanned=${scannedFaces} syncable=${syncedFaces} skipped=${skippedFaces}`)

    if (args.limit > 0 && scannedFaces >= args.limit) {
      break
    }
    if (snap.size < args.batchSize) {
      break
    }
  }

  console.log('\n[qdrant-sync] summary')
  console.log(`scannedFaces=${scannedFaces}`)
  console.log(`syncableFaces=${syncedFaces}`)
  console.log(`skippedFaces=${skippedFaces}`)
  if (args.resume) {
    console.log(`checkpointFile=${checkpointPath}`)
    console.log(`lastDocId=${lastDocId || 'NONE'}`)
  }
}

run().catch((err) => {
  console.error('[qdrant-sync] fatal:', err.message)
  process.exit(1)
})
