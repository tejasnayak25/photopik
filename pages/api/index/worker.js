import admin from 'firebase-admin'
import { getDriveClient, loadServiceAccount } from '../../../lib/googleDrive'
import { processImageIndexJob } from '../../../lib/faceIndexing'
import { claimJob, listCandidateJobs, markJobDone, markJobFailure } from '../../../lib/indexJobs'

function getAuthToken(req) {
  const authHeader = req.headers.authorization || ''
  if (!authHeader.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

async function processClaimedJob({ db, drive, jobDoc, hfSpaceUrl, embeddingVersionDefault }) {
  const jobData = jobDoc.data() || {}
  const imageId = jobData.imageId
  const eventId = jobData.eventId
  const driveFileId = jobData.driveFileId
  const mimeType = jobData.mimeType || 'image/jpeg'
  const embeddingVersion = jobData.embeddingVersion || embeddingVersionDefault

  if (!imageId || !eventId || !driveFileId) {
    throw new Error('Job missing required fields (imageId/eventId/driveFileId)')
  }

  await db.collection('images').doc(imageId).set(
    {
      indexingStatus: 'processing',
      updatedAt: new Date(),
      indexingLastError: null,
    },
    { merge: true }
  )

  const summary = await processImageIndexJob({
    db,
    admin,
    drive,
    imageId,
    eventId,
    driveFileId,
    mimeType,
    embeddingVersion,
    hfSpaceUrl,
  })

  await markJobDone({
    jobRef: jobDoc.ref,
    summary: {
      attempts: Number(jobData.attempts || 0) + 1,
      ...summary,
    },
  })

  return {
    jobId: jobDoc.id,
    imageId,
    ...summary,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const workerSecret = process.env.INDEX_WORKER_SECRET || process.env.CRON_SECRET
  if (!workerSecret) {
    return res.status(500).json({ error: 'INDEX_WORKER_SECRET or CRON_SECRET is required' })
  }

  const provided = getAuthToken(req)
  if (!provided || provided !== workerSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const hfSpaceUrl = process.env.HF_SPACE_URL
  if (!hfSpaceUrl) {
    return res.status(500).json({ error: 'HF_SPACE_URL is required' })
  }

  let serviceAccount
  try {
    serviceAccount = loadServiceAccount()
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }

  const db = admin.firestore()
  const drive = getDriveClient()
  const limit = Math.max(1, Number(req.body?.limit || req.query?.limit || 10))
  const embeddingVersionDefault = process.env.EMBEDDING_VERSION || 'v2'

  const candidates = await listCandidateJobs(db, limit)
  const claimed = []

  for (const doc of candidates) {
    const ok = await claimJob(db, doc.ref)
    if (ok) claimed.push(doc)
  }

  const results = {
    requested: limit,
    candidates: candidates.length,
    claimed: claimed.length,
    processed: 0,
    failed: 0,
    jobs: [],
  }

  for (const jobDoc of claimed) {
    const jobData = jobDoc.data() || {}
    try {
      const processed = await processClaimedJob({
        db,
        drive,
        jobDoc,
        hfSpaceUrl,
        embeddingVersionDefault,
      })
      results.jobs.push({
        jobId: processed.jobId,
        imageId: processed.imageId,
        status: 'done',
        detectedFaces: processed.detectedFaces,
        usableFaces: processed.usableFaces,
      })
      results.processed += 1
    } catch (err) {
      const failure = await markJobFailure({
        db,
        jobRef: jobDoc.ref,
        jobData,
        errorMessage: err.message,
      })
      results.jobs.push({
        jobId: jobDoc.id,
        imageId: jobData.imageId || null,
        status: failure.shouldRetry ? 'retry' : 'failed',
        attempts: failure.attempts,
        maxAttempts: failure.maxAttempts,
        error: err.message,
      })
      results.failed += 1
    }
  }

  return res.status(200).json(results)
}
