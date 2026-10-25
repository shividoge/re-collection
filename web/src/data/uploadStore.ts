// Unfinished multipart uploads, kept in IndexedDB so a reload (or a dropped connection) resumes
// them instead of starting over. Without IndexedDB (private mode) uploads still work, they just
// can't resume after a reload.
import type { SavedUpload } from './uploadPlan'

const DB = 'braindance-uploads'
const STORE = 'uploads'

let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'uploadId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  return opening
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

export const uploadStore = {
  all: async (): Promise<SavedUpload[]> => (await run('readonly', (s) => s.getAll() as IDBRequest<SavedUpload[]>)) ?? [],
  put: async (upload: SavedUpload) => void (await run('readwrite', (s) => s.put(upload))),
  remove: async (uploadId: string) => void (await run('readwrite', (s) => s.delete(uploadId))),
}
