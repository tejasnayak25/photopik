import { IncomingForm } from 'formidable'
import fs from 'fs'
import admin from 'firebase-admin'

export const config = {
  api: {
    bodyParser: false,
  },
}

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

  const form = new IncomingForm({
    maxFileSize: 10 * 1024 * 1024, // 10MB
    filter: function ({ name, originalFilename, mimetype }) {
      return mimetype && mimetype.startsWith('image/')
    }
  })

  let parsed
  try {
    parsed = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err)
        resolve({ fields, files })
      })
    })
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse form: ' + err.message })
  }

  const { fields, files } = parsed
  const rawEventId = Array.isArray(fields.eventId) ? fields.eventId[0] : fields.eventId
  const eventIdField = (rawEventId || '').trim()

  if (!eventIdField) {
    return res.status(400).json({ error: 'eventId is required' })
  }

  const selfie = Array.isArray(files.selfie) ? files.selfie[0] : files.selfie
  if (!selfie) {
    return res.status(400).json({ error: 'selfie file is required' })
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
    // 1. Verify Event exists
    const eventDoc = await db.collection('events').doc(eventIdField).get()
    if (!eventDoc.exists) {
      return res.status(404).json({ error: `Event '${eventIdField}' not found.` })
    }

    // 2. Generate Embedding for Selfie via HF Space using Gradio Client
    const HF_SPACE_URL = process.env.HF_SPACE_URL
    if (!HF_SPACE_URL) {
      return res.status(500).json({ error: 'AI processing service is not configured (HF_SPACE_URL missing).' })
    }

    const filePath = selfie.filepath || selfie.path
    const fileBuffer = fs.readFileSync(filePath)
    const blob = new Blob([fileBuffer], { type: selfie.mimetype || 'image/jpeg' })

    console.log("Connecting to Gradio Space for selfie embedding...");
    const { Client } = await import('@gradio/client')
    const client = await Client.connect(HF_SPACE_URL)
    const result = await client.predict("/process", {
      image: blob
    })

    const faces = result.data[1] || []
    if (faces.length === 0) {
      return res.status(400).json({ error: 'No face detected in the selfie. Please ensure your face is clearly visible.' })
    }

    // Use the first face detected in the selfie
    const selfieEmbedding = faces[0].embedding
    if (!selfieEmbedding) {
      return res.status(400).json({ error: 'Biometric embedding missing from AI response. Please update the Space\'s gradio_app.py file to expose the "embedding" key instead of "embedding_len".' })
    }

    // 3. Scan Firestore faces for event and calculate cosine similarity
    const facesSnap = await db.collection('faces').where('eventId', '==', eventIdField).limit(3000).get()
    const results = []

    facesSnap.forEach(doc => {
      const data = doc.data()
      const score = cosine(selfieEmbedding, data.embedding)
      // Only include results that meet a minimum confidence threshold
      if (score >= 0.35) {
        results.push({
          faceId: doc.id,
          imageId: data.imageId,
          score,
          bbox: data.bbox || null
        })
      }
    })

    // Sort by cosine similarity score descending
    results.sort((a, b) => b.score - a.score)

    // Deduplicate images (in case a single image has multiple matching faces, return the best score)
    const uniqueImagesMap = new Map()
    for (const r of results) {
      if (!uniqueImagesMap.has(r.imageId) || uniqueImagesMap.get(r.imageId).score < r.score) {
        uniqueImagesMap.set(r.imageId, r)
      }
    }
    const finalResults = Array.from(uniqueImagesMap.values()).slice(0, 30)

    return res.status(200).json({ results: finalResults })
  } catch (err) {
    console.error('Selfie search error', err)
    return res.status(500).json({ error: err.message })
  }
}
