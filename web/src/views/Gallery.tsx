import { useCallback, useEffect, useState } from 'react';

import { fileUrl, getKey, guide, GuideError, setKey } from '../api';
import type { CaptureSummary } from '../api';
import { readFolder, readZip, uploadPackage } from '../upload';

type UploadState =
  | { kind: 'idle' }
  | { kind: 'reading'; name: string }
  | { kind: 'uploading'; sent: number; total: number; file: string }
  | { kind: 'error'; message: string };

export function Gallery() {
  const [captures, setCaptures] = useState<CaptureSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(() => {
    guide
      .captures()
      .then((list) => {
        setCaptures(list);
        setError(null);
        setNeedsKey(false);
      })
      .catch((e: GuideError) => {
        if (e.status === 401) setNeedsKey(true);
        else setError(e.message);
      });
  }, []);

  useEffect(refresh, [refresh]);

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    try {
      const zip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip') ? files[0] : null;
      setUpload({ kind: 'reading', name: zip?.name ?? `${files.length} files` });
      const pkg = zip ? await readZip(zip) : await readFolder(files);
      await uploadPackage(pkg, (sent, total, file) => setUpload({ kind: 'uploading', sent, total, file }));
      setUpload({ kind: 'idle' });
      location.hash = `#/capture/${pkg.id}`;
    } catch (e) {
      setUpload({ kind: 'error', message: (e as Error).message });
      refresh();
    }
  }

  const busy = upload.kind === 'reading' || upload.kind === 'uploading';

  return (
    <main
      className={`gallery ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!busy) void handleFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="gallery-header">
        <h1>
          <span className="mark">●</span> Braindance
        </h1>
        <p className="tagline">Step back into a visit.</p>
      </header>

      {needsKey && <KeyForm onSaved={refresh} />}

      <section className={`dropzone ${busy ? 'busy' : ''}`}>
        {upload.kind === 'idle' && (
          <>
            <p className="drop-title">Drop a capture zip from the phone</p>
            <p className="drop-hint">AirDrop it from the app's review screen, then drag it here.</p>
            <label className="button">
              Choose a zip
              <input type="file" accept=".zip" hidden onChange={(e) => void handleFiles([...(e.target.files ?? [])])} />
            </label>
          </>
        )}
        {upload.kind === 'reading' && <p className="drop-title">Opening {upload.name}…</p>}
        {upload.kind === 'uploading' && (
          <>
            <p className="drop-title">
              {upload.file === 'checking' ? 'Checking every file…' : `Uploading ${upload.file}`}
            </p>
            <progress value={upload.sent} max={upload.total || 1} />
            <p className="drop-hint">
              {(upload.sent / 1e6).toFixed(0)} of {(upload.total / 1e6).toFixed(0)} MB
            </p>
          </>
        )}
        {upload.kind === 'error' && (
          <>
            <p className="drop-title error">{upload.message}</p>
            <button className="button" onClick={() => setUpload({ kind: 'idle' })}>
              Try another file
            </button>
          </>
        )}
      </section>

      {error && <p className="error">{error}</p>}

      {captures && captures.length === 0 && <p className="empty">No captures yet.</p>}
      {captures && captures.length > 0 && (
        <ul className="cards">
          {captures.map((c) => (
            <li key={c.id}>
              <a className="card" href={`#/capture/${c.id}`}>
                {c.thumb ? <img src={fileUrl(c.thumb)} alt="" loading="lazy" /> : <div className="thumb-missing" />}
                <div className="card-body">
                  <h2>{c.title || 'Untitled visit'}</h2>
                  <p className="meta">
                    {c.createdAt ? new Date(c.createdAt).toLocaleString() : 'Unknown date'}
                    {c.durationSec != null && ` · ${Math.round(c.durationSec)} s`}
                  </p>
                  {c.status.upload !== 'done' && (
                    <p className="error small">
                      {c.status.upload === 'invalid' ? `Incomplete: ${c.status.uploadErrors?.[0] ?? ''}` : 'Still uploading'}
                    </p>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(getKey());
  return (
    <form
      className="key-form"
      onSubmit={(e) => {
        e.preventDefault();
        setKey(value.trim());
        onSaved();
      }}
    >
      <label>
        Team password
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button className="button">Unlock</button>
    </form>
  );
}
