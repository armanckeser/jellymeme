import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  FFMPEG,
  ffmpeg,
  RenderError,
  encodeSegment,
  concatSegments,
  toGif,
  toStill,
  escapeFilterPath,
  makeWorkDir,
  cleanUp,
} from './ffmpeg'
import { buildAss, cuesToClipEvents } from './ass'

const run = promisify(execFile)

/**
 * Exercises the real ffmpeg pipeline against a media file served over HTTP with
 * range support — the same shape as Jellyfin's static stream endpoint.
 *
 * Opt-in because it encodes video: `RUN_FFMPEG_TESTS=1 npm test`.
 */
const enabled = process.env.RUN_FFMPEG_TESTS === '1'
const maybe = enabled ? describe : describe.skip

async function probeDuration(path: string): Promise<number> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', path], { maxBuffer: 1 << 24 }).catch(
    (e) => e as { stderr: string },
  )
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr)
  if (!m) throw new Error('no duration in ffmpeg output')
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

async function probeStreams(path: string): Promise<string> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', path], { maxBuffer: 1 << 24 }).catch(
    (e) => e as { stderr: string },
  )
  return stderr
}

/**
 * How many frames a file has, and how many of them are keyframes.
 *
 * Counted from ffmpeg's own progress output rather than with ffprobe, which is not
 * part of the ffmpeg-static package this app ships. Decoding to the null muxer
 * twice reads the file but writes nothing; `select` on picture type makes the
 * second pass emit only keyframes, so its frame count is the keyframe count.
 */
async function probeFrameCounts(path: string): Promise<{ frames: number; keyFrames: number }> {
  const count = async (filter: string[]): Promise<number> => {
    const { stderr } = await run(
      FFMPEG,
      ['-nostdin', '-hide_banner', '-i', path, '-map', '0:v:0', ...filter, '-f', 'null', '-'],
      { maxBuffer: 1 << 24 },
    )
    const reported = [...stderr.matchAll(/frame=\s*(\d+)/g)]
    if (reported.length === 0) throw new Error(`no frame count in ffmpeg output for ${path}`)
    return Number(reported[reported.length - 1][1])
  }

  return {
    frames: await count([]),
    keyFrames: await count(['-vf', "select='eq(pict_type\\,I)'", '-vsync', '0']),
  }
}

