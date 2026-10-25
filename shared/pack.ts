// The pack container for derived files (docs/architecture-v3.md §4.1). No dependencies.

export type PackType = 'f32' | 'u32' | 'u16' | 'i16' | 'u8' | 'i8'
export type PackKind = 'points' | 'surface' | 'timeline'
export type TypedArray = Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array

export interface PackArrayInfo {
  name: string
  type: PackType
  count: number
  components: number
  offset: number
  byteLength: number
}

export interface PackHeader<M = Record<string, unknown>> {
  kind: PackKind
  meta: M
  arrays: PackArrayInfo[]
}

export interface PackInput<M> {
  kind: PackKind
  meta: M
  arrays: { name: string; data: TypedArray; components: number }[]
}

export interface Pack<M = Record<string, unknown>> {
  kind: PackKind
  meta: M
  arrays: Map<string, { data: TypedArray; components: number }>
}

const MAGIC = 0x4b504442 // "BDPK" little-endian
const VERSION = 1
const ALIGN = 16

const align = (n: number) => Math.ceil(n / ALIGN) * ALIGN

function typeOf(a: TypedArray): PackType {
  if (a instanceof Float32Array) return 'f32'
  if (a instanceof Uint32Array) return 'u32'
  if (a instanceof Uint16Array) return 'u16'
  if (a instanceof Int16Array) return 'i16'
  if (a instanceof Uint8Array) return 'u8'
  return 'i8'
}

const CTORS = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  i16: Int16Array,
  u8: Uint8Array,
  i8: Int8Array,
} as const

export class PackError extends Error {}

export function encodePack<M>(input: PackInput<M>): Uint8Array {
  // Header size depends on offsets, which depend on header size: iterate until stable.
  let headerBytes = 0
  let header: PackHeader<M> = { kind: input.kind, meta: input.meta, arrays: [] }
  let json = ''
  for (let pass = 0; pass < 4; pass++) {
    let offset = align(12 + headerBytes)
    header = {
      kind: input.kind,
      meta: input.meta,
      arrays: input.arrays.map(({ name, data, components }) => {
        if (data.length % components !== 0) throw new PackError(`Array "${name}" has ${data.length} elements, not a multiple of ${components}.`)
        const info = { name, type: typeOf(data), count: data.length, components, offset, byteLength: data.byteLength }
        offset = align(offset + data.byteLength)
        return info
      }),
    }
    json = JSON.stringify(header)
    const size = new TextEncoder().encode(json).length
    if (size === headerBytes) break
    headerBytes = size
  }
  const jsonBytes = new TextEncoder().encode(json)
  if (jsonBytes.length !== headerBytes) throw new PackError('Pack header did not settle.')
  const last = header.arrays.at(-1)
  const total = last ? last.offset + last.byteLength : align(12 + headerBytes)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, VERSION, true)
  view.setUint32(8, headerBytes, true)
  out.set(jsonBytes, 12)
  header.arrays.forEach((info, i) => {
    const d = input.arrays[i].data
    out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), info.offset)
  })
  return out
}

/** Reads a pack. Arrays are views into `buf` when aligned (they always are when `buf` starts the file). */
export function decodePack<M = Record<string, unknown>>(buf: ArrayBuffer | Uint8Array): Pack<M> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.byteLength < 12) throw new PackError('Pack file is too short.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw new PackError('Not a pack file (bad magic).')
  const version = view.getUint32(4, true)
  if (version !== VERSION) throw new PackError(`Unsupported pack version ${version}.`)
  const headerBytes = view.getUint32(8, true)
  if (12 + headerBytes > bytes.byteLength) throw new PackError('Pack header runs past the end of the file.')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes))) as PackHeader<M>
  const arrays = new Map<string, { data: TypedArray; components: number }>()
  for (const a of header.arrays) {
    const Ctor = CTORS[a.type]
    if (!Ctor) continue // unknown type: ignore (forward compatible)
    if (a.offset + a.byteLength > bytes.byteLength) throw new PackError(`Array "${a.name}" runs past the end of the file.`)
    const start = bytes.byteOffset + a.offset
    const data =
      start % Ctor.BYTES_PER_ELEMENT === 0
        ? new Ctor(bytes.buffer as ArrayBuffer, start, a.count)
        : new Ctor(bytes.slice(a.offset, a.offset + a.byteLength).buffer as ArrayBuffer)
    arrays.set(a.name, { data, components: a.components })
  }
  return { kind: header.kind, meta: header.meta, arrays }
}

/** One array of a decoded pack, checked for its type. */
export function packArray<T extends TypedArray>(pack: Pack<unknown>, name: string, ctor: { new (...args: never[]): T }): T {
  const a = pack.arrays.get(name)
  if (!a) throw new PackError(`Pack has no "${name}" array.`)
  if (!(a.data instanceof ctor)) throw new PackError(`Pack array "${name}" has the wrong type.`)
  return a.data as T
}

// ---- metas of the three kinds (§4.2–4.4) --------------------------------------------------

export type Vec3 = [number, number, number]
export interface GridMeta { nx: number; ny: number; nz: number; origin: Vec3; voxel: number }
export interface PointsMeta { count: number; min: Vec3; max: Vec3; sizeMin: number; sizeMax: number; levels: { count: number; sizeScale: number }[] }
export interface SurfaceMeta { grid: GridMeta; keyframes: { file: string; t: number }[] }
export interface TimelineMeta { grid: GridMeta }
