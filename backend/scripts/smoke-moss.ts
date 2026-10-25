// Checks the AI guide's use of Moss with real credentials, without touching the palace's own
// index: creates a throwaway index with documents shaped exactly as the guide makes them
// (lib/guide.ts mossDocs), searches it filtered to one memory, then deletes it.
//
//   MOSS_PROJECT_ID=... MOSS_PROJECT_KEY=... bun scripts/smoke-moss.ts
import { MossClient } from '@moss-js/moss'
import { mossDocs, mossKey, saidDoc, sourceIdOf, sourcesOf } from '../convex/lib/guide'

const id = process.env.MOSS_PROJECT_ID
const key = process.env.MOSS_PROJECT_KEY
if (!id || !key) {
  console.error('Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY first.')
  process.exit(1)
}
const client = new MossClient(id, key)
const index = `braindance-smoke-${Date.now()}`
const memory = '11111111-2222-4333-8444-555555555555/video'
const other = '11111111-2222-4333-8444-555555555555/k0012'
const docs = [
  ...mossDocs(memory, sourcesOf({ title: 'Hardware Lab table', caption: '', notes: 'Major League Hacking lends sensors, boards and cameras from this table. The tablecloth is blue.', facts: [] })),
  ...mossDocs(other, sourcesOf({ title: 'Giant letters', caption: '', notes: 'The giant lighted letters spell CAL HACKS on the stage.', facts: [] })),
  saidDoc(memory, 'my grandson borrowed a camera here once', 1),
]
try {
  console.log(`creating ${index} with ${docs.length} documents…`)
  await client.createIndex(index, docs)
  await client.loadIndex(index)
  const t = Date.now()
  const r = await client.query(index, 'what can you borrow here?', { topK: 5, filter: { field: 'memory', condition: { $eq: mossKey(memory) } } })
  console.log(`query: ${Date.now() - t} ms (Moss says ${r.timeTakenInMs ?? '?'} ms)`)
  for (const d of r.docs) console.log(`  ${sourceIdOf(d).padEnd(10)} ${d.score?.toFixed(2) ?? ''}  ${d.text}`)
  const leaked = r.docs.filter((d) => d.metadata?.memory !== mossKey(memory))
  console.log(leaked.length === 0 && r.docs.length > 0 ? 'PASS: found this memory\'s notes, and nothing from the other memory' : 'FAIL: unexpected results')
} catch (e) {
  console.error('FAIL:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await client.deleteIndex(index).catch(() => {})
  await client.close?.()
}
