export async function listCandidateJobs(db, limit) {
  const safeLimit = Math.max(1, Number(limit) || 20)
  const now = new Date()

  const pendingSnap = await db
    .collection('indexJobs')
    .where('status', '==', 'pending')
    .limit(safeLimit)
    .get()

  const jobs = [...pendingSnap.docs]
  if (jobs.length >= safeLimit) {
    return jobs
  }

  try {
    const retrySnap = await db
      .collection('indexJobs')
      .where('status', '==', 'retry')
      .where('nextAttemptAt', '<=', now)
      .limit(safeLimit - jobs.length)
      .get()
    jobs.push(...retrySnap.docs)
  } catch (err) {
    const details = String(err?.details || err?.message || '')
    if (!details.includes('requires an index')) {
      throw err
    }
    console.warn('[index-worker] missing composite index for retry query; processing pending jobs only')
  }

  return jobs
}

export async function claimJob(db, jobRef) {
  return db.runTransaction(async (tx) => {
    const fresh = await tx.get(jobRef)
    if (!fresh.exists) {
      return false
    }

    const data = fresh.data() || {}
    const status = data.status
    const nextAttemptAt = data.nextAttemptAt
    const nextAttemptDate = nextAttemptAt && typeof nextAttemptAt.toDate === 'function'
      ? nextAttemptAt.toDate()
      : null

    const isPending = status === 'pending'
    const isReadyRetry = status === 'retry' && (!nextAttemptDate || nextAttemptDate <= new Date())

    if (!isPending && !isReadyRetry) {
      return false
    }

    tx.update(jobRef, {
      status: 'processing',
      startedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    })

    return true
  })
}

export function retryDelayMs(attempts) {
  const safeAttempts = Math.max(1, Number(attempts) || 1)
  const baseSeconds = 15
  const cappedPower = Math.min(safeAttempts, 6)
  const jitterMs = Math.floor(Math.random() * 400)
  return baseSeconds * (2 ** (cappedPower - 1)) * 1000 + jitterMs
}

export async function markJobDone({ jobRef, summary }) {
  await jobRef.update({
    status: 'done',
    updatedAt: new Date(),
    completedAt: new Date(),
    attempts: summary.attempts,
    result: {
      detectedFaces: summary.detectedFaces,
      usableFaces: summary.usableFaces,
      skippedFaces: summary.skippedFaces,
      insertedFaces: summary.insertedFaces,
      deletedFaces: summary.deletedFaces,
    },
    nextAttemptAt: null,
    lastError: null,
  })
}

export async function markJobFailure({ db, jobRef, jobData, errorMessage }) {
  const previousAttempts = Number(jobData.attempts || 0)
  const attempts = previousAttempts + 1
  const maxAttempts = Number(jobData.maxAttempts || 5)
  const shouldRetry = attempts < maxAttempts

  const patch = {
    attempts,
    status: shouldRetry ? 'retry' : 'failed',
    updatedAt: new Date(),
    lastError: errorMessage,
    failedAt: shouldRetry ? null : new Date(),
    nextAttemptAt: shouldRetry ? new Date(Date.now() + retryDelayMs(attempts)) : null,
  }

  await jobRef.update(patch)

  if (jobData.imageId) {
    await db.collection('images').doc(jobData.imageId).set(
      {
        indexingStatus: shouldRetry ? 'retry' : 'failed',
        indexingLastError: errorMessage,
        updatedAt: new Date(),
      },
      { merge: true }
    )
  }

  return {
    attempts,
    maxAttempts,
    shouldRetry,
  }
}