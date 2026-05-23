import { useState, useEffect } from 'react'
import Head from 'next/head'
import Header from '../components/Header'

async function resizeToWebP(file, maxWidth, quality = 0.8) {
  const imgBitmap = await createImageBitmap(file)
  const ratio = Math.min(1, maxWidth / imgBitmap.width)
  const width = Math.round(imgBitmap.width * ratio)
  const height = Math.round(imgBitmap.height * ratio)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(imgBitmap, 0, 0, width, height)

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob)
      },
      'image/webp',
      quality
    )
  })
}

export default function UploadPage() {
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState('info') // info, success, error
  const [eventId, setEventId] = useState('wedding-2026')
  const [consent, setConsent] = useState(true)
  const [secretKey, setSecretKey] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)

  // Load secret key from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('photopik_upload_secret')
    if (saved) setSecretKey(saved)
  }, [])

  const handleSecretChange = (val) => {
    setSecretKey(val)
    localStorage.setItem('photopik_upload_secret', val)
  }

  const onFileChange = (e) => {
    const f = e.target.files?.[0]
    if (f) {
      if (!f.type.startsWith('image/')) {
        setStatus('Please select an image file.')
        setStatusType('error')
        return
      }
      setFile(f)
      setPreviewUrl(URL.createObjectURL(f))
      setStatus('')
    }
  }

  const onDragOver = (e) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const onDragLeave = () => {
    setIsDragOver(false)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setIsDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) {
      if (!f.type.startsWith('image/')) {
        setStatus('Please drop an image file.')
        setStatusType('error')
        return
      }
      setFile(f)
      setPreviewUrl(URL.createObjectURL(f))
      setStatus('')
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!file) return

    setStatus('Optimizing image in browser...')
    setStatusType('info')

    try {
      // 1. Generate WebP optimized derivatives client-side
      const derivativeBlob = await resizeToWebP(file, 1280, 0.85)
      const thumbBlob = await resizeToWebP(file, 320, 0.8)

      const form = new FormData()
      form.append('eventId', eventId)
      form.append('consent', consent ? 'true' : 'false')
      form.append('original', file, file.name)
      form.append('derivative', new File([derivativeBlob], `${file.name.split('.').slice(0, -1).join('.')}-deriv.webp`, { type: 'image/webp' }))
      form.append('thumbnail', new File([thumbBlob], `${file.name.split('.').slice(0, -1).join('.')}-thumb.webp`, { type: 'image/webp' }))

      setStatus('Uploading to Google Drive & running AI indexing...')
      const headers = {}
      if (secretKey) {
        headers['Authorization'] = `Bearer ${secretKey}`
      }

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers,
        body: form,
      })

      const data = await res.json()
      if (res.ok) {
        setStatus('Photo uploaded and indexed successfully!')
        setStatusType('success')
        setFile(null)
        setPreviewUrl('')
      } else {
        setStatus(data?.error || data?.message || 'Upload failed')
        setStatusType('error')
      }
    } catch (err) {
      console.error(err)
      setStatus('Error: ' + err.message)
      setStatusType('error')
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative overflow-hidden">
      <Head>
        <title>Upload Photos — PhotoPik</title>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <style>{`
          body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #020617;
          }
        `}</style>
      </Head>

      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-violet-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-fuchsia-600/10 blur-[120px] rounded-full pointer-events-none" />

      <Header />

      <main className="flex-1 max-w-xl mx-auto px-6 py-12 relative z-10 w-full">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-fuchsia-400">
            Upload & Index Photos
          </h2>
          <p className="text-sm text-slate-400 mt-2">
            Add images to an event. They will be stored in Google Drive and face-indexed.
          </p>
        </div>

        <form onSubmit={onSubmit} className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-md space-y-6 shadow-xl">
          {/* Authorization Key */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Admin Access Key / Passcode
            </label>
            <input
              type="password"
              placeholder="Enter upload key"
              value={secretKey}
              onChange={(e) => handleSecretChange(e.target.value)}
              className="w-full bg-slate-950/80 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-violet-500/80 transition-colors text-sm"
            />
            <p className="text-[10px] text-slate-500 mt-1">Saved locally. Transmitted as secure Authorization Bearer header.</p>
          </div>

          {/* Event ID */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Event ID (Folder Identifier)
            </label>
            <input
              type="text"
              required
              placeholder="e.g. wedding-2026"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="w-full bg-slate-950/80 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-violet-500/80 transition-colors text-sm font-mono"
            />
          </div>

          {/* Drag and Drop Zone */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer relative ${isDragOver
                ? 'border-violet-500 bg-violet-600/5 shadow-md shadow-violet-500/5'
                : 'border-slate-800 hover:border-slate-700 bg-slate-950/20'
              }`}
            onClick={() => document.getElementById('image-upload').click()}
          >
            <input
              id="image-upload"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileChange}
            />

            {previewUrl ? (
              <div className="relative group/preview max-w-xs mx-auto">
                <img
                  src={previewUrl}
                  alt="selected preview"
                  className="rounded-lg max-h-56 mx-auto object-cover border border-slate-800 shadow"
                />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/preview:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
                  <span className="text-xs font-semibold text-slate-200">Change Image</span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mx-auto text-slate-400">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-300">Drag & drop your event photo here</p>
                  <p className="text-xs text-slate-500 mt-1">or click to browse files (PNG, JPG, WEBP)</p>
                </div>
              </div>
            )}
          </div>

          {/* Consent Checkbox */}
          <div className="flex items-start space-x-3 bg-slate-950/40 p-4 rounded-xl border border-slate-900">
            <input
              id="consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-slate-800 bg-slate-950 text-violet-600 focus:ring-violet-600/50"
            />
            <div className="text-xs text-slate-400 select-none">
              <label htmlFor="consent" className="font-semibold text-slate-300 block mb-0.5 cursor-pointer">
                Biometric processing consent
              </label>
              I authorize the system to scan this image for human faces and generate biometric matching templates.
            </div>
          </div>

          {/* Action Button */}
          <button
            type="submit"
            disabled={!file}
            className={`w-full py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg flex items-center justify-center space-x-2 ${file
                ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white shadow-violet-500/20'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed shadow-none border border-slate-800/80'
              }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Upload Photo</span>
          </button>

          {/* Status Alert */}
          {status && (
            <div
              className={`p-4 rounded-xl border text-xs leading-relaxed transition-all flex items-start space-x-2 ${statusType === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                  : statusType === 'error'
                    ? 'bg-rose-500/10 border-rose-500/25 text-rose-400'
                    : 'bg-violet-500/10 border-violet-500/25 text-violet-400'
                }`}
            >
              <div className="mt-0.5">
                {statusType === 'success' && (
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                )}
                {statusType === 'error' && (
                  <svg className="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                )}
                {statusType === 'info' && (
                  <svg className="w-4 h-4 animate-spin text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                )}
              </div>
              <span className="font-medium">{status}</span>
            </div>
          )}
        </form>
      </main>

      <footer className="py-6 border-t border-slate-900 bg-slate-950/20 text-center text-xs text-slate-500 relative z-10">
        <p>&copy; {new Date().getFullYear()} PhotoPik. All rights reserved.</p>
      </footer>
    </div>
  )
}

