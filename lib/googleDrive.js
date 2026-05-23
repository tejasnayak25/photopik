import { google } from 'googleapis'
import fs from 'fs'

let cachedDriveClient = null

export function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''
  if (!raw) return null
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw)
    const content = fs.readFileSync(raw, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    throw new Error('Failed to load service account JSON: ' + err.message)
  }
}

export function getDriveClient() {
  if (cachedDriveClient) return cachedDriveClient

  // Option 1: Personal Google Drive via OAuth2 Refresh Token (bypasses Service Account 0-quota limit)
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    )
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    })
    cachedDriveClient = google.drive({ version: 'v3', auth: oauth2Client })
    console.log("Initialized Google Drive client using OAuth2 Refresh Token (Personal Drive flow)")
    return cachedDriveClient
  }

  // Option 2: Service Account (requires Workspace Shared Drives for uploads)
  const serviceAccount = loadServiceAccount()
  if (!serviceAccount) {
    throw new Error('Configuration missing: set either GOOGLE_REFRESH_TOKEN (with GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET) or GOOGLE_SERVICE_ACCOUNT_JSON in your environment.')
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive']
  })
  cachedDriveClient = google.drive({ version: 'v3', auth })
  console.log("Initialized Google Drive client using Service Account (Workspace flow)")
  return cachedDriveClient
}
