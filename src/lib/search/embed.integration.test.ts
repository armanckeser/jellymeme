import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { EMBEDDING_DIM, embed, stopEmbedder } from './embed'

/**
 * Embedding runs in a child process, and these tests are about what happens when
 * that process dies.
 *
 * This is not hypothetical. onnxruntime's ArmKleidiAI SME2 matmul kernels raised
 * SIGILL on Apple Silicon partway through indexing a series, twice in one
 * afternoon, and killed the entire web server: no error, no log, and the next
 * search the user tried simply failed because nothing was listening. A native
 * crash cannot be caught in the process it happens in, so the fix was to move
 * embedding out of the process that serves requests. What follows checks that
 * the isolation actually holds.
 *
 * Heavy: needs the cached model weights. Same opt-in as the other local-asset
 * tests — `RUN_FFMPEG_TESTS=1 npm test`.
 */
const enabled = process.env.RUN_FFMPEG_TESTS === '1'
const maybe = enabled ? describe : describe.skip

/**
 * PIDs of embedding workers belonging to *this* process only.
 *
 * Deliberately scoped to direct children: a dev server running alongside the
 * tests has a worker of its own, and a broad pattern kill would take out the
 * application the developer is looking at.
 */
function ownWorkerPids(): number[] {
  let children: string
  try {
    children = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
  } catch {
    return []
  }

  return children
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .filter((pid) => {
      try {
        const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
          encoding: 'utf8',
        })
        return command.includes(join('scripts', 'embed-worker.mjs'))
      } catch {
        return false
      }
    })
}

async function waitForWorker(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [pid] = ownWorkerPids()
    if (pid) return pid
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('no embedding worker was spawned')
}

const SENTENCES = [
  'i love you morty',
  'wubba lubba dub dub',
  'he declares bankruptcy by shouting it across the office',
]

maybe('the embedding worker', () => {
  afterAll(() => stopEmbedder())

  it('returns one unit-length vector per text', async () => {
    const vectors = await embed(SENTENCES)

    expect(vectors).toHaveLength(3)
    for (const vector of vectors) {
      expect(vector).toBeInstanceOf(Float32Array)
      expect(vector.length).toBe(EMBEDDING_DIM)
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      expect(norm).toBeCloseTo(1, 5)
    }
  }, 120_000)

  it('places related sentences closer than unrelated ones', async () => {
    const [reunion, catchphrase, bankruptcy] = await embed([
      'i missed you so much',
      'wubba lubba dub dub',
      'i declare bankruptcy',
    ])
    const dot = (a: Float32Array, b: Float32Array) =>
      a.reduce((sum, value, i) => sum + value * b[i], 0)

    // Unit vectors, so a dot product is the cosine similarity.
    expect(dot(reunion, catchphrase)).toBeLessThan(dot(catchphrase, catchphrase))
    expect(dot(bankruptcy, bankruptcy)).toBeCloseTo(1, 5)
  }, 120_000)

  /*
   * The regression this whole design exists for. SIGKILL stands in for the SIGILL
   * onnxruntime raised: both are unstoppable, uncatchable process death.
   *
   * Two things must hold. This process has to still be alive afterwards — if the
   * embedder were in-process, the run would end here rather than fail. And the
   * caller must not have to care, because the crash depended on matmul shape and
   * thread timing rather than on the text, so the retry usually succeeds.
   */
  it('survives its worker being killed mid-batch, and finishes the work anyway', async () => {
    await embed(['prime the model'])
    const before = await waitForWorker()

    const inFlight = embed(SENTENCES)
    process.kill(before, 'SIGKILL')

    const vectors = await inFlight
    expect(vectors).toHaveLength(SENTENCES.length)
    expect(vectors[0].length).toBe(EMBEDDING_DIM)

    // A different worker did the work, which is the proof the old one really died
    // rather than the kill quietly missing.
    const after = await waitForWorker()
    expect(after).not.toBe(before)
  }, 180_000)

  it('keeps working across repeated crashes rather than degrading', async () => {
    const seen = new Set<number>()

    for (let round = 0; round < 3; round++) {
      const vectors = await embed(['round ' + round])
      expect(vectors[0].length).toBe(EMBEDDING_DIM)
      const pid = await waitForWorker()
      seen.add(pid)
      process.kill(pid, 'SIGKILL')
    }

    expect(seen.size).toBe(3)
    // And exactly one worker is left running, not one per crash.
    const vectors = await embed(['still here'])
    expect(vectors[0].length).toBe(EMBEDDING_DIM)
    expect(ownWorkerPids()).toHaveLength(1)
  }, 240_000)

  it('starts a fresh worker after a deliberate shutdown', async () => {
    await embed(['before shutdown'])
    stopEmbedder()

    const vectors = await embed(['after shutdown'])
    expect(vectors[0].length).toBe(EMBEDDING_DIM)
  }, 120_000)
})
