/**
 * Embedding, in a process of its own.
 *
 * This exists because onnxruntime can die on an illegal instruction mid-matmul —
 * on Apple Silicon its ArmKleidiAI SME2 kernels raised SIGILL and killed the
 * whole web server, halfway through indexing a series, leaving no error and no
 * log. A native crash cannot be caught by a try/catch in the process it happens
 * in, so the only way to survive one is to not be in that process.
 *
 * Plain JavaScript on purpose: `fork` needs a real file on disk, and this must
 * run without a TypeScript loader or the app's path aliases. It is deliberately
 * dumb — one model, one message type — so that the interesting logic stays in
 * embed.ts where it can be typed and tested.
 */
import { pipeline, env } from '@huggingface/transformers'

env.cacheDir = process.env.JELLYMEME_MODEL_CACHE
env.allowLocalModels = true

const MODEL = process.env.JELLYMEME_EMBEDDING_MODEL

let extractor = null

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' })
  }
  return extractor
}

process.on('message', async (message) => {
  const { id, texts } = message
  try {
    const extract = await getExtractor()
    const output = await extract(texts, { pooling: 'mean', normalize: true })
    process.send({ id, vectors: output.tolist() })
  } catch (error) {
    // An ordinary failure (a bad tensor shape, a missing model) reports back and
    // leaves the worker usable. Only a native crash takes the process with it.
    process.send({ id, error: error instanceof Error ? error.message : String(error) })
  }
})

// Without this a worker outlives the server that spawned it and sits on the
// model's memory forever.
process.on('disconnect', () => process.exit(0))
