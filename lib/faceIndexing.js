import { isVectorSearchEnabled, upsertImageFaceVectors } from './vectorSearch'

let cachedSpaceClient = null
let cachedSpaceUrl = null

async function getSpaceClient(hfSpaceUrl) {
  if (!hfSpaceUrl) {
    throw new Error('HF_SPACE_URL is required for face indexing')
  }
  if (cachedSpaceClient && cachedSpaceUrl === hfSpaceUrl) {
    return cachedSpaceClient
  }
  const { Client } = await import('@gradio/client')
  cachedSpaceClient = await Client.connect(hfSpaceUrl)
  cachedSpaceUrl = hfSpaceUrl
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
  const blob = new BlobCtor([buffer], { type: mimeType || 'image/jpeg' })
  const client = await getSpaceClient(hfSpaceUrl)
  const result = await client.predict('/process', { image: blob })
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
    batch.set(ref, {
      imageId,
      eventId,
      embedding: item.embedding,
      bbox: item.bbox,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      embeddingVersion,
      reembeddedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
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

  let vectorSync = null
  if (isVectorSearchEnabled()) {
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