'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client-api'
import type { Cue } from '@/lib/subtitles/parse'

/**
 * The dialogue inside a span of an episode, with its real cue boundaries.
 *
 * Shared by the trim strip, which snaps edges to where lines start and stop, and
 * by the caption editor, which lets those lines be rewritten. Both have to be
 * looking at the same cues the caption burner is, and this endpoint serves
 * exactly those.
 *
 * Failures are swallowed. Snapping and line editing are both enhancements over
 * controls that still work without them, so a subtitle fetch that times out
 * should not put a banner on a card whose footage is fine.
 */
export function useClipCues(videoId: string, startMs: number, endMs: number): Cue[] {
  const [cues, setCues] = useState<Cue[]>([])

  useEffect(() => {
    let live = true
    const params = new URLSearchParams({
      videoId,
      start: String(Math.round(startMs)),
      end: String(Math.round(endMs)),
    })
    api<{ cues: Cue[] }>(`/api/clip-cues?${params.toString()}`)
      .then((data) => {
        if (live) setCues(data.cues)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [videoId, startMs, endMs])

  return cues
}
