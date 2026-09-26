import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { clipDurationMs } from './montage/types'

const run = promisify(execFile)

/**
 * End-to-end run against a stand-in Jellyfin server.
 *
 * The mock reproduces the behaviours of a real Jellyfin 10.11 server that the
 * app actually depends on, including the awkward ones:
 *
 * - `GET /Items/{id}` is rejected with a bare 400, because that route resolves
 *   against a user's library and an API-key caller has no user context. An
 *   earlier version of this mock answered it happily, so a client built on it
 *   passed every test and then failed on the first real click.
 * - `GET /Items?ids=` is the working single-item lookup.
 * - The transcode endpoint is a positioned, *non-seekable* stream whose
 *   timestamps keep the source's offset instead of restarting at zero. Bounding
 *   a read of it on the input side overshoots badly.
 * - The static endpoint is byte-seekable, as the original file is.
 *
 * Everything above the mock — subtitle parsing, windowing, embedding, vector
 * search, montage assembly and the ffmpeg render — runs for real.
 *
 * Opt-in: `RUN_FFMPEG_TESTS=1 npm test`.
 */
const enabled = process.env.RUN_FFMPEG_TESTS === '1'
const maybe = enabled ? describe : describe.skip

const SERIES_ID = 'series-1'
const EPISODES = [
  {
    id: 'ep-1',
    name: 'Health Care',
    season: 1,
    episode: 3,
    srt: `1
00:00:05,000 --> 00:00:08,000
I have to go to the hospital right now.

2
00:00:08,500 --> 00:00:11,000
Did you burn your foot on the grill again?

3
00:00:30,000 --> 00:00:33,000
I declare bankruptcy!

4
00:00:33,500 --> 00:00:37,000
You can't just say the word bankruptcy and expect anything to happen.

5
00:00:37,500 --> 00:00:40,000
I didn't say it. I declared it.

6
00:01:10,000 --> 00:01:13,000
The fire is spreading, everyone get to the stairwell.

7
00:01:13,500 --> 00:01:16,000
Why is the door handle hot? Nobody touch it.
`,
  },
  {
    id: 'ep-2',
    name: 'The Dinner Party',
    season: 2,
    episode: 9,
    srt: `1
00:00:12,000 --> 00:00:15,000
Please sit down, dinner will be ready in three hours.

2
00:00:15,500 --> 00:00:18,000
We only have one chair, so someone will have to stand.

3
00:00:50,000 --> 00:00:53,000
She threw the plasma television across the room.

4
00:00:53,500 --> 00:00:56,000
That was a very small television and a very large throw.
`,
  },
  closingSceneEpisode(),
]

