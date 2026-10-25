// bun run bake --local <captureDir> --out <dir>
// Bakes a capture folder on disk and writes the derived files twice: as is, and as .gz (what
// the job uploads). For testing, and as fixtures for the web.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { bakeCapture } from './bake'
import { listDir } from './listing'
import { ValidationError } from './validate'
import { bakeVersion } from './version'

const { values } = parseArgs({ options: { local: { type: 'string' }, out: { type: 'string' } } })
if (!values.local || !values.out) {
  console.error('Usage: bun run bake --local <captureDir> --out <dir>')
  process.exit(2)
}
const out = values.out
try {
  const result = await bakeCapture(values.local, await listDir(values.local), {
    bakeVersion: bakeVersion(),
    onProgress: (p) => console.error(`  ${Math.round((p.fraction ?? 0) * 100)}% ${p.message}`),
  })
  await mkdir(out, { recursive: true })
  for (const f of result.files) {
    await Bun.write(join(out, f.name), f.bytes)
    const gz = f.gzip ? gzipSync(f.bytes, { level: 6 }) : null
    if (gz) await Bun.write(join(out, `${f.name}.gz`), gz)
    console.log(`${f.name.padEnd(18)} ${String(f.bytes.byteLength).padStart(10)} bytes${gz ? `  gzip ${String(gz.byteLength).padStart(10)}` : ''}`)
  }
  console.log(JSON.stringify({ stats: result.derived.stats, timings: result.timings }))
} catch (e) {
  if (e instanceof ValidationError) {
    console.error('The capture is not valid:')
    for (const err of e.errors) console.error(`- ${err}`)
    process.exit(1)
  }
  throw e
}
