import { IncomingForm } from 'formidable'
import fs from 'fs'
import { google } from 'googleapis'
import admin from 'firebase-admin'
import driveQueue from '../../lib/driveQueue'
import FormData from 'form-data'
import fetch from 'node-fetch'
import { getDriveClient, loadServiceAccount } from '../../lib/googleDrive'

export const config = {
  api: {
    bodyParser: false,
  },
}



async function uploadToDrive(drive, file, name, mimeType) {
  const filePath = file?.filepath || file?.path
  const res = await drive.files.create({
    requestBody: { name, mimeType },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id',
    supportsAllDrives: true,
  })
  return res.data.id
}

async function uploadToDriveInFolder(drive, file, name, mimeType, folderId) {
  const filePath = file?.filepath || file?.path
  const requestBody = { name, mimeType }
  if (folderId) requestBody.parents = [folderId]
  const res = await drive.files.create({
    requestBody,
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id',
    supportsAllDrives: true,
  })
  return res.data.id
}

async function ensureEventFolder(drive, eventId, parentFolderId) {
  const folderName = `event_${eventId}`
  let q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`
  if (parentFolderId) {
    q += ` and '${parentFolderId}' in parents`
  }
  const list = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (list.data.files && list.data.files.length) return list.data.files[0].id

  const requestBody = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  }
  if (parentFolderId) {
    requestBody.parents = [parentFolderId]
  }
  const created = await drive.files.create({
    requestBody,
    fields: 'id',
    supportsAllDrives: true,
  })
  return created.data.id
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

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

  // 1. Authentication and RBAC Check
  const authHeader = req.headers.authorization
  const uploadSecret = process.env.ADMIN_UPLOAD_SECRET
  let isAuthorized = false
  let decodedUser = null
  let userRole = null

  if (uploadSecret && authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    if (token === uploadSecret) {
      isAuthorized = true
      userRole = 'admin'
    }
  }

  if (!isAuthorized && authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    try {
      decodedUser = await admin.auth().verifyIdToken(token)
      // Check user role in Firestore: users/{uid}
      const userDoc = await db.collection('users').doc(decodedUser.uid).get()
      if (userDoc.exists) {
        const role = userDoc.data().role
        if (role === 'admin' || role === 'photographer') {
          isAuthorized = true
          userRole = role
        }
      } else {
        // Fallback: If no users exist, auto-grant admin to the first logged-in user
        const usersSnap = await db.collection('users').limit(1).get()
        if (usersSnap.empty) {
          await db.collection('users').doc(decodedUser.uid).set({
            email: decodedUser.email || '',
            role: 'admin',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          })
          isAuthorized = true
          userRole = 'admin'
        }
      }
    } catch (authErr) {
      console.warn('Auth token validation warning:', authErr.message)
    }
  }

  // Enforce auth if ADMIN_UPLOAD_SECRET is configured OR there are users registered in the database
  const totalUsersSnap = await db.collection('users').limit(1).get()
  const authRequired = !!uploadSecret || !totalUsersSnap.empty

  if (authRequired && !isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid upload secret / Firebase ID token with admin/photographer role.' })
  }

  // 2. Parse form with Formidable (enforcing image-only filtering and size limits)
  const form = new IncomingForm({
    maxFileSize: 15 * 1024 * 1024, // 15MB
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
    console.error('form parse error', err)
    return res.status(400).json({ error: 'Failed to parse form: ' + err.message })
  }

  const { fields, files } = parsed

  let drive
  try {
    drive = getDriveClient()
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message })
  }

  try {
    const original = Array.isArray(files.original) ? files.original[0] : files.original
    const derivative = Array.isArray(files.derivative) ? files.derivative[0] : files.derivative
    const thumbnail = Array.isArray(files.thumbnail) ? files.thumbnail[0] : files.thumbnail

    if (!original) return res.status(400).json({ error: 'original image file is required' })

    const rawEventId = Array.isArray(fields.eventId) ? fields.eventId[0] : fields.eventId
    const eventIdField = (rawEventId || 'default').trim()
    const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || null

    // 3. Resolve or Create Firestore Event to Google Drive folder association
    const eventRef = db.collection('events').doc(eventIdField)
    const eventDoc = await eventRef.get()
    let folderId = null

    if (eventDoc.exists) {
      folderId = eventDoc.data().driveFolderId
    }

    if (!folderId) {
      // Ensure folder exists inside parent shared folder
      folderId = await ensureEventFolder(drive, eventIdField, parentFolderId)

      if (eventDoc.exists) {
        await eventRef.update({ driveFolderId: folderId })
      } else {
        await eventRef.set({
          name: eventIdField,
          driveFolderId: folderId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
      }
    }

    // Upload to Drive folder
    const originalId = await driveQueue.enqueue(() => uploadToDriveInFolder(drive, original, original.originalFilename || original.newFilename || 'original', original.mimetype || 'image/jpeg', folderId))
    let derivativeId = null
    let thumbnailId = null
    if (derivative) {
      derivativeId = await driveQueue.enqueue(() => uploadToDriveInFolder(drive, derivative, derivative.originalFilename || derivative.newFilename || 'derivative.webp', derivative.mimetype || 'image/webp', folderId))
    }
    if (thumbnail) {
      thumbnailId = await driveQueue.enqueue(() => uploadToDriveInFolder(drive, thumbnail, thumbnail.originalFilename || thumbnail.newFilename || 'thumbnail.webp', thumbnail.mimetype || 'image/webp', folderId))
    }

    const consentField = Array.isArray(fields.consent) ? fields.consent[0] : fields.consent
    const uploaderIdField = Array.isArray(fields.uploaderId) ? fields.uploaderId[0] : fields.uploaderId

    const imageDoc = {
      eventId: eventIdField,
      driveFileId: originalId,
      derivativeDriveId: derivativeId,
      thumbnailDriveId: thumbnailId,
      driveFolderId: folderId || null,
      syncedToCloud: false,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      uploaderId: uploaderIdField || (decodedUser ? decodedUser.uid : null),
      consent: consentField === 'true',
    }

    const docRef = await db.collection('images').add(imageDoc)

    // If HF Space configured, send derivative (or original) to HF /process endpoint via Gradio
    const HF_SPACE_URL = process.env.HF_SPACE_URL
    if (HF_SPACE_URL) {
      try {
        const fileIdToUse = derivativeId || originalId
        // download file from Drive into buffer
        const driveRes = await drive.files.get({ fileId: fileIdToUse, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' })
        const chunks = []
        await new Promise((resolve, reject) => {
          driveRes.data.on('data', (chunk) => chunks.push(chunk))
          driveRes.data.on('end', resolve)
          driveRes.data.on('error', reject)
        })
        const buffer = Buffer.concat(chunks)
        const mimeType = derivative ? derivative.mimetype : original.mimetype
        const blob = new Blob([buffer], { type: mimeType })

        console.log("Connecting to Gradio Space for face embedding...");
        const { Client } = await import('@gradio/client')
        const client = await Client.connect(HF_SPACE_URL)
        const result = await client.predict("/process", {
          image: blob
        })

        const faces = result.data[1] || []
        console.log(`Detected ${faces.length} face(s) from Space.`);

        for (const item of faces) {
          const emb = item.embedding
          const bbox = item.bbox || null

          // Validate embedding exists and is not an all-zero vector.
          if (!emb || !Array.isArray(emb) || emb.length === 0) {
            console.warn("WARNING: Face detected but 'embedding' array is missing from Space response. Please update your Space's gradio_app.py to return the actual embedding array.");
            continue;
          }

          // Detect all-zero embeddings which commonly indicate the model wasn't loaded
          // or an error occurred during embedding generation.
          const allZero = emb.every((v) => Number(v) === 0)
          if (allZero) {
            console.warn("WARNING: Face embedding is all zeros — embedding model may be missing or failed. Skipping storing this face.");
            continue;
          }

          const faceDoc = {
            imageId: docRef.id,
            eventId: eventIdField,
            embedding: emb,
            bbox: bbox,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            embeddingVersion: 'v1'
          }
          await db.collection('faces').add(faceDoc)
        }
      } catch (hfErr) {
        console.error('HF processing error', hfErr)
      }
    }

    return res.status(200).json({ success: true, imageId: docRef.id, driveFileId: originalId })
  } catch (err) {
    console.error('upload error', err)
    return res.status(500).json({ error: err.message })
  }
}

