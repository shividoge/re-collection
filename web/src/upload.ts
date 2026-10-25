// Uploads straight to R2 through URLs Convex signs (architecture-v3.md §6.2):
// captures.begin → per file uploads.start → one PUT, or parts 4 at a time → uploads.finish →
// captures.complete. A failed part is retried with backoff; after that, uploads.resume hands out
// fresh URLs for what's left. Unfinished multipart uploads are saved in IndexedDB, so dropping the
// same zip again after a reload carries on where it stopped, and files the server already has are
// skipped. An old video works the same way: the same file dropped again goes on into the capture
// made the first time. Saved state older than a week is forgotten.
import { unzip } from 'fflate'
import { parseManifest } from '../../shared/manifest'
import { errorCode, errorList, errorMessage, uploadsApi, type UploadsApi, type UploadTarget } from './data'
import {
  alreadyThere,
  backoffMs,
  contentType,
  findResumable,
  isStale,
  mergeParts,
  pendingParts,
  pool,
  skipFile,
  uploadOrder,
  videoKey,
  type Part,
  type SavedUpload,
  type SavedVideo,
} from './data/uploadPlan'
import { uploadStore, videoStore } from './data/uploadStore'

export type PackageFiles = { id: string; manifestJson: string; files: Map<string, Blob> }

/**
 * Finds the capture inside a zip from the phone's AirDrop (or a folder), wherever manifest.json
 * sits, and returns its files with names relative to it.
 */
function collect(entries: Map<string, Blob>, manifestJson: (blob: Blob) => Promise<string>): Promise<PackageFiles> {
  const manifestPath = [...entries.keys()].find((name) => !skipFile(name) && /(^|\/)manifest\.json$/.test(name))
  if (!manifestPath) throw new Error("There's no manifest.json in what you dropped. Drop the capture zip from the phone.")
  const prefix = manifestPath.slice(0, -'manifest.json'.length)
  const files = new Map<string, Blob>()
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) continue
    const rel = name.slice(prefix.length)
    if (!skipFile(rel)) files.set(rel, data)
  }
  return manifestJson(files.get('manifest.json')!).then((json) => {
    const manifest = parseManifest(json)
    if ((manifest as { format?: string }).format !== 'braindance.capture') throw new Error("That manifest.json isn't a Braindance capture.")
    return { id: manifest.id, manifestJson: json, files }
  })
}

export async function readZip(file: File): Promise<PackageFiles> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, { filter: (f) => !skipFile(f.name) }, (error, result) => (error ? reject(new Error(`Couldn't open the zip: ${error.message}`)) : resolve(result))),
  )
  const blobs = new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data as Uint8Array<ArrayBuffer>])]))
  return collect(blobs, (b) => b.text())
}

/** A folder picked with <input webkitdirectory> or dropped. */
export function readFolder(files: File[]): Promise<PackageFiles> {
  const entries = new Map<string, Blob>()
  for (const file of files) entries.set((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file)
  return collect(entries, (b) => b.text())
}

export type FileState = 'waiting' | 'uploading' | 'done' | 'skipped' | 'failed'
export type FileProgress = { name: string; bytes: number; sent: number; state: FileState }
export type UploadProgress = { captureId: string | null; files: FileProgress[]; phase: 'uploading' | 'checking' | 'done' }

/** Everything a file upload needs from outside (swapped for fakes in tests). */
export type UploadDeps = {
  api: Pick<UploadsApi, 'start' | 'resume' | 'finish'>
  /** PUTs one body, returns the response's ETag (null if the storage didn't expose it). */
  put(url: string, body: Blob, headers: Record<string, string>): Promise<string | null>
  saved: { all(): Promise<SavedUpload[]>; put(u: SavedUpload): Promise<void>; remove(uploadId: string): Promise<void> }
  /** Which capture each old video being uploaded goes to. */
  videos: { all(): Promise<SavedVideo[]>; put(v: SavedVideo): Promise<void>; remove(key: string): Promise<void> }
  sleep(ms: number): Promise<void>
}

export const PART_CONCURRENCY = 4
export const FILE_CONCURRENCY = 3
/** Tries per part before asking for fresh URLs; fresh URLs at most this many times per file. */
export const PART_TRIES = 4
export const RESUMES = 3

async function browserPut(url: string, body: Blob, headers: Record<string, string>): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(url, { method: 'PUT', body, headers })
  } catch {
    throw new Error('The upload lost its connection.')
  }
  if (!response.ok) throw new Error(`The storage refused a piece of the upload (HTTP ${response.status}).`)
  return response.headers.get('ETag')
}

