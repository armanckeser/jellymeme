import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const run = promisify(execFile)

/**
 * Which ffmpeg to run.
 *
 * The override exists because the bundled binary is not always usable.
 * `ffmpeg-static` ships a *statically linked* glibc build, and a static glibc
 * cannot dlopen the NSS modules `getaddrinfo` needs — so every hostname lookup
 * segfaults before a single line reaches stderr. Measured in the Docker image:
 * `-i http://host.docker.internal:8096/...` dies on SIGSEGV, the same URL with
 * a literal IP encodes normally, and even `localhost` crashes it. Every render
 * surface reads its input from Jellyfin over HTTP, so a Jellyfin URL written as
 * a hostname takes out previews, filmstrips and exports together while indexing
 * — which goes through Node's own resolver — keeps working.
 *
 * The image therefore installs a dynamically linked ffmpeg and points this at
 * it. Elsewhere (macOS, Windows, a non-glibc build) the bundled binary is fine
 * and stays the default.
 */
export const FFMPEG =
  process.env.JELLYMEME_FFMPEG?.trim() || (ffmpegPath as unknown as string) || 'ffmpeg'

/** ffmpeg writes progress to stderr; a long montage can produce a lot of it. */
const MAX_BUFFER = 1024 * 1024 * 32

export class RenderError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * Strips the Jellyfin API key out of text on its way to a user or a log.
 *
 * ffmpeg echoes the input URL when it fails, and that URL carries the key as a
 * query parameter, so an unredacted stderr tail puts a live credential on
 * screen. Applied before any stderr is read, not at each display site, because
 * the display sites are the places that will be forgotten.
 */
function redactCredentials(text: string): string {
  return text.replace(/((?:api_key|apikey|api-key|X-Emby-Token)=)[^&\s"']+/gi, '$1REDACTED')
}

/**
 * Rewrites the common ffmpeg failures into something a user can act on.
 *
 * Raw ffmpeg stderr is full of memory addresses and internal muxer names; the
 * cases that actually happen in this app have a specific, fixable cause.
 */
function explain(stderr: string): string | null {
  if (/401 Unauthorized/i.test(stderr)) {
    return 'Jellyfin rejected the request while reading the video (401). The API key may have been revoked.'
  }
  if (/Operation timed out|Connection timed out|timed out/i.test(stderr)) {
    return 'Jellyfin took too long to start streaming that clip. It is probably busy transcoding — try again.'
  }
  if (/40[34] (Not Found|Forbidden)/i.test(stderr)) {
    return 'Jellyfin could not serve the video file (404). The item may have been removed or moved since it was indexed.'
  }
  if (/Connection refused|Failed to resolve hostname|Network is unreachable/i.test(stderr)) {
    return 'Could not reach Jellyfin while reading the video. Check that the server is running.'
  }
  if (/No such file or directory/i.test(stderr)) {
    return 'A temporary render file went missing. Try exporting again.'
  }
  if (/Fontconfig|Cannot load font|no usable font/i.test(stderr)) {
    return 'No usable font was found for burning captions. Install a font package (for example fonts-dejavu) or set JELLYMEME_CAPTION_FONT.'
  }
  return null
}

/**
 * Explains an ffmpeg that died on a signal rather than exiting.
 *
 * A crash produces no diagnosis of its own — it is killed mid-instruction, so
 * there is nothing on stderr to read and every message below has to be inferred
 * from the signal alone.
 *
 * SIGSEGV is called out by name because it has one cause here in practice: see
 * FFMPEG above for why a statically linked ffmpeg segfaults on any hostname.
 * Without this the failure is genuinely invisible — an empty error in the
 * browser, nothing in the container log, and a healthy binary that runs
 * `-version` happily.
 */
function crashed(signal: string | null | undefined): string | null {
  if (!signal) return null
  if (signal === 'SIGSEGV') {
    return (
      'ffmpeg crashed (SIGSEGV) without reading anything. ' +
      'A statically linked ffmpeg cannot resolve hostnames and dies this way on any name, ' +
      'including localhost. Point JELLYMEME_FFMPEG at a system ffmpeg, ' +
      'or set the Jellyfin URL to a literal IP address.'
    )
  }
  return `ffmpeg was killed by ${signal} before it finished.`
}

export async function ffmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await run(FFMPEG, ['-nostdin', '-hide_banner', '-y', ...args], {
      maxBuffer: MAX_BUFFER,
    })
    return stderr
  } catch (error) {
    const err = error as { stderr?: string; message: string; signal?: string | null }
    // Redacted first so no later path can leak the key: the message, the tail
    // and the retained stderr all derive from this.
    const stderr = redactCredentials(err.stderr ?? '')
    throw new RenderError(
      renderErrorMessage(stderr, err.signal, redactCredentials(err.message)),
      stderr,
    )
  }
}

