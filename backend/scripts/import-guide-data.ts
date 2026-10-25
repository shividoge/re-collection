// Imports a guide data folder (captures/, sessions/, people.json, museum.json) into Convex + R2,
// the way a client would: captures.begin, the review state, then every file through
// uploads.start / PUT / uploads.finish, then captures.complete; sessions, the person, the museum
// arrangement and public flags after. Safe to run again: files already stored with the same size
// are skipped, and the rest is replaced.
//
//   bun scripts/import-guide-data.ts <dataDir> [--dry-run] [--only <captureId>]
//
// --dry-run reads the folder and checks every package against its manifest locally (the same check
// captures.complete runs), without touching Convex or R2. Never writes to <dataDir>.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { parseManifest } from '../../shared/manifest'
import { api } from '../convex/_generated/api'
import { readDepthIndex, validatePackage, type RegisteredFile } from '../convex/lib/validate'
import { scriptEnv } from './env'
import { isPackageFile, toMoment, toSession, uploadPlan } from './plan'
import { putFile } from './upload'

const args = process.argv.slice(2)
const dataDir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--only')
const dryRun = args.includes('--dry-run')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.toLowerCase() : undefined
if (!dataDir) {
  console.error('Usage: bun scripts/import-guide-data.ts <dataDir> [--dry-run] [--only <captureId>]')
  process.exit(2)
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function listLocal(dir: string): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const name = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
    out.push({ name, bytes: statSync(join(dir, name)).size })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The check captures.complete will run, from local sizes (depth v2 index read from disk). */
function localCheck(id: string, dir: string, files: { name: string; bytes: number }[]) {
  const manifest = parseManifest(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const registered: RegisteredFile[] = files.filter((f) => isPackageFile(f.name)).map((f) => {
    if (manifest.depth.encoding === 'v2' && f.name === manifest.depth.index) {
      const index = readDepthIndex(readJson(join(dir, f.name)))
      if (!('error' in index)) return { ...f, indexedBytes: index.bytes, indexedCount: index.count }
    }
    return f
  })
  return validatePackage(id, manifest, registered)
}

async function main(root: string) {
  const capturesDir = join(root, 'captures')
  const ids = readdirSync(capturesDir).filter((n) => UUID.test(n) && (!only || n.toLowerCase() === only))
  const env = dryRun ? null : scriptEnv()
  const client = env ? new ConvexHttpClient(env.convexUrl) : null
  const imported = new Set<string>()
  let problems = 0

  for (const id of ids) {
    const dir = join(capturesDir, id)
    if (!existsSync(join(dir, 'manifest.json'))) {
      console.log(`${id}: no manifest.json, skipped`)
      continue
    }
    const local = listLocal(dir)
    const check = localCheck(id, dir, local)
    const mb = (local.reduce((s, f) => s + f.bytes, 0) / 1024 ** 2).toFixed(0)
    console.log(`${id}: ${local.filter((f) => isPackageFile(f.name)).length} files, ${mb} MB, ${check.ok ? 'package OK' : `PACKAGE PROBLEMS: ${check.errors.join(' ')}`}`)
    if (!check.ok) problems += 1
    if (!client || !env) continue

    const manifestJson = readFileSync(join(dir, 'manifest.json'), 'utf8')
    await client.mutation(api.captures.begin, { manifestJson })
    // The review first, so registering the files doesn't start a new extraction.
    if (existsSync(join(dir, 'moment.json'))) await client.mutation(api.admin.importMoment, { token: env.token, moment: toMoment(id, readJson(join(dir, 'moment.json'))) })

    const stored = (await client.query(api.captures.get, { captureId: id }))?.files ?? []
    const plan = uploadPlan(local, stored)
    for (const [i, f] of plan.entries()) {
      const target = await client.action(api.uploads.start, { captureId: id, name: f.name, bytes: f.bytes, contentType: f.contentType })
      const parts = await putFile(join(dir, f.name), f.bytes, target)
      await client.action(api.uploads.finish, { uploadId: target.uploadId, ...(parts ? { parts } : {}) })
      if (f.bytes > 8 * 1024 ** 2 || i === plan.length - 1) console.log(`  uploaded ${i + 1}/${plan.length} (${f.name}, ${(f.bytes / 1024 ** 2).toFixed(1)} MB)`)
    }
    const status = (await client.query(api.moments.get, { captureId: id })).status
    if (plan.length > 0 || status?.upload !== 'done') {
      try {
        await client.action(api.captures.complete, { captureId: id })
        console.log('  complete: bake queued')
      } catch (error) {
        problems += 1
        console.log(`  complete failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      console.log('  already complete, nothing new')
    }
    const statusFile = join(dir, 'status.json')
    if (existsSync(statusFile)) {
      const isPublic = (readJson(statusFile) as { public?: unknown }).public === true
      await client.mutation(api.captures.setPublic, { captureId: id, public: isPublic })
    }
    imported.add(id.toLowerCase())
  }

  const sessionsDir = join(root, 'sessions')
  if (existsSync(sessionsDir)) {
    let count = 0
    for (const name of readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))) {
      const session = toSession(readJson(join(sessionsDir, name)))
      if (!ids.some((id) => id.toLowerCase() === session.captureId)) continue
      count += 1
      if (client && env && imported.has(session.captureId)) await client.mutation(api.admin.importSession, { token: env.token, session })
    }
    console.log(`sessions: ${count} ${client ? 'imported' : 'found'}`)
  }
  const peopleFile = join(root, 'people.json')
  if (existsSync(peopleFile)) {
    const p = readJson(peopleFile) as { displayName?: string; preferredAddress?: string }
    if (client) await client.mutation(api.people.set, { displayName: p.displayName ?? '', preferredAddress: p.preferredAddress ?? '' })
    console.log(`person: ${p.displayName ?? ''} (${p.preferredAddress ?? ''})`)
  }
  const museumFile = join(root, 'museum.json')
  if (existsSync(museumFile) && !only) {
    const m = readJson(museumFile) as { title?: string; subtitle?: string; items?: { capture: string; piece: string; title?: string; caption?: string }[] }
    const items = (m.items ?? []).map((i) => ({ capture: i.capture, piece: i.piece, title: i.title ?? '', caption: i.caption ?? '' }))
    if (client) await client.mutation(api.museum.setArrangement, { title: m.title ?? '', subtitle: m.subtitle ?? '', items })
    console.log(`museum arrangement: ${items.length} pictures`)
  }
  if (problems) {
    console.log(`${problems} capture(s) had problems; see above.`)
    process.exitCode = 1
  }
}

await main(dataDir)
