import admin from 'firebase-admin'
import fs from 'fs'
import { isVectorSearchEnabled, searchFacesByEmbedding } from '../../lib/vectorSearch'

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env required')
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw)
    const path = raw
    const content = fs.readFileSync(path, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    throw new Error('Failed to load service account JSON: ' + err.message)
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i])
    const vb = Number(b[i])
    dot += va * vb
    na += va * va
    nb += vb * vb
  }
  if (na === 0 || nb === 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { eventId, embedding, topK = 20, limit = 5000 } = req.body
  if (!eventId || !embedding) return res.status(400).json({ error: 'eventId and embedding required' })

  let serviceAccount
  try {
    serviceAccount = loadServiceAccount()
    console.log("Initializing Firebase Admin for project:", serviceAccount.project_id)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message })
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()

  try {
    // Validate event exists in Firestore
    const eventDoc = await db.collection('events').doc(eventId).get()
    if (!eventDoc.exists) {
      return res.status(404).json({ error: `Event '${eventId}' not found.` })
    }

    const queryEmbedding = Array.isArray(embedding) ? embedding : JSON.parse(embedding)

    if (isVectorSearchEnabled()) {
      const vectorRes = await searchFacesByEmbedding({
        eventId,
        embedding: queryEmbedding,
        topK,
      })
      return res.status(200).json({
        backend: 'vector',
        results: vectorRes.results,
      })
    }

    const facesSnap = await db.collection('faces').where('eventId', '==', eventId).limit(limit).get()
    const results = []
    facesSnap.forEach((doc) => {
      const data = doc.data()
      const score = cosine(queryEmbedding, data.embedding)
      if (score !== -1) {
        results.push({ faceId: doc.id, imageId: data.imageId, score })
      }
    })
    results.sort((a, b) => b.score - a.score)
    const top = results.slice(0, topK)
    return res.status(200).json({
      backend: 'firestore-bruteforce',
      results: top,
    })
  } catch (err) {
    console.error('search error', err)
    return res.status(500).json({ error: err.message })
  }
}
