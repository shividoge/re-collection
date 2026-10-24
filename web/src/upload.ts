import { unzip } from 'fflate'

import { guide } from './api'

export type PackageFiles = { id: string; files: Map<string, Uint8Array> }

/**
 * Files the guide writes itself, and junk macOS adds to zips: __MACOSX/,
 * .DS_Store and "._name" AppleDouble files. Any hidden file is skipped.
 */
const SKIP = /(^|\/)(__MACOSX|\.[^/]*|status\.json|moment\.json)(\/|$)/

/**
 * Finds the capture inside a zip from the phone's AirDrop (or a folder),
 * wherever manifest.json sits, and returns its files with names relative to it.
 */
function collect(entries: Map<string, Uint8Array>): PackageFiles {
  const manifestPath = [...entries.keys()].find((name) => !SKIP.test(name) && /(^|\/)manifest\.json$/.test(name))
  if (!manifestPath) throw new Error("There's no manifest.json in what you dropped. Drop the capture zip from the phone.")
  const prefix = manifestPath.slice(0, -'manifest.json'.length)

  const files = new Map<string, Uint8Array>()
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix) || SKIP.test(name) || name.endsWith('/')) continue
    files.set(name.slice(prefix.length), data)
  }
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
  if (manifest.format !== 'braindance.capture' || typeof manifest.id !== 'string') {
    throw new Error("That manifest.json isn't a Braindance capture.")
  }
  return { id: manifest.id, files }
}

export async function readZip(file: File): Promise<PackageFiles> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, (error, result) => (error ? reject(new Error(`Couldn't open the zip: ${error.message}`)) : resolve(result))),
  )
  return collect(new Map(Object.entries(entries)))
}

/** A folder picked with <input webkitdirectory> or dropped. */
export async function readFolder(files: File[]): Promise<PackageFiles> {
  const entries = new Map<string, Uint8Array>()
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    entries.set(path, new Uint8Array(await file.arrayBuffer()))
  }
  return collect(entries)
}

/** Small files first, so a half-finished upload still shows the room. */
function order(names: string[]): string[] {
  const rank = (n: string) =>
    n === 'manifest.json' ? 0 : n === 'room.bin' ? 1 : n === 'thumb.jpg' ? 2 : n.endsWith('.bin') ? 9 : n.startsWith('video.') ? 8 : 5
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export async function uploadPackage(pkg: PackageFiles, onProgress: (sent: number, total: number, file: string) => void) {
  const names = order([...pkg.files.keys()])
  const total = names.reduce((sum, n) => sum + pkg.files.get(n)!.byteLength, 0)
  let sent = 0
  for (const name of names) {
    onProgress(sent, total, name)
    const data = pkg.files.get(name)!
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await guide.putFile(pkg.id, name, data)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
    sent += data.byteLength
  }
  onProgress(total, total, 'checking')
  await guide.complete(pkg.id)
}
