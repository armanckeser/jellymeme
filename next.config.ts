import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Native and binary-bearing packages must not be bundled — they load .node
  // addons, ONNX runtimes and a static ffmpeg binary from disk at runtime.
  serverExternalPackages: [
    'better-sqlite3',
    'sqlite-vec',
    '@huggingface/transformers',
    'ffmpeg-static',
  ],
}

export default nextConfig
