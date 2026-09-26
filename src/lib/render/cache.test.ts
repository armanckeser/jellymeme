import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Guards a disk leak. Nothing in the artefact cache was ever deleted, so it grew
 * without bound — 94 previews had reached 497MB before anyone looked. What makes
 * this delicate is not the pruning but what must survive it: finished exports the
 * user downloads, encodes that are still being written, and the file whose own
 * build triggered the sweep.
 *
 * No ffmpeg here. The cache does not care what wrote the bytes, so a build that
 * writes a buffer exercises the same code an encode does, and runs ungated.
 */

/** Every cached file is this big, so a cap can be stated in whole files. */
const FILE_BYTES = 1000
const CONTENT = 'x'.repeat(FILE_BYTES)

describe('the artefact cache staying under its cap', () => {
  let renderDir: string
  let cache: typeof import('./cache')
  let paths: typeof import('./paths')

  beforeAll(async () => {
    renderDir = await mkdtemp(join(tmpdir(), 'jellymeme-cache-'))
    // Before the import: the directory layout is read once, when paths.ts loads.
    process.env.JELLYMEME_RENDERS = renderDir
    paths = await import('./paths')
    cache = await import('./cache')
  })

  afterAll(async () => {
    delete process.env.JELLYMEME_CACHE_MAX_BYTES
    await rm(renderDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // The root goes first: the cache directories are inside it, so clearing it
    // afterwards would take the fresh ones with it.
    await rm(paths.RENDER_DIR, { recursive: true, force: true })
    await mkdir(paths.PREVIEW_DIR, { recursive: true })
    await mkdir(paths.FILMSTRIP_DIR, { recursive: true })
    delete process.env.JELLYMEME_CACHE_MAX_BYTES
  })

  /** A cached artefact whose bytes came from nowhere in particular. */
  const build = (directory: string, key: string) =>
    cache.cachedArtefact({ directory, key, extension: 'mp4' }, (outputPath) =>
      writeFile(outputPath, CONTENT, 'utf8'),
    )

  /**
   * Writes a file directly, with an explicit age.
   *
   * Ages are set rather than taken from the clock because several files written in
   * one test can land in the same millisecond, and then "oldest first" has nothing
   * to order by.
   */
  async function place(directory: string, name: string, secondsOld: number): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, CONTENT, 'utf8')
    const when = new Date(Date.now() - secondsOld * 1000)
    await utimes(path, when, when)
    return path
  }

  const names = async (directory: string): Promise<string[]> =>
    (await readdir(directory)).sort()

  it('drops the oldest artefacts, across every cache directory, until it fits', async () => {
    // Oldest to newest: the filmstrip, then the two previews.
    await place(paths.FILMSTRIP_DIR, 'oldest.jpg', 300)
    await place(paths.PREVIEW_DIR, 'middle.mp4', 200)
    await place(paths.PREVIEW_DIR, 'newest.mp4', 100)
    // Four files will exist once the build below lands; room for two.
    process.env.JELLYMEME_CACHE_MAX_BYTES = String(FILE_BYTES * 2 + 500)

    await build(paths.PREVIEW_DIR, 'fresh')

    expect(await names(paths.FILMSTRIP_DIR)).toEqual([])
    expect(await names(paths.PREVIEW_DIR)).toEqual(['fresh.mp4', 'newest.mp4'])
  })

  /*
   * The point of the whole feature is that the editor keeps working. Evicting the
   * file the request was for would hand the caller a path to nothing.
   */
  it('keeps the artefact whose own build ran the sweep, even with no room for it', async () => {
    await place(paths.PREVIEW_DIR, 'older.mp4', 100)
    process.env.JELLYMEME_CACHE_MAX_BYTES = '0'

    const built = await build(paths.PREVIEW_DIR, 'fresh')

    expect(built).toBe(join(paths.PREVIEW_DIR, 'fresh.mp4'))
    expect(await names(paths.PREVIEW_DIR)).toEqual(['fresh.mp4'])
  })

  /*
   * Finished exports live in the root of the same tree. They are what
   * `render.file_path` points at and what the user downloads, so pruning one turns
   * a completed render into a broken download link.
   */
  it('never deletes a finished export, however old it is', async () => {
    await place(paths.RENDER_DIR, 'a-finished-export.mp4', 9999)
    await place(paths.PREVIEW_DIR, 'older.mp4', 100)
    process.env.JELLYMEME_CACHE_MAX_BYTES = '0'

    await build(paths.PREVIEW_DIR, 'fresh')

    expect(await names(paths.RENDER_DIR)).toContain('a-finished-export.mp4')
  })

  /*
   * A partial sits in the same directory as the real files, under a scratch name,
   * while ffmpeg is still writing it. Unlinking one destroys an encode in flight —
   * and the encode would then rename its way to a file that is already gone.
   */
  it('leaves an encode that is still being written alone', async () => {
    await place(paths.PREVIEW_DIR, 'partial-11111111-2222.mp4', 500)
    process.env.JELLYMEME_CACHE_MAX_BYTES = '0'

    await build(paths.PREVIEW_DIR, 'fresh')

    expect(await names(paths.PREVIEW_DIR)).toContain('partial-11111111-2222.mp4')
  })

  it('deletes nothing while the cache is under its cap', async () => {
    await place(paths.PREVIEW_DIR, 'older.mp4', 100)
    process.env.JELLYMEME_CACHE_MAX_BYTES = String(FILE_BYTES * 10)

    await build(paths.PREVIEW_DIR, 'fresh')

    expect(await names(paths.PREVIEW_DIR)).toEqual(['fresh.mp4', 'older.mp4'])
  })

  /*
   * A blank variable is an unset one. Read as a number it is zero, which would make
   * a machine that exported it empty throw away every artefact on every build.
   */
  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['not a number', 'lots'],
    ['negative', '-1'],
  ])('falls back to the built-in cap when the limit is %s', async (_case, configured) => {
    await place(paths.PREVIEW_DIR, 'older.mp4', 100)
    if (configured === undefined) delete process.env.JELLYMEME_CACHE_MAX_BYTES
    else process.env.JELLYMEME_CACHE_MAX_BYTES = configured

    await build(paths.PREVIEW_DIR, 'fresh')

    expect(await names(paths.PREVIEW_DIR)).toEqual(['fresh.mp4', 'older.mp4'])
  })
})
