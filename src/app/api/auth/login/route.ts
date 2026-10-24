import { NextResponse } from 'next/server'
import { SESSION_COOKIE, SESSION_DAYS, authPassword, createSession, samePassword } from '@/lib/auth/session'

export const runtime = 'nodejs'

/** Only a path on this site, so the sign-in form can't send anyone elsewhere ("/\" works like "//"). */
const safeNext = (value: FormDataEntryValue | null) =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) && !value.includes('\\') ? value : '/'

// Relative, so it stays on whatever address the browser used, behind any reverse proxy.
const seeOther = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } })

const isHttps = (request: Request) =>
  request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:'

export async function POST(request: Request) {
  const password = authPassword()
  const form = await request.formData()
  const next = safeNext(form.get('next'))
  if (!password) return seeOther(next)

  const given = form.get('password')
  if (typeof given !== 'string' || !samePassword(given, password)) {
    const back = new URLSearchParams({ error: '1' })
    if (next !== '/') back.set('next', next)
    return seeOther(`/login?${back}`)
  }

  const response = seeOther(next)
  response.cookies.set(SESSION_COOKIE, await createSession(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(request),
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })
  return response
}
