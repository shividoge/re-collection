import { describe, expect, it } from 'vitest'
import { fingerprint, groundGuide, memoryKey, mossDocs, namesIn, sourceIdOf, sourcesOf, splitNotes, type MemoryContext } from './guide'

const CTX: MemoryContext = {
  key: 'cap/video',
  title: 'Her 80th birthday',
  caption: 'In the garden',
  notes: 'Priya baked the mango cake the night before. Sam played the violin.\nIt rained a little, so everyone moved under the big tree.',
  avoid: 'Uncle Ravi passed away last spring',
  facts: [{ id: 'f1', text: 'Priya brought a mango cake.' }],
  address: 'Mom',
}

describe('the guide\'s sources', () => {
  it('splits notes into short sources and adds the label and approved facts', () => {
    expect(splitNotes(CTX.notes)).toEqual([
      'Priya baked the mango cake the night before.',
      'Sam played the violin.',
      'It rained a little, so everyone moved under the big tree.',
    ])
    expect(sourcesOf(CTX).map((s) => s.id)).toEqual(['label', 'n1', 'n2', 'n3', 'f1'])
    expect(splitNotes('Hi. Yes.\n\nShe loved it here.')).toEqual(['Hi. Yes.', 'She loved it here.'])
  })
  it('tags Moss documents with their memory and finds the source again', () => {
    const docs = mossDocs(memoryKey({ capture: 'cap', piece: 'video' }), sourcesOf(CTX))
    expect(docs[1]).toEqual({ id: 'cap/video#n1', text: 'Priya baked the mango cake the night before.', metadata: { memory: 'cap/video', source: 'n1' } })
    expect(sourceIdOf(docs[4])).toBe('f1')
    expect(sourceIdOf({ id: 'cap/video#n2' })).toBe('n2')
  })
  it('notices when the notes change', () => {
    expect(fingerprint(CTX)).toBe(fingerprint({ ...CTX }))
    expect(fingerprint(CTX)).not.toBe(fingerprint({ ...CTX, notes: CTX.notes + ' More.' }))
  })
  it('finds names but not sentence-initial words', () => {
    expect([...namesIn('Then Priya came. Sam too.')]).toEqual(['priya'])
  })
})

describe('grounding what the guide says', () => {
  const given = sourcesOf(CTX)
  it('keeps sentences that cite what it was given', () => {
    const r = groundGuide([{ sentence: 'Priya baked the mango cake.', sources: ['n1'] }], CTX, given)
    expect(r.sentences).toEqual([{ sentence: 'Priya baked the mango cake.', sources: ['n1'] }])
  })
  it('drops sentences citing sources it was not given', () => {
    const r = groundGuide([{ sentence: 'Sam played violin.', sources: ['n9'] }], CTX, given.slice(0, 2))
    expect(r.sentences).toEqual([])
    expect(r.dropped[0].reason).toMatch(/n9/)
  })
  it('allows one plain free sentence, but not with names or numbers', () => {
    const r = groundGuide(
      [
        { sentence: 'It looks like a happy day.', sources: [] },
        { sentence: 'What a lovely afternoon.', sources: [] },
        { sentence: 'Priya was there.', sources: [] },
        { sentence: 'It was 2019.', sources: [] },
      ],
      CTX,
      given,
    )
    expect(r.sentences.map((s) => s.sentence)).toEqual(['It looks like a happy day.'])
    expect(r.dropped).toHaveLength(3)
  })
  it('never touches what the family asked not to bring up, even when cited', () => {
    const r = groundGuide([{ sentence: 'Ravi was there too.', sources: ['n1'] }], CTX, given)
    expect(r.sentences).toEqual([])
    expect(r.dropped[0].reason).toMatch(/not to bring up/)
  })
  it('lets a free sentence repeat what the person just said', () => {
    const r = groundGuide([{ sentence: 'You asked about Priya.', sources: [] }], CTX, given, 'who is Priya?')
    expect(r.sentences).toHaveLength(1)
  })
})

describe('the guide\'s notes in the arrangement', () => {
  const CAP = '11111111-2222-4333-8444-555555555555'
  it('keeps notes (with their paragraphs) and "don\'t bring up" for the guide', async () => {
    const { validateArrangement } = await import('./museum')
    const r = validateArrangement({ items: [{ capture: CAP, piece: 'video', notes: '  Line one.\n\n\n\nLine   two. ', avoid: ' Uncle Ravi ' }] }, new Set([CAP]))
    expect('value' in r && r.value.items[0]).toMatchObject({ notes: 'Line one.\n\nLine two.', avoid: 'Uncle Ravi' })
  })
  it('leaves them out of what visitors see', async () => {
    const { publicArrangement } = await import('./museum')
    const a = { title: 't', subtitle: '', items: [{ capture: CAP, piece: 'video', title: '', caption: '', notes: 'private', avoid: 'x' }] }
    expect(publicArrangement(a, [CAP])!.items[0]).toEqual({ capture: CAP, piece: 'video', title: '', caption: '' })
  })
})
