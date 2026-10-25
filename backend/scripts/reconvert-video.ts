// Converts a video capture again with the current converter (tools/video2capture), keeping its
// id, facts, review and sessions: admin.reconvertVideo, then the source video through
// uploads.start / PUT / uploads.finish, which queues the GPU conversion. A new splat follows it.
//
//   bun scripts/reconvert-video.ts <captureId> <source video>
import { statSync } from 'node:fs'
import { extname } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import { scriptEnv } from './env'
import { putFile } from './upload'

const [captureId, video] = process.argv.slice(2)
if (!captureId || !video) {
  console.error('Usage: bun scripts/reconvert-video.ts <captureId> <source video>')
  process.exit(2)
}
const ext = extname(video).slice(1).toLowerCase()
const types: Record<string, string> = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4' }
if (!types[ext]) throw new Error(`${video}: expected a .mov, .mp4 or .m4v video.`)

const env = scriptEnv()
const client = new ConvexHttpClient(env.convexUrl)
const bytes = statSync(video).size
await client.mutation(api.admin.reconvertVideo, { token: env.token, captureId })
const target = await client.action(api.uploads.start, { captureId, name: `source.${ext}`, bytes, contentType: types[ext] })
if (!target.key.startsWith('videos/')) throw new Error(`The upload went to ${target.key}, not the source video's place.`)
const parts = await putFile(video, bytes, target)
await client.action(api.uploads.finish, { uploadId: target.uploadId, ...(parts ? { parts } : {}) })
console.log(`${captureId}: uploaded ${(bytes / 1024 ** 2).toFixed(1)} MB; conversion queued.`)
