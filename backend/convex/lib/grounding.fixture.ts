// The guide's test moment: f1 approved, f2 approved but "don't bring this up", f3 pending,
// f4 approved and reworded.
import type { Moment } from '../validators'

const CAPTURE_ID = '11111111-2222-4333-8444-555555555555'
type F = Moment['facts'][number]
const f = (id: string, text: string, extra: Partial<F>): F => ({
  id, text, kind: 'object', salience: 1, cue: '', status: 'pending', editedText: null, doNotRaise: false,
  evidence: [{ type: 'frame', t: 0, keyframe: 'keyframes/k0000.jpg' }], ...extra,
})
export const moment: Moment = {
  captureId: CAPTURE_ID,
  moment: { title: 'Cake visit', place: '', occasion: '', summary: '' },
  facts: [
    f('f1', 'Priya brought a mango cake.', { salience: 3, cue: 'Something sweet', status: 'approved', evidence: [{ type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' }] }),
    f('f2', 'Uncle Raj told a story about the war.', { kind: 'speech', salience: 2, status: 'approved', doNotRaise: true }),
    f('f3', 'There were yellow flowers on the table.', {}),
    f('f4', 'Dev wore a red sweater.', { kind: 'person', salience: 2, status: 'approved', editedText: 'Dev wore his red sweater.', evidence: [{ type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' }] }),
  ],
  chapters: [{ tStart: 0, tEnd: 2, label: 'Arriving' }],
  dropped: [],
  inputs: { keyframes: 2, transcriptSegments: null },
  extractedAt: '2026-10-24T20:00:00.000Z',
  model: 'stub',
}