export const browserDeps: UploadDeps = {
  api: uploadsApi,
  put: browserPut,
  saved: uploadStore,
  videos: videoStore,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

async function withRetries<T>(deps: UploadDeps, tries: number, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= tries) throw error
      await deps.sleep(backoffMs(attempt))
    }
  }
}

/**
 * Uploads one file of a capture and registers it (uploads.finish). Resumes a saved multipart
 * upload of the same file when there is one. `onSent` gets the bytes confirmed so far.
 */
export async function uploadFile(
  deps: UploadDeps,
  { captureId, name, body }: { captureId: string; name: string; body: Blob },
  onSent: (sent: number) => void,
): Promise<void> {
  const bytes = body.size
  let target: UploadTarget | null = null
  let done: Part[] = []

  const saved = findResumable(await deps.saved.all(), captureId, name, bytes)
  if (saved) {
    try {
      const resumed = await deps.api.resume(saved.uploadId)
      target = resumed.target
      done = mergeParts(saved.parts, resumed.done)
    } catch {
      // Expired or already finished: start this file again.
      await deps.saved.remove(saved.uploadId)
    }
  }
  target ??= await withRetries(deps, PART_TRIES, () => deps.api.start({ captureId, name, bytes, contentType: contentType(name) }))

  if (target.single) {
    const { single, uploadId } = target
    await withRetries(deps, PART_TRIES, () => deps.put(single.url, body, single.headers))
    onSent(bytes)
    await withRetries(deps, PART_TRIES, () => deps.api.finish(uploadId))
    return
  }

  const uploadId = target.uploadId
  const record = (): SavedUpload => ({ uploadId, captureId, name, bytes, parts: done, updatedAt: Date.now() })
  await deps.saved.put(record())
  const partSize = target.partSize ?? bytes
  const sentOf = () => done.reduce((sum, p) => sum + Math.min(partSize, bytes - (p.partNumber - 1) * partSize), 0)
  onSent(sentOf())

  for (let round = 0; ; round++) {
    const todo = pendingParts(target, bytes, done)
    try {
      await pool(todo, PART_CONCURRENCY, async (part) => {
        const etag = await withRetries(deps, PART_TRIES, () => deps.put(part.url, body.slice(part.start, part.end), {}))
        if (!etag) throw new Error('The storage didn’t return an ETag for a part. Its CORS rules must expose the ETag header.')
        done = mergeParts(done, [{ partNumber: part.partNumber, etag }])
        onSent(sentOf())
        await deps.saved.put(record())
      })
      break
    } catch (error) {
      if (round + 1 >= RESUMES || /ETag/.test(String(error))) throw error
      // URLs may have expired (they last an hour) or the network dropped: get fresh ones.
      const resumed = await withRetries(deps, PART_TRIES, () => deps.api.resume(uploadId))
      target = resumed.target
      done = mergeParts(done, resumed.done)
    }
  }
  await withRetries(deps, PART_TRIES, () => deps.api.finish(uploadId, done))
  await deps.saved.remove(uploadId)
}

/** Drops saved uploads and videos nobody came back to (R2 has aborted those uploads by now). */
async function forgetStale(deps: UploadDeps): Promise<void> {
  const now = Date.now()
  for (const u of await deps.saved.all()) if (isStale(u.updatedAt, now)) await deps.saved.remove(u.uploadId)
  for (const v of await deps.videos.all()) if (isStale(v.updatedAt, now)) await deps.videos.remove(v.key)
}

