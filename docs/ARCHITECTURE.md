# Architecture

Why the app is shaped the way it is, what was measured against a real Jellyfin
server rather than assumed, and which traps are load-bearing. Read this before
"simplifying" anything in `render/` or `montage/`.

## The pipeline

```
Jellyfin  ──subtitles──▶  parse → window → embed  ──▶  SQLite + sqlite-vec
   │                                                          │
   │                          paste ──▶ split ──▶ embed ──▶ KNN search
   │                                                          │
   └──media over HTTP range──▶  ffmpeg: clip → caption → concat → MP4/GIF
```

Jellyfin owns the library, metadata, subtitle extraction and format conversion,
and the tonemapping transcode. Jellymeme owns windowing, embedding, search and
frame-accurate export. Nothing reads the media files off disk.

## Invariants

These exist because breaking them produced a real bug.

**One preview pipeline.** Preview and export were once unrelated: preview was a raw
Jellyfin stream and captions existed only in the ffmpeg export path, so changing the
caption mode visibly did nothing. A preview is now a real render of one clip through
the same encoder and the same caption builder as the export, only smaller.
`render/caption.ts` (`writeCaptionFile()`) is the single caption source, and
`resolveCaption` is the single answer to "what will this render with". Both the
preview and the encoder call it. That is what stops them drifting.

**Export reads the tonemapped source, not the original.** Reading the original 4K
HEVC put PQ-tagged HDR pixels into an 8-bit SDR container, which looked washed out.
Jellyfin already tone maps on its GPU with a better algorithm, so export goes
through `segmentUrl()` too. This also makes preview and export agree on colour.

**The filmstrip is invariant under trimming.** One ffmpeg run produces one wide
sprite covering the clip's whole *reachable* range at 500 ms intervals, so it is
fetched once and dragging is pure CSS. This is why the window is derived from the
match rather than from the current bounds, and it is what makes the control feel
direct.

**Filmstrip geometry has exactly one definition.** `montage/filmstrip.ts` is pure
geometry, imported by the ffmpeg builder, the API route and the component. One tile
count, one offset formula, so the sprite and the timeline cannot disagree.

**Trim rules are pure and React-free.** `montage/trim.ts` holds the reachable range,
minimum clip length, cue snapping and boundary walking. The timeline snaps to cues
from the same `cuesForVideo()` the caption burner uses, so the boundary it snaps to
is the boundary the caption appears on.

**Library-wide search must still narrow a clip's alternates.** `montage.title_id` is
NOT NULL, so a cut belongs to exactly one show, while a library-wide search returns
candidates from several, and those candidates become a clip's `alternates`. Without
narrowing, "Not this one" would swap in footage from a different series while the cut
still claimed the original title. `alternatesForTitle` in `montage/types.ts` narrows,
the API derives the title from the *chosen match* rather than trusting the request,
and the "find a different scene" dialogue stays title-scoped for the same reason.

**A clip states its caption rather than leaving it derived.** `'inherit'` is a fourth
`ClipCaptionMode`, not a separate "overridden" flag. Clips written before cut-level
captions existed hold an explicit `none`, indistinguishable from someone choosing it,
so they must not silently follow a new default; the caption bar reports how many are
set individually and offers to convert them.

**Index removal is destructive and says so.** `montage.title_id` and
`render.montage_id` both cascade, so deleting a title's index once deleted every cut
made from it and orphaned the render files on disk. `DELETE /api/library/{titleId}`
now reports the cost and refuses without `confirm=1`, and `removeTitleIndex()`
unlinks the files the cascade cannot reach. Re-indexing is safe: `runIndexJob`
upserts, and only the explicit delete cascades.

**Indexing is a serial queue.** `startIndexJobs` runs one at a time. "Select all 201
shown" is a reasonable thing to click, and sixty concurrent runs would thrash the
embedding model and SQLite and finish nothing.

