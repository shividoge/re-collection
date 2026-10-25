import { useCallback, useEffect, useState } from 'react'
import { fileUrl, getKey, guide, GuideError, setKey } from '../api'
import type { CaptureSummary } from '../api'
import { readFolder, readZip, uploadPackage } from '../upload'
import { openRoomFile } from './RoomFile'

type UploadState =
  | { kind: 'idle' }
  | { kind: 'reading'; name: string }
  | { kind: 'uploading'; sent: number; total: number; file: string }
  | { kind: 'error'; message: string }

/** Every capture on the guide, plus the drop zone for new ones from the phone. */
export function Gallery() {
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsKey, setNeedsKey] = useState(false)
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)

  const refresh = useCallback(() => {
    guide
      .captures()
      .then((list) => {
        setCaptures(list)
        setError(null)
        setNeedsKey(false)
      })
      .catch((e: GuideError) => {
        if (e.status === 401) setNeedsKey(true)
        else setError(e.message)
      })
  }, [])

  useEffect(refresh, [refresh])

  async function handleFiles(files: File[]) {
    if (files.length === 0) return
    try {
      // A bare room scan opens straight in the viewer, without uploading anything.
      if (files.length === 1 && files[0].name.toLowerCase().endsWith('.bin')) {
        setUpload({ kind: 'reading', name: files[0].name })
        await openRoomFile(files[0])
        return
      }
      const zip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip') ? files[0] : null
      setUpload({ kind: 'reading', name: zip?.name ?? `${files.length} files` })
      const pkg = zip ? await readZip(zip) : await readFolder(files)
      await uploadPackage(pkg, (sent, total, file) => setUpload({ kind: 'uploading', sent, total, file }))
      setUpload({ kind: 'idle' })
      location.hash = `#/capture/${pkg.id}`
    } catch (e) {
      setUpload({ kind: 'error', message: (e as Error).message })
      refresh()
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

      {needsKey && <KeyForm onSaved={refresh} />}

      <section className="dropzone">
        {upload.kind === 'idle' && (
          <>
            <p className="drop-title">Drop a capture zip from the phone</p>
            <p className="drop-hint">AirDrop it from the app's review screen, then drag it here. A room.bin on its own opens just the room.</p>
            <div className="drop-actions">
              <label className="btn">
                Choose a zip
                <input type="file" accept=".zip" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
              </label>
              <label className="btn ghost">
                Open a room.bin
                <input type="file" accept=".bin" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
              </label>
            </div>
          </>
        )}
        {upload.kind === 'reading' && <p className="drop-title">Opening {upload.name}…</p>}
        {upload.kind === 'uploading' && (
          <>
            <p className="drop-title">{upload.file === 'checking' ? 'Checking every file…' : `Uploading ${upload.file}`}</p>
            <progress value={upload.sent} max={upload.total || 1} />
            <p className="drop-hint">
              {(upload.sent / 1e6).toFixed(0)} of {(upload.total / 1e6).toFixed(0)} MB
            </p>
          </>
        )}
        {upload.kind === 'error' && (
          <>
            <p className="drop-title error">{upload.message}</p>
            <button onClick={() => setUpload({ kind: 'idle' })}>Try another file</button>
          </>
        )}
      </section>

      {error && <p className="error">{error}</p>}

      {captures && captures.length === 0 && <p className="muted">No captures yet.</p>}
      {captures && captures.length > 0 && (
        <ul className="cards">
          {captures.map((c) => (
            <li key={c.id}>
              <a className="card" href={`#/capture/${c.id}`}>
                {c.thumb ? <img src={fileUrl(c.thumb)} alt="" loading="lazy" /> : <div className="thumb-missing" />}
                <div className="card-body">
                  <h2>{c.title || 'Untitled visit'}</h2>
                  {c.source === 'video' && <span className="estimated-badge">Estimated from a video</span>}
                  <p className="meta">
                    {c.createdAt ? new Date(c.createdAt).toLocaleString() : 'Unknown date'}
                    {c.durationSec != null && ` · ${Math.round(c.durationSec)} s`}
                  </p>
                  <StatusBadge capture={c} />
                  {(c.status.warnings?.length ?? 0) > 0 && <p className="meta">{c.status.warnings![0]}</p>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

/** Where the capture is in the pipeline, from the guide's real status. */
function StatusBadge({ capture }: { capture: CaptureSummary }) {
  const { upload, facts, factsError } = capture.status
  if (upload === 'invalid') return <span className="badge failed">Incomplete: {capture.status.uploadErrors?.[0] ?? 'upload failed'}</span>
  if (upload !== 'done') return <span className="badge working">Still uploading</span>
  if (facts === 'done') return <span className="badge done">Facts ready</span>
  if (facts === 'failed') return <span className="badge failed">Facts failed{factsError ? `: ${factsError}` : ''}</span>
  if (facts === 'queued' || facts === 'running') return <span className="badge working">Claude is reading it…</span>
  return <span className="badge">No facts yet</span>
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(getKey())
  return (
    <form
      className="key-form"
      onSubmit={(e) => {
        e.preventDefault()
        setKey(value.trim())
        onSaved()
      }}
    >
      <label>
        Team password
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button className="btn">Unlock</button>
    </form>
  )
}
