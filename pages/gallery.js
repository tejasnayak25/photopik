import { useState, useRef, useEffect } from 'react'
import Head from 'next/head'
import Header from '../components/Header'

export default function GalleryPage() {
  const [eventId, setEventId] = useState('wedding-2026')
  const [selfieFile, setSelfieFile] = useState(null)
  const [selfiePreview, setSelfiePreview] = useState('')
  const [searchMethod, setSearchMethod] = useState('upload') // upload, camera
  const [consent, setConsent] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [searchStatus, setSearchStatus] = useState('')
  const [results, setResults] = useState([])
  const [searched, setSearched] = useState(false)
  const [activePhoto, setActivePhoto] = useState(null) // for Lightbox
  const [cameraActive, setCameraActive] = useState(false)
  
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  // Clean up webcam stream on unmount
  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  // Attach the stream after the video element is mounted.
  useEffect(() => {
    if (!cameraActive) return
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream) return

    video.srcObject = stream
    video.play().catch((err) => {
      console.error('Camera play error:', err)
    })
  }, [cameraActive])

  const startCamera = async () => {
    try {
      setSelfieFile(null)
      setSelfiePreview('')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 640, height: 480 }
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setCameraActive(true)
      setSearchStatus('')
    } catch (err) {
      console.error('Camera access error:', err)
      setSearchStatus('Could not access camera. Please upload a photo instead.')
      setSearchMethod('upload')
    }
  }

  const stopCamera = () => {
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    setCameraActive(false)
  }

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas')
      canvas.width = videoRef.current.videoWidth || 640
      canvas.height = videoRef.current.videoHeight || 480
      const ctx = canvas.getContext('2d')
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height)
      
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' })
          setSelfieFile(file)
          setSelfiePreview(URL.createObjectURL(blob))
          stopCamera()
        }
      }, 'image/jpeg', 0.9)
    }
  }

  const handleFileChange = (e) => {
    const f = e.target.files?.[0]
    if (f) {
      setSelfieFile(f)
      setSelfiePreview(URL.createObjectURL(f))
      setSearched(false)
    }
  }

  const handleSearchToggle = (method) => {
    setSearchMethod(method)
    setSearched(false)
    setResults([])
    if (method === 'camera') {
      startCamera()
    } else {
      stopCamera()
    }
  }

  const onSearch = async (e) => {
    e.preventDefault()
    if (!selfieFile || !consent) return

    setIsSearching(true)
    setSearchStatus('Detecting face & extracting biometric signatures...')
    setResults([])
    setSearched(true)

    try {
      const form = new FormData()
      form.append('eventId', eventId.trim())
      form.append('selfie', selfieFile)

      const res = await fetch('/api/search-by-selfie', {
        method: 'POST',
        body: form
      })

      const data = await res.json()
      if (res.ok) {
        setResults(data.results || [])
        setSearchStatus('')
      } else {
        setSearchStatus(data.error || 'Failed to search photos.')
      }
    } catch (err) {
      console.error(err)
      setSearchStatus('Error searching photos: ' + err.message)
    } finally {
      setIsSearching(false)
    }
  }

  const handleDeleteFace = async (faceId, imageId, index) => {
    if (!confirm('Are you sure you want to permanently erase your face index from this photo? You will no longer be able to retrieve this image via selfie search.')) {
      return
    }

    try {
      const res = await fetch('/api/delete-my-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faceIds: [faceId] })
      })

      if (res.ok) {
        // Remove from UI results
        const updated = [...results]
        updated.splice(index, 1)
        setResults(updated)
        if (activePhoto?.faceId === faceId) {
          setActivePhoto(null)
        }
        alert('Face index erased successfully.')
      } else {
        const data = await res.json()
        alert('Deletion failed: ' + (data.error || 'Server error'))
      }
    } catch (err) {
      alert('Error request: ' + err.message)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative overflow-hidden">
      <Head>
        <title>Find Photos — PhotoPik</title>
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

      <main className="flex-1 max-w-6xl mx-auto px-6 py-12 relative z-10 w-full flex flex-col md:flex-row gap-8">
        
        {/* Left Control Panel */}
        <div className="w-full md:w-80 flex-shrink-0">
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-md sticky top-24 space-y-6 shadow-xl">
            <div>
              <h2 className="text-xl font-bold tracking-tight">Search Selfie</h2>
              <p className="text-xs text-slate-400 mt-1">Upload a face photo to fetch all images containing you.</p>
            </div>

            <form onSubmit={onSearch} className="space-y-4">
              {/* Event ID */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Event ID</label>
                <input
                  type="text"
                  required
                  placeholder="wedding-2026"
                  value={eventId}
                  onChange={(e) => setEventId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-violet-500/80 transition-colors text-sm font-mono"
                />
              </div>

              {/* Mode Toggle */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Selfie Source</label>
                <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 border border-slate-850 rounded-xl">
                  <button
                    type="button"
                    onClick={() => handleSearchToggle('upload')}
                    className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-all ${
                      searchMethod === 'upload' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Upload File
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSearchToggle('camera')}
                    className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-all ${
                      searchMethod === 'camera' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Use Camera
                  </button>
                </div>
              </div>

              {/* Selfie Input Area */}
              {searchMethod === 'upload' ? (
                <div>
                  <div className="border border-dashed border-slate-800 hover:border-slate-700 bg-slate-950/20 rounded-xl p-4 text-center cursor-pointer relative"
                       onClick={() => document.getElementById('selfie-file-input').click()}>
                    <input
                      id="selfie-file-input"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    
                    {selfiePreview ? (
                      <img src={selfiePreview} alt="selfie preview" className="w-24 h-24 rounded-full object-cover mx-auto border border-slate-700 shadow" />
                    ) : (
                      <div className="space-y-1.5 py-4">
                        <svg className="w-8 h-8 mx-auto text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <p className="text-xs font-semibold text-slate-300">Choose selfie image</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {cameraActive ? (
                    <div className="relative border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                      <video ref={videoRef} autoPlay playsInline muted className="w-full h-auto aspect-video object-cover" />
                      <button
                        type="button"
                        onClick={capturePhoto}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-lg"
                      >
                        Capture Frame
                      </button>
                    </div>
                  ) : (
                    selfiePreview && (
                      <div className="text-center space-y-2">
                        <img src={selfiePreview} alt="captured selfie" className="w-24 h-24 rounded-full object-cover mx-auto border border-slate-700 shadow" />
                        <button
                          type="button"
                          onClick={startCamera}
                          className="text-xs text-violet-400 hover:underline font-semibold"
                        >
                          Retake photo
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}

              {/* Consent Box */}
              <div className="flex items-start space-x-2 bg-slate-950/40 p-3 rounded-lg border border-slate-900">
                <input
                  id="search-consent"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 rounded border-slate-800 bg-slate-950 text-violet-600 focus:ring-violet-600/50"
                />
                <label htmlFor="search-consent" className="text-[10px] text-slate-400 select-none cursor-pointer">
                  I consent to AI face indexing for matching retrieval purposes.
                </label>
              </div>

              {/* Action */}
              <button
                type="submit"
                disabled={!selfieFile || !consent || isSearching}
                className={`w-full py-2.5 rounded-xl font-bold text-xs transition-all shadow-md flex items-center justify-center space-x-1.5 ${
                  selfieFile && consent && !isSearching
                    ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-850'
                }`}
              >
                {isSearching ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>Searching...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <span>Find My Photos</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Right Gallery Result Grid */}
        <div className="flex-1 bg-slate-900/20 border border-slate-900 rounded-2xl p-6 min-h-[400px] flex flex-col">
          
          {searchStatus && (
            <div className="mb-6 p-4 rounded-xl bg-violet-650/10 border border-violet-500/20 text-violet-400 text-xs flex items-center space-x-2">
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
              <span>{searchStatus}</span>
            </div>
          )}

          {!searched && !isSearching && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center text-slate-600 border border-slate-800">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <div>
                <h3 className="text-lg font-bold">No Photos Searched</h3>
                <p className="text-sm text-slate-500 max-w-sm mx-auto mt-1">
                  Enter an Event ID and provide a selfie on the left side to look up matching event photos.
                </p>
              </div>
            </div>
          )}

          {searched && !isSearching && results.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center text-slate-600 border border-slate-800">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <div>
                <h3 className="text-lg font-bold">No Match Found</h3>
                <p className="text-sm text-slate-500 max-w-sm mx-auto mt-1">
                  We couldn't find any photos matching your selfie in event "{eventId}". Make sure the Event ID is correct and your selfie is clear.
                </p>
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div className="space-y-4">
              <div className="flex justify-between items-center border-b border-slate-950 pb-4">
                <h3 className="font-bold text-slate-200">Retrieved Matches ({results.length})</h3>
                <span className="text-xs text-slate-500 font-medium">Sorted by facial similarity score</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {results.map((item, index) => {
                  const matchPercentage = Math.round(item.score * 100)
                  return (
                    <div
                      key={item.faceId}
                      className="group relative rounded-xl border border-slate-800 bg-slate-900/40 p-2 overflow-hidden hover:border-violet-500/40 transition-all duration-200 shadow hover:shadow-lg"
                    >
                      <div
                        className="relative aspect-square bg-slate-950 rounded-lg overflow-hidden cursor-pointer"
                        onClick={() => setActivePhoto({ ...item, index })}
                      >
                        <img
                          src={`/api/image/${item.imageId}?size=thumbnail`}
                          alt={`matched event photo`}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          loading="lazy"
                        />
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-violet-600 text-[10px] font-bold text-white shadow shadow-black/40">
                          {matchPercentage}% Match
                        </div>
                      </div>
                      
                      <div className="mt-2 flex items-center justify-between px-1">
                        <button
                          onClick={() => setActivePhoto({ ...item, index })}
                          className="text-[10px] text-slate-400 hover:text-slate-200 font-semibold"
                        >
                          View Photo
                        </button>
                        <button
                          onClick={() => handleDeleteFace(item.faceId, item.imageId, index)}
                          title="Erase my biometric face index from this photo"
                          className="text-[10px] text-rose-500 hover:text-rose-400 font-medium"
                        >
                          Erase Face
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Fullscreen Lightbox Modal */}
      {activePhoto && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col justify-between p-6">
          <div className="flex items-center justify-between text-slate-200">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">Event photo details</span>
              <h4 className="text-sm font-mono mt-0.5 text-slate-300">ID: {activePhoto.imageId}</h4>
            </div>
            <button
              onClick={() => setActivePhoto(null)}
              className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center hover:bg-slate-800 text-white font-bold"
            >
              &times;
            </button>
          </div>

          <div className="flex-1 flex items-center justify-center p-4">
            <div className="relative max-w-4xl max-h-[70vh] w-full h-full flex items-center justify-center">
              <img
                src={`/api/image/${activePhoto.imageId}`}
                alt="fullscreen view"
                className="max-w-full max-h-full object-contain rounded-lg shadow-2xl border border-slate-900"
              />
              <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-violet-600/90 text-xs font-bold text-white shadow backdrop-blur">
                {Math.round(activePhoto.score * 100)}% Face Match Score
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 py-4 border-t border-slate-950">
            <a
              href={`/api/image/${activePhoto.imageId}?size=original`}
              target="_blank"
              rel="noreferrer"
              download
              className="px-6 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition-all shadow-lg flex items-center space-x-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              <span>Download Original High-Res</span>
            </a>
            
            <button
              onClick={() => handleDeleteFace(activePhoto.faceId, activePhoto.imageId, activePhoto.index)}
              className="px-6 py-2.5 rounded-xl bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white border border-rose-500/25 text-xs font-bold transition-all flex items-center space-x-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              <span>Request Biometric Erasure</span>
            </button>
          </div>
        </div>
      )}

      <footer className="py-6 border-t border-slate-900 bg-slate-950/20 text-center text-xs text-slate-500 relative z-10">
        <p>&copy; {new Date().getFullYear()} PhotoPik. All rights reserved.</p>
      </footer>
    </div>
  )
}
