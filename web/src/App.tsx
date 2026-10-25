import { useEffect, useState } from 'react'
import { CaptureView } from './views/CaptureView'
import { Dashboard, DashboardOverview } from './views/Dashboard'
import { FactsPage } from './views/FactsPage'
import { Gallery } from './views/Gallery'
import { PublicView } from './views/PublicView'
import { MuseumEditor } from './museum/MuseumEditor'
import { MuseumPage } from './museum/MuseumPage'
import { RoomFile } from './views/RoomFile'
import { Showcase } from './views/Showcase'
import { MemoryWindow } from './window/MemoryWindow'
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
  // The old hall's address now opens the museum (keeping a helper's join code).
  [/^#\/memories(\?join=[A-Za-z]*)?$/i, (join) => (location.replace(`#/museum${join ?? ''}`), null)],
  // The walkable museum: #/museum, or #/museum/<exhibition id>; #/museum?join=CODE is a helper's
  // phone joining the iPad's walk ("Visit together").
  [/^#\/museum(?:\/([\w-]+))?(?:\?join=([A-Za-z]*))?$/, (id, join) => <MuseumPage key="museum" id={id} join={join} />],
  // The caretaker's editor for that museum (after the line above, so it wins over an exhibition id).
  [/^#\/museum\/edit$/, () => <MuseumEditor />],
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
  if (hash === '#/dashboard') view = <DashboardOverview />
  for (const [pattern, render] of ROUTES) {
    const m = pattern.exec(hash)
    if (m) view = render(m[1], m[2])
  }
  // A static site has no family tools: everything but the museum and its Memory Windows lands
  // on the front page. (Visit together needs the live guide, so #/memories isn't in it.)
  const staticPage = /^#\/(museum(\/[\w-]+)?|window\/[0-9a-f-]{36}(\?from=museum)?)$/i.test(hash)
  if (visitor) view = <PublicView key={visitor[1]} id={visitor[1]} />
  else if (front || (STATIC && !staticPage)) view = <Showcase />

  return (
    <div className="app">
      <div className="app-body">{view}</div>
    </div>
  )
}
