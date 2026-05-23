import Link from 'next/link'
import { useRouter } from 'next/router'

export default function Header() {
  const router = useRouter()

  const isActive = (path) => router.pathname === path

  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-slate-950/70 border-b border-slate-800/80 px-6 py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <Link href="/" className="flex items-center space-x-2 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-violet-600 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-violet-500/20 group-hover:scale-105 transition-transform">
            <span className="text-white font-extrabold text-sm tracking-wider">P</span>
          </div>
          <span className="font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-slate-100 to-slate-300">
            Photo<span className="text-violet-500 font-extrabold">Pik</span>
          </span>
        </Link>
        <nav className="flex space-x-1 sm:space-x-2">
          <Link
            href="/upload"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              isActive('/upload')
                ? 'bg-slate-800 text-violet-400 shadow-inner'
                : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/50'
            }`}
          >
            Upload
          </Link>
          <Link
            href="/gallery"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              isActive('/gallery')
                ? 'bg-slate-800 text-violet-400 shadow-inner'
                : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/50'
            }`}
          >
            Find Photos
          </Link>
        </nav>
      </div>
    </header>
  )
}

