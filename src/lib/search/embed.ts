import * as childProcess from 'node:child_process'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

/**
 * all-MiniLM-L6-v2: 384 dimensions, ~23M parameters, runs comfortably on CPU.
 *
 * Chosen over larger retrieval models because indexing a full TV library means
 * embedding hundreds of thousands of short passages, and this model is roughly
 * an order of magnitude faster while remaining strong on short-text semantic
 * similarity. It also needs no "query:"/"passage:" prefixes, so the same code
 * path embeds both sides.
 */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIM = 384

// Mirrors DATA_DIR in db/index.ts, which the docs promise
// (JELLYMEME_MODEL_CACHE defaults to "$JELLYMEME_DATA/models") but the code
// did not actually do — it fell back to ./data/models regardless of
// JELLYMEME_DATA, so a container that sets only JELLYMEME_DATA (the normal
// case: it is what points at the volume) cached the ~90MB model outside it and
// re-downloaded on every restart.
const DATA_DIR = process.env.JELLYMEME_DATA ?? join(process.cwd(), 'data')
const MODEL_CACHE = process.env.JELLYMEME_MODEL_CACHE ?? join(DATA_DIR, 'models')

/**
 * Where the worker script lives, relative to the app root.
 *
 * `fork` needs a path on disk, so this file is not part of the Next build graph
 * and the Docker runtime stage has to copy it explicitly — the same treatment
 * schema.sql gets.
 *
 * Assembled from parts rather than written as one literal, because Turbopack
 * statically analyses the argument to `fork` and tries to resolve it as a module
 * at build time. It is a runtime file, so that resolution fails and takes
 * `next build` down with it. `turbopackIgnore` does not help — the magic comments
 * only apply to `import()` and `require()`, not to child_process.
 */
const WORKER_SEGMENTS = ['scripts', 'embed-worker.mjs']

/**
 * Raised when the embedding process died rather than returning an error.
 *
 * Worth its own type because it means something different from a failed
 * embedding: the model is fine, the process is gone, and retrying on a fresh one
 * is a reasonable thing to do.
 */
export class EmbedderCrashed extends Error {
  constructor(reason: string) {
    super(`The embedding process stopped unexpectedly (${reason})`)
    this.name = 'EmbedderCrashed'
  }
}

interface Pending {
  resolve: (vectors: number[][]) => void
  reject: (error: Error) => void
}

interface WorkerReply {
  id: number
  vectors?: number[][]
  error?: string
}

let worker: ChildProcess | null = null
const pending = new Map<number, Pending>()
let nextRequestId = 1

/**
 * The embedding model runs in a child process.
 *
 * onnxruntime can abort the process it runs in — its ArmKleidiAI SME2 kernels
 * raised SIGILL on Apple Silicon partway through indexing a series and took the
 * whole web server down with them. A native crash is not catchable in-process,
 * so embedding is kept out of the process that serves requests. The runtime is
 * also pinned below the version carrying those kernels (see package.json); this
 * is the belt to that braces, and it covers the next such bug too.
 */
function getWorker(): ChildProcess {
  if (worker) return worker

  // Reached by property lookup for the same reason the path is assembled: the
  // build-time scan matches a direct `fork(...)` call and nothing else.
  const startWorker = childProcess['fork']

  const child = startWorker(join(process.cwd(), ...WORKER_SEGMENTS), [], {
    env: {
      ...process.env,
      JELLYMEME_MODEL_CACHE: MODEL_CACHE,
      JELLYMEME_EMBEDDING_MODEL: EMBEDDING_MODEL,
    },
    // stdout and stderr are inherited so a model download or a native crash
    // message still reaches the server's log rather than vanishing.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })

  child.on('message', (reply: WorkerReply) => {
    const waiting = pending.get(reply.id)
    if (!waiting) return
    pending.delete(reply.id)
    if (reply.error) waiting.reject(new Error(reply.error))
    else waiting.resolve(reply.vectors ?? [])
  })

  child.on('exit', (code, signal) => {
    worker = null
    // Everything in flight died with it. Failing them explicitly is what turns a
    // silent hang into an error the index job can report against one episode.
    const reason = signal ? `signal ${signal}` : `exit code ${code}`
    for (const [id, waiting] of pending) {
      pending.delete(id)
      waiting.reject(new EmbedderCrashed(reason))
    }
  })

  child.on('error', (error) => {
    worker = null
    for (const [id, waiting] of pending) {
      pending.delete(id)
      waiting.reject(new EmbedderCrashed(error.message))
    }
  })

  // The server must be able to exit without waiting for the model to unload.
  child.unref()
  worker = child
  return child
}

function requestEmbedding(texts: string[]): Promise<number[][]> {
  const child = getWorker()
  const id = nextRequestId++

  return new Promise<number[][]>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.send({ id, texts }, (error) => {
      if (!error) return
      pending.delete(id)
      reject(new EmbedderCrashed(error.message))
    })
  })
}

/** Warms the model so the first user-facing request is not the one that pays for the download. */
export async function warmUpEmbedder(): Promise<void> {
  await embed(['warm up'])
}

/**
 * Embeds a batch of texts into unit-length vectors.
 *
 * Mean pooling plus L2 normalisation means cosine similarity reduces to a dot
 * product, which is what sqlite-vec's cosine metric expects.
 *
 * A crashed worker is retried once on a fresh process. The crash this guards
 * against depended on matmul shape and thread timing rather than on the text, so
 * the same batch usually succeeds second time — and one retry is the difference
 * between an index run losing an episode and losing nothing.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []

  const rows = await requestEmbedding(texts).catch(async (error: unknown) => {
    if (!(error instanceof EmbedderCrashed)) throw error
    return requestEmbedding(texts)
  })

  return rows.map((row) => Float32Array.from(row))
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [vector] = await embed([text])
  return vector
}

/** Stops the embedding process. Tests use this; the server has no reason to. */
export function stopEmbedder(): void {
  worker?.kill()
  worker = null
}