**Schema changes are additive at runtime.** There is no migration runner, and
`schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which is a no-op for a table that
already exists. `addColumns()` in `db/index.ts` applies column adds idempotently;
`schema.sql` stays the description of a *fresh* database.

**The playhead follows the media element, not React state.** It is driven by the
video element's own `play`/`pause` events. Gating it on state failed the first time
playback started by a route the component did not initiate: the marker froze while
the picture kept moving. `wantsPlay` is the user's intent, which has to outlive the
element being paused behind the app's back on every rebuild.

## Verified Jellyfin behaviour

Measured against a real Jellyfin **10.11.7**, not inferred from docs. Do not
re-probe these.

| Fact | Value |
|---|---|
| Item lookup | `/Items/{id}` returns a bare **400**. Working forms: `/Items?ids=`, `/Users/{uid}/Items/{id}` |
| Why | That route resolves against a user's library view, and an API-key caller has no user context |
| `/Items?ids=` carries MediaSources | **Yes** on 10.11 |
| Transcoded progressive mp4 | **Not seekable**: no `Content-Length`, no `Accept-Ranges`, ignores `Range` |
| Static original | Seekable (206), but often 4K HEVC/DOVI, which browsers cannot decode |
| HDR is the norm | HDR10 / DOVI / DOVIWithHDR10Plus, not an edge case |
| Server tonemapping | `EnableTonemapping=true`, algorithm `bt2390`, hardware accelerated |
| Requested width honoured | 480→480x240, 720→720x360, **only with stream copy disabled** |
| Subtitle tracks per episode | Up to 42. The picker prefers English, non-forced, non-SDH |
| Subtitle coverage | Roughly a third of a real library has no text track and can never be indexed |
| Trickplay | 320 px wide, 10 000 ms interval. **Unused**: 10 s granularity is too coarse for boundary frames, and one ffmpeg pass gives 500 ms |

Rough costs on a ~200-title library (62 series, 140 films, ~1,300 episodes):

| Operation | Cost |
|---|---|
| Indexing | ~2,000 windows per 6 episodes in 6.3 s, so a whole library is ~25-40 min |
| Filmstrip build | 31 s window → 62 tiles, 7936×72 px, 95 KB, ~3.0 s, once per clip |
| 12 s preview | 4.4 s from the 4K static file vs **1.5-2.9 s** via Jellyfin's transcode |
| Embedding model | 97 MB, cached in `data/models` |

## Traps

Each of these cost real time, and each looks like something worth tidying away.

1. **`-t` before `-i` overshoots on a positioned stream.** A server-positioned
   transcode keeps the source's timestamps, so an input-side duration bound gave
   **20.17 s for a 12 s request**. `-t` *after* `-i` gives exactly 12.00 s and is
   faster. This is why `SegmentSpec.seek` (`'range' | 'positioned'`) exists. Do not
   simplify it away.
2. **Stream copy must stay disabled in `segmentUrl()`.** With copy allowed, Jellyfin
   can return the original packets for an already-H.264 source, skipping the
   tonemapping the endpoint exists for and ignoring `maxWidth`.
3. **ffmpeg stderr contains the API key.** ffmpeg echoes its input URL on failure,
   which once put a live credential on screen. `redactCredentials()` in
   `render/ffmpeg.ts` strips it at the source and a regression test guards it. Never
   surface raw ffmpeg output without it.
4. **Never print a Jellyfin response body.** An HLS playlist embeds `api_key=` in
   every segment URI.
5. **Never write the Jellyfin hostname or key into a repo file.** The connection
   lives in `data/jellymeme.db` (`config` table, keys `jellyfin.url` /
   `jellyfin.apiKey`).
6. **The test mock does not reproduce Jellyfin's timestamp offsets.** Mutation
   testing proved the duration assertion in the e2e test stays green with trap 1
   reintroduced. That assertion guards padding/trim/concat arithmetic only.
7. **A sprite wider than ~16 384 px silently fails to paint** rather than erroring.
   `planFilmstrip` caps tiles at 96 and a test guards the bound.
8. **Turbopack resolves the argument to `child_process.fork` at build time.** It
   treats it as a module, and `scripts/embed-worker.mjs` is a runtime file, so
   `next build` fails with *"server relative imports are not implemented yet"* while
   dev and every test pass. `turbopackIgnore` does **not** help; those magic comments
   apply to `import()` and `require()` only. The fix is to give the scan nothing to
   match: assemble the path from segments and reach `fork` by property lookup. Do not
   tidy either back into a literal call.
9. **`scripts/embed-worker.mjs` is not in the Next build graph** because it is forked
   at runtime. The Docker runtime stage needs an explicit `COPY` for it, the same
   treatment `schema.sql` gets, or embedding breaks in the image but not in dev.
10. **Apostrophes are not quotes.** `QUOTED_SPAN` matches `"` and `“ ”` only. As an
    anchored whole-line pattern an apostrophe was survivable; as a *span* it turns
    `He's got it, it's fine` into `s got it, it`. Guarded by a test and confirmed by
    mutation: adding `'` to the pattern fails it.

## Decisions, and what was rejected

**Preview is a cheap real render.** Exact caption fidelity through libass and the
same code as export, WYSIWYG by construction, and the HDR fix falls out of it. Cost:
a ~1.5-2.6 s debounced rebuild rather than instant scrubbing.

**Boundary frames come from the same sprite, not separate renders.** Four exact
frames per adjustment would be four ffmpeg runs per drag; tile indices are free. The
exact in-point frame is still available exactly, as frame 0 of the preview player.

**Both trim edges are unbounded within the filmstrip window.** Each edge used to be
clamped relative to the *matched dialogue* as well as to the other edge, which
pinned every clip to the region the search happened to land on. A search result is a
place to start looking, so the only limits left are the filmstrip window and
`MIN_CLIP_MS`. `paddingFor` clamps the in/out *points* to the window rather than
clamping the two padding numbers, which is what lets a stored pair describe a clip
sitting entirely outside its match.

