import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Jellymeme',
  description: 'Find scenes in your Jellyfin library by description and cut them into montages.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
            <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold">
              <span className="grid size-6 place-items-center rounded bg-accent text-base" aria-hidden>
                <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
                  <path d="M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3 2.5v5l4-2.5-4-2.5Z" />
                </svg>
              </span>
              Jellymeme
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="rounded-lg px-2.5 py-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                Your shows
              </Link>
              <Link
                href="/add"
                className="rounded-lg px-2.5 py-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                Add shows
              </Link>
              <Link
                href="/settings"
                className="rounded-lg px-2.5 py-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                Settings
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
      </body>
    </html>
  )
}