/** One SRT cue per line of dialogue, two seconds long, at the second given. */
function toSrt(lines: { atSecond: number; text: string }[]): string {
  const clock = (seconds: number) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`
  return lines
    .map((line, i) => `${i + 1}\n${clock(line.atSecond)} --> ${clock(line.atSecond + 2)}\n${line.text}\n`)
    .join('\n')
}

/**
 * An episode with more dialogue than a search over-fetches candidates for.
 *
 * Built to catch one specific bug: applying a position hint to the rows a query
 * returned, rather than inside its ORDER BY, lets the row limit choose by score
 * first — so "the closing scene" can only reshuffle whichever lines already
 * scored well. Here the fifty-eight lines about paperwork all score better than
 * the two at the end, and there are more of them than the forty candidates a
 * search fetches, so the closing lines are only reachable if the band is applied
 * before the cut.
 */
function closingSceneEpisode() {
  const paperwork = Array.from({ length: 58 }, (_, i) => ({
    atSecond: i + 1,
    text: `Line ${i + 1}: we need to file the quarterly paperwork before the audit.`,
  }))
  return {
    id: 'ep-3',
    name: 'Casino Night',
    season: 2,
    episode: 22,
    srt: toSrt([
      ...paperwork,
      { atSecond: 84, text: 'Goodnight everyone, drive home safely.' },
      { atSecond: 87, text: 'See you all on Monday morning.' },
    ]),
  }
}

maybe('end-to-end against a mock Jellyfin server', () => {
  let server: Server
  let jellyfinUrl: string
  let dataDir: string
  let mediaPath: string
  let mod: typeof import('./index/indexer')
  let searchMod: typeof import('./search/search')
  let montageMod: typeof import('./montage/build')
  let renderMod: typeof import('./render/render')
  let JellyfinClient: typeof import('./jellyfin/client').JellyfinClient
  let client: InstanceType<typeof import('./jellyfin/client').JellyfinClient>
  let ffmpegBin: string
  /** Every path the mock was asked for, so tests can assert which one export used. */
  const requested: { path: string; query: URLSearchParams }[] = []
  /**
   * How many subtitle transcodes the mock ever had open at once.
   *
   * A real Jellyfin server does not take a second one gracefully while the
   * first is still running — the loser stalls until the client gives up,
   * misreporting a perfectly fine episode as broken. Indexing must overlap
   * subtitle fetching with embedding, never with another subtitle fetch, and
   * a 20ms delay here gives two overlapping requests, if the indexer ever
   * sends them, room to actually overlap instead of racing to respond first.
   */
  let activeSubtitleRequests = 0
  let maxConcurrentSubtitleRequests = 0

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jellymeme-e2e-'))
    mediaPath = join(dataDir, 'episode.mkv')

    // Isolate database and renders; reuse the already-downloaded model weights.
    process.env.JELLYMEME_DATA = dataDir
    process.env.JELLYMEME_RENDERS = join(dataDir, 'renders')
    process.env.JELLYMEME_MODEL_CACHE = join(process.cwd(), 'data', 'models')

    const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string
    ffmpegBin = ffmpegStatic
    await run(
      ffmpegStatic,
      [
        '-nostdin', '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=90',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
        '-c:a', 'aac', '-shortest', mediaPath,
      ],
      { maxBuffer: 1 << 24 },
    )

    const size = statSync(mediaPath).size

    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      const path = url.pathname
      requested.push({ path, query: url.searchParams })
      const send = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      // Every authenticated call must carry a non-empty token, either in
      // Jellyfin's Authorization header or as the ApiKey query parameter that
      // ffmpeg uses. Jellyfin 12 rejects the legacy api_key spelling.
      const headerToken = /MediaBrowser Token="([^"]*)"/.exec(req.headers.authorization ?? '')?.[1]
      const queryToken = url.searchParams.get('ApiKey')
      if (!headerToken && !queryToken) {
        res.writeHead(401)
        return res.end()
      }

      if (path === '/System/Info') {
        return send({ ServerName: 'Mock Jellyfin', Version: '10.11.7', Id: 'mock' })
      }

      if (path === '/Items') {
        const series = { Id: SERIES_ID, Name: 'Test Show', Type: 'Series', ProductionYear: 2005 }
        // `ids` is honoured, because that is the lookup the client has to use.
        const ids = url.searchParams.get('ids')?.split(',')
        const items = ids ? [series].filter((item) => ids.includes(item.Id)) : [series]
        return send({ Items: items, TotalRecordCount: items.length, StartIndex: 0 })
      }

      // A single-item GET is rejected exactly as the real server rejects it.
      if (/^\/Items\/[^/]+$/.test(path)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ title: 'Error processing request.', status: 400 }))
      }

      if (path === `/Shows/${SERIES_ID}/Episodes`) {
        return send({
          Items: EPISODES.map((ep) => ({
            Id: ep.id,
            Name: ep.name,
            Type: 'Episode',
            SeriesId: SERIES_ID,
            IndexNumber: ep.episode,
            ParentIndexNumber: ep.season,
            RunTimeTicks: 90 * 10_000_000,
            MediaSources: [
              {
                Id: `ms-${ep.id}`,
                Path: `/media/${ep.id}.mkv`,
                Container: 'mkv',
                MediaStreams: [
                  { Index: 0, Type: 'Video', Codec: 'h264', Language: null, DisplayTitle: '1080p', IsDefault: true, IsForced: false, IsExternal: false, IsTextSubtitleStream: false },
                  { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', DisplayTitle: 'English', IsDefault: true, IsForced: false, IsExternal: false, IsTextSubtitleStream: false },
                  // A forced track and a bitmap track, to prove track selection works.
                  { Index: 2, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', DisplayTitle: 'English (Forced)', IsDefault: false, IsForced: true, IsExternal: false, IsTextSubtitleStream: true },
                  { Index: 3, Type: 'Subtitle', Codec: 'pgssub', Language: 'eng', DisplayTitle: 'English (PGS)', IsDefault: false, IsForced: false, IsExternal: false, IsTextSubtitleStream: false },
                  { Index: 4, Type: 'Subtitle', Codec: 'subrip', Language: 'eng', DisplayTitle: 'English', IsDefault: true, IsForced: false, IsExternal: false, IsTextSubtitleStream: true },
                ],
              },
            ],
          })),
          TotalRecordCount: EPISODES.length,
          StartIndex: 0,
        })
      }

      const subtitleMatch = /^\/Videos\/([^/]+)\/([^/]+)\/Subtitles\/(\d+)\/Stream\.srt$/.exec(path)
      if (subtitleMatch) {
        const ep = EPISODES.find((e) => e.id === subtitleMatch[1])
        // Only the non-forced text track should ever be requested.
        if (!ep || subtitleMatch[3] !== '4') {
          res.writeHead(404)
          return res.end()
        }
        activeSubtitleRequests++
        maxConcurrentSubtitleRequests = Math.max(maxConcurrentSubtitleRequests, activeSubtitleRequests)
        setTimeout(() => {
          activeSubtitleRequests--
          res.writeHead(200, { 'Content-Type': 'application/x-subrip' })
          res.end(ep.srt)
        }, 20)
        return
      }

      /*
       * The transcode endpoint. Three properties are deliberate, because all
       * three are true of the real one and each has bitten us:
       *   - no Content-Length and no Accept-Ranges, and Range is ignored, so it
       *     cannot be seeked;
       *   - -copyts keeps the source's timestamps, so the stream does not start
       *     at zero and an input-side duration bound overshoots;
       *   - maxWidth is honoured, so a caller cannot silently get another size.
       */
      if (/^\/Videos\/[^/]+\/stream\.mp4$/.test(path)) {
        const startMs = Number(url.searchParams.get('startTimeTicks') ?? 0) / 10_000
        const maxWidth = Number(url.searchParams.get('maxWidth') ?? 640)

        res.writeHead(200, { 'Content-Type': 'video/mp4' })
        const child = spawn(ffmpegBin, [
          '-nostdin', '-hide_banner', '-loglevel', 'error',
          '-copyts',
          '-ss', (startMs / 1000).toFixed(3),
          '-i', mediaPath,
          '-vf', `scale=min(iw\\,${maxWidth}):-2`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1',
        ])
        child.stdout.pipe(res)
        res.on('close', () => child.kill('SIGKILL'))
        return
      }

      if (/^\/Videos\/[^/]+\/stream$/.test(path)) {
        const range = req.headers.range
        const m = range && /bytes=(\d+)-(\d*)/.exec(range)
        const start = m ? Number(m[1]) : 0
        const end = m && m[2] ? Number(m[2]) : size - 1
        res.writeHead(m ? 206 : 200, {
          'Content-Type': 'video/x-matroska',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        })
        const stream = createReadStream(mediaPath, { start, end })
        stream.pipe(res)
        res.on('close', () => stream.destroy())
        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address === 'string' || !address) throw new Error('no address')
    jellyfinUrl = `http://127.0.0.1:${address.port}`

    // Import after the env vars are set so the db singleton picks them up.
    JellyfinClient = (await import('./jellyfin/client')).JellyfinClient
    mod = await import('./index/indexer')
    searchMod = await import('./search/search')
    montageMod = await import('./montage/build')
    renderMod = await import('./render/render')

    client = new JellyfinClient({ baseUrl: jellyfinUrl, apiKey: 'test-key' })
  }, 180_000)

  afterAll(async () => {
    server?.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('authenticates and reads server info', async () => {
    const info = await client.systemInfo()
    expect(info.ServerName).toBe('Mock Jellyfin')
  })

  it('rejects a bad API key with a readable message', async () => {
    const bad = new JellyfinClient({ baseUrl: jellyfinUrl, apiKey: '' })
    await expect(bad.systemInfo()).rejects.toThrow(/API key/i)
  })

  /*
   * Guards the bug that shipped: item() used GET /Items/{id}, which the real
   * server rejects with a 400, so indexing died on the first click while every
   * test passed.
   */
  it('looks up one item without using the route the server rejects', async () => {
    const item = await client.item(SERIES_ID)
    expect(item.Name).toBe('Test Show')

    const singleItemGets = requested.filter((r) => /^\/Items\/[^/]+$/.test(r.path))
    expect(singleItemGets).toEqual([])
  })

  it('reports a missing item rather than returning an empty one', async () => {
    await expect(client.item('does-not-exist')).rejects.toThrow(/no item/i)
  })

  it('picks the non-forced text subtitle track over forced and bitmap tracks', async () => {
    const episodes = await client.videosForTitle({
      Id: SERIES_ID,
      Name: 'Test Show',
      Type: 'Series',
    })
    const track = JellyfinClient.pickSubtitleTrack(episodes[0].MediaSources)
    expect(track?.index).toBe(4)
    expect(track?.isForced).toBe(false)
  })

  it('indexes the whole series', async () => {
    const job = await mod.runIndexJob(client, {
      Id: SERIES_ID,
      Name: 'Test Show',
      Type: 'Series',
      ProductionYear: 2005,
    })

    expect(job.status).toBe('done')
    expect(job.processedVideos).toBe(3)
    expect(job.skipped).toEqual([])
    expect(job.linesIndexed).toBeGreaterThan(0)
  }, 120_000)

  it('never asks Jellyfin for two subtitle transcodes at once', () => {
    expect(maxConcurrentSubtitleRequests).toBeLessThanOrEqual(1)
  })

  it('finds a scene from a description that shares no words with the dialogue', async () => {
    const { matches: results } = await searchMod.searchScenes(
      SERIES_ID,
      'the part where he shouts about being financially ruined',
      3,
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text.toLowerCase()).toContain('bankruptcy')
    expect(results[0].videoId).toBe('ep-1')
  }, 60_000)

  it('matches a different scene to a different description', async () => {
    const { matches: results } = await searchMod.searchScenes(SERIES_ID, 'the building is on fire', 3)
    expect(results[0].text.toLowerCase()).toMatch(/fire|stairwell/)
  }, 60_000)

  it('returns distinct moments rather than overlapping views of one', async () => {
    const { matches: results } = await searchMod.searchScenes(SERIES_ID, 'bankruptcy', 5)
    const starts = results.filter((r) => r.videoId === 'ep-1').map((r) => r.startMs)
    for (let i = 1; i < starts.length; i++) {
      expect(Math.abs(starts[i] - starts[i - 1])).toBeGreaterThanOrEqual(20_000)
    }
  }, 60_000)

  /*
   * Searching without a title has to actually drop the filter rather than pass a
   * null through to `title_id = ?`, which matches nothing in SQL and would look
   * exactly like "your library has nothing in it".
   *
   * One indexed show is enough to tell the two paths apart: a title that does not
   * exist must find nothing, and no title at all must find the same scene the
   * scoped search does.
   */
  it('searches every title when no title is given, and filters when one is', async () => {
    const { matches: everywhere } = await searchMod.searchScenes(null, 'bankruptcy', 3)
    const { matches: scoped } = await searchMod.searchScenes(SERIES_ID, 'bankruptcy', 3)
    const { matches: elsewhere } = await searchMod.searchScenes(
      'a-show-that-was-never-added',
      'bankruptcy',
      3,
    )

    expect(everywhere.length).toBeGreaterThan(0)
    expect(everywhere[0].lineId).toBe(scoped[0].lineId)
    expect(elsewhere).toEqual([])
  }, 60_000)

  it('says which show every match came from, so a library-wide result can name it', async () => {
    const { matches: results } = await searchMod.searchScenes(null, 'bankruptcy', 3)

    for (const match of results) {
      expect(match.titleId).toBe(SERIES_ID)
      expect(match.titleName).toBe('Test Show')
    }
  }, 60_000)

  /*
   * Episode hints, against the real index.
   *
   * The parser is unit-tested; what these hold is that a hint actually reaches
   * retrieval. `line_vec` cannot filter on video_id, so honouring one means an
   * exact distance scan over the named episode rather than hoping it turns up in
   * a wider neighbour set — a difference no amount of parser testing would show.
   */
  it('ranks the named episode first, against a much stronger match elsewhere', async () => {
    // "bankruptcy" is said four times in ep-1 and never in ep-2, so the wording
    // pulls hard the wrong way. The stated episode still wins.
    const { matches, request } = await searchMod.searchScenes(
      SERIES_ID,
      'the bit about declaring bankruptcy in "The Dinner Party"',
      5,
    )

    expect(request.where?.videoIds).toEqual(['ep-2'])
    expect(matches[0].videoId).toBe('ep-2')
  }, 60_000)

  /*
   * The other half of "prefer, do not filter". A hint is a guess about a
   * half-remembered scene, so the better match has to stay in reach — otherwise
   * "Not this one" cannot walk out of an episode the user named by mistake.
   */
  it('keeps the stronger match reachable below the named episode', async () => {
    const { matches } = await searchMod.searchScenes(
      SERIES_ID,
      'the bit about declaring bankruptcy in "The Dinner Party"',
      5,
    )

    expect(matches.some((m) => m.videoId === 'ep-1' && m.text.includes('bankruptcy'))).toBe(true)
  }, 60_000)

  it('falls back to plain ranking when the named episode never existed', async () => {
    const { matches, request } = await searchMod.searchScenes(
      SERIES_ID,
      'the bit about declaring bankruptcy in "An Episode That Never Aired"',
      3,
    )

    expect(request.where).toBeNull()
    expect(matches[0].text.toLowerCase()).toContain('bankruptcy')
  }, 60_000)

  it('embeds the description without the episode title welded into it', async () => {
    const { request } = await searchMod.searchScenes(
      SERIES_ID,
      'the plasma television moment in "The Dinner Party"',
      3,
    )

    expect(request.text).toBe('the plasma television moment in')
  }, 60_000)

  it('never returns nothing because a hint was given', async () => {
    // A description that is only an episode title has no dialogue in it at all.
    const { matches } = await searchMod.searchScenes(SERIES_ID, '"The Dinner Party"', 3)

    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].videoId).toBe('ep-2')
  }, 60_000)

  /*
   * Position is a tie-breaker inside a named episode, where the wording carries
   * almost no information: "the cold open of X" says nothing about what is said.
   * Both searches use one vector so the only difference is the hint.
   */
  it('biases toward the start of an episode when the description says so', async () => {
    const { embed } = await import('./search/embed')
    const [vector] = await embed(['a moment from this episode'])
    const inEp2 = { videoIds: ['ep-2'] }

    const plain = searchMod.searchScenesByVector(SERIES_ID, vector, 4, { ...inEp2, when: null })
    const opening = searchMod.searchScenesByVector(SERIES_ID, vector, 4, {
      ...inEp2,
      when: 'opening',
    })

    // ep-2 runs 90s with lines at 12s, 15.5s, 50s and 53.5s; the first 15% holds
    // only the 12s one, and it scores 0.09 below the 50s line on this query.
    expect(opening[0].startMs).toBeLessThan(13_500)
    expect(plain[0].startMs).toBe(50_000)
    expect(plain.map((m) => m.lineId)).not.toEqual(opening.map((m) => m.lineId))
  }, 60_000)

  /*
   * The band has to be part of the query's ORDER BY, not applied to what it
   * returned: otherwise the row limit selects by score and position only
   * reshuffles the survivors. ep-3 has more better-scoring lines than a search
   * fetches candidates, so its closing two are unreachable if that is wrong.
   */
  it('reaches the closing lines even when better-scoring ones crowd them out', async () => {
    const { embed } = await import('./search/embed')
    const [vector] = await embed(['filing the quarterly paperwork before the audit'])
    const inEp3 = { videoIds: ['ep-3'] }

    const plain = searchMod.searchScenesByVector(SERIES_ID, vector, 3, { ...inEp3, when: null })
    const ending = searchMod.searchScenesByVector(SERIES_ID, vector, 3, {
      ...inEp3,
      when: 'ending',
    })

    // ep-3 runs 90s, so the last 15% starts at 76.5s; only the 84s and 87s lines
    // are in it, and both are about saying goodnight rather than about paperwork.
    expect(plain[0].startMs).toBeLessThan(76_500)
    expect(ending[0].startMs).toBeGreaterThanOrEqual(76_500)
    expect(ending[0].text).toContain('Goodnight')
  }, 60_000)

  it('builds a montage from pasted reddit-style text', async () => {
    const montage = await montageMod.buildMontage(
      SERIES_ID,
      `1. when he yells about declaring bankruptcy
2. the one where the office catches fire
- the awkward dinner with only one chair`,
      'Test Montage',
    )

    expect(montage.clips).toHaveLength(3)
    expect(montage.clips[0].alternates[0].text.toLowerCase()).toContain('bankruptcy')
    expect(montage.clips[1].alternates[0].text.toLowerCase()).toMatch(/fire|stairwell/)
    expect(montage.clips[2].alternates[0].videoId).toBe('ep-2')
    // Alternates give the editor somewhere to go.
    expect(montage.clips[0].alternates.length).toBeGreaterThan(1)
  }, 120_000)

  it('persists and reloads a montage', async () => {
    const montage = await montageMod.buildMontage(SERIES_ID, 'the fire drill scene')
    const reloaded = montageMod.getMontage(montage.id)
    expect(reloaded?.clips[0].description).toBe('the fire drill scene')

    const saved = montageMod.saveMontage(montage.id, {
      clips: [{ ...montage.clips[0], padBeforeMs: 3000 }],
    })
    expect(saved?.clips[0].padBeforeMs).toBe(3000)
  }, 120_000)

  it('renders a montage end to end, pulling media from Jellyfin over HTTP', async () => {
    const montage = await montageMod.buildMontage(
      SERIES_ID,
      `1. when he yells about declaring bankruptcy
2. the one where the office catches fire`,
    )

    // Caption one clip from real subtitles, the other with custom meme text.
    const clips = montage.clips.map((clip, i) => ({
      ...clip,
      caption:
        i === 0
          ? { mode: 'subtitle' as const, text: '' }
          : { mode: 'custom' as const, text: 'this is fine' },
    }))
    const prepared = montageMod.saveMontage(montage.id, { clips })!

    const renderId = 'render-test-1'
    const { getDb } = await import('./db')
    getDb()
      .prepare(
        `INSERT INTO render (id, montage_id, status, progress, stage, format, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, 'queued', 'mp4', ?, ?)`,
      )
      .run(renderId, prepared.id, Date.now(), Date.now())

    await renderMod.runRender(
      renderId,
      prepared,
      { format: 'mp4', maxWidth: 320, fps: 12, stripAudio: false, frameMs: 0 },
      client,
    )

    const record = renderMod.getRender(renderId)
    expect(record?.error).toBeNull()
    expect(record?.status).toBe('done')
    expect(record?.fileSize).toBeGreaterThan(1000)
    expect(statSync(record!.filePath!).size).toBe(record!.fileSize)

    /*
     * The output must be as long as the clips asked for, which guards padding,
     * trimming and concat arithmetic.
     *
     * It does NOT guard the input-versus-output duration bound for a positioned
     * stream: reading one with an input-side -t produced 20.2s for a 12s request
     * against a real 10.11 server, and mutation testing confirms this assertion
     * stays green with that bug reintroduced, because the mock's piped ffmpeg
     * does not reproduce Jellyfin's timestamp offsets. That fix is verified only
     * by hand against a real server.
     */
    const expectedMs = prepared.clips.reduce((sum, clip) => sum + clipDurationMs(clip), 0)
    const { stderr } = await run(
      (await import('ffmpeg-static')).default as unknown as string,
      ['-hide_banner', '-i', record!.filePath!],
      { maxBuffer: 1 << 24 },
    ).catch((e) => e as { stderr: string })
    const clock = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr)
    const actualMs =
      (Number(clock![1]) * 3600 + Number(clock![2]) * 60 + Number(clock![3])) * 1000
    expect(actualMs).toBeGreaterThan(expectedMs - 500)
    expect(actualMs).toBeLessThan(expectedMs + 500)

    /*
     * Export must read through the transcoder, not the original file: that is
     * what tone maps HDR to SDR, and reading the original is why exports came
     * out washed out. Stream copy must be off or Jellyfin can hand back the
     * original packets and skip the conversion.
     */
    const transcodeReads = requested.filter((r) => r.path.endsWith('/stream.mp4'))
    expect(transcodeReads.length).toBeGreaterThan(0)
    for (const read of transcodeReads) {
      expect(read.query.get('allowVideoStreamCopy')).toBe('false')
      expect(read.query.get('startTimeTicks')).toBeTruthy()
    }
  }, 300_000)

  it('renders a still image with a burned-in custom caption', async () => {
    const montage = await montageMod.buildMontage(SERIES_ID, 'when he yells about bankruptcy')
    const prepared = montageMod.saveMontage(montage.id, {
      clips: montage.clips.map((c) => ({
        ...c,
        caption: { mode: 'custom' as const, text: 'this is fine' },
        // Trim inward as well as outward, exercising signed padding end to end.
        padBeforeMs: -500,
        padAfterMs: 2000,
      })),
    })!

    const renderId = 'render-still-1'
    const { getDb } = await import('./db')
    getDb()
      .prepare(
        `INSERT INTO render (id, montage_id, status, progress, stage, format, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, 'queued', 'png', ?, ?)`,
      )
      .run(renderId, prepared.id, Date.now(), Date.now())

    await renderMod.runRender(
      renderId,
      prepared,
      { format: 'png', maxWidth: 320, fps: 12, stripAudio: true, frameMs: 500 },
      client,
    )

    const record = renderMod.getRender(renderId)
    expect(record?.error).toBeNull()
    expect(record?.status).toBe('done')
    expect(record!.filePath!.endsWith('.png')).toBe(true)

    // Verify it really is a PNG, not an empty or mislabelled file.
    const { readFileSync } = await import('node:fs')
    const header = readFileSync(record!.filePath!).subarray(0, 8)
    expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }, 300_000)

  /*
   * The editor addresses the filmstrip by tile index: tile n is the frame at
   * `start + n * interval`, and the CSS that slides the sprite is derived from
   * the same tile count ffmpeg was given. If the two ever disagree the editor
   * shows a frame from elsewhere in the episode and labels it as the frame the
   * cut lands on, which is worse than showing nothing.
   */
  it('builds the trim filmstrip as one sprite with exactly the planned tiles', async () => {
    const { planFilmstrip, TILE_WIDTH, TILE_HEIGHT } = await import('./montage/filmstrip')
    const { buildFilmstrip } = await import('./render/filmstrip')

    const plan = planFilmstrip(20_000, 50_000)
    expect(plan.tiles).toBe(60)

    const path = await buildFilmstrip('ep-1', plan, client)

    const { stderr } = await run(ffmpegBin, ['-hide_banner', '-i', path], {
      maxBuffer: 1 << 24,
    }).catch((e) => e as { stderr: string })

    const size = /Stream #0:0.*?(\d{3,6})x(\d{2,4})/.exec(stderr)
    expect(size).not.toBeNull()
    expect(Number(size![1])).toBe(plan.tiles * TILE_WIDTH)
    expect(Number(size![2])).toBe(TILE_HEIGHT)
  }, 180_000)

  /*
   * The filmstrip covers everywhere a clip's edges can reach, so it is fetched
   * once and then dragging a handle is pure CSS. That only holds if a repeat
   * request is free, and if ten clips opening at once share one encode instead
   * of starting ten transcodes on the media server.
   */
  it('encodes a filmstrip once however many callers ask for it at once', async () => {
    const { planFilmstrip } = await import('./montage/filmstrip')
    const { buildFilmstrip } = await import('./render/filmstrip')

    const plan = planFilmstrip(60_000, 80_000)
    const before = requested.filter((r) => r.path.endsWith('/stream.mp4')).length

    const paths = await Promise.all([
      buildFilmstrip('ep-2', plan, client),
      buildFilmstrip('ep-2', plan, client),
      buildFilmstrip('ep-2', plan, client),
    ])
    expect(new Set(paths).size).toBe(1)

    const duringConcurrentBuild = requested.filter((r) => r.path.endsWith('/stream.mp4')).length
    expect(duringConcurrentBuild - before).toBe(1)

    // And once it is on disk, asking again reads nothing from Jellyfin at all.
    await buildFilmstrip('ep-2', plan, client)
    expect(requested.filter((r) => r.path.endsWith('/stream.mp4')).length).toBe(
      duringConcurrentBuild,
    )
  }, 180_000)

  it('re-indexing is idempotent and does not duplicate lines', async () => {
    const { getDb } = await import('./db')
    const before = getDb()
      .prepare('SELECT COUNT(*) AS n FROM line WHERE title_id = ?')
      .get(SERIES_ID) as { n: number }

    await mod.runIndexJob(
      client,
      { Id: SERIES_ID, Name: 'Test Show', Type: 'Series' },
      { force: true },
    )

    const after = getDb()
      .prepare('SELECT COUNT(*) AS n FROM line WHERE title_id = ?')
      .get(SERIES_ID) as { n: number }
    expect(after.n).toBe(before.n)

    // The vector index must stay in step with the line table.
    const vecCount = getDb()
      .prepare('SELECT COUNT(*) AS n FROM line_vec WHERE title_id = ?')
      .get(SERIES_ID) as { n: number }
    expect(vecCount.n).toBe(after.n)
  }, 180_000)

  /*
   * Removing a title's index cascades into every cut made from it, and the files
   * those cuts produced are not covered by the cascade at all. This runs last
   * because it takes the whole fixture with it.
   */
  it('reports what removing an index would destroy, and cleans up after itself', async () => {
    const { titleRemovalCost, removeTitleIndex } = mod
    const { getDb } = await import('./db')
    const db = getDb()

    const cost = titleRemovalCost(SERIES_ID)
    expect(cost.montages).toBeGreaterThan(0)
    expect(cost.renders).toBeGreaterThan(0)

    const files = (
      db
        .prepare(
          `SELECT r.file_path FROM render r
             JOIN montage m ON m.id = r.montage_id
            WHERE m.title_id = ? AND r.file_path IS NOT NULL`,
        )
        .all(SERIES_ID) as { file_path: string }[]
    ).map((row) => row.file_path)
    expect(files.length).toBe(cost.renders)
    for (const file of files) expect(existsSync(file)).toBe(true)

    await removeTitleIndex(SERIES_ID)

    const remaining = (table: string, column: string) =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(SERIES_ID) as {
          n: number
        }
      ).n

    expect(remaining('title', 'id')).toBe(0)
    expect(remaining('video', 'title_id')).toBe(0)
    expect(remaining('line', 'title_id')).toBe(0)
    expect(remaining('montage', 'title_id')).toBe(0)
    // The vector index has no foreign key, so it has to be cleaned explicitly.
    expect(remaining('line_vec', 'title_id')).toBe(0)

    // Orphaned files are the part a cascade cannot do.
    for (const file of files) expect(existsSync(file)).toBe(false)
  }, 60_000)
})
