import { createFetchCache } from './fetchCache'

/** The page's one byte cache (~512 MB, LRU by bytes). */
export const pageCache = createFetchCache({ maxBytes: 512 * 1024 * 1024 })
