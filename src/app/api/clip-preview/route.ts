import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { readIndexedVideo } from '@/lib/queries'
import { buildClipPreview } from '@/lib/render/preview'
import {
  DEFAULT_LOOK,
  MIN_CLIP_MS,
  clampCaptionSize,
  type CaptionMode,
  type CaptionPlacement,
  type SubtitleEdits,
} from '@/lib/montage/types'
import { fail, handler, serveFile } from '@/lib/api'

export const runtime = 'nodejs'

/** A preview is a working artefact, not an export; cap what one can cost. */
const MAX_PREVIEW_MS = 60_000
const MAX_CAPTION_CHARS = 300

/**
 * A clip holds a handful of subtitle lines, so the whole edit set fits in a
 * query string comfortably. The cap is only here because the string arrives
 * from outside and something has to bound it.
 */
const MAX_LINE_EDITS_CHARS = 8_000

const CAPTION_MODES = new Set<string>(['none', 'subtitle', 'custom'])
const CAPTION_PLACEMENTS = new Set<string>(['auto', 'top', 'bottom'])

/**
 * The per-line subtitle rewrites, as the editor sends them: a JSON object of cue
 * start time to replacement text.
 *
 * Returns null for anything that is not that, so a malformed parameter is a
 * clear 400 rather than a preview that silently ignores the user's edits and
 * disagrees with the export.
 */
function readLineEdits(raw: string): SubtitleEdits | null {
  if (!raw) return {}
  if (raw.length > MAX_LINE_EDITS_CHARS) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const edits: SubtitleEdits = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') return null
    edits[key] = value.slice(0, MAX_CAPTION_CHARS)
  }
  return edits
}

/**
 * A rendered preview of a single clip: trimmed to its exact bounds with its
 * caption burned in, so the editor can show what the export will contain.
 */
export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams

  const videoId = params.get('videoId')
  const startMs = Number(params.get('start'))
  const endMs = Number(params.get('end'))
  const mode = params.get('mode') ?? 'none'
  const text = (params.get('text') ?? '').slice(0, MAX_CAPTION_CHARS)
  const placement = params.get('place') ?? DEFAULT_LOOK.placement
  const size = params.has('size') ? Number(params.get('size')) : DEFAULT_LOOK.size
  const lines = readLineEdits(params.get('lines') ?? '')

  if (!videoId) return fail('videoId is required')
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return fail('start and end must be numbers in milliseconds')
  }
  if (endMs - startMs < MIN_CLIP_MS) return fail('That clip is too short to preview')
  if (endMs - startMs > MAX_PREVIEW_MS) return fail('That clip is too long to preview')
  if (!CAPTION_MODES.has(mode)) return fail(`Unknown caption mode: ${mode}`)
  if (!CAPTION_PLACEMENTS.has(placement)) return fail(`Unknown caption placement: ${placement}`)
  if (!lines) return fail('Could not read the caption line edits')

  if (!readIndexedVideo(videoId)) return fail('That video has not been indexed', 404)

  const path = await buildClipPreview(
    {
      videoId,
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.round(endMs),
      caption: {
        mode: mode as CaptionMode,
        text,
        look: { size: clampCaptionSize(size), placement: placement as CaptionPlacement },
        lines,
      },
    },
    requireJellyfinClient(),
  )

  return serveFile(request, path, {
    contentType: 'video/mp4',
    filename: 'clip-preview.mp4',
    disposition: 'inline',
    // The query string fixes the pixels, so the browser may reuse this freely.
    // Not immutable: re-indexing a title can change its subtitle timings.
    cacheControl: 'private, max-age=86400',
  })
})
