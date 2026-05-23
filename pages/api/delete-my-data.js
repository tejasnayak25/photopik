import admin from 'firebase-admin'
import fs from 'fs'

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

  const { faceIds } = req.body
  if (!faceIds || !Array.isArray(faceIds) || faceIds.length === 0) {
    return res.status(400).json({ error: 'faceIds array is required' })
  }

  let serviceAccount
  try {
    serviceAccount = loadServiceAccount()
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message })
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  const db = admin.firestore()

  try {
    const batch = db.batch()
    let count = 0

    for (const id of faceIds) {
      if (typeof id === 'string') {
        const ref = db.collection('faces').doc(id)
        batch.delete(ref)
        count++
      }
    }

    if (count > 0) {
      await batch.commit()
    }

    return res.status(200).json({ success: true, message: `Successfully deleted ${count} face indexes.` })
  } catch (err) {
    console.error('delete error', err)
    return res.status(500).json({ error: err.message })
  }
}
