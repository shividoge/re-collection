import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dataMode, errorMessage, guide, palaceLive, type Arrangement, type ArrangementItem, type GuideWords } from '../data'
import {
  arrangedExhibition,
  automaticArrangement,
  loadArrangement,
  loadVisits,
  pieceArtwork,
  piecesOf,
  resetArrangement,
  saveArrangement,
  type Visit,
} from './exhibitions'
import { planMuseum } from './layout'
import { visitLink } from './live/visitKey'
import { MuseumScene } from './MuseumScene'
import type { WalkerHandle } from './Walker'
import type { Dive } from './warp'
import './museum.css'
import './editor.css'

const STATIC = dataMode === 'static'

const CAPTION_MAX = 240
const TITLE_MAX = 80

/** A row in the editor: an arrangement item plus a key that survives reordering. */
type Row = ArrangementItem & { key: number }
type Draft = { title: string; subtitle: string; rows: Row[] }

let nextKey = 1
const toDraft = (a: Arrangement): Draft => ({ title: a.title, subtitle: a.subtitle, rows: a.items.map((i) => ({ ...i, key: nextKey++ })) })
const toArrangement = (d: Draft): Omit<Arrangement, 'updatedAt'> => ({
  title: d.title.trim(),
  subtitle: d.subtitle.trim(),
  items: d.rows.map(({ capture, piece, title, caption, notes, avoid }) => ({
    capture,
    piece,
    title: title.trim(),
    caption: caption.trim(),
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
    ...(avoid?.trim() ? { avoid: avoid.trim() } : {}),
  })),
})
/** What the caretaker may tell the AI guide about one memory (backend lib/guide.ts). */
const NOTES_MAX = 2000
const AVOID_MAX = 400

/**
 * Her link with the live visit's key: the same for her iPad and for family joining her visits.
 * Making a new one stops the old link working (her iPad too) and lets everyone in a visit out.
 */
function VisitLink() {
  const [key, setKey] = useState<string | null>(null)
  const [state, setState] = useState<{ kind: 'busy' | 'ok' | 'error'; text: string } | null>({ kind: 'busy', text: 'Getting her link…' })
  useEffect(() => {
    palaceLive
      .makeVisitKey(false)
      .then((k) => {
        setKey(k)
        setState(null)
      })
      .catch((e: unknown) => setState({ kind: 'error', text: errorMessage(e) }))
  }, [])
  const replace = async () => {
    if (!confirm('Make a new link? The old one stops working, on her iPad too, and anyone visiting now is let out.')) return
    setState({ kind: 'busy', text: 'Making a new link…' })
    try {
      setKey(await palaceLive.makeVisitKey(true))
      setState({ kind: 'ok', text: 'New link made. Open it on her iPad and send it to the family again.' })
    } catch (e) {
      setState({ kind: 'error', text: errorMessage(e) })
    }
  }
  const link = key ? visitLink(key) : ''
  return (
    <div className="me-visit-link">
      <label className="me-field me-link">
        <span>Her link (her iPad, and family joining her visits)</span>
        <input readOnly value={link} placeholder="…" onFocus={(e) => e.target.select()} />
      </label>
      <p className="me-hint">Family who open it can join her visits from anywhere and talk with her. Share it only with family.</p>
      <div className="me-link-tools">
        <button disabled={!key} onClick={() => void navigator.clipboard?.writeText(link).then(() => setState({ kind: 'ok', text: 'Link copied.' }))}>
          Copy link
        </button>
        <button className="me-reset" disabled={!key || state?.kind === 'busy'} onClick={() => void replace()}>
          Make a new link
        </button>
      </div>
      {state && <p className={`me-status ${state.kind}`}>{state.text}</p>}
    </div>
  )
}

/**
 * The caretaker's side of the museum (`#/museum/edit`): choose which pictures hang, put them in
 * order, and write a title and a few words for each one's label, with the museum itself as a live
 * preview. Saving stores it on the server, and the patient's museum (`#/museum`) shows exactly that.
 */
