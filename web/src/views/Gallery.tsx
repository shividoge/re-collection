import { useState } from 'react'
import { errorMessage, family, onlineWorkers, useCaptures, useHealth, useNow, usePerson, type CaptureSummary, type WorkerInfo } from '../data'
import { readFolder, readZip, uploadPackage, uploadVideo, type UploadProgress } from '../upload'
import { stageLines } from './pipeline'

type UploadState =
  | { kind: 'idle' }
  | { kind: 'reading'; name: string }
  | { kind: 'video'; file: File }
  | { kind: 'uploading'; progress: UploadProgress }
  | { kind: 'error'; message: string }

const VIDEO = /\.(mp4|mov|m4v|webm)$/i

/** Every capture, live, plus the drop zone for new ones from the phone or an old video. */
export function Gallery() {
  const captures = useCaptures()
  const health = useHealth()
  const now = useNow()
  const workers = onlineWorkers(health.status === 'ready' ? health.data : null, now)
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)

  async function handleFiles(files: File[]) {
    if (files.length === 0) return
    try {
      const one = files.length === 1 ? files[0] : null
      // A bare room scan opens straight in the viewer, without uploading anything.
      if (one && one.name.toLowerCase().endsWith('.bin')) {
        setUpload({ kind: 'reading', name: one.name })
        const { openRoomFile } = await import('./RoomFile')
        await openRoomFile(one)
        return
      }
      if (one && VIDEO.test(one.name)) return setUpload({ kind: 'video', file: one })
      const zip = one && one.name.toLowerCase().endsWith('.zip') ? one : null
      setUpload({ kind: 'reading', name: zip?.name ?? `${files.length} files` })
      const pkg = zip ? await readZip(zip) : await readFolder(files)
      const { captureId } = await uploadPackage(pkg, (progress) => setUpload({ kind: 'uploading', progress }))
      setUpload({ kind: 'idle' })
      location.hash = `#/capture/${captureId}`
    } catch (e) {
      setUpload({ kind: 'error', message: errorMessage(e) })
    }
  }

  async function sendVideo(file: File, title: string, attendees: string[]) {
    try {
      await uploadVideo(file, { title, attendees }, (progress) => setUpload({ kind: 'uploading', progress }))
      setUpload({ kind: 'idle' })
    } catch (e) {
      setUpload({ kind: 'error', message: errorMessage(e) })
    }
  }

  const busy = upload.kind === 'reading' || upload.kind === 'uploading'

  return (
    <main
      className={`gallery ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!busy) void handleFiles([...e.dataTransfer.files])
      }}
    >
      <header className="gallery-header">
        <h1>BRAINDANCE</h1>
        <p className="tagline">Step back into a visit.</p>
        <a href="#/dashboard" className="btn ghost gallery-dashboard">
          Recall dashboard
        </a>
      </header>

      <PersonForm />

      <section className="dropzone">
        {upload.kind === 'idle' && (
          <>
            <p className="drop-title">Drop a capture zip from the phone, or an old video</p>
            <p className="drop-hint">
              AirDrop the zip from the app's review screen, then drag it here. An ordinary video is turned into an estimated 3D moment. A room.bin on its own
              opens just the room.
            </p>
            <div className="drop-actions">
              <label className="btn">
                Choose a zip
                <input type="file" accept=".zip" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
              </label>
              <label className="btn ghost">
                Choose a video
                <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
              </label>
              <label className="btn ghost">
                Open a room.bin
                <input type="file" accept=".bin" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
              </label>
            </div>
          </>
        )}
        {upload.kind === 'reading' && <p className="drop-title">Opening {upload.name}…</p>}
        {upload.kind === 'video' && <VideoForm file={upload.file} onCancel={() => setUpload({ kind: 'idle' })} onSend={(t, a) => void sendVideo(upload.file, t, a)} />}
        {upload.kind === 'uploading' && <UploadView progress={upload.progress} />}
        {upload.kind === 'error' && (
          <>
            <p className="drop-title error">{upload.message}</p>
            <button onClick={() => setUpload({ kind: 'idle' })}>Try another file</button>
          </>
        )}
      </section>

      {workers.length > 0 && (
        <p className="meta">Workers online: {workers.map((w) => `${w.workerId}${w.gpu ? ' (GPU)' : ''}`).join(', ')}</p>
      )}
      {captures.status === 'error' && <p className="error">{captures.message}</p>}
      {captures.status === 'loading' && <p className="muted">Loading…</p>}
      {captures.status === 'ready' && captures.data.length === 0 && <p className="muted">No captures yet.</p>}
      {captures.status === 'ready' && captures.data.length > 0 && (
        <ul className="cards">
          {captures.data.map((c) => (
            <li key={c.id}>
              <a className="card" href={`#/capture/${c.id}`}>
                {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <div className="thumb-missing" />}
                <div className="card-body">
                  <h2>{c.title || 'Untitled visit'}</h2>
                  {c.source === 'video' && <span className="estimated-badge">Estimated from a video</span>}
                  <p className="meta">
                    {new Date(c.createdAt).toLocaleString()}
                    {c.durationSec > 0 && ` · ${Math.round(c.durationSec)} s`}
                  </p>
                  <PipelineStatus capture={c} workers={workers} />
                  {c.status.warnings.length > 0 && <p className="meta">{c.status.warnings[0]}</p>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

/** Where the capture is in the pipeline, live from its status. */
export function PipelineStatus({ capture, workers }: { capture: Pick<CaptureSummary, 'status' | 'durationSec'>; workers: WorkerInfo[] }) {
  const lines = stageLines(capture.status, workers, capture.durationSec || null)
  return (
    <div className="stage-lines">
      {lines.map((l) => (
        <span key={l.key} className={`badge ${l.tone === 'idle' ? '' : l.tone}`}>
          {l.label}
        </span>
      ))}
    </div>
  )
}

function UploadView({ progress }: { progress: UploadProgress }) {
  const total = progress.files.reduce((n, f) => n + f.bytes, 0)
  const sent = progress.files.reduce((n, f) => n + f.sent, 0)
  const active = progress.files.filter((f) => f.state === 'uploading' || f.state === 'failed')
  const finished = progress.files.filter((f) => f.state === 'done' || f.state === 'skipped').length
  return (
    <>
      <p className="drop-title">{progress.phase === 'checking' ? 'Checking every file…' : progress.phase === 'done' ? 'Uploaded.' : 'Uploading…'}</p>
      <progress value={sent} max={total || 1} />
      <p className="drop-hint">
        {(sent / 1e6).toFixed(0)} of {(total / 1e6).toFixed(0)} MB · {finished} of {progress.files.length} files
      </p>
      <ul className="upload-files">
        {active.map((f) => (
          <li key={f.name} className={f.state}>
            <span>{f.name}</span>
            <progress value={f.sent} max={f.bytes || 1} />
            <span className="meta">{f.state === 'failed' ? 'failed' : `${Math.round((f.sent / (f.bytes || 1)) * 100)}%`}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

function VideoForm({ file, onSend, onCancel }: { file: File; onSend: (title: string, attendees: string[]) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(file.name.replace(/\.[^.]+$/, ''))
  const [people, setPeople] = useState('')
  return (
    <form
      className="video-form"
      onSubmit={(e) => {
        e.preventDefault()
        const attendees = people
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
        onSend(title.trim(), attendees)
      }}
    >
      <p className="drop-title">Turn {file.name} into a moment</p>
      <p className="drop-hint">The room and people are estimated from the video, not measured. Names come only from what you type.</p>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </label>
      <label>
        Who was there (comma separated)
        <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="Priya, Sam" />
      </label>
      <div className="drop-actions">
        <button className="btn">Upload</button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Who the visits are for: their name, and how Claude addresses them ("Mom"). */
function PersonForm() {
  const person = usePerson()
  const [draft, setDraft] = useState<{ displayName: string; preferredAddress: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  if (person.status === 'loading') return null
  if (person.status === 'error') return <p className="error small">Couldn’t load who the visits are for: {person.message}</p>
  const value = draft ?? person.data
  const dirty = draft !== null && (draft.displayName !== person.data.displayName || draft.preferredAddress !== person.data.preferredAddress)
  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!draft) return
        family
          .setPerson({ displayName: draft.displayName.trim(), preferredAddress: draft.preferredAddress.trim() })
          .then(() => {
            setDraft(null)
            setNote('Saved.')
          })
          .catch((err: unknown) => setNote(errorMessage(err)))
      }}
    >
      <label>
        The visits are for
        <input value={value.displayName} onChange={(e) => setDraft({ ...value, displayName: e.target.value })} required />
      </label>
      <label>
        Claude calls them
        <input value={value.preferredAddress} onChange={(e) => setDraft({ ...value, preferredAddress: e.target.value })} required />
      </label>
      <button className="btn ghost" disabled={!dirty}>
        Save
      </button>
      {note && <span className="meta">{note}</span>}
    </form>
  )
}
