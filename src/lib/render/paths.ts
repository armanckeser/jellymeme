import { join } from 'node:path'

/**
 * Where everything ffmpeg writes ends up.
 *
 * One definition because four modules put files under here and, more importantly,
 * because the cache has to know which of these directories it is allowed to delete
 * from. That distinction was previously implicit in three separate copies of the
 * same `join` call.
 */
export const RENDER_DIR = process.env.JELLYMEME_RENDERS ?? join(process.cwd(), 'renders')

/** Rendered previews of a single clip, as the editor shows them. */
export const PREVIEW_DIR = join(RENDER_DIR, 'previews')

/** Thumbnail sprites behind the trim timeline. */
export const FILMSTRIP_DIR = join(RENDER_DIR, 'filmstrips')

/**
 * The directories the cache may prune, which is every directory whose contents can
 * be rebuilt from a request.
 *
 * `RENDER_DIR` itself is deliberately absent. Its files are the finished exports:
 * they are what `render.file_path` points at and what the user downloads, so
 * deleting one to save space turns a completed render into a broken link.
 */
export const EVICTABLE_DIRECTORIES = [PREVIEW_DIR, FILMSTRIP_DIR]
