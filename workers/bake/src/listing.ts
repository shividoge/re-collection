import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Listing } from './validate'

/** Every file under `dir` (relative names with `/`) and its size. Skips macOS `._` and dot files. */
export async function listDir(dir: string): Promise<Listing> {
  const out = new Map<string, number>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const path = join(entry.parentPath, entry.name)
    out.set(relative(dir, path).split('\\').join('/'), (await stat(path)).size)
  }
  return out
}
