import { ConvexProvider } from 'convex/react'
import { convex, convexUrl } from './convex'
import { dataMode } from './mode'

/** Live mode: the Convex client for every hook below it. Static mode: nothing to provide. */
export function DataProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (dataMode === 'static') return <>{children}</>
  if (!convexUrl) return <div className="center-message error">This build has no VITE_CONVEX_URL, so it can’t reach the server.</div>
  return <ConvexProvider client={convex()}>{children}</ConvexProvider>
}
