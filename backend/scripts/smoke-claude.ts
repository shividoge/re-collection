// One real narrate + turn + end against a deployment, on a hand-made moment that is deleted
// afterwards (nothing is left behind). Prints the latency of each call.
//   bun scripts/smoke-claude.ts
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api'
import type { Fact } from '../convex/validators'
import { scriptEnv } from './env'

const { convexUrl, token } = scriptEnv()
const client = new ConvexHttpClient(convexUrl)
const id = crypto.randomUUID()
const manifest = {
  format: 'braindance.capture', version: 1, id, createdAt: new Date().toISOString(), title: '[smoke test] Cake visit', attendees: ['Priya'],
  video: { file: 'video.mp4', width: 1920, height: 1440, fps: 30, durationSec: 20, frameCount: 600 },
  depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width: 256, height: 192, unit: 'mm', rateHz: 10, count: 0 },
  warnings: [],
}
const fact = (n: number, text: string, extra: Partial<Fact> = {}): Fact => ({
  id: `f${n}`, text, kind: 'object', salience: 2, cue: '', status: 'approved', editedText: null, doNotRaise: false,
  evidence: [{ type: 'frame', t: n * 4, keyframe: `keyframes/k${String(n * 4).padStart(4, '0')}.jpg` }], ...extra,
})
const timed = async <R>(label: string, run: () => Promise<R>): Promise<R> => {
  const t0 = performance.now()
  const result = await run()
  console.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(2)} s`)
  return result
}

await client.mutation(api.captures.begin, { manifestJson: JSON.stringify(manifest) })
try {
  await client.mutation(api.admin.importMoment, {
    token,
    moment: {
      captureId: id,
      moment: { title: 'Cake visit', place: '', occasion: '', summary: 'A short test visit.' },
      facts: [
        fact(1, 'Priya brought a mango cake.'),
        fact(2, 'There were yellow flowers on the table.'),
        fact(3, 'Uncle Raj told a story about the war.', { doNotRaise: true }),
      ],
      chapters: [{ tStart: 0, tEnd: 20, label: 'Arriving' }],
      dropped: [],
      inputs: { keyframes: 0, transcriptSegments: null },
      extractedAt: new Date().toISOString(),
      model: 'hand-made for the smoke test',
    },
  })
  const { sessionId, welcome } = await client.mutation(api.sessions.start, { captureId: id })
  console.log('welcome:', welcome.sentences.map((s) => s.sentence).join(' '))
  const narration = await timed('narrate (live model)', () => client.action(api.sessions.narrate, { sessionId, chapterIndex: 0 }))
  console.log('  said:', narration.reply.sentences.map((s) => `${s.sentence} [${s.factIds.join(',')}]`).join(' | '), `dropped ${narration.reply.dropped.length}`)
  const turn = await timed('turn (live model)', () => client.action(api.sessions.turn, { sessionId, text: 'Oh, mango cake! My mother used to bake one every summer.' }))
  console.log('  said:', turn.reply.sentences.map((s) => s.sentence).join(' | '), `branch: ${turn.branch}`, `distress: ${turn.distress}`, `dropped ${turn.reply.dropped.length}`)
  const ended = await timed('end + scoring (offline model)', () => client.action(api.sessions.end, { sessionId, reason: 'complete' }))
  console.log('  scores:', ended.scores.map((s) => `${s.factId}=${s.result}`).join(' '), '| note:', ended.note)
  const raised = [...narration.reply.sentences, ...turn.reply.sentences].some((s) => s.factIds.includes('f3') || /war/i.test(s.sentence))
  console.log(raised ? 'FAIL: the do-not-raise fact was spoken' : 'ok: the do-not-raise fact was never spoken')
} finally {
  await client.mutation(api.captures.remove, { captureId: id })
  console.log('test capture, moment and session deleted')
}
