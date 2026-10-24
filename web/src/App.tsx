import { useEffect, useState } from 'react'
import { CaptureView } from './views/CaptureView'
import { Dashboard } from './views/Dashboard'
import { FactsPage } from './views/FactsPage'
import { Gallery } from './views/Gallery'
import { PublicView } from './views/PublicView'
import { RoomFile } from './views/RoomFile'
import { Showcase } from './views/Showcase'
import { MemoryWindow } from './window/MemoryWindow'
import { Museum } from './museum/Museum'
import { setPublicMode, STATIC } from './api'
import './views/views.css'

/** Hash routes, so the guide can serve this app as plain static files. */
const ROUTES: [RegExp, (id: string, t?: string) => React.ReactNode][] = [
  // #/capture/<id>, or #/capture/<id>?t=12.5 to open at that second (from a fact's evidence).
  [/^#\/capture\/([0-9a-f-]{36})(?:\?t=([\d.]+))?$/i, (id, t) => <CaptureView key={`${id}@${t ?? ''}`} id={id} startAt={t ? Number(t) : undefined} />],
  [/^#\/facts\/([0-9a-f-]{36})$/i, (id) => <FactsPage key={id} id={id} />],
  // Revisiting happens in the playground now; old links still land there.
  [/^#\/revisit\/([0-9a-f-]{36})$/i, (id) => <CaptureView key={id} id={id} />],
  [/^#\/dashboard\/([0-9a-f-]{36})$/i, (id) => <Dashboard key={id} id={id} />],
  // The Memory Window: the visit full screen, looked into with head tracking (TV, laptop, iPad).
  // #/window/<id>?from=museum comes back to the museum.
  [/^#\/window\/([0-9a-f-]{36})(?:\?from=(museum))?$/i, (id, from) => <MemoryWindow key={id} id={id} from={from} />],
  // The Memory Museum: every moment as a picture frame in a calm hall; tap one to step in.
  // #/museum?join=CODE is a helper's phone joining the iPad's walk ("Visit together").
  [/^#\/museum(\?join=[A-Za-z]*)?$/i, (join) => <Museum key={join ?? ''} join={join?.slice('?join='.length)} />],
]

export default function App() {
  const [hash, setHash] = useState(location.hash)

  useEffect(() => {
    const onChange = () => setHash(location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  // Visitors never need a key: the front page ("#/", and anchors like "#how") and "#/p/<id>"
  // read only the read-only /public routes. The family's tools live at "#/captures" and below.
  const visitor = /^#\/p\/([0-9a-f-]{36})$/i.exec(hash)
  const front = !hash.startsWith('#/') || hash === '#/'
  if (!STATIC) setPublicMode(Boolean(visitor) || front)

  let view: React.ReactNode = <Gallery />
  if (hash === '#/room') view = <RoomFile />
  for (const [pattern, render] of ROUTES) {
    const m = pattern.exec(hash)
    if (m) view = render(m[1], m[2])
  }
  // A static site has no family tools: everything else lands on the front page.
  if (visitor) view = <PublicView key={visitor[1]} id={visitor[1]} />
  else if (front || STATIC) view = <Showcase />

  return (
    <div className="app">
      <div className="app-body">{view}</div>
    </div>
  )
}
