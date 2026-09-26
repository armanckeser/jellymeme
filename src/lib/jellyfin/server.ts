import { getConfig, setConfig, deleteConfig } from '@/lib/db'
import { JellyfinClient } from './client'

const URL_KEY = 'jellyfin.url'
const KEY_KEY = 'jellyfin.apiKey'

/**
 * The stored Jellyfin connection, or null if the user has not connected yet.
 *
 * Credentials live in the local SQLite file rather than environment variables
 * so the app can be configured from its own UI without a restart.
 */
export function getJellyfinClient(): JellyfinClient | null {
  const baseUrl = getConfig(URL_KEY) ?? process.env.JELLYFIN_URL ?? null
  const apiKey = getConfig(KEY_KEY) ?? process.env.JELLYFIN_API_KEY ?? null
  if (!baseUrl || !apiKey) return null
  return new JellyfinClient({ baseUrl, apiKey })
}

export function saveJellyfinConnection(baseUrl: string, apiKey: string): void {
  setConfig(URL_KEY, baseUrl.replace(/\/+$/, ''))
  setConfig(KEY_KEY, apiKey)
}

export function clearJellyfinConnection(): void {
  deleteConfig(URL_KEY)
  deleteConfig(KEY_KEY)
}

export function getConnectionInfo(): { baseUrl: string; connected: boolean } {
  const baseUrl = getConfig(URL_KEY) ?? process.env.JELLYFIN_URL ?? ''
  return { baseUrl, connected: Boolean(getJellyfinClient()) }
}

/** Throws a message suitable for returning straight to the client. */
export function requireJellyfinClient(): JellyfinClient {
  const client = getJellyfinClient()
  if (!client) throw new Error('Not connected to Jellyfin. Add your server URL and API key first.')
  return client
}
