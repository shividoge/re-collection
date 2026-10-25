// Writes the public data as plain files for GitHub Pages (architecture-v3.md §8), from the
// public.* queries only, so the privacy rules are the backend's:
//
//   <out>/data/captures.json            data/captures/<id>.json      data/moments/<id>.json
//   data/progress/<id>.json             data/sessions/<sid>.json     data/museum/arrangement.json
//   data/files/<id>/<raw name>          data/files/<id>/derived/<derived name>
//
// Every URL inside a JSON file is relative to that file. Derived files are stored gzipped in R2;
// fetch removes the gzip, and Pages compresses on its own.
//
//   bun scripts/export-static.ts [outDir]     (default ../.static-site)
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import { scriptEnv } from './env'
import { exportCapture, exportList, type Download } from './plan'

/** GitHub rejects files over 100 MB and asks sites to stay under about 1 GB. */
const FILE_LIMIT = 95 * 1024 ** 2
const SITE_LIMIT = 900 * 1024 ** 2
const MARKER = '.braindance-static-data'

const outDir = resolve(process.argv[2] ?? join(import.meta.dir, '../../.static-site'))
const out = join(outDir, 'data')
if (existsSync(out) && !existsSync(join(out, MARKER))) {
  console.error(`${out} exists and wasn't made by this exporter. Pick another folder.`)
  process.exit(1)
}
const client = new ConvexHttpClient(scriptEnv().convexUrl)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, MARKER), 'static export of the public Braindance captures\n')
const write = (path: string, body: unknown) => {
  if (body === null || body === undefined) return false
  mkdirSync(dirname(join(out, path)), { recursive: true })
  writeFileSync(join(out, path), JSON.stringify(body))
  return true
}

async function download(d: Download): Promise<number> {
  const res = await fetch(d.url)
  if (!res.ok) throw new Error(`${d.path}: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  mkdirSync(dirname(join(out, d.path)), { recursive: true })
  writeFileSync(join(out, d.path), bytes)
  return bytes.length
}

const warnings: string[] = []
let total = 0
let sessions = 0
const list = await client.query(api.public.captures, {})
write('captures.json', exportList(list))

for (const { id } of list) {
  const capture = await client.query(api.public.capture, { captureId: id })
  if (!capture) continue
  const { json, downloads } = exportCapture(capture)
  write(`captures/${id}.json`, json)
  write(`moments/${id}.json`, await client.query(api.public.moment, { captureId: id }))
  const progress = await client.query(api.public.progress, { captureId: id })
  write(`progress/${id}.json`, progress)
  for (const s of progress?.sessions ?? []) if (write(`sessions/${s.sessionId}.json`, await client.query(api.public.session, { sessionId: s.sessionId }))) sessions += 1

  let bytes = 0
  for (const d of downloads) {
    const size = await download(d)
    bytes += size
    if (size > FILE_LIMIT) warnings.push(`${d.path} is ${(size / 1024 ** 2).toFixed(0)} MB; GitHub rejects files over 100 MB.`)
  }
  total += bytes
  console.log(`${id}: ${downloads.length} files, ${(bytes / 1024 ** 2).toFixed(1)} MB`)
}

const arrangement = await client.query(api.public.arrangement, {})
if (arrangement) write('museum/arrangement.json', arrangement)
if (total > SITE_LIMIT) warnings.push(`The site is ${(total / 1024 ** 2).toFixed(0)} MB; GitHub Pages sites should stay under about 1 GB.`)
console.log(`${list.length} public captures, ${sessions} sessions, ${(total / 1024 ** 2).toFixed(1)} MB → ${out}`)
for (const w of warnings) console.log(`warning: ${w}`)
