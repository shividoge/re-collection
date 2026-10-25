// Unfinished uploads, kept in IndexedDB so a reload (or a dropped connection) resumes them instead
// of starting over: multipart uploads by uploadId, and which capture an old video is going to.
// Without IndexedDB (private mode) uploads still work, they just can't resume after a reload.
import type { SavedUpload, SavedVideo } from './uploadPlan'

const DB = 'braindance-uploads'
const UPLOADS = 'uploads'
const VIDEOS = 'videos'

let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const request = indexedDB.open(DB, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(UPLOADS)) db.createObjectStore(UPLOADS, { keyPath: 'uploadId' })
      if (!db.objectStoreNames.contains(VIDEOS)) db.createObjectStore(VIDEOS, { keyPath: 'key' })
    }
    request.onsuccess = () => {
      // Let a newer version in another tab upgrade instead of being blocked by this one.
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => resolve(null)
    // An older tab still holds the database: carry on without saving rather than wait.
    request.onblocked = () => resolve(null)
  })
  return opening
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    let request: IDBRequest<T>
    try {
      request = work(db.transaction(store, mode).objectStore(store))
    } catch {
      return resolve(null)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

function table<T>(store: string) {
  return {
    all: async (): Promise<T[]> => (await run(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? [],
    put: async (row: T) => void (await run(store, 'readwrite', (s) => s.put(row))),
    remove: async (key: string) => void (await run(store, 'readwrite', (s) => s.delete(key))),
  }
}

export const uploadStore = table<SavedUpload>(UPLOADS)
export const videoStore = table<SavedVideo>(VIDEOS)
