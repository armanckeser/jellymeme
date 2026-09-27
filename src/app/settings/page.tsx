'use client'

import { useEffect, useState } from 'react'
import { api, del, post } from '@/lib/client-api'
import { Banner, Button, Card, Field, Input, Spinner } from '@/components/ui'

interface Connection {
  baseUrl: string
  connected: boolean
}

export default function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [status, setStatus] = useState<{ tone: 'error' | 'success'; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Connection>('/api/connection')
      .then((c) => {
        setConnection(c)
        setBaseUrl(c.baseUrl)
      })
      .catch(() => setConnection({ baseUrl: '', connected: false }))
  }, [])

  async function connect(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      const result = await post<{ serverName: string; version: string }>('/api/connection', {
        baseUrl,
        apiKey,
      })
      setStatus({
        tone: 'success',
        message: `Connected to ${result.serverName} (Jellyfin ${result.version}).`,
      })
      setConnection({ baseUrl, connected: true })
      setApiKey('')
    } catch (error) {
      setStatus({ tone: 'error', message: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    await del('/api/connection')
    setConnection({ baseUrl: '', connected: false })
    setBaseUrl('')
    setStatus(null)
  }

  if (!connection) return <Spinner label="Loading settings…" />

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Jellyfin connection</h1>
        <p className="mt-1 text-sm text-muted">API access only. No media files needed.</p>
      </div>

      {connection.connected && (
        <Banner tone="success">
          Connected to <span className="font-medium">{connection.baseUrl}</span>
        </Banner>
      )}

      <Card className="p-5">
        <form onSubmit={connect} className="space-y-4">
          <Field label="Server URL" hint="For example http://192.168.1.10:8096">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://jellyfin.local:8096"
              autoComplete="url"
              spellCheck={false}
            />
          </Field>

          <Field
            label="API key"
            hint="Jellyfin → Dashboard → API Keys. Kept on the server."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={connection.connected ? 'Saved. Paste a new key to replace it' : ''}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {status && <Banner tone={status.tone}>{status.message}</Banner>}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Checking…' : connection.connected ? 'Update connection' : 'Connect'}
            </Button>
            {connection.connected && (
              <Button type="button" variant="danger" onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  )
}
