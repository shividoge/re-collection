import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Checks a capture folder against its manifest (docs/capture-format.md).
 * Returns { ok, errors, warnings }. Every error says exactly what's wrong,
 * because the phone and the web show it to a person as is.
 *
 * @param store  a Store
 * @param id     capture id
 */
export async function validateCapture(store, id) {
  const errors = [];
  const warnings = [];

  let manifest;
  try {
    manifest = await store.readJson(id, 'manifest.json');
  } catch (error) {
    return { ok: false, errors: [error.message], warnings };
  }
  if (!manifest) return { ok: false, errors: ['manifest.json is missing.'], warnings };

  if (manifest.format !== 'braindance.capture') errors.push(`manifest.format is "${manifest.format}", expected "braindance.capture".`);
  if (manifest.version !== 1) errors.push(`manifest.version is ${manifest.version}; this guide reads version 1.`);
  if (manifest.id?.toLowerCase() !== id.toLowerCase()) errors.push(`manifest.id "${manifest.id}" doesn't match the upload id "${id}".`);

  /** Adds an error unless `name` exists, optionally with an exact byte size. Returns the size. */
  async function requireFile(name, expectedBytes, what) {
    let path;
    try {
      path = store.filePath(id, name);
    } catch (error) {
      errors.push(`${what}: ${error.message}`);
      return null;
    }
    const size = await store.size(path);
    if (size === null) {
      errors.push(`${name} is missing (${what}).`);
    } else if (expectedBytes !== undefined && size !== expectedBytes) {
      errors.push(`${name} is ${size} bytes, but the manifest implies ${expectedBytes} (${what}).`);
    } else if (size === 0) {
      errors.push(`${name} is empty (${what}).`);
    }
    return size;
  }

  // Video and frames.
  const video = manifest.video;
  if (!video?.file) {
    errors.push('manifest.video.file is missing.');
  } else {
    await requireFile(video.file, undefined, 'the recorded video');
  }

  const frames = await requireFile('frames.jsonl', undefined, 'camera poses');
  if (frames && video?.frameCount !== undefined) {
    const counts = await countFrameLines(store.filePath(id, 'frames.jsonl'));
    if (counts.bad > 0) errors.push(`frames.jsonl has ${counts.bad} lines that aren't valid JSON.`);
    if (counts.moment !== video.frameCount) {
      errors.push(`frames.jsonl has ${counts.moment} moment lines, but manifest.video.frameCount is ${video.frameCount}.`);
    }
    if (counts.maxDepthIndex >= (manifest.depth?.count ?? 0)) {
      errors.push(`frames.jsonl points at depth frame ${counts.maxDepthIndex}, but manifest.depth.count is ${manifest.depth?.count}.`);
    }
  }

  // Depth and confidence: fixed-size frames.
  const depth = manifest.depth;
  if (!depth) {
    errors.push('manifest.depth is missing.');
  } else {
    const pixels = depth.count * depth.width * depth.height;
    await requireFile(depth.file, pixels * 2, `${depth.count} depth frames of ${depth.width}x${depth.height} UInt16`);
    await requireFile(depth.confidenceFile, pixels, `${depth.count} confidence frames of ${depth.width}x${depth.height} UInt8`);
  }

  // Room cloud: UInt32 count, then 12 bytes of xyz and 3 bytes of rgb per point.
  const room = manifest.room;
  if (room) {
    const size = await requireFile(room.bin, 4 + room.points * 15, `${room.points} room points`);
    if (size !== null && size >= 4) {
      const header = await readBytes(store.filePath(id, room.bin), 0, 4);
      const count = header.readUInt32LE(0);
      if (count !== room.points) errors.push(`${room.bin} says ${count} points, but manifest.room.points is ${room.points}.`);
    }
    if (room.ply) await requireFile(room.ply, undefined, 'the room cloud for desktop viewers');
    if (room.splat) await checkSplat(room.splat);
  } else {
    warnings.push('This capture has no room scan, so there is no 3D room to show.');
  }

  /** Optional room splat (docs/capture-format.md "room splat"): an INRIA 3DGS PLY whose size matches its header. */
  async function checkSplat(splat) {
    if (!splat.file) {
      errors.push('manifest.room.splat.file is missing.');
    } else if (splat.format !== '3dgs-ply') {
      errors.push(`manifest.room.splat.format is "${splat.format}", expected "3dgs-ply".`);
    } else {
      const size = await requireFile(splat.file, undefined, 'the room splat');
      if (!size) return;
      const header = parsePlyHeader(await readBytes(store.filePath(id, splat.file), 0, Math.min(size, PLY_HEADER_MAX)));
      for (const problem of splatProblems(header, splat, size)) errors.push(`${splat.file} ${problem}`);
    }
  }

  // Optional pieces from the next phone build.
  if (manifest.transcript?.file) await requireFile(manifest.transcript.file, undefined, 'the transcript');
  if (manifest.keyframes?.count) {
    const dir = manifest.keyframes.dir ?? 'keyframes';
    const files = (await store.listFiles(id)).filter((f) => f.startsWith(`${dir}/`));
    if (files.length !== manifest.keyframes.count) {
      errors.push(`${dir}/ has ${files.length} images, but manifest.keyframes.count is ${manifest.keyframes.count}.`);
    }
  }
  if (!manifest.transcript) warnings.push('No transcript: facts can only come from what the keyframes show.');

  for (const warning of manifest.warnings ?? []) warnings.push(`From the phone: ${warning}`);

  return { ok: errors.length === 0, errors, warnings };
}

