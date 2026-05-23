#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')
const admin = require('firebase-admin')

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
    eventId: null,
    top: 10,
    sample: 5,
    minScore: 0.8,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--eventId' && argv[i + 1]) args.eventId = argv[++i]
    if (token.startsWith('--eventId=')) args.eventId = token.split('=')[1]
    if (token === '--top' && argv[i + 1]) args.top = Number(argv[++i])
    if (token.startsWith('--top=')) args.top = Number(token.split('=')[1])
    if (token === '--sample' && argv[i + 1]) args.sample = Number(argv[++i])
    if (token.startsWith('--sample=')) args.sample = Number(token.split('=')[1])
    if (token === '--minScore' && argv[i + 1]) args.minScore = Number(argv[++i])
    if (token.startsWith('--minScore=')) args.minScore = Number(token.split('=')[1])
  }

  if (!args.eventId) {
    throw new Error('--eventId is required')
  }
  if (!Number.isFinite(args.top) || args.top <= 0) {
    throw new Error('--top must be a positive number')
  }
  if (!Number.isFinite(args.sample) || args.sample <= 0) {
    throw new Error('--sample must be a positive number')
  }
  if (!Number.isFinite(args.minScore) || args.minScore < 0 || args.minScore > 1) {
    throw new Error('--minScore must be between 0 and 1')
  }

  args.top = Math.floor(args.top)
  args.sample = Math.floor(args.sample)

  return args
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

function isUsableEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return false
  return !embedding.every((value) => Number(value) === 0)
}

async function qdrantSearch(config, { vector, top, eventId }) {
  const headers = { 'content-type': 'application/json' }
  if (config.apiKey) {
    headers['api-key'] = config.apiKey
  }

  const response = await fetch(`${config.url}/collections/${config.collection}/points/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      vector,
      limit: top,
      with_payload: true,
      score_threshold: 0,
      filter: {
        must: [
          {
            key: 'eventId',
            match: { value: eventId },
          },
        ],
      },
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Qdrant search failed (${response.status}): ${JSON.stringify(payload)}`)
  }
  return Array.isArray(payload.result) ? payload.result : []
}

async function run() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  const qdrant = getQdrantConfig()
  const serviceAccount = loadServiceAccount()

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()

  const facesSnap = await db
    .collection('faces')
    .where('eventId', '==', args.eventId)
    .limit(Math.max(args.sample * 8, args.sample + 10))
    .get()

  const candidates = facesSnap.docs
    .filter((doc) => isUsableEmbedding(doc.data()?.embedding))
    .slice(0, args.sample)

  if (candidates.length === 0) {
    throw new Error(`No syncable faces found for eventId='${args.eventId}'`)
  }

  console.log(`[qdrant-probe] event=${args.eventId} sample=${candidates.length} top=${args.top} minScore=${args.minScore}`)

  let matched = 0
  let scorePass = 0

  for (const doc of candidates) {
    const data = doc.data() || {}
    const results = await qdrantSearch(qdrant, {
      vector: data.embedding,
      top: args.top,
      eventId: args.eventId,
    })

    const topHit = results[0] || null
    const topFaceId = topHit?.payload?.faceId || String(topHit?.id || '')
    const topScore = Number(topHit?.score || 0)
    const selfInTop = results.some((item) => (item?.payload?.faceId || String(item.id)) === doc.id)

    if (selfInTop) matched += 1
    if (topScore >= args.minScore) scorePass += 1

    console.log(`[qdrant-probe] face=${doc.id} topFace=${topFaceId || 'NONE'} topScore=${topScore.toFixed(4)} selfInTop=${selfInTop}`)
  }

  const matchRate = matched / candidates.length
  const scoreRate = scorePass / candidates.length
  console.log('\n[qdrant-probe] summary')
  console.log(`selfMatchRate=${(matchRate * 100).toFixed(1)}% (${matched}/${candidates.length})`)
  console.log(`topScoreAboveMinRate=${(scoreRate * 100).toFixed(1)}% (${scorePass}/${candidates.length})`)
}

run().catch((err) => {
  console.error('[qdrant-probe] fatal:', err.message)
  process.exit(1)
})
