// PUTs a local file to an uploads.start target (one PUT, or multipart parts in parallel).
import type { UploadTarget } from '../convex/validators'

const PARALLEL_PARTS = 4

export async function putFile(path: string, bytes: number, target: UploadTarget): Promise<{ partNumber: number; etag: string }[] | undefined> {
  const file = Bun.file(path)
  if (target.single) {
    const res = await fetch(target.single.url, { method: 'PUT', headers: target.single.headers, body: file })
    if (!res.ok) throw new Error(`PUT ${path}: HTTP ${res.status} ${await res.text()}`)
    return undefined
  }
  const partSize = target.partSize ?? 0
  const parts = [...(target.parts ?? [])]
  const done: { partNumber: number; etag: string }[] = []
  const worker = async () => {
    for (let part = parts.shift(); part; part = parts.shift()) {
      const start = (part.partNumber - 1) * partSize
      const res = await fetch(part.url, { method: 'PUT', body: file.slice(start, Math.min(bytes, start + partSize)) })
      const etag = res.headers.get('etag')
      if (!res.ok || !etag) throw new Error(`part ${part.partNumber} of ${path}: HTTP ${res.status}`)
      done.push({ partNumber: part.partNumber, etag })
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_PARTS }, worker))
  return done.sort((a, b) => a.partNumber - b.partNumber)
}
