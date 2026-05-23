import admin from 'firebase-admin'
import fs from 'fs'
import { google } from 'googleapis'
import { getDriveClient, loadServiceAccount } from '../../../lib/googleDrive'



export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'id required' })

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
    const doc = await db.collection('images').doc(id).get()
    let driveFileId = null
    const { size } = req.query

    if (doc.exists) {
      const data = doc.data()
      if (size === 'original') {
        driveFileId = data.driveFileId
      } else if (size === 'thumbnail') {
        driveFileId = data.thumbnailDriveId || data.derivativeDriveId || data.driveFileId
      } else {
        driveFileId = data.derivativeDriveId || data.driveFileId
      }
    } else {
      // allow direct Drive fileId if user provided one
      driveFileId = id
    }

    if (!driveFileId) return res.status(404).json({ error: 'file not found' })

    let drive
    try {
      drive = getDriveClient()
    } catch (err) {
      console.error(err)
      return res.status(500).json({ error: err.message })
    }

    // get metadata for mimeType
    const meta = await drive.files.get({ fileId: driveFileId, fields: 'mimeType, name', supportsAllDrives: true })
    const mimeType = meta.data?.mimeType || 'application/octet-stream'

    res.setHeader('Content-Type', mimeType)
    // cache for 1 hour on client, longer on CDN
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400')

    const driveRes = await drive.files.get({ fileId: driveFileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' })
    driveRes.data.pipe(res)
  } catch (err) {
    console.error('image proxy error', err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
}
