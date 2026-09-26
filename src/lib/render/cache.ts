import { randomUUID } from 'node:crypto'
import { access, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from './ffmpeg'
import { EVICTABLE_DIRECTORIES } from './paths'

/**
 * Disk cache for rendered artefacts, shared by every editor surface that has to
 * ask ffmpeg for pixels.
 *
 * Four rules, and each one exists because leaving it out is visibly broken:
 *
 * - Deduplicate in flight. A montage opens ten clips at once and React will
 *   happily ask for the same bytes twice; without this each request starts its
 *   own encode.
 * - Write to a scratch name and rename into place. A build interrupted halfway
 *   would otherwise leave a truncated file that the cache then serves forever.
 * - Bound concurrency across all artefact kinds. Every build occupies a Jellyfin
 *   transcode session as well as a local encoder, so the gate has to be global
 *   rather than per-kind — two previews and two filmstrips at once is still four
 *   transcodes.
 * - Bound the total on disk. Nothing here was ever deleted, so it grew without
 *   limit: 94 previews had reached 497MB on a laptop by the time it was measured.
 */

/**
 * Deliberately small. Jellyfin is doing the expensive half of this work and it
 * is also serving whatever else the household is watching.
 */
const MAX_CONCURRENT = 2

let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  active++
  try {
    return await work()
  } finally {
    active--
    waiting.shift()?.()
  }
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/** Builds in flight, keyed by output path, so duplicate requests share one encode. */
const building = new Map<string, Promise<string>>()

/**
 * Marks a file that is still being written, so a sweep does not delete it and no
 * reader mistakes it for a finished artefact.
 *
 * One constant for both the naming and the skipping: a partial lives in the same
 * directory as the real files, so a sweep that did not know the prefix would
 * happily unlink an encode that was halfway through.
 */
const PARTIAL_PREFIX = 'partial-'

/** Roughly two gigabytes, which is a few hundred previews. */
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3

/**
 * The ceiling on rebuildable artefacts.
 *
 * Read per sweep rather than once at import so that setting it takes effect
 * regardless of when this module first happened to load.
 */
function maxBytes(): number {
  // An empty variable is an unset one; only a real number overrides the default,
  // or a machine that exported it blank would evict everything on every build.
  const configured = process.env.JELLYMEME_CACHE_MAX_BYTES?.trim()
  if (!configured) return DEFAULT_MAX_BYTES
  const bytes = Number(configured)
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : DEFAULT_MAX_BYTES
}

interface CachedFile {
  path: string
  size: number
  mtimeMs: number
}

async function cachedFilesIn(directory: string): Promise<CachedFile[]> {
  // A directory that does not exist yet holds nothing, which is not a failure.
  const names = await readdir(directory).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => !name.startsWith(PARTIAL_PREFIX))
      .map(async (name) => {
        const path = join(directory, name)
        const info = await stat(path).catch(() => null)
        return info?.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null
      }),
  )
  return found.filter((file): file is CachedFile => file !== null)
}

/**
 * Deletes the least recently written artefacts until the cache is under its cap.
 *
 * Oldest first because age is the best available proxy for what will not be asked
 * for again: the newest file is the clip currently on screen, and the oldest is
 * from a cut nobody has opened since. Everything here can be rebuilt, so the cost
 * of being wrong is one more encode rather than lost work.
 *
 * Files in `building` are skipped. A path is in there from before its encode starts
 * until just after it is renamed into place, so this covers the artefact whose own
 * build triggered the sweep — which would otherwise be a candidate for deletion
 * moments before its path is handed back to the caller.
 */
async function evictOldest(): Promise<void> {
  const files = (await Promise.all(EVICTABLE_DIRECTORIES.map(cachedFilesIn))).flat()
  const cap = maxBytes()
  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= cap) return

  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= cap) return
    if (building.has(file.path)) continue
    await unlink(file.path).then(
      () => {
        total -= file.size
      },
      // Another sweep got there first, which is the outcome this one wanted.
      () => {},
    )
  }
}

export interface ArtefactSpec {
  /** Directory the artefact lives in. Created if missing. */
  directory: string
  /** Content-addressed name, without extension. */
  key: string
  extension: 'mp4' | 'jpg'
}

/**
 * Path to a cached artefact, building it first if it is not on disk.
 *
 * `build` receives the scratch path to write to; it must not touch the final
 * path itself.
 */
export async function cachedArtefact(
  spec: ArtefactSpec,
  build: (outputPath: string) => Promise<void>,
): Promise<string> {
  await ensureDir(spec.directory)

  const outputPath = join(spec.directory, `${spec.key}.${spec.extension}`)
  if (await exists(outputPath)) return outputPath

  const inFlight = building.get(outputPath)
  if (inFlight) return inFlight

  const started = withSlot(async () => {
    const partial = join(spec.directory, `${PARTIAL_PREFIX}${randomUUID()}.${spec.extension}`)
    try {
      await build(partial)
      await rename(partial, outputPath)
      // After the rename, so the file just built counts against the cap and the
      // request that pushed the cache over the line is the one that trims it.
      // Never fatal: a full cache is not a reason to fail a render that succeeded.
      await evictOldest().catch(() => {})
      return outputPath
    } catch (error) {
      await unlink(partial).catch(() => {})
      throw error
    }
  }).finally(() => {
    building.delete(outputPath)
  })

  building.set(outputPath, started)
  return started
}
