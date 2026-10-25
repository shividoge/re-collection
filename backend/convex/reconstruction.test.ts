import { afterEach, expect, test, vi } from 'vitest'
import { api, CAPTURE_ID, setup, tinyCapture, TOKEN } from './test.helpers'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

test('a reviewed smaller scene requires authorization and a completed linked bake; clearing or losing it restores density selection', async () => {
  const t = setup()
  const cleanId = '22222222-2222-4333-8444-555555555555'
  const denseId = '33333333-2222-4333-8444-555555555555'
  const unrelatedId = '44444444-2222-4333-8444-555555555555'
  for (const [id, points] of [[CAPTURE_ID, 10], [cleanId, 5], [denseId, 20], [unrelatedId, 30]] as const) {
    const { manifest } = tinyCapture({ id })
    await t.mutation(api.captures.begin, { manifestJson: JSON.stringify({ ...manifest, room: { bin: 'room.bin', points, voxelMeters: .01 } }) })
  }
  for (const captureId of [cleanId, denseId]) {
    await t.mutation(api.admin.registerReconstruction, { token: TOKEN, originalId: CAPTURE_ID, captureId })
  }
  const select = { token: TOKEN, originalId: CAPTURE_ID, reconstructionId: cleanId }
  await expect(t.mutation(api.admin.preferReconstruction, { ...select, token: 'wrong' })).rejects.toThrow()
  await expect(t.mutation(api.admin.preferReconstruction, { ...select, reconstructionId: unrelatedId })).rejects.toThrow(/not linked/)
  await expect(t.mutation(api.admin.preferReconstruction, select)).rejects.toThrow(/completed reconstruction/)
  await t.run(async (ctx) => {
    for (const [id, points] of [[cleanId, 5], [denseId, 20]] as const) {
      const row = await ctx.db.query('captures').withIndex('by_captureId', q => q.eq('captureId', id)).unique()
      await ctx.db.patch(row!._id, {
        status: { ...row!.status, upload: 'done', bake: 'done' },
        derived: { format: 'braindance.derived', version: 1, captureId: id, bakedAt: '2026-10-25T00:00:00Z', bakeVersion: 'test', files: { points: 'points.pack' }, stats: { points, bakeMs: 1 } },
      })
    }
  })
  const selected = async () => (await t.query(api.captures.get, { captureId: CAPTURE_ID }))?.reconstruction?.id
  expect(await selected()).toBe(denseId)
  await t.mutation(api.admin.preferReconstruction, select)
  expect(await selected()).toBe(cleanId)
  expect((await t.query(api.captures.list, {})).map(c => c.id)).not.toContain(cleanId)
  await t.mutation(api.admin.preferReconstruction, { ...select, reconstructionId: null })
  expect(await selected()).toBe(denseId)
  await t.mutation(api.admin.preferReconstruction, select)
  await t.run(async ctx => {
    const row = await ctx.db.query('captures').withIndex('by_captureId', q => q.eq('captureId', cleanId)).unique()
    await ctx.db.patch(row!._id, { deleting: true })
  })
  expect(await selected()).toBe(denseId)
})
