import { useState } from 'react'
import { guide } from '../api'

/** The family's switch for the public front page. Off unless they turn it on. */
export function PublicSwitch({ id, initial }: { id: string; initial: boolean }) {
  const [on, setOn] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  return (
    <label className="public-switch" title="When on, anyone with the site's link can see this capture, its approved facts and its finished sessions.">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const next = e.target.checked
          setError(null)
          guide
            .setPublic(id, next)
            .then(() => setOn(next))
            .catch((err: Error) => setError(err.message))
        }}
      />
      Public{error && <span style={{ color: 'var(--bd-error)' }}> {error}</span>}
    </label>
  )
}
