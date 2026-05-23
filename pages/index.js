import Head from 'next/head'
import Link from 'next/link'
import Header from '../components/Header'

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative overflow-hidden">
      <Head>
        <title>PhotoPik — Intelligent Face-Based Photo Retrieval</title>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <style>{`
          body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #020617;
          }
        `}</style>
      </Head>

      {/* Decorative background glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-violet-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-fuchsia-600/10 blur-[120px] rounded-full pointer-events-none" />

      <Header />

      <main className="flex-1 max-w-6xl mx-auto px-6 py-12 flex flex-col justify-center items-center relative z-10 w-full">
        {/* Hero Section */}
        <div className="text-center max-w-3xl mx-auto space-y-6 mb-16 mt-8">
          <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-xs font-semibold text-violet-400">
            <span>✨ Now Secure & Event-Isolated</span>
          </div>
          
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-none">
            Find Your Event Photos{' '}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400">
              Instantly with AI
            </span>
          </h1>
          
          <p className="text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Upload, optimize, and organize event images in your secure Google Drive. Attendees find their photos in seconds simply by scanning their face.
          </p>
        </div>

        {/* Portal Cards Grid */}
        <div className="grid md:grid-cols-2 gap-8 w-full max-w-4xl mx-auto">
          {/* Card 1: Admin Upload */}
          <div className="group relative rounded-2xl border border-slate-800 bg-slate-900/40 p-8 backdrop-blur-md transition-all duration-300 hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/5 hover:-translate-y-1">
            <div className="absolute inset-0 bg-gradient-to-br from-violet-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl pointer-events-none" />
            <div className="relative z-10 flex flex-col h-full justify-between">
              <div>
                <div className="w-12 h-12 rounded-xl bg-violet-600/20 flex items-center justify-center text-violet-400 mb-6 border border-violet-500/20">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <h3 className="text-2xl font-bold mb-3 text-slate-100">Photographer Portal</h3>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  Securely upload and index photos for an event. Images are automatically resized to optimized WebP formats and structured in dedicated Google Drive folders.
                </p>
                <ul className="space-y-2 mb-8 text-xs text-slate-400">
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>Google Drive parent-folder confinement</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>Role-based access & passcode protection</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>In-browser derivative generation</span>
                  </li>
                </ul>
              </div>
              <Link href="/upload" className="w-full text-center py-3 px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-all shadow-lg shadow-violet-500/25">
                Upload & Organize
              </Link>
            </div>
          </div>

          {/* Card 2: Selfie Search */}
          <div className="group relative rounded-2xl border border-slate-800 bg-slate-900/40 p-8 backdrop-blur-md transition-all duration-300 hover:border-fuchsia-500/40 hover:shadow-lg hover:shadow-fuchsia-500/5 hover:-translate-y-1">
            <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl pointer-events-none" />
            <div className="relative z-10 flex flex-col h-full justify-between">
              <div>
                <div className="w-12 h-12 rounded-xl bg-fuchsia-600/20 flex items-center justify-center text-fuchsia-400 mb-6 border border-fuchsia-500/20">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-2xl font-bold mb-3 text-slate-100">Find My Photos</h3>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  Attendees can search the event database. Take a selfie or upload a photo to retrieve all matching images using instant AI face-similarity scoring.
                </p>
                <ul className="space-y-2 mb-8 text-xs text-slate-400">
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-fuchsia-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>Instant selfie capture & matching</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-fuchsia-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>Secure image proxy streaming</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-fuchsia-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" /></svg>
                    <span>Biometric consent & deletion rights</span>
                  </li>
                </ul>
              </div>
              <Link href="/gallery" className="w-full text-center py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 hover:text-slate-100 border border-slate-700 text-slate-200 font-semibold text-sm transition-all shadow-md">
                Search Gallery
              </Link>
            </div>
          </div>
        </div>

        {/* Powered by badges */}
        <div className="mt-16 flex flex-wrap items-center justify-center gap-6 opacity-40 text-xs">
          <span>POWERED BY</span>
          <div className="flex items-center space-x-1">
            <span className="font-bold">Google Cloud Drive</span>
          </div>
          <div className="w-1.5 h-1.5 rounded-full bg-slate-700" />
          <div className="flex items-center space-x-1">
            <span className="font-bold">Firebase Firestore</span>
          </div>
          <div className="w-1.5 h-1.5 rounded-full bg-slate-700" />
          <div className="flex items-center space-x-1">
            <span className="font-bold">Hugging Face AI</span>
          </div>
        </div>
      </main>

      <footer className="py-6 border-t border-slate-900 bg-slate-950/20 text-center text-xs text-slate-500">
        <p>&copy; {new Date().getFullYear()} PhotoPik. All rights reserved. Face-based retrieval prototype.</p>
      </footer>
    </div>
  )
}

