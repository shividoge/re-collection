// Select a visually reviewed scene, or restore automatic density selection.
// bun scripts/prefer-reconstruction.ts <original capture ID> <scene ID | auto>
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import { scriptEnv } from './env'

const [originalId, sceneId] = process.argv.slice(2)
if (!originalId || !sceneId) throw new Error('Usage: bun scripts/prefer-reconstruction.ts <original capture ID> <scene ID | auto>')
const { convexUrl, token } = scriptEnv()
const client = new ConvexHttpClient(convexUrl)
await client.mutation(api.admin.preferReconstruction, { token, originalId, reconstructionId: sceneId === 'auto' ? null : sceneId })
console.log(`${originalId}: ${sceneId === 'auto' ? 'automatic density selection restored' : `preferred scene ${sceneId}`}`)
