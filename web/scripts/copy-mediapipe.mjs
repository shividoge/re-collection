// Copies MediaPipe's WebAssembly runtime into public/ so the Memory Window's head tracking
// works offline and same-origin (nothing loads from a CDN). Runs before dev and build.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(web, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const to = join(web, 'public', 'mediapipe')
if (!existsSync(from)) {
  console.error('copy-mediapipe: @mediapipe/tasks-vision is not installed; run npm install in web/.')
  process.exit(1)
}
mkdirSync(to, { recursive: true })
for (const name of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  cpSync(join(from, name), join(to, name))
}