**Confidence scores are not shown.** The `73% confidence` label was a cosine
distance dressed up as a probability.

**Rejected: trickplay sprites for the timeline.** Free and instant, but 10 s
granularity cannot answer "what is just outside the cut", and it needs a separate
metadata fetch and sprite-grid maths.

**Rejected: hls.js for seekable transcoded playback.** Instant scrubbing, but
captions become an HTML overlay that only approximates the burned output, so preview
and export drift, which is the exact failure this design removes.

**Rejected: local zscale/tonemap in ffmpeg.** Works, but Jellyfin already does it
with hardware acceleration and a better algorithm, and doing it locally means
decoding 4K HEVC on the client machine (4.4 s vs 1.5 s).

**Rejected: mute in the preview cache key.** Silence is applied by the player.

**Deferred: suggested cuts** (three pre-cut options per clip from cue boundaries).
The line-level actions cover the same intent more cheaply.

**Deferred: cuts that mix shows.** The better long-term shape, and the natural next
step now that search spans the library. The blocker is not the UI:
`removeTitleIndex` cascade-deletes montages through `montage.title_id`, so with clips
from several shows, removing one show has to invalidate *those clips* rather than the
whole cut. `alternatesForTitle` is the seam that would relax.

## The embedder runs in a child process, and why

The dev server used to exit silently mid-index. It was **onnxruntime aborting the
process on an illegal instruction**, which presented as the app simply not being
there:

```
EXC_BAD_INSTRUCTION (SIGILL)
kai_run_matmul_clamp_f32_f32p2vlx1_f32p2vlx1biasf32_sme2_mopa   ← ArmKleidiAI SME2
ArmKleidiAI::MlasGemmBatch → MlasGemmBatch → MatMul<float>::Compute
  … inside ThreadPool::RunInParallel
```

The database fingerprint is a title with thousands of `line` rows but `indexed_at`
NULL, meaning a run was killed partway through.

Notes if you meet it again:

- **Apple M4 does advertise SME2** (`hw.optional.arm.FEAT_SME2: 1`), so this is not a
  plain feature-detect mismatch. The crash is inside a thread-pool parallel region,
  which points at SME state on pool worker threads.
- **Not reproducible on demand.** Replaying every stored window at batch 128
  completes cleanly. It depends on matmul shape and thread timing, not on the text,
  which is why a retry usually succeeds. Do not sink time into a repro.

Two fixes, both shipped:

1. **`onnxruntime-node` pinned to 1.23.2** via `overrides` in `package.json`.
   Verified by symbol inspection rather than by hoping: 1.24.3 contains 166 `kai_`
   symbols including the exact crashing kernel, and **1.23.2 contains zero**, so the
   crash is impossible by construction. `@huggingface/transformers` 4.2.0 pins 1.24.3
   but works against 1.23.2 (384 dims, unit norm, and queries embedded on 1.23.2
   still match an index built on 1.24.3).
2. **Embedding moved into a child process** (`scripts/embed-worker.mjs`). A native
   crash cannot be caught in the process it happens in, so the only way to survive
   one is to not be in that process. A dead worker fails its in-flight batch with
   `EmbedderCrashed`, is respawned on the next call, and `embed()` retries once, so a
   crash that used to cost a whole index run now costs nothing.
   `embed.integration.test.ts` SIGKILLs the worker mid-batch and asserts the parent
   survives and the batch still completes.

`worker_threads` does not work for this: a SIGILL in a worker thread kills the whole
process. It has to be a separate process. When killing workers in a test, scope to
`pgrep -P $PID` children, because a broad pattern kill takes out the dev server's
worker too.

Same root cause, also fixed: `refreshTitleCounts` ran only when a job *finished*, so
an interrupted run left `line_count` at 0 with thousands of rows on disk and the
library then labelled the title "no usable subtitles". It now runs after every
episode.

## Notes

- **`/api/preview/[videoId]`** is used by `SceneSearch` for the
  watch-before-you-pick preview. Not dead code.
- **Bulk indexing across many titles at once** has not been exercised against a real
  server at scale; the single-title path through the queue has.

## Running and verifying

```bash
npm ci
npm run dev                      # :3000
npm test                         # 231 fast tests
RUN_FFMPEG_TESTS=1 npm test      # all 270, adding ffmpeg and embedder tests
npm run typecheck && npm run lint && npm run build
```

Poking the artefact endpoints directly:

```bash
# A filmstrip sprite: 62 tiles at 128x72 = 7936x72
curl -s "http://localhost:3000/api/clip-filmstrip?videoId=<id>&start=1461393&end=1492394" -o /tmp/strip.jpg
# A preview with captions burned in
curl -s "http://localhost:3000/api/clip-preview?videoId=<id>&start=187000&end=199000&mode=subtitle" -o /tmp/p.mp4
```

The trim handles expose their state through ARIA, which is the cheapest way to
verify a drag landed:

```js
document.querySelector('[aria-label="Clip start"]').getAttribute('aria-valuetext')
```
