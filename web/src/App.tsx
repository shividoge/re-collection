import { Component, lazy, Suspense, useEffect, useState } from 'react'
import { dataMode, useHealth } from './data'
import { legacyMuseumHash } from './museum/roomSync'
import './views/views.css'

// Every screen is its own chunk: the front page never downloads three.js, the museum,
// postprocessing, Spark or MediaPipe, and a family screen never downloads the front page.
const CaptureView = lazy(() => import('./views/CaptureView').then((m) => ({ default: m.CaptureView })))
const Dashboard = lazy(() => import('./views/Dashboard').then((m) => ({ default: m.Dashboard })))
const DashboardOverview = lazy(() => import('./views/Dashboard').then((m) => ({ default: m.DashboardOverview })))
const FactsPage = lazy(() => import('./views/FactsPage').then((m) => ({ default: m.FactsPage })))
const Gallery = lazy(() => import('./views/Gallery').then((m) => ({ default: m.Gallery })))
const PublicView = lazy(() => import('./views/PublicView').then((m) => ({ default: m.PublicView })))
const MuseumEditor = lazy(() => import('./museum/MuseumEditor').then((m) => ({ default: m.MuseumEditor })))
const MuseumPage = lazy(() => import('./museum/MuseumPage').then((m) => ({ default: m.MuseumPage })))
const RoomFile = lazy(() => import('./views/RoomFile').then((m) => ({ default: m.RoomFile })))
const Showcase = lazy(() => import('./views/Showcase').then((m) => ({ default: m.Showcase })))
const MemoryWindow = lazy(() => import('./window/MemoryWindow').then((m) => ({ default: m.MemoryWindow })))

/** Hash routes, so the app works as plain static files. */
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
  // The walkable museum: #/museum, or #/museum/<exhibition id>; #/museum?join=CODE is a helper's
  // phone joining the iPad's walk ("Visit together"); #/museum?visit=<key> carries the live visit's
  // key (read by the page itself).
  [/^#\/(?:palace|museum)(?:\/([\w-]+))?(?:\?join=([A-Za-z]*)|\?visit=[A-Za-z0-9_-]+)?$/, (id, join) => <MuseumPage key="museum" id={id} join={join} />],
  // The caretaker's editor for that museum (after the line above, so it wins over an exhibition id).
  [/^#\/(?:palace|museum)\/edit$/, () => <MuseumEditor />],
]

function view(hash: string): React.ReactNode {
  // The old hall's address opens the museum (keeping a helper's join code), on the static site too.
  const legacy = legacyMuseumHash(hash)
  if (legacy) {
    location.replace(legacy)
    return null
  }
  // Visitors read only the public routes: the front page ("#/", and anchors like "#how") and
  // "#/p/<id>". The family's tools live at "#/captures" and below.
  const visitor = /^#\/p\/([0-9a-f-]{36})$/i.exec(hash)
  if (visitor) return <PublicView key={visitor[1]} id={visitor[1]} />
  const front = !hash.startsWith('#/') || hash === '#/'
  // A static site has no family tools: everything but the museum and its Memory Windows lands
  // on the front page. (Visit together needs the live backend.)
  const staticPage = /^#\/(museum(\/[\w-]+)?|window\/[0-9a-f-]{36}(\?from=museum)?)$/i.test(hash)
  if (front || (dataMode === 'static' && !staticPage)) return <Showcase />

  let page: React.ReactNode = <Gallery />
  if (hash === '#/room') page = <RoomFile />
  if (hash === '#/dashboard') page = <DashboardOverview />
  for (const [pattern, render] of ROUTES) {
    const m = pattern.exec(hash)
    if (m) page = render(m[1], m[2])
  }
  return page
}

/** A screen that crashes says so (and the rest of the app keeps working) instead of going blank. */
class ScreenBoundary extends Component<{ hash: string; children: React.ReactNode }, { error: Error | null; at: string | null }> {
  state: { error: Error | null; at: string | null } = { error: null, at: null }
  static getDerivedStateFromError(error: Error) {
    return { error, at: location.hash }
  }
  render() {
    // Going somewhere else tries again.
    if (!this.state.error || this.state.at !== this.props.hash) return this.props.children
    return (
      <div className="center-message error">
        This screen ran into a problem: {this.state.error.message} <a href="#/">Go to the front page</a>
      </div>
    )
  }
}

/** Red and impossible to miss when Claude's answers are canned (MOCK_CLAUDE=1 on the server). */
function MockBanner() {
  const health = useHealth()
  if (health.status !== 'ready' || !health.data.mock) return null
  return (
    <div className="mock-banner" role="alert">
      MOCK MODE: Claude isn't being called. Every answer is canned and starts with [mock].
    </div>
  )
}

export default function App() {
  const [hash, setHash] = useState(location.hash)

  useEffect(() => {
    const onChange = () => setHash(location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return (
    <div className="app">
      {dataMode === 'live' && <MockBanner />}
      <div className="app-body">
        <ScreenBoundary hash={hash}>
          <Suspense fallback={<div className="center-message">Loading…</div>}>{view(hash)}</Suspense>
        </ScreenBoundary>
      </div>
    </div>
  )
}