maybe('render pipeline (real ffmpeg)', () => {
  let server: Server
  let baseUrl: string
  let workDir: string
  let sourcePath: string
  const rangeRequests: string[] = []

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'jellymeme-test-'))
    sourcePath = join(workDir, 'source.mkv')

    // A 120-second colour-bars clip with a tone, so seeks land somewhere real.
    await run(FFMPEG, [
      '-nostdin', '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=120',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'aac', '-shortest', sourcePath,
    ], { maxBuffer: 1 << 24 })

    const size = statSync(sourcePath).size
    server = createServer((req, res) => {
      const range = req.headers.range
      if (range) rangeRequests.push(range)
      const m = range && /bytes=(\d+)-(\d*)/.exec(range)
      const start = m ? Number(m[1]) : 0
      const end = m && m[2] ? Number(m[2]) : size - 1
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'video/x-matroska',
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      })
      const stream = createReadStream(sourcePath, { start, end })
      stream.pipe(res)
      res.on('close', () => stream.destroy())
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address === 'string' || !address) throw new Error('no address')
    baseUrl = `http://127.0.0.1:${address.port}/source.mkv`
  }, 120_000)

  afterAll(async () => {
    server?.close()
    await rm(workDir, { recursive: true, force: true })
  })

  it('encodes a segment by seeking into a remote file with range requests', async () => {
    const out = join(workDir, 'seg.mp4')
    await encodeSegment(
      { input: baseUrl, seek: 'range', startMs: 90_000, endMs: 94_000, silent: false },
      { maxWidth: 480, fps: 24, stripAudio: false },
      out,
    )
    expect(await probeDuration(out)).toBeCloseTo(4, 0)
    // A deep seek must not have been served by streaming from byte zero.
    expect(rangeRequests.some((r) => /bytes=[1-9]\d{5,}-/.test(r))).toBe(true)
  }, 120_000)

  it('downscales without upscaling and normalises to the target fps', async () => {
    const out = join(workDir, 'scaled.mp4')
    // Source is 640 wide; asking for 1920 must leave it at 640.
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 1000, endMs: 3000, silent: false },
      { maxWidth: 1920, fps: 12, stripAudio: false },
      out,
    )
    const info = await probeStreams(out)
    expect(info).toMatch(/640x360/)
    expect(info).toMatch(/12 fps/)
  }, 120_000)

  it('burns captions from an ASS file', async () => {
    const assPath = join(workDir, 'cap.ass')
    await writeFile(
      assPath,
      buildAss([{ startMs: 0, endMs: 2000, text: 'BURNED CAPTION' }], {
        width: 480,
        height: 270,
        style: 'meme',
      }),
      'utf8',
    )
    const out = join(workDir, 'captioned.mp4')
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 5000, endMs: 7000, assPath, silent: false },
      { maxWidth: 480, fps: 24, stripAudio: false },
      out,
    )
    expect(statSync(out).size).toBeGreaterThan(1000)
  }, 120_000)

  it('replaces audio with silence for a muted clip but keeps the stream layout', async () => {
    const out = join(workDir, 'muted.mp4')
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 10_000, endMs: 12_000, silent: true },
      { maxWidth: 480, fps: 24, stripAudio: false },
      out,
    )
    expect(await probeStreams(out)).toMatch(/Audio: aac/)
  }, 120_000)

  it('concatenates segments into one file of the summed duration', async () => {
    const dir = await makeWorkDir()
    try {
      const paths: string[] = []
      for (const [i, start] of [20_000, 40_000, 60_000].entries()) {
        const p = join(dir, `s${i}.mp4`)
        await encodeSegment(
          { input: sourcePath, seek: 'range', startMs: start, endMs: start + 2000, silent: false },
          { maxWidth: 480, fps: 24, stripAudio: false },
          p,
        )
        paths.push(p)
      }
      const joined = join(dir, 'joined.mp4')
      await concatSegments(paths, joined, dir)
      expect(await probeDuration(joined)).toBeCloseTo(6, 0)
    } finally {
      await cleanUp(dir)
    }
  }, 180_000)

  /*
   * Guards a fourfold waste on every encode this app does.
   *
   * `-force_key_frames expr:gte(t,0)` reads as "a keyframe at the start" and means
   * "a keyframe wherever t >= 0", which is everywhere — so x264 emitted an
   * all-intra stream. Measured on a 6-second 480p segment: 143 of 143 frames were
   * keyframes, at 695KB against 166KB with one. It inflated the previews the editor
   * rebuilds on every drag and the file the user downloads alike.
   */
  it('puts a keyframe at the segment start rather than on every frame', async () => {
    const out = join(workDir, 'sparse.mp4')
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 30_000, endMs: 36_000, silent: false },
      { maxWidth: 480, fps: 24, stripAudio: false },
      out,
    )

    const { frames, keyFrames } = await probeFrameCounts(out)
    expect(frames).toBeGreaterThan(100)
    // A ceiling rather than "fewer than the frames", which 142 of 143 would pass.
    // Real footage can add one at a hard cut, so this is not pinned to exactly one.
    expect(keyFrames).toBeLessThanOrEqual(3)
  }, 120_000)

  /*
   * The other half of that fix. Whole seconds between keyframes is only safe
   * because an input-side seek decodes forward to the timestamp asked for instead
   * of snapping back to the keyframe before it. If it ever snapped, every moment
   * inside one keyframe interval would freeze the same picture and the export
   * panel's "which moment to freeze" slider would quietly stop doing anything.
   */
  it('freezes the moment asked for, not the keyframe before it', async () => {
    const segment = join(workDir, 'forstill.mp4')
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 40_000, endMs: 46_000, silent: false },
      { maxWidth: 320, fps: 24, stripAudio: true },
      segment,
    )

    // 200ms apart, so both fall inside the one keyframe interval the segment has.
    const earlier = join(workDir, 'still-earlier.png')
    const later = join(workDir, 'still-later.png')
    await toStill(segment, earlier, { frameMs: 2000, maxWidth: 320, jpeg: false })
    await toStill(segment, later, { frameMs: 2200, maxWidth: 320, jpeg: false })

    expect(statSync(earlier).size).toBeGreaterThan(1000)
    expect(readFileSync(earlier).equals(readFileSync(later))).toBe(false)
  }, 120_000)

  it('produces a valid looping gif', async () => {
    const src = join(workDir, 'forgif.mp4')
    await encodeSegment(
      { input: sourcePath, seek: 'range', startMs: 3000, endMs: 5000, silent: false },
      { maxWidth: 320, fps: 12, stripAudio: true },
      src,
    )
    const gif = join(workDir, 'out.gif')
    await toGif(src, gif, { fps: 12, maxWidth: 320 })
    expect(await probeStreams(gif)).toMatch(/Video: gif/)
    expect(statSync(gif).size).toBeGreaterThan(1000)
  }, 180_000)
})

