// Decoded capture files, shared by every viewer on the page and loaded once per URL. The bytes
// come from the data layer's fetch cache; this keeps what was made from them (parsed frames,
// pack views) so two viewers of one capture share the same objects, and the same GPU geometry
// when they share a canvas. An entry nobody has used for a while is dropped.
import { useCallback, useSyncExternalStore } from 'react'

export type Async<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; message: string }

const LOADING = { status: 'loading' } as const
/** How long an unused entry is kept, so leaving and reopening a view doesn't reload it. */
const KEEP_MS = 30_000

interface Entry {
  state: Async<unknown>
  listeners: Set<() => void>
  drop: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()

function entryFor<T>(key: string, load: () => Promise<T>): Entry {
  let e = entries.get(key)
  if (e) return e
  const entry: Entry = { state: LOADING, listeners: new Set(), drop: null }
  entries.set(key, entry)
  const settle = (state: Async<unknown>) => {
    entry.state = state
    for (const l of entry.listeners) l()
  }
  load().then(
    (data) => settle({ status: 'ready', data }),
    (err: unknown) => settle({ status: 'failed', message: err instanceof Error ? err.message : String(err) }),
  )
  e = entry
  return e
}

/** Loads `key` once (if not yet loading) and returns its state; `load` is only called the first time. */
export function useAsync<T>(key: string | null, load: () => Promise<T>): Async<T> | null {
  // `load` is tied to `key`; a new function for the same key is ignored on purpose.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(load, [key])
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === null) return () => {}
      const e = entryFor(key, loader)
      if (e.drop) clearTimeout(e.drop)
      e.drop = null
      e.listeners.add(onChange)
      // The load may have settled between render and subscribe.
      onChange()
      return () => {
        e.listeners.delete(onChange)
        if (e.listeners.size === 0) e.drop = setTimeout(() => entries.get(key) === e && e.listeners.size === 0 && entries.delete(key), KEEP_MS)
      }
    },
    [key, loader],
  )
  const snapshot = useCallback(() => (key === null ? null : ((entries.get(key)?.state ?? LOADING) as Async<T>)), [key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