/** Uploads every file of a capture package in order, then asks the server to check it. */
export async function uploadPackage(pkg: PackageFiles, onProgress: (p: UploadProgress) => void, deps: UploadDeps = browserDeps, api: UploadsApi = uploadsApi) {
  const files = uploadOrder([...pkg.files].map(([name, body]) => ({ name, body })))
  const progress: UploadProgress = { captureId: null, phase: 'uploading', files: files.map((f) => ({ name: f.name, bytes: f.body.size, sent: 0, state: 'waiting' })) }
  const report = () => onProgress({ ...progress, files: progress.files.map((f) => ({ ...f })) })
  report()

  await forgetStale(deps)
  const { captureId } = await api.begin(pkg.manifestJson)
  progress.captureId = captureId
  const registered = await api.registered(captureId).catch(() => [])
  await pool(files, FILE_CONCURRENCY, async (file, i) => {
    const row = progress.files[i]
    if (alreadyThere(registered, file.name, row.bytes)) {
      Object.assign(row, { state: 'skipped', sent: row.bytes })
      return report()
    }
    row.state = 'uploading'
    report()
    try {
      await uploadFile(deps, { captureId, name: file.name, body: file.body }, (sent) => {
        row.sent = sent
        report()
      })
      Object.assign(row, { state: 'done', sent: row.bytes })
      report()
    } catch (error) {
      row.state = 'failed'
      report()
      throw new Error(`${file.name}: ${errorMessage(error)} Drop the same zip again to carry on.`)
    }
  })

  progress.phase = 'checking'
  report()
  try {
    await api.complete(captureId)
  } catch (error) {
    const problems = errorList(error)
    throw new Error(problems.length ? `The capture is incomplete: ${problems.join(' ')}` : errorMessage(error))
  }
  progress.phase = 'done'
  report()
  return { captureId }
}

/** The video's length in seconds, read by the browser (null if it can't play this file). */
export function videoDuration(file: File): Promise<number | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    video.preload = 'metadata'
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null)
    video.onerror = () => done(null)
    video.src = url
  })
}

/**
 * An old video to turn into a moment: videos.create, then the file as source.<ext> (queues
 * convert). The same file dropped again (same title and people) goes on into the capture made the
 * first time and resumes its upload; a new capture only if that one was deleted.
 */
export async function uploadVideo(
  file: File,
  meta: { title: string; attendees: string[] },
  onProgress: (p: UploadProgress) => void,
  deps: UploadDeps = browserDeps,
  api: UploadsApi = uploadsApi,
) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] ?? 'mp4').toLowerCase()
  const name = `source.${ext}`
  const key = videoKey(file, meta)
  const row: FileProgress = { name: file.name, bytes: file.size, sent: 0, state: 'uploading' }
  const report = (captureId: string | null, phase: UploadProgress['phase'] = 'uploading') => onProgress({ captureId, phase, files: [{ ...row }] })
  report(null)

  await forgetStale(deps)
  const saved = (await deps.videos.all()).find((v) => v.key === key)
  const create = async () => {
    const durationSec = (await videoDuration(file)) ?? undefined
    const { captureId } = await api.createVideo({ ...meta, fileName: file.name, bytes: file.size, ...(durationSec ? { durationSec } : {}) })
    return captureId
  }
  const send = async (captureId: string) => {
    await deps.videos.put({ key, captureId, updatedAt: Date.now() })
    row.sent = 0
    report(captureId)
    await uploadFile(deps, { captureId, name, body: file }, (sent) => {
      row.sent = sent
      report(captureId)
    })
  }

  let captureId = saved?.captureId ?? (await create())
  try {
    try {
      await send(captureId)
    } catch (error) {
      // The capture from the last try was deleted since: start a new one.
      if (!saved || errorCode(error) !== 'not_found') throw error
      captureId = await create()
      await send(captureId)
    }
  } catch (error) {
    row.state = 'failed'
    report(captureId)
    throw new Error(`${errorMessage(error)} Drop the same video again to carry on.`)
  }
  await deps.videos.remove(key)
  Object.assign(row, { state: 'done', sent: row.bytes })
  report(captureId, 'done')
  return { captureId }
}
