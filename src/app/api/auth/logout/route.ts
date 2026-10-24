import { NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/session'

export const runtime = 'nodejs'

export async function POST() {
  const response = new NextResponse(null, { status: 303, headers: { Location: '/login' } })
  response.cookies.delete(SESSION_COOKIE)
  return response
}
