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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { eventId, embedding, topK = 20 } = req.body
  if (!eventId || !embedding) return res.status(400).json({ error: 'eventId and embedding required' })

  if (!isVectorSearchEnabled()) {
    return res.status(503).json({
      error: 'Vector search is required. Set QDRANT_URL (and optional QDRANT_API_KEY/QDRANT_COLLECTION).',
    })
  }

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

    const vectorRes = await searchFacesByEmbedding({
      eventId,
      embedding: queryEmbedding,
      topK,
    })
    return res.status(200).json({
      backend: 'vector',
      results: vectorRes.results,
    })
  } catch (err) {
    console.error('search error', err)
    return res.status(500).json({ error: err.message })
  }
}
