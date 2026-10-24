import { describe, expect, it } from 'vitest'
import { SESSION_DAYS, createSession, isValidSession, samePassword } from './session'

const DAY = 24 * 60 * 60 * 1000

describe('session cookie', () => {
  it('accepts a cookie it signed with the same password', async () => {
    const cookie = await createSession('hunter2', 1_000)
    expect(await isValidSession(cookie, 'hunter2', 2_000)).toBe(true)
  })

  it('rejects it once the password changes', async () => {
    const cookie = await createSession('hunter2', 1_000)
    expect(await isValidSession(cookie, 'another', 2_000)).toBe(false)
  })

  it('rejects it after it expires', async () => {
    const cookie = await createSession('hunter2', 0)
    expect(await isValidSession(cookie, 'hunter2', SESSION_DAYS * DAY + 1)).toBe(false)
  })

  it('rejects an expiry moved later by hand', async () => {
    const [, signature] = (await createSession('hunter2', 0)).split('.')
    expect(await isValidSession(`${400 * DAY}.${signature}`, 'hunter2', 200 * DAY)).toBe(false)
  })

  it('rejects missing and malformed cookies', async () => {
    expect(await isValidSession(undefined, 'hunter2')).toBe(false)
    expect(await isValidSession('', 'hunter2')).toBe(false)
    expect(await isValidSession('abc.def', 'hunter2')).toBe(false)
    expect(await isValidSession('123', 'hunter2')).toBe(false)
  })
})

describe('samePassword', () => {
  it('matches only the exact password', () => {
    expect(samePassword('hunter2', 'hunter2')).toBe(true)
    expect(samePassword('hunter', 'hunter2')).toBe(false)
    expect(samePassword('hunter3', 'hunter2')).toBe(false)
    expect(samePassword('', 'hunter2')).toBe(false)
  })
})
