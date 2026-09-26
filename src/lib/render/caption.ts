import { writeFile } from 'node:fs/promises'
import { getDb } from '@/lib/db'
import { JellyfinClient } from '@/lib/jellyfin/client'
import { parseSubtitles, type Cue } from '@/lib/subtitles/parse'
import { applyLineEdits, buildAss, cuesToClipEvents } from './ass'
import type { ResolvedCaption } from '@/lib/montage/types'

/**
 * Caption building lives here rather than inside the render loop because the
 * editor's preview and the final export must produce byte-identical ASS. When
 * they were separate, the preview simply had no captions at all, and toggling
 * caption mode changed nothing the user could see.
 */

/**
 * The canvas libass composes against.
 *
 * The real frame height is not known until ffmpeg has scaled the source, so a
 * 16:9 canvas at the target width is assumed and libass scales its output to
 * whatever the frame turns out to be.
 */
export const assCanvas = (width: number): { width: number; height: number } => ({
  width,
  height: Math.round((width * 9) / 16),
})

/** Original subtitle cues for a video, fetched once per run and reused. */
export async function cuesForVideo(
  client: JellyfinClient,
  videoId: string,
  cache: Map<string, Cue[]>,
): Promise<Cue[]> {
  const cached = cache.get(videoId)
  if (cached) return cached

  const row = getDb()
    .prepare('SELECT media_source_id, subtitle_index FROM video WHERE id = ?')
    .get(videoId) as { media_source_id: string | null; subtitle_index: number | null } | undefined

  let cues: Cue[] = []
  if (row?.media_source_id && row.subtitle_index != null) {
    try {
      const srt = await client.subtitleSrt(videoId, {
        mediaSourceId: row.media_source_id,
        index: row.subtitle_index,
        language: null,
        displayTitle: null,
        isExternal: false,
        isForced: false,
        isDefault: true,
        isHearingImpaired: false,
        codec: null,
      })
      cues = parseSubtitles(srt)
    } catch {
      // Captions are a nice-to-have; a failed subtitle fetch must not fail the render.
      cues = []
    }
  }

  cache.set(videoId, cues)
  return cues
}

export interface CaptionRequest {
  caption: ResolvedCaption
  videoId: string
  startMs: number
  endMs: number
  /** Target output width; the ASS canvas is derived from it. */
  width: number
}

/**
 * Writes the ASS file for one clip, or returns undefined when the clip carries
 * no caption to burn.
 */
export async function writeCaptionFile(
  request: CaptionRequest,
  client: JellyfinClient,
  cueCache: Map<string, Cue[]>,
  outputPath: string,
): Promise<string | undefined> {
  const { caption, videoId, startMs, endMs, width } = request
  const canvas = assCanvas(width)

  switch (caption.mode) {
    case 'none':
      return undefined

    case 'subtitle': {
      const cues = await cuesForVideo(client, videoId, cueCache)
      const events = cuesToClipEvents(applyLineEdits(cues, caption.lines), startMs, endMs)
      // Emptiness is checked after the edits, not before: blanking every line in
      // a clip is a way of saying "no caption here", and writing a file with
      // nothing drawable in it would put libass in the filter chain for nothing.
      if (!events.some((event) => event.text.trim())) return undefined
      await writeFile(
        outputPath,
        buildAss(events, { ...canvas, style: 'subtitle', look: caption.look }),
        'utf8',
      )
      return outputPath
    }

    case 'custom': {
      const text = caption.text.trim()
      if (!text) return undefined
      await writeFile(
        outputPath,
        buildAss([{ startMs: 0, endMs: endMs - startMs, text }], {
          ...canvas,
          style: 'meme',
          look: caption.look,
        }),
        'utf8',
      )
      return outputPath
    }
  }
}
