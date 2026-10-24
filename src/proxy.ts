import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, authPassword, isValidSession } from '@/lib/auth/session'

// With AUTH_PASSWORD set, everything but the sign-in page, its API and the health check needs the session
// cookie. Pages redirect to /login; API calls get 401. See src/lib/auth/session.ts.
const OPEN = ['/login', '/api/auth/', '/api/health']

export async function proxy(request: NextRequest) {
  const password = authPassword()
  if (!password) return NextResponse.next()

  const { pathname, search } = request.nextUrl
  if (OPEN.some((path) => pathname === path || pathname.startsWith(path))) return NextResponse.next()
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value, password)) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  }
  const login = new URL('/login', request.url)
  if (pathname !== '/') login.searchParams.set('next', pathname + search)
  return NextResponse.redirect(login)
}

export const config = {
  // Next's own files and the static ones in public/ never need a session.
  matcher: ['/((?!_next/|favicon|icon|apple-touch-icon|manifest|robots).*)'],
}