/**
 * Picks the most useful description of a failed ffmpeg run.
 *
 * Joined with `||` rather than `??`, which is the whole reason this is a named
 * function with tests. Each candidate here is a *string* that is routinely
 * empty, and `??` only falls through on null or undefined — so the previous
 * `explain(stderr) ?? tail ?? message` stopped at `tail` whenever stderr was
 * empty, because `''.split('\n').filter(...).join('\n')` is `''`, not nullish.
 * Every crash therefore surfaced as `{"error":""}`: a 500 with no message in
 * the UI, no stack, and nothing written to the log.
 */
export function renderErrorMessage(
  stderr: string,
  signal: string | null | undefined,
  message: string,
): string {
  // ffmpeg's own diagnosis is on the last few stderr lines; the rest is banner noise.
  const tail = stderr
    .split('\n')
    .filter((l) => l.trim())
    .slice(-6)
    .join('\n')

  return (
    explain(stderr) ||
    crashed(signal) ||
    tail ||
    message ||
    'ffmpeg failed without reporting a reason.'
  )
}

/**
 * Quotes a path for use as a filter argument, e.g. `subtitles=<this>`.
 *
 * ffmpeg unescapes a filter argument twice: once when it splits the graph and
 * again when it splits the filter's options. Single quotes carry the path
 * through the first pass verbatim (commas and all), leaving `\:` for the second
 * pass to turn back into a literal colon. An unquoted `\:` was consumed by the
 * first pass, so a Windows drive letter reached the option parser as a
 * separator. A quote in the path closes the quoting, adds an escaped quote at
 * both levels, and reopens.
 */
export function escapeFilterPath(path: string): string {
  const escaped = path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''")
  return `'${escaped}'`
}

/** How the segment's start point is reached in its source. */
export type SegmentSeek =
  /** Byte-seekable source: ffmpeg jumps to the timestamp with range requests. */
  | 'range'
  /** The server already positioned the stream at the start; read from the top. */
  | 'positioned'

export interface SegmentSpec {
  /** Source URL (a Jellyfin stream) or local path. */
  input: string
  seek: SegmentSeek
  startMs: number
  endMs: number
  /** Path to an ASS file to burn in, if any. */
  assPath?: string
  /** Replace this clip's audio with silence. */
  silent: boolean
}

export interface EncodeOptions {
  maxWidth: number
  fps: number
  /** Produce video-only segments. All segments in a run must agree. */
  stripAudio: boolean
}

/**
 * Builds the video filter chain for one segment.
 *
 * Every segment is normalised to the same width, frame rate, pixel format and
 * sample aspect ratio. That uniformity is what lets the concat demuxer stitch
 * the results with a stream copy instead of a second full re-encode.
 */
function videoFilter(options: EncodeOptions, assPath?: string): string {
  const filters = [
    // Downscale only — never upscale a source that is already smaller.
    `scale=min(iw\\,${options.maxWidth}):-2:flags=bicubic`,
    'setsar=1',
    `fps=${options.fps}`,
  ]
  if (assPath) filters.push(`subtitles=${escapeFilterPath(assPath)}`)
  filters.push('format=yuv420p')
  return filters.join(',')
}

/** Encodes one normalised segment. */
export async function encodeSegment(
  spec: SegmentSpec,
  options: EncodeOptions,
  outputPath: string,
): Promise<void> {
  const durationSec = (spec.endMs - spec.startMs) / 1000
  const args: string[] = []

  if (spec.seek === 'range') {
    // -ss before -i makes ffmpeg seek with HTTP range requests rather than
    // decoding from the start of the file. Seeking resets output timestamps to
    // zero, so the duration can bound the input read.
    args.push('-ss', (spec.startMs / 1000).toFixed(3))
    args.push('-t', durationSec.toFixed(3))
  }

  args.push('-i', spec.input)

  const needsSilentTrack = !options.stripAudio && spec.silent
  if (needsSilentTrack) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  }

  if (spec.seek === 'positioned') {
    // A server-positioned transcode carries the source's own timestamps, which
    // do not start at zero, so an input-side -t overshoots badly (a 12s request
    // measured 20.2s). Bounding the output instead is exact.
    args.push('-t', durationSec.toFixed(3))
  }

  args.push('-vf', videoFilter(options, spec.assPath))
  args.push('-map', '0:v:0')

  if (options.stripAudio) {
    args.push('-an')
  } else if (needsSilentTrack) {
    args.push('-map', '1:a:0')
  } else {
    // A source with no audio track still has to yield one, or concat sees
    // mismatched stream layouts.
    args.push('-map', '0:a:0?')
  }

  /*
   * No -force_key_frames. concatSegments stream-copies, so each segment has to
   * begin on a keyframe — and x264 opens every stream with one regardless, so
   * asking costs an argument and buys nothing. Measured both ways, in both the
   * range and positioned paths: byte-identical output, keyframe at frame 0.
   *
   * This used to say `expr:gte(t,0)`, which reads as "one keyframe at the start"
   * and means "a keyframe wherever t >= 0", i.e. everywhere. x264 duly emitted an
   * all-intra stream: 143 of 143 frames on a 6s 480p segment, 695KB against 166KB.
   * Four times the bytes and the encode time, on the previews the editor rebuilds
   * as you drag as well as on what the user downloads.
   *
   * Sparse keyframes are safe for the other reader of the joined file too. toStill
   * seeks input-side, which decodes forward to the requested timestamp instead of
   * snapping to the keyframe before it — verified frame-exact at five points across
   * a two-segment cut holding two keyframes in 286 frames.
   */
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')

  if (!options.stripAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2')
    // Guarantees an audio stream exists even when the source segment is silent.
    args.push('-shortest')
  }

  args.push('-movflags', '+faststart')
  args.push(outputPath)

  await ffmpeg(args)
}

