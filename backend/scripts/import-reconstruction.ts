// Import a completed dense scene as an alternate package for an existing memory.
// bun scripts/import-reconstruction.ts <original capture ID> <capture folder>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { parseManifest } from '../../shared/manifest'
import { api } from '../convex/_generated/api'
import { readDepthIndex, validatePackage, type RegisteredFile } from '../convex/lib/validate'
import { scriptEnv } from './env'
import { isPackageFile, uploadPlan } from './plan'
import { putFile } from './upload'

const [originalId, folder] = process.argv.slice(2)
if (!originalId || !folder) throw new Error('Usage: bun scripts/import-reconstruction.ts <original capture ID> <capture folder>')
const dir = resolve(folder)
const manifestJson = readFileSync(join(dir, 'manifest.json'), 'utf8')
const manifest = parseManifest(manifestJson)
const local = readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return { name: relative(dir, path).split('\\').join('/'), bytes: statSync(path).size }
  }).filter((f) => isPackageFile(f.name))
const registered: RegisteredFile[] = local.map((f) => {
  if (manifest.depth.encoding !== 'v2' || f.name !== manifest.depth.index) return f
  const index = readDepthIndex(JSON.parse(readFileSync(join(dir, f.name), 'utf8')))
  if ('error' in index) throw new Error(index.error)
  return { ...f, indexedBytes: index.bytes, indexedCount: index.count }
})
const check = validatePackage(manifest.id, manifest, registered)
if (!check.ok) throw new Error(check.errors.join(' '))

const { convexUrl, token } = scriptEnv()
const client = new ConvexHttpClient(convexUrl)
await client.mutation(api.captures.begin, { manifestJson })
await client.mutation(api.admin.registerReconstruction, { token, captureId: manifest.id, originalId })
const stored = await client.query(api.captures.get, { captureId: manifest.id })
const plan = uploadPlan(local, stored?.files ?? [])
for (const [i, file] of plan.entries()) {
  const target = await client.action(api.uploads.start, { captureId: manifest.id, name: file.name, bytes: file.bytes, contentType: file.contentType })
  const parts = await putFile(join(dir, file.name), file.bytes, target)
  await client.action(api.uploads.finish, { uploadId: target.uploadId, ...(parts ? { parts } : {}) })
  console.log(`${i + 1}/${plan.length}: ${file.name}`)
}
if (plan.length || stored?.status.upload !== 'done') await client.action(api.captures.complete, { captureId: manifest.id })
console.log(`${originalId}: linked ${manifest.id} (${manifest.room?.points.toLocaleString()} points); selected automatically once baked`)
