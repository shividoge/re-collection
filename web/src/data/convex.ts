// The one Convex client (live mode only). Views never import this: they use data/index.ts.
import { ConvexReactClient } from 'convex/react'
import { api } from '../../../backend/convex/_generated/api'

export { api }

const url = import.meta.env.VITE_CONVEX_URL as string | undefined

/** The deployment URL, or null in a build that has none (static mode, or a missing .env). */
export const convexUrl: string | null = url ? url.replace(/\/+$/, '') : null

let client: ConvexReactClient | null = null

/** The shared client. Throws a plain message when the build has no VITE_CONVEX_URL. */
export function convex(): ConvexReactClient {
  if (!convexUrl) throw new Error('This build has no VITE_CONVEX_URL, so it can’t reach the server.')
  client ??= new ConvexReactClient(convexUrl)
  return client
}
