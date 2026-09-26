import { JellyfinClient } from '@/lib/jellyfin/client'
import {
  clearJellyfinConnection,
  getConnectionInfo,
  saveJellyfinConnection,
} from '@/lib/jellyfin/server'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

export const GET = handler(async () => json(getConnectionInfo()))

export const POST = handler(async (request: Request) => {
  const { baseUrl, apiKey } = (await request.json()) as { baseUrl?: string; apiKey?: string }

  if (!baseUrl?.trim()) return fail('Enter your Jellyfin server URL')
  if (!apiKey?.trim()) return fail('Enter a Jellyfin API key')

  const url = baseUrl.trim()
  if (!/^https?:\/\//i.test(url)) {
    return fail('The server URL must start with http:// or https://')
  }

  // Verify before saving, so a bad key never gets persisted.
  const client = new JellyfinClient({ baseUrl: url, apiKey: apiKey.trim() })
  const info = await client.systemInfo()

  saveJellyfinConnection(url, apiKey.trim())
  return json({ connected: true, serverName: info.ServerName, version: info.Version })
})

export const DELETE = handler(async () => {
  clearJellyfinConnection()
  return json({ connected: false })
})