describe('ffmpeg failure messages', () => {
  /*
   * Guards a credential leak: ffmpeg echoes its input URL on failure, and the
   * Jellyfin stream URL carries the API key as a query parameter. An unredacted
   * message put a live key on screen in the clip editor.
   */
  it('never repeats the api key from a failing command', async () => {
    const secret = 'sk-should-never-appear-1234'
    const url = `http://127.0.0.1:9/Videos/x/stream.mp4?static=false&api_key=${secret}`

    const failure = await ffmpeg(['-i', url, '-frames:v', '1', '/dev/null']).then(
      () => null,
      (error: unknown) => error as RenderError,
    )

    expect(failure).toBeInstanceOf(RenderError)
    expect(failure!.message).not.toContain(secret)
    expect(failure!.stderr ?? '').not.toContain(secret)
    expect(`${failure!.message}${failure!.stderr}`).toContain('REDACTED')
  }, 60_000)
})

describe('escapeFilterPath', () => {
  it('quotes the path and escapes colons for the option parser', () => {
    expect(escapeFilterPath('/tmp/a,b/c:d/e.ass')).toBe("'/tmp/a,b/c\\:d/e.ass'")
  })

  it('keeps a Windows drive letter intact', () => {
    expect(escapeFilterPath('C:\\Users\\me\\cue.ass')).toBe("'C\\:/Users/me/cue.ass'")
  })
})

describe('cuesToClipEvents', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'way before' },
    { startMs: 9500, endMs: 10_500, text: 'straddles the start' },
    { startMs: 11_000, endMs: 12_000, text: 'inside' },
    { startMs: 14_500, endMs: 16_000, text: 'straddles the end' },
    { startMs: 30_000, endMs: 31_000, text: 'way after' },
  ]

  it('keeps only overlapping cues and rebases them onto the clip timeline', () => {
    const events = cuesToClipEvents(cues, 10_000, 15_000)
    expect(events.map((e) => e.text)).toEqual(['straddles the start', 'inside', 'straddles the end'])
    expect(events[0].startMs).toBe(0)
    expect(events[1].startMs).toBe(1000)
  })

  it('clamps a cue that runs past the end of the clip', () => {
    const events = cuesToClipEvents(cues, 10_000, 15_000)
    expect(events[2].endMs).toBe(5000)
  })
})

describe('buildAss', () => {
  it('emits a parseable script with scaled styling', () => {
    const ass = buildAss([{ startMs: 0, endMs: 1500, text: 'hello' }], {
      width: 1280,
      height: 720,
      style: 'meme',
    })
    expect(ass).toContain('PlayResX: 1280')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,HELLO')
  })

  it('escapes braces so ASS override syntax cannot be injected', () => {
    const ass = buildAss([{ startMs: 0, endMs: 1000, text: '{\\an8}not an override' }], {
      width: 640,
      height: 360,
      style: 'subtitle',
    })
    expect(ass).toContain('\\{\\\\an8\\}not an override')
  })

  it('drops empty and zero-length events', () => {
    const ass = buildAss(
      [
        { startMs: 0, endMs: 0, text: 'zero length' },
        { startMs: 0, endMs: 100, text: '   ' },
      ],
      { width: 640, height: 360, style: 'subtitle' },
    )
    expect(ass).not.toContain('Dialogue:')
  })
})
