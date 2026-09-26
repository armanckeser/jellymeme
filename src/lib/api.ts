import { NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

export const json = <T>(data: T, init?: ResponseInit) => NextResponse.json(data, init)

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

/** Turns a thrown value into a JSON error response with a useful message. */
export function failFrom(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json({ error: message }, { status })
}

export interface FileResponse {
  contentType: string
  filename: string
  disposition: 'inline' | 'attachment'
  /** A Cache-Control value. Use immutable only when the URL fixes the bytes. */
  cacheControl: string
}

/**
 * Streams a file to the client, honouring range requests.
 *
 * Range support is not optional here: a `<video>` element cannot seek within a
 * response that arrives as one opaque body, so without it every scrub restarts
 * the download from the beginning.
 */
export async function serveFile(
  request: Request,
  path: string,
  options: FileResponse,
): Promise<Response> {
  const size = (await stat(path)).size
  const headers: Record<string, string> = {
    'Content-Type': options.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    'Content-Disposition': `${options.disposition}; filename="${options.filename}"`,
  }

  const range = request.headers.get('range')
  const requested = range && /bytes=(\d*)-(\d*)/.exec(range)

  if (!requested) {
    const whole = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(whole, { headers: { ...headers, 'Content-Length': String(size) } })
  }

  const start = requested[1] ? Number(requested[1]) : 0
  const end = requested[2] ? Math.min(Number(requested[2]), size - 1) : size - 1

  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }

  const part = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
  return new Response(part, {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  })
}

/** Wraps a route handler so an unexpected throw becomes JSON rather than an HTML error page. */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch (error) {
      return failFrom(error)
    }
  }
}
