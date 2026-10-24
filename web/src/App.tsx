import { useEffect, useState } from 'react'
import { CaptureView } from './views/CaptureView'
import { Dashboard } from './views/Dashboard'
import { FactsPage } from './views/FactsPage'
import { Gallery } from './views/Gallery'
import { RoomFile } from './views/RoomFile'
import './views/views.css'

/** Hash routes, so the guide can serve this app as plain static files. */
const ROUTES: [RegExp, (id: string, t?: string) => React.ReactNode][] = [
  // #/capture/<id>, or #/capture/<id>?t=12.5 to open at that second (from a fact's evidence).
  [/^#\/capture\/([0-9a-f-]{36})(?:\?t=([\d.]+))?$/i, (id, t) => <CaptureView key={`${id}@${t ?? ''}`} id={id} startAt={t ? Number(t) : undefined} />],
  [/^#\/facts\/([0-9a-f-]{36})$/i, (id) => <FactsPage key={id} id={id} />],
  // Revisiting happens in the playground now; old links still land there.
  [/^#\/revisit\/([0-9a-f-]{36})$/i, (id) => <CaptureView key={id} id={id} />],
  [/^#\/dashboard\/([0-9a-f-]{36})$/i, (id) => <Dashboard key={id} id={id} />],
]

export default function App() {
  const [hash, setHash] = useState(location.hash)

  useEffect(() => {
    const onChange = () => setHash(location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  let view: React.ReactNode = <Gallery />
  if (hash === '#/room') view = <RoomFile />
  for (const [pattern, render] of ROUTES) {
    const m = pattern.exec(hash)
    if (m) view = render(m[1], m[2])
  }

  return (
    <div className="app">
      <div className="app-body">{view}</div>
    </div>
  )
}
