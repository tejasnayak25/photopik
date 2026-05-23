import { IncomingForm } from 'formidable'
import fs from 'fs'
import admin from 'firebase-admin'
import driveQueue from '../../lib/driveQueue'
import { getDriveClient, loadServiceAccount } from '../../lib/googleDrive'
import { processImageIndexJob } from '../../lib/faceIndexing'
import { isVectorSearchEnabled } from '../../lib/vectorSearch'

export const config = {
  api: {
    bodyParser: false,
  },
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

    // Face indexing: async queue by default for faster upload response.
    const HF_SPACE_URL = process.env.HF_SPACE_URL
    const asyncIndexingEnabled = process.env.INDEX_ASYNC_UPLOAD !== 'false'
    const embeddingVersion = process.env.EMBEDDING_VERSION || 'v2'
    let indexJobId = null

    if (HF_SPACE_URL) {
      if (!isVectorSearchEnabled()) {
        return res.status(500).json({
          error: 'Qdrant is required for indexing. Set QDRANT_URL (and optional QDRANT_API_KEY/QDRANT_COLLECTION).',
        })
      }

      const driveFileIdForIndex = derivativeId || originalId
      const mimeTypeForIndex = derivative?.mimetype || original?.mimetype || 'image/jpeg'

      await db.collection('images').doc(docRef.id).set(
        {
          indexingStatus: asyncIndexingEnabled ? 'pending' : 'processing',
          embeddingVersion,
          indexedFaceCount: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )

      if (asyncIndexingEnabled) {
        const jobRef = await db.collection('indexJobs').add({
          imageId: docRef.id,
          eventId: eventIdField,
          driveFileId: driveFileIdForIndex,
          mimeType: mimeTypeForIndex,
          embeddingVersion,
          status: 'pending',
          attempts: 0,
          maxAttempts: 5,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          nextAttemptAt: null,
          lastError: null,
        })
        indexJobId = jobRef.id
      } else {
        try {
          await processImageIndexJob({
            db,
            admin,
            drive,
            imageId: docRef.id,
            eventId: eventIdField,
            driveFileId: driveFileIdForIndex,
            mimeType: mimeTypeForIndex,
            embeddingVersion,
            hfSpaceUrl: HF_SPACE_URL,
          })
        } catch (hfErr) {
          console.error('HF processing error', hfErr)
          await db.collection('images').doc(docRef.id).set(
            {
              indexingStatus: 'failed',
              indexingLastError: hfErr.message,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        }
      }
    }

    return res.status(200).json({
      success: true,
      imageId: docRef.id,
      driveFileId: originalId,
      indexing: {
        mode: HF_SPACE_URL ? (asyncIndexingEnabled ? 'async' : 'sync') : 'disabled',
        status: HF_SPACE_URL ? (asyncIndexingEnabled ? 'pending' : 'processing') : 'disabled',
        jobId: indexJobId,
      },
    })
  } catch (err) {
    console.error('upload error', err)
    return res.status(500).json({ error: err.message })
  }
}

