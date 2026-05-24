import { createHash } from 'crypto'
import { isVectorSearchEnabled, upsertImageFaceVectors, isQdrantRequired } from './vectorSearch'

let cachedSpaceClient = null
let cachedSpaceUrl = null
let cachedSpaceClientPromise = null
let cachedSharpPromise = null
let sharpImportFailed = false
const normalizedHfBufferCache = new Map()

function getHfBufferCacheLimit() {
  const raw = Number(process.env.HF_BUFFER_CACHE_LIMIT || 20)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20
}

function makeHfBufferCacheKey(buffer, mimeType, maxWidth, jpegQuality) {
  return [
    String(mimeType || 'image/jpeg').toLowerCase(),
    String(maxWidth),
    String(jpegQuality),
    createHash('sha1').update(buffer).digest('hex'),
  ].join(':')
}

function rememberNormalizedBuffer(cacheKey, value) {
  normalizedHfBufferCache.delete(cacheKey)
  normalizedHfBufferCache.set(cacheKey, value)

  const limit = getHfBufferCacheLimit()
  while (normalizedHfBufferCache.size > limit) {
    const oldestKey = normalizedHfBufferCache.keys().next().value
    if (oldestKey == null) break
    normalizedHfBufferCache.delete(oldestKey)
  }
}

function getHfRequestTimeoutMs() {
  const raw = Number(process.env.HF_REQUEST_TIMEOUT_MS || 120000)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120000
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function getSharp() {
  if (sharpImportFailed) {
    return null
  }
  if (!cachedSharpPromise) {
    cachedSharpPromise = import('sharp')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        sharpImportFailed = true
        cachedSharpPromise = null
        console.warn('sharp unavailable, skipping HF input normalization:', err?.message || err)
        return null
      })
  }
  return cachedSharpPromise
}

function getHfMaxInputWidth() {
  const raw = Number(process.env.HF_INPUT_MAX_WIDTH || 1024)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1024
}

function getHfJpegQuality() {
  const raw = Number(process.env.HF_INPUT_JPEG_QUALITY || 82)
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? Math.floor(raw) : 82
}

async function normalizeImageBufferForHf(buffer, mimeType) {
  const maxWidth = getHfMaxInputWidth()
  const jpegQuality = getHfJpegQuality()
  const cacheKey = makeHfBufferCacheKey(buffer, mimeType, maxWidth, jpegQuality)
  const cached = normalizedHfBufferCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const sharp = await getSharp()
  if (!sharp) {
    const normalized = { buffer, mimeType: mimeType || 'image/jpeg' }
    rememberNormalizedBuffer(cacheKey, normalized)
    return normalized
  }

  const image = sharp(buffer, { failOn: 'none' }).rotate()
  const metadata = await image.metadata()
  const width = Number(metadata.width || 0)
  const shouldResize = width > 0 && width > maxWidth
  const shouldTranscode = String(mimeType || '').toLowerCase() !== 'image/jpeg'

  if (!shouldResize && !shouldTranscode) {
    const normalized = { buffer, mimeType: mimeType || 'image/jpeg' }
    rememberNormalizedBuffer(cacheKey, normalized)
    return normalized
  }

  let pipeline = image
  if (shouldResize) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true, fit: 'inside' })
  }

  const output = await pipeline.jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer()
  const normalized = { buffer: output, mimeType: 'image/jpeg' }
  rememberNormalizedBuffer(cacheKey, normalized)
  return normalized
}

async function getSpaceClient(hfSpaceUrl) {
  if (!hfSpaceUrl) {
    throw new Error('HF_SPACE_URL is required for face indexing')
  }
  if (cachedSpaceClient && cachedSpaceUrl === hfSpaceUrl) {
    return cachedSpaceClient
  }
  if (cachedSpaceClientPromise && cachedSpaceUrl === hfSpaceUrl) {
    return cachedSpaceClientPromise
  }
  const { Client } = await import('@gradio/client')
  cachedSpaceClientPromise = Client.connect(hfSpaceUrl)
  cachedSpaceUrl = hfSpaceUrl
  cachedSpaceClient = await cachedSpaceClientPromise
  return cachedSpaceClient
}

export function isUsableEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return false
  return !embedding.every((value) => Number(value) === 0)
}

