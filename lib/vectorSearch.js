import { createHash } from 'crypto'

let collectionReady = false

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

function getConfig() {
  return {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY || null,
    collection: process.env.QDRANT_COLLECTION || 'photopik_faces',
  }
}

export function isVectorSearchEnabled() {
  const cfg = getConfig()
  return Boolean(cfg.url && cfg.collection)
}

export function isQdrantRequired() {
  // Default: required unless explicitly set to "false"
  const raw = String(process.env.QDRANT_REQUIRED || 'true').toLowerCase()
  return raw !== 'false'
}

async function qdrantRequest({ method, path, body }) {
  const cfg = getConfig()
  if (!cfg.url) {
    throw new Error('QDRANT_URL is required when vector backend is enabled')
  }
  const endpoint = `${cfg.url.replace(/\/$/, '')}${path}`
  const headers = {
    'content-type': 'application/json',
  }
  if (cfg.apiKey) {
    headers['api-key'] = cfg.apiKey
  }

  const response = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Qdrant request failed (${response.status} ${path}): ${JSON.stringify(payload)}`)
  }
  return payload
}

async function ensureCollection(vectorSize) {
  if (collectionReady) return
  const cfg = getConfig()
  const collectionPath = `/collections/${cfg.collection}`

  const existing = await qdrantRequest({ method: 'GET', path: collectionPath })
    .then(() => true)
    .catch((err) => {
      const msg = String(err?.message || '')
      if (msg.includes('404')) return false
      throw err
    })

  if (!existing) {
    await qdrantRequest({
      method: 'PUT',
      path: collectionPath,
      body: {
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      },
    })
  }

  collectionReady = true
}

export async function upsertImageFaceVectors({ eventId, imageId, faces }) {
  if (!isVectorSearchEnabled()) {
    return { enabled: false, upserted: 0 }
  }
  const validFaces = Array.isArray(faces) ? faces.filter((face) => Array.isArray(face.embedding) && face.embedding.length > 0) : []
  if (validFaces.length === 0) {
    return { enabled: true, upserted: 0 }
  }

  const cfg = getConfig()
  await ensureCollection(validFaces[0].embedding.length)

  await qdrantRequest({
    method: 'POST',
    path: `/collections/${cfg.collection}/points/delete`,
    body: {
      filter: {
        must: [
          { key: 'eventId', match: { value: eventId } },
          { key: 'imageId', match: { value: imageId } },
        ],
      },
    },
  })

  const points = validFaces.map((face) => ({
    id: toQdrantPointId(face.faceId),
    vector: face.embedding,
    payload: {
      faceId: face.faceId,
      eventId,
      imageId,
      bbox: face.bbox || null,
    },
  }))

  await qdrantRequest({
    method: 'PUT',
    path: `/collections/${cfg.collection}/points`,
    body: {
      points,
    },
  })

  return {
    enabled: true,
    upserted: points.length,
  }
}

export async function searchFacesByEmbedding({ eventId, embedding, topK = 20, minScore = null }) {
  if (!isVectorSearchEnabled()) {
    return { enabled: false, results: [] }
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { enabled: true, results: [] }
  }

  const cfg = getConfig()
  await ensureCollection(embedding.length)

  const response = await qdrantRequest({
    method: 'POST',
    path: `/collections/${cfg.collection}/points/search`,
    body: {
      vector: embedding,
      limit: topK,
      with_payload: true,
      filter: {
        must: [{ key: 'eventId', match: { value: eventId } }],
      },
      score_threshold: minScore == null ? undefined : minScore,
    },
  })

  const raw = Array.isArray(response?.result) ? response.result : []
  return {
    enabled: true,
    results: raw.map((item) => ({
      faceId: item?.payload?.faceId || String(item.id),
      imageId: item?.payload?.imageId || null,
      score: Number(item.score),
      bbox: item?.payload?.bbox || null,
    })),
  }
}

export async function searchFacesByManyEmbeddings({ eventId, queryEmbeddings, topKPerEmbedding = 30, minScore = null }) {
  if (!isVectorSearchEnabled()) {
    return { enabled: false, results: [] }
  }

  const items = Array.isArray(queryEmbeddings) ? queryEmbeddings : []
  const merged = []
  for (const item of items) {
    const queryEmbedding = item?.embedding
    const queryIndex = item?.index
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) continue
    const single = await searchFacesByEmbedding({
      eventId,
      embedding: queryEmbedding,
      topK: topKPerEmbedding,
      minScore,
    })
    for (const row of single.results) {
      merged.push({
        ...row,
        matchedQueryFaceIndex: queryIndex,
      })
    }
  }

  return {
    enabled: true,
    results: merged,
  }
}