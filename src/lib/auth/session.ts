// Optional sign-in for a self-hosted install. Off unless AUTH_PASSWORD is set: then every page and API
// route asks for that one password (src/proxy.ts), and a signed cookie keeps you signed in for 180 days.
//
// The cookie holds its expiry and an HMAC of it. The key is derived from the password, so changing the
// password signs everyone out, and there is no secret to store. Web Crypto only, so the same code runs in
// the proxy and in route handlers.

export const SESSION_COOKIE = 'jellymeme-session'
export const SESSION_DAYS = 180

const encoder = new TextEncoder()

export function authPassword(): string | undefined {
  const password = process.env.AUTH_PASSWORD
  return password && password.length > 0 ? password : undefined
}

async function signingKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`jellymeme-session:${password}`))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export async function createSession(password: string, now = Date.now()): Promise<string> {
  const expires = String(now + SESSION_DAYS * 24 * 60 * 60 * 1000)
  const signature = await crypto.subtle.sign('HMAC', await signingKey(password), encoder.encode(expires))
  return `${expires}.${toHex(signature)}`
}

export async function isValidSession(cookie: string | undefined, password: string, now = Date.now()): Promise<boolean> {
  if (!cookie) return false
  const [expires, signature] = cookie.split('.')
  const bytes = signature ? fromHex(signature) : null
  if (!expires || !bytes || !/^\d+$/.test(expires) || Number(expires) < now) return false
  return crypto.subtle.verify('HMAC', await signingKey(password), bytes, encoder.encode(expires))
}

/** Compares two strings in time that does not depend on where they differ. */
export function samePassword(given: string, expected: string): boolean {
  const a = encoder.encode(given)
  const b = encoder.encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
