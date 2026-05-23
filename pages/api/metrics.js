import fs from 'fs'
import { getDriveQueueStats } from '../../lib/driveQueue'

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
  if (req.method !== 'GET') return res.status(405).end()

  let serviceAccount
  try {
    serviceAccount = loadServiceAccount()
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }

  try {
    const queueStats = getDriveQueueStats()

    return res.status(200).json({
      quota: null,
      note: 'Service accounts do not expose storage quota. Use a shared drive or OAuth delegation for quota-aware monitoring.',
      queueStats,
    })
  } catch (err) {
    console.error('metrics error', err)
    return res.status(500).json({ error: err.message })
  }
}
