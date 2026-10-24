import { FactsPanel } from './FactsPanel'

/**
 * The family's fact review on its own page. Only facts approved here ever reach the patient.
 * Clicking a fact's evidence opens the visit at that moment.
 */
export function FactsPage({ id }: { id: string }) {
  return (
    <div className="facts-page">
      <header className="bar">
        <a href={`#/capture/${id}`} className="back">
          ← Back to the visit
        </a>
        <div className="bar-title">
          <strong>Check the facts</strong>
          <span className="meta">What Claude found in the visit, each with its evidence. Only approved facts are ever said during a visit.</span>
        </div>
        <nav className="bar-links">
          <a href={`#/dashboard/${id}`}>Dashboard</a>
        </nav>
      </header>
      <main className="facts-page-body">
        <FactsPanel captureId={id} onSeek={(t) => (location.hash = `#/capture/${id}?t=${t.toFixed(1)}`)} />
      </main>
    </div>
  )
}
