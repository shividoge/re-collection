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
  } else {
    warnings.push('This capture has no room scan, so there is no 3D room to show.');
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
