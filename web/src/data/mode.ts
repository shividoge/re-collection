// Live: the app talks to Convex. Static: a GitHub Pages export (architecture-v3.md §8) read as
// plain files, with no server and nothing that can change. Fixed per build (VITE_STATIC=1).
export type DataMode = 'live' | 'static'
export const dataMode: DataMode = import.meta.env.VITE_STATIC === '1' ? 'static' : 'live'

/** An absolute URL for a path of the static export (it may sit in any folder or sub-path). */
export function staticUrl(path: string): string {
  return new URL(import.meta.env.BASE_URL + path, document.baseURI).href
}