export interface FilmstripSpec {
  /** A stream the server has already positioned at the strip's first moment. */
  input: string
  durationMs: number
  tiles: number
  tileWidth: number
  tileHeight: number
}

/**
 * Samples a span of video into one wide sprite of evenly spaced thumbnails.
 *
 * A single ffmpeg run and a single file, rather than one request per thumbnail:
 * the cost here is almost entirely Jellyfin starting a transcode, so asking it
 * for forty separate frames costs forty times as much as asking for one strip.
 *
 * Every tile is letterboxed to the same box instead of being scaled to fit.
 * Scope films are not 16:9, and a strip whose tiles change shape halfway
 * through cannot be indexed by position.
 */
export async function encodeFilmstrip(spec: FilmstripSpec, outputPath: string): Promise<void> {
  const durationSec = spec.durationMs / 1000
  const { tileWidth: w, tileHeight: h } = spec

  const filter = [
    // A rational rather than a decimal, so the sample instants land exactly on
    // the boundaries the editor computes for each tile.
    `fps=${spec.tiles}/${durationSec.toFixed(3)}`,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:-1:-1:color=black`,
    `tile=${spec.tiles}x1`,
  ].join(',')

  await ffmpeg([
    '-i',
    spec.input,
    // Output-side, like every other read of a positioned stream. See encodeSegment.
    '-t',
    durationSec.toFixed(3),
    '-an',
    '-vf',
    filter,
    // tile emits the grid once it is full, and flushes a partly filled one at
    // EOF; either way the strip is the first frame out.
    '-frames:v',
    '1',
    '-q:v',
    '4',
    outputPath,
  ])
}

/** Stitches normalised segments without re-encoding. */
export async function concatSegments(
  segmentPaths: string[],
  outputPath: string,
  workDir: string,
): Promise<void> {
  if (segmentPaths.length === 0) throw new RenderError('Nothing to render: the montage has no clips')

  if (segmentPaths.length === 1) {
    await ffmpeg(['-i', segmentPaths[0], '-c', 'copy', '-movflags', '+faststart', outputPath])
    return
  }

  const listPath = join(workDir, 'concat.txt')
  // The concat demuxer takes single-quoted paths, escaping embedded quotes.
  const list = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listPath, list + '\n', 'utf8')

  await ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outputPath,
  ])
}

/**
 * Converts the assembled video to an animated GIF.
 *
 * A GIF is limited to 256 colours, so a per-clip palette is generated first
 * (`stats_mode=diff` weights colours by what actually changes between frames)
 * and then applied. Without this step video-sourced GIFs band badly.
 */
export async function toGif(
  inputPath: string,
  outputPath: string,
  options: { fps: number; maxWidth: number },
): Promise<void> {
  const filter =
    `fps=${options.fps},scale=min(iw\\,${options.maxWidth}):-1:flags=lanczos,` +
    `split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`

  await ffmpeg(['-i', inputPath, '-filter_complex', filter, '-loop', '0', outputPath])
}

/**
 * Extracts a single frame as a still image.
 *
 * Seeking is done on the already-assembled cut, so any burned caption is baked
 * into the frame exactly as it appears in the video — the still and the GIF of
 * the same moment look identical.
 */
export async function toStill(
  inputPath: string,
  outputPath: string,
  options: { frameMs: number; maxWidth: number; jpeg: boolean },
): Promise<void> {
  const args = [
    '-ss',
    (options.frameMs / 1000).toFixed(3),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=min(iw\\,${options.maxWidth}):-2:flags=lanczos`,
  ]
  // -q:v on mjpeg runs 2 (best) to 31; 2 keeps text edges crisp.
  if (options.jpeg) args.push('-q:v', '2')
  args.push(outputPath)

  await ffmpeg(args)
}

/** Re-encodes the assembled video to VP9/Opus WebM. */
export async function toWebm(inputPath: string, outputPath: string, stripAudio: boolean) {
  const args = ['-i', inputPath, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1']
  if (stripAudio) args.push('-an')
  else args.push('-c:a', 'libopus', '-b:a', '128k')
  args.push(outputPath)
  await ffmpeg(args)
}

export async function makeWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jellymeme-'))
}

export async function cleanUp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size
}