async function countFrameLines(path) {
  const counts = { moment: 0, scan: 0, bad: 0, maxDepthIndex: -1 };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.phase === 'scan') counts.scan += 1;
      else counts.moment += 1;
      if (Number.isInteger(frame.d)) counts.maxDepthIndex = Math.max(counts.maxDepthIndex, frame.d);
    } catch {
      counts.bad += 1;
    }
  }
  return counts;
}

async function readBytes(path, position, length) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return buffer;
  } finally {
    await handle.close();
  }
}

const PLY_HEADER_MAX = 64 * 1024;
const PLY_TYPE_BYTES = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, float: 4, int32: 4, uint32: 4, float32: 4,
  double: 8, float64: 8,
};

/**
 * Reads a PLY header from the start of a file. Returns
 * { format, elements: [{ name, count, properties: [{ name, type }] }], headerBytes } or { error }.
 */
export function parsePlyHeader(bytes) {
  const end = bytes.indexOf('end_header\n');
  if (bytes.subarray(0, 4).toString('latin1') !== 'ply\n') return { error: "isn't a PLY file (no \"ply\" header line)." };
  if (end < 0) return { error: `has no end_header in its first ${bytes.length} bytes.` };
  const header = { format: null, elements: [], headerBytes: end + 'end_header\n'.length };
  for (const line of bytes.subarray(0, end).toString('latin1').split('\n')) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'format') header.format = words[1];
    else if (words[0] === 'element') header.elements.push({ name: words[1], count: Number(words[2]), properties: [] });
    else if (words[0] === 'property') {
      const element = header.elements.at(-1);
      if (!element) return { error: 'has a property before any element.' };
      element.properties.push(words[1] === 'list' ? { name: words.at(-1), type: 'list' } : { name: words[2], type: words[1] });
    }
  }
  return header;
}

/** Everything wrong with a 3DGS PLY header against its manifest entry and file size; [] when it's fine. */
export function splatProblems(header, splat, fileBytes) {
  if (header.error) return [header.error];
  const problems = [];
  if (header.format !== 'binary_little_endian') problems.push(`format is ${header.format}, expected binary_little_endian.`);
  if (header.elements.length !== 1 || header.elements[0].name !== 'vertex') {
    return [...problems, `has elements [${header.elements.map((e) => e.name).join(', ')}], expected only "vertex".`];
  }
  const { count, properties } = header.elements[0];
  if (count !== splat.count) problems.push(`has ${count} Gaussians, but manifest.room.splat.count is ${splat.count}.`);

  const names = new Set(properties.map((p) => p.name));
  const degree = splat.shDegree ?? 0;
  const rest = 3 * ((degree + 1) ** 2 - 1);
  const required = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  for (let i = 0; i < rest; i++) required.push(`f_rest_${i}`);
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) problems.push(`is missing properties ${missing.join(', ')}.`);
  const extraRest = properties.filter((p) => p.name.startsWith('f_rest_')).length - rest;
  if (extraRest > 0) problems.push(`has ${rest + extraRest} f_rest properties, but manifest.room.splat.shDegree ${degree} means ${rest}.`);

  const unknown = properties.find((p) => !(p.type in PLY_TYPE_BYTES));
  if (unknown) return [...problems, `property ${unknown.name} has type ${unknown.type}, which a splat can't use.`];
  const stride = properties.reduce((sum, p) => sum + PLY_TYPE_BYTES[p.type], 0);
  const expected = header.headerBytes + count * stride;
  if (fileBytes !== expected) problems.push(`is ${fileBytes} bytes, but its header implies ${expected} (${count} × ${stride} bytes after a ${header.headerBytes}-byte header).`);
  return problems;
}
