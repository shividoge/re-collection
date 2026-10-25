import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { guide, STATIC, UPLOAD_TYPES, uploadMuseumFile, type Arrangement, type ArrangementItem, type MuseumUpload } from '../api'
import {
  arrangedExhibition,
  automaticArrangement,
  loadArrangement,
  loadUploads,
  loadVisits,
  pieceArtwork,
  piecesOf,
  resetArrangement,
  saveArrangement,
  uploadArtwork,
  type Artwork,
  type Visit,
} from './exhibitions'
import { MuseumPage, type MuseumHandle } from './MuseumPage'
import './museum.css'
import './editor.css'

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
  items: d.rows.map(({ capture, piece, upload, title, caption }) =>
    upload ? { upload, title: title.trim(), caption: caption.trim() } : { capture, piece, title: title.trim(), caption: caption.trim() },
  ),
})

/** A file on its way to the guide. */
type Transfer = { key: number; name: string; progress: number; error?: string }

/**
 * The caretaker's side of the museum (`#/museum/edit`): choose which pictures hang, put them in
 * order, and write a title and a few words for each one's label, with the museum itself as a live
 * preview. Saving stores it on the guide, and the patient's museum (`#/museum`) shows exactly that.
 */
export function MuseumEditor() {
  const [visits, setVisits] = useState<Visit[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedJson, setSavedJson] = useState('')
  const [custom, setCustom] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const [selected, setSelected] = useState(-1)
  const [adding, setAdding] = useState(false)
  const [uploads, setUploads] = useState<MuseumUpload[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [dropping, setDropping] = useState(false)
  // Folded: the panel slides away and the caretaker walks her museum exactly as she will.
  const [folded, setFolded] = useState(false)
  const dragFrom = useRef(-1)
  const filePicker = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const [all, saved, ups] = await Promise.all([loadVisits(), loadArrangement(), loadUploads()])
    setVisits(all)
    setUploads(ups)
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
  const uploadsById = useMemo(() => new Map(uploads.map((u) => [u.id, u])), [uploads])
  /** What a row shows: a piece of a visit, or an upload. */
  const rowArt = (row: ArrangementItem): Artwork | null => {
    if (row.upload) {
      const u = uploadsById.get(row.upload)
      return u ? uploadArtwork(u) : null
    }
    const v = row.capture ? byId.get(row.capture) : undefined
    return v && row.piece ? pieceArtwork(v, row.piece) : null
  }
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
  const hangUpload = (u: MuseumUpload) => {
    setRows((r) => [...r, { upload: u.id, title: '', caption: '', key: nextKey++ }])
  }

  /** Sends the caretaker's own photos and videos to the guide, one at a time, and hangs each one. */
  async function uploadFiles(files: File[]) {
    for (const file of files) {
      const key = nextKey++
      const name = file.name || 'untitled'
      if (!UPLOAD_TYPES.includes(file.type)) {
        setTransfers((t) => [...t, { key, name, progress: 0, error: 'Only photos (JPEG, PNG, WebP, GIF) and videos (MP4, MOV, WebM).' }])
        continue
      }
      setTransfers((t) => [...t, { key, name, progress: 0 }])
      try {
        const u = await uploadMuseumFile(file, (progress) => setTransfers((t) => t.map((x) => (x.key === key ? { ...x, progress } : x))))
        setUploads((all) => [...all, u])
        hangUpload(u)
        setTransfers((t) => t.filter((x) => x.key !== key))
      } catch (e) {
        setTransfers((t) => t.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)))
      }
    }
  }

  async function deleteUpload(u: MuseumUpload) {
    if (rows.some((r) => r.upload === u.id)) {
      setStatus({ kind: 'error', text: 'It still hangs on the walls. Take it down (✕ in the list) and save first.' })
      return
    }
    if (!window.confirm(`Delete “${u.name}” from the guide?`)) return
    try {
      await guide.deleteMuseumUpload(u.id)
      setUploads((all) => all.filter((x) => x.id !== u.id))
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  // The live preview: the patient's museum, built from the draft.
  const exhibition = useMemo(
    () => (draft && visits ? arrangedExhibition(toArrangement(draft) as Arrangement, visits, uploads) : null),
    [draft, visits, uploads],
  )
  const museum = useRef<MuseumHandle>(null)
  /** Walking up to a picture in the museum picks its row in the list. */
  const onMuseumFocus = useCallback((i: number) => {
    if (i >= 0) setSelected(i)
  }, [])
  /** A row picked in the list: walk to its picture. */
  const show = useCallback((i: number) => {
    setSelected(i)
    museum.current?.goTo(i)
  }, [])

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
    <div className={`museum museum-editor${folded ? ' folded' : ''}`}>
      <aside
        className={`me-panel${dropping ? ' dropping' : ''}`}
        // Photos and videos dropped anywhere on the panel are uploaded (a row being dragged carries no files).
        onDragOver={(e) => {
          if (STATIC || ![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          if (STATIC || e.dataTransfer.files.length === 0) return
          e.preventDefault()
          setAdding(true)
          void uploadFiles([...e.dataTransfer.files])
        }}
      >
        <header className="me-head">
          <div className="me-head-row">
            <a className="me-back" href="#/">
              ← Front page
            </a>
            <button className="me-fold" onClick={() => setFolded(true)} title="Hide this panel and walk through the museum as she will">
              Hide panel ⟩
            </button>
          </div>
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
              {!STATIC && (
                <div className="me-uploads">
                  <div className="me-upload-head">
                    <strong>Your own photos and videos</strong>
                    <button className="me-upload-button" onClick={() => filePicker.current?.click()}>
                      Upload from this device
                    </button>
                    <input
                      ref={filePicker}
                      type="file"
                      hidden
                      multiple
                      // Listing exact types makes an iPhone send its HEIC photos as JPEG.
                      accept={UPLOAD_TYPES.join(',')}
                      onChange={(e) => {
                        void uploadFiles([...(e.target.files ?? [])])
                        e.target.value = ''
                      }}
                    />
                  </div>
                  <span className="me-upload-hint">Or drop them anywhere on this panel. Each one hangs at the end of the list; only the family sees them.</span>
                  {transfers.map((t) => (
                    <div key={t.key} className={`me-transfer${t.error ? ' failed' : ''}`}>
                      <span>{t.name}</span>
                      {t.error ? (
                        <>
                          <em>{t.error}</em>
                          <button onClick={() => setTransfers((all) => all.filter((x) => x.key !== t.key))} aria-label="Dismiss">
                            ✕
                          </button>
                        </>
                      ) : (
                        <progress value={t.progress} max={1} />
                      )}
                    </div>
                  ))}
                  {uploads.length > 0 && (
                    <div className="me-pieces">
                      {uploads.map((u) => {
                        const art = uploadArtwork(u)
                        return (
                          <div key={u.id} className="me-piece-wrap">
                            <button className="me-piece" onClick={() => hangUpload(u)} title={`Hang ${u.name}`}>
                              {u.kind === 'video' ? <video src={`${art.src}#t=0.1`} muted preload="metadata" /> : <img src={art.src} alt="" loading="lazy" />}
                              {u.kind === 'video' && <span className="me-badge">▶ video</span>}
                            </button>
                            <button className="me-piece-delete" onClick={() => void deleteUpload(u)} aria-label={`Delete ${u.name}`} title="Delete from the guide">
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
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
              const v = row.capture ? byId.get(row.capture) : undefined
              const u = row.upload ? uploadsById.get(row.upload) : undefined
              const art = rowArt(row)
              const video = row.piece === 'video' || u?.kind === 'video'
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
                    {!art ? (
                      <span>missing</span>
                    ) : u?.kind === 'video' ? (
                      <video src={`${art.src}#t=0.1`} muted preload="metadata" />
                    ) : (
                      <img src={art.poster ?? art.src} alt="" loading="lazy" />
                    )}
                    {video && <span className="me-badge">▶</span>}
                  </div>
                  <div className="me-words">
                    <input
                      value={row.title}
                      maxLength={TITLE_MAX}
                      placeholder={v?.title ?? (u ? `A title for the label (${u.name})` : 'Title')}
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
            <button className="me-open" onClick={() => setFolded(true)}>
              Walk through it →
            </button>
          </div>
          {status && <p className={`me-status ${status.kind}`}>{status.text}</p>}
          <label className="me-field me-link">
            <span>Her link (for the iPad)</span>
            <input readOnly value={patientLink} onFocus={(e) => e.target.select()} />
          </label>
          {custom && (
            <button className="me-reset" onClick={() => void reset()}>
              Go back to the automatic museum
            </button>
          )}
        </footer>
      </aside>

      <div className="me-preview">
        <MuseumPage preview={exhibition} onFocus={onMuseumFocus} ref={museum} />
        {folded ? (
          <button className="me-unfold" onClick={() => setFolded(false)}>
            ✎ Edit
          </button>
        ) : (
          <p className="me-preview-label">Live preview · tap a picture to walk to it, again to step in</p>
        )}
      </div>
    </div>
  )
}
