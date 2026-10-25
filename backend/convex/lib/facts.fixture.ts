// Claude's reply for the guide's facts tests: one grounded fact, one invented one.
export const goodReply = {
  moment: { title: 'Cake visit', place: 'a kitchen', occasion: '', summary: 'Priya visited.' },
  facts: [
    {
      text: 'Priya brought a mango cake.',
      kind: 'object',
      salience: 3,
      cue: 'There was something sweet.',
      evidence: [
        { type: 'transcript', keyframe: null, tStart: 0.4, tEnd: 1.6, quote: 'I brought the mango cake' },
        { type: 'frame', keyframe: 'keyframes/k0001.jpg', tStart: null, tEnd: null, quote: null },
      ],
    },
    {
      // Invented: cites a frame Claude never saw and words nobody said.
      text: 'Grandpa played the piano.',
      kind: 'action',
      salience: 2,
      cue: 'Music',
      evidence: [
        { type: 'frame', keyframe: 'keyframes/k0099.jpg', tStart: null, tEnd: null, quote: null },
        { type: 'transcript', keyframe: null, tStart: 1, tEnd: 2, quote: 'play us a song' },
      ],
    },
  ],
  chapters: [{ tStart: 0, tEnd: 5, label: 'Arriving' }],
}