export function MuseumEditor() {
  const [visits, setVisits] = useState<Visit[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  // The AI guide's words for each memory, rewritten after each save (live mode only).
  const [guideWords, setGuideWords] = useState<Map<string, GuideWords>>(new Map())
  useEffect(() => {
    if (!guide.available()) return
    return guide.watch((words) => setGuideWords(new Map(words.map((w) => [w.key, w]))))
  }, [])
  const [savedJson, setSavedJson] = useState('')
  const [custom, setCustom] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const [selected, setSelected] = useState(-1)
  const [adding, setAdding] = useState(false)
  const dragFrom = useRef(-1)

  const load = useCallback(async () => {
    const [all, saved] = await Promise.all([loadVisits(), loadArrangement()])
    setVisits(all)
    const start = saved && saved.items.length > 0 ? saved : automaticArrangement(all)
    const d = toDraft(start)
    setDraft(d)
    setSavedJson(JSON.stringify(toArrangement(d)))
    setCustom(Boolean(saved && saved.items.length > 0))
  }, [])
  useEffect(() => {
    load().catch((e: Error) => setStatus({ kind: 'error', text: e.message }))
  }, [load])

  const dirty = draft !== null && JSON.stringify(toArrangement(draft)) !== savedJson
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const byId = useMemo(() => new Map((visits ?? []).map((v) => [v.id, v])), [visits])
  const rows = draft?.rows ?? []
  const setRows = (f: (rows: Row[]) => Row[]) => setDraft((d) => (d ? { ...d, rows: f(d.rows) } : d))
  const change = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, k) => (k === i ? { ...row, ...patch } : row)))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return
    setRows((r) => {
      const next = r.slice()
      const [row] = next.splice(from, 1)
      next.splice(to, 0, row)
      return next
    })
    setSelected(to)
  }
  const remove = (i: number) => {
    setRows((r) => r.filter((_, k) => k !== i))
    setSelected(-1)
  }
  const add = (v: Visit, piece: string) => {
    setRows((r) => [...r, { capture: v.id, piece, title: '', caption: '', key: nextKey++ }])
    setSelected(rows.length)
  }

  // The live preview: the patient's museum, built from the draft.
  const exhibition = useMemo(
    () => (draft && visits ? arrangedExhibition(toArrangement(draft) as Arrangement, visits) : null),
    [draft, visits],
  )
  const plan = useMemo(() => planMuseum(Math.max(1, exhibition?.items.length ?? 1)), [exhibition?.items.length])
  const walker = useRef<WalkerHandle>(null)
  const dive = useRef<Dive | null>(null)
  const [focus, setFocus] = useState(-1)
  const show = useCallback(
    (i: number) => {
      setSelected(i)
      const slot = plan.slots[i]
      if (!slot) return
      setFocus(i)
      walker.current?.walkTo(slot.view, slot.center)
    },
    [plan],
  )

  async function save() {
    if (!draft) return
    setStatus({ kind: 'busy', text: 'Saving…' })
    try {
      const saved = await saveArrangement(toArrangement(draft))
      setSavedJson(JSON.stringify(toArrangement(draft)))
      setCustom(true)
      const at = saved.updatedAt ? new Date(saved.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
      setStatus({ kind: 'ok', text: STATIC ? `Saved in this browser ${at}` : `Saved ${at}. Her museum shows it now.` })
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  async function reset() {
    if (!window.confirm('Go back to the automatic museum (every visit, oldest first)? Your titles, captions and order are cleared.')) return
    try {
      await resetArrangement()
      await load()
      setSelected(-1)
      setStatus({ kind: 'ok', text: 'Back to the automatic museum.' })
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  const patientLink = `${location.origin}${location.pathname}#/museum`

  if (status?.kind === 'error' && !draft) return <div className="museum-message">{status.text}</div>
  if (!draft || !visits || !exhibition) return <div className="museum-message">Opening the museum…</div>

  return (
    <div className="museum museum-editor">
      <aside className="me-panel">
        <header className="me-head">
          <a className="me-back" href="#/">
            ← Front page
          </a>
          <h1>Set up her museum</h1>
          <p>Choose the pictures she'll see, put them in order, and write a few words for each label. She sees exactly this.</p>
          {STATIC && <p className="me-note">This public demo has no server, so saving keeps it in this browser only.</p>}
        </header>

        <section className="me-section">
          <label className="me-field">
            <span>Museum title</span>
            <input value={draft.title} maxLength={TITLE_MAX} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Our visits" />
          </label>
          <label className="me-field">
            <span>Under the title</span>
            <input
              value={draft.subtitle}
              maxLength={TITLE_MAX}
              onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
              placeholder="Every visit the family filmed, oldest first"
            />
          </label>
        </section>

        <section className="me-section">
          <div className="me-section-head">
            <h2>
              On the walls <span>{rows.length}</span>
            </h2>
            <button className="me-add-toggle" onClick={() => setAdding(!adding)} aria-expanded={adding}>
              {adding ? 'Done adding' : '+ Add pictures'}
            </button>
          </div>

          {adding && (
            <div className="me-library">
              {visits.map((v) => (
                <div key={v.id} className="me-visit">
                  <strong>{v.title}</strong>
                  <span>{v.date}</span>
                  <div className="me-pieces">
                    {piecesOf(v).map((piece) => {
                      const art = pieceArtwork(v, piece)
                      if (!art) return null
                      return (
                        <button key={piece} className="me-piece" onClick={() => add(v, piece)} title={`Hang ${piece === 'video' ? 'the video' : 'this picture'}`}>
                          <img src={art.poster ?? art.src} alt="" loading="lazy" />
                          {piece === 'video' && <span className="me-badge">▶ video</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {rows.length === 0 && <p className="me-empty">Nothing hangs yet. Press “+ Add pictures”.</p>}
          <ol className="me-rows">
            {rows.map((row, i) => {
              const v = byId.get(row.capture)
              const art = v ? pieceArtwork(v, row.piece) : null
              return (
                <li
                  key={row.key}
                  className={`me-row${i === selected ? ' on' : ''}`}
                  draggable
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => move(dragFrom.current, i)}
                  onClick={() => show(i)}
                >
                  <span className="me-n">{i + 1}</span>
                  <div className="me-thumb">
                    {art ? <img src={art.poster ?? art.src} alt="" loading="lazy" /> : <span>missing</span>}
                    {row.piece === 'video' && <span className="me-badge">▶</span>}
                  </div>
                  <div className="me-words">
                    <input
                      value={row.title}
                      maxLength={TITLE_MAX}
                      placeholder={v?.title ?? 'Title'}
                      onChange={(e) => change(i, { title: e.target.value })}
                      onFocus={() => show(i)}
                      aria-label={`Title of picture ${i + 1}`}
                    />
                    <textarea
                      value={row.caption}
                      maxLength={CAPTION_MAX}
                      rows={2}
                      placeholder="A few words for her (optional)"
                      onChange={(e) => change(i, { caption: e.target.value })}
                      onFocus={() => show(i)}
                      aria-label={`Caption of picture ${i + 1}`}
                    />
                    {row.caption.length > CAPTION_MAX - 40 && (
                      <span className="me-count">
                        {row.caption.length}/{CAPTION_MAX}
                      </span>
                    )}
                    {guide.available() && <GuideFields row={row} words={guideWords.get(guide.key(row))} onChange={(patch) => change(i, patch)} onFocus={() => show(i)} />}
                  </div>
                  <div className="me-tools">
                    <button onClick={(e) => (e.stopPropagation(), move(i, i - 1))} disabled={i === 0} aria-label="Move up">
                      ↑
                    </button>
                    <button onClick={(e) => (e.stopPropagation(), move(i, i + 1))} disabled={i === rows.length - 1} aria-label="Move down">
                      ↓
                    </button>
                    <button onClick={(e) => (e.stopPropagation(), remove(i))} aria-label="Take down">
                      ✕
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <footer className="me-foot">
          <div className="me-buttons">
            <button className="me-save" onClick={() => void save()} disabled={!dirty || status?.kind === 'busy'}>
              {dirty ? 'Save' : 'Saved'}
            </button>
            <a className="me-open" href="#/museum">
              Open her museum →
            </a>
          </div>
          {status && <p className={`me-status ${status.kind}`}>{status.text}</p>}
          {STATIC ? (
            <label className="me-field me-link">
              <span>Her link (for the iPad)</span>
              <input readOnly value={patientLink} onFocus={(e) => e.target.select()} />
            </label>
          ) : (
            <VisitLink />
          )}
          {custom && (
            <button className="me-reset" onClick={() => void reset()}>
              Go back to the automatic museum
            </button>
          )}
        </footer>
      </aside>

      <div className="me-preview">
        <MuseumScene
          exhibition={exhibition}
          plan={plan}
          focus={focus}
          onSelect={show}
          onArrive={() => {}}
          onLook={() => {}}
          walker={walker}
          dive={dive}
          onMeasure={() => {}}
        />
        <p className="me-preview-label">Live preview · drag to look around, click a picture to find it in the list</p>
      </div>
    </div>
  )
}

/**
 * What the caretaker tells the AI guide about one memory: the story behind it (the guide's only
 * source, with the approved facts), and anything it must never bring up. Below, what the guide
 * will say, once it has written it after a save.
 */
function GuideFields({ row, words, onChange, onFocus }: { row: ArrangementItem; words?: GuideWords; onChange: (patch: Partial<ArrangementItem>) => void; onFocus: () => void }) {
  const has = Boolean(row.notes?.trim())
  return (
    <details className="me-guide" open={has}>
      <summary>{has ? 'For the AI guide ✓' : '+ Tell the AI guide about this memory'}</summary>
      <textarea
        value={row.notes ?? ''}
        maxLength={NOTES_MAX}
        rows={4}
        placeholder="Who is in it, where and when, what happened, what they loved about it. The guide says only what's written here and the approved facts."
        onChange={(e) => onChange({ notes: e.target.value })}
        onFocus={onFocus}
        aria-label="Notes for the AI guide"
      />
      <input
        value={row.avoid ?? ''}
        maxLength={AVOID_MAX}
        placeholder="Never bring up (e.g. someone who has passed away)"
        onChange={(e) => onChange({ avoid: e.target.value })}
        onFocus={onFocus}
        aria-label="Never bring up"
      />
      {words?.status === 'preparing' && <p className="me-guide-status">The guide is writing what it will say…</p>}
      {words?.status === 'failed' && <p className="me-guide-status error">The guide couldn't write this one: {words.error}</p>}
      {words?.status === 'ready' && (words.intro || words.story) && (
        <div className="me-guide-preview">
          {words.intro && (
            <p>
              <strong>At the frame:</strong> {words.intro}
            </p>
          )}
          {words.story && (
            <p>
              <strong>Inside:</strong> {words.story}
            </p>
          )}
          {words.error && <p className="me-guide-status">{words.error}</p>}
        </div>
      )}
    </details>
  )
}