export async function downloadDriveFileBuffer(drive, fileId) {
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

export async function extractEmbeddingsFromBuffer({ buffer, mimeType, hfSpaceUrl }) {
  const BlobCtor = globalThis.Blob || (await import('buffer')).Blob
  const normalized = await normalizeImageBufferForHf(buffer, mimeType)
  const blob = new BlobCtor([normalized.buffer], { type: normalized.mimeType })
  const client = await getSpaceClient(hfSpaceUrl)
  const timeoutMs = getHfRequestTimeoutMs()

  let result
  try {
    result = await withTimeout(
      client.predict('/process', { image: blob }),
      timeoutMs,
      `HF Space request timed out after ${timeoutMs}ms`
    )
  } catch (err) {
    // One retry after a timeout or transient session issue.
    if (cachedSpaceClientPromise && cachedSpaceUrl === hfSpaceUrl) {
      cachedSpaceClient = null
      cachedSpaceClientPromise = null
    }
    const retryClient = await getSpaceClient(hfSpaceUrl)
    result = await withTimeout(
      retryClient.predict('/process', { image: blob }),
      timeoutMs,
      `HF Space request timed out after ${timeoutMs}ms`
    )
  }
  const faces = result?.data?.[1] || []

  const usableFaces = []
  let skippedFaces = 0

  for (const item of faces) {
    const embedding = item?.embedding
    if (!isUsableEmbedding(embedding)) {
      skippedFaces += 1
      continue
    }
    usableFaces.push({
      embedding,
      bbox: item?.bbox || null,
    })
  }

  return {
    detectedFaces: faces.length,
    skippedFaces,
    usableFaces,
  }
}

export async function replaceFacesForImage({ db, admin, imageId, eventId, usableFaces, embeddingVersion }) {
  const existingSnap = await db.collection('faces').where('imageId', '==', imageId).get()
  const batch = db.batch()
  const insertedFaceRows = []
  existingSnap.forEach((doc) => {
    batch.delete(doc.ref)
  })

  for (const item of usableFaces) {
    const ref = db.collection('faces').doc()
    // Persist face metadata only — do NOT store raw embeddings in Firestore.
    batch.set(
      ref,
      {
        imageId,
        eventId,
        bbox: item.bbox,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        embeddingVersion,
        reembeddedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    )
    // Keep embedding in the returned rows so the caller can upsert to Qdrant.
    insertedFaceRows.push({
      faceId: ref.id,
      imageId,
      eventId,
      embedding: item.embedding,
      bbox: item.bbox,
    })
  }

  await batch.commit()
  return {
    deletedFaces: existingSnap.size,
    insertedFaces: usableFaces.length,
    insertedFaceRows,
  }
}

export async function processImageIndexJob({
  db,
  admin,
  drive,
  imageId,
  eventId,
  driveFileId,
  mimeType,
  embeddingVersion,
  hfSpaceUrl,
}) {
  if (!driveFileId) {
    throw new Error('driveFileId is required')
  }
  const qdrantEnabled = isVectorSearchEnabled()
  if (!qdrantEnabled && isQdrantRequired()) {
    throw new Error('Qdrant vector backend is required for indexing (set QDRANT_URL)')
  }

  const buffer = await downloadDriveFileBuffer(drive, driveFileId)
  const extraction = await extractEmbeddingsFromBuffer({
    buffer,
    mimeType,
    hfSpaceUrl,
  })

  const replaceResult = await replaceFacesForImage({
    db,
    admin,
    imageId,
    eventId,
    usableFaces: extraction.usableFaces,
    embeddingVersion,
  })

  let vectorSync = { enabled: false, upserted: 0 }
  if (qdrantEnabled) {
    vectorSync = await upsertImageFaceVectors({
      eventId,
      imageId,
      faces: replaceResult.insertedFaceRows,
    })
  }

  await db.collection('images').doc(imageId).set(
    {
      indexingStatus: 'done',
      indexedAt: admin.firestore.FieldValue.serverTimestamp(),
      indexedFaceCount: extraction.usableFaces.length,
      indexingDetectedFaceCount: extraction.detectedFaces,
      embeddingVersion,
      indexingLastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  return {
    detectedFaces: extraction.detectedFaces,
    skippedFaces: extraction.skippedFaces,
    usableFaces: extraction.usableFaces.length,
    deletedFaces: replaceResult.deletedFaces,
    insertedFaces: replaceResult.insertedFaces,
    vectorUpserted: vectorSync?.upserted || 0,
  }
}