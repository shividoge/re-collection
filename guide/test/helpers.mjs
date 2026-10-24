import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CAPTURE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * A tiny capture that follows docs/capture-format.md, for tests only:
 * 2 room points, 3 moment frames, 2 depth frames of 4x3. Returns
 * { files: { name: Buffer }, manifest }.
 */
export function tinyCapture({ id = CAPTURE_ID } = {}) {
  const width = 4;
  const height = 3;
  const depthCount = 2;
  const points = 2;

  const roomBin = Buffer.alloc(4 + points * 15);
  roomBin.writeUInt32LE(points, 0);
  [0, 0, -1, 1, 0, -1].forEach((v, i) => roomBin.writeFloatLE(v, 4 + i * 4));
  Buffer.from([255, 0, 0, 0, 255, 0]).copy(roomBin, 4 + points * 12);

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const line = (i, t, d, phase) => JSON.stringify({ i, t, T: identity, K: [1500, 1500, 960, 720], track: 'normal', d, phase });
  const framesJsonl = [line(null, -1, 0, 'scan'), line(0, 0, 1, 'moment'), line(1, 1 / 30, null, 'moment'), line(2, 2 / 30, null, 'moment')]
    .join('\n') + '\n';

  const manifest = {
    format: 'braindance.capture',
    version: 1,
    id,
    createdAt: '2026-10-24T13:34:58Z',
    device: 'test',
    title: 'Test visit',
    attendees: [],
    coordinates: 'arkit-world-meters-y-up',
    imageOrientation: 'landscapeRight',
    video: { file: 'video.mov', width: 1920, height: 1440, fps: 30, durationSec: 0.1, frameCount: 3 },
    audio: { inVideo: true, sampleRate: 48000, channels: 1 },
    depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width, height, unit: 'mm', rateHz: 10, count: depthCount },
    mesh: { present: false },
    room: { ply: 'room.ply', bin: 'room.bin', points, voxelMeters: 0.01, source: 'on-device' },
    phases: { scan: { tStart: -1, tEnd: -1 }, moment: { tStart: 0, tEnd: 0.1 } },
    warnings: [],
  };

  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'room.bin': roomBin,
    'room.ply': Buffer.from('ply\nformat binary_little_endian 1.0\nend_header\n'),
    'video.mov': Buffer.from('not really a video, but the guide only checks it exists'),
    'frames.jsonl': Buffer.from(framesJsonl),
    'depth.bin': Buffer.alloc(depthCount * width * height * 2, 1),
    'confidence.bin': Buffer.alloc(depthCount * width * height, 2),
    'thumb.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  };
  return { files, manifest };
}

export async function tempDataDir() {
  return mkdtemp(join(tmpdir(), 'braindance-guide-test-'));
}

/** Writes a capture straight into <dataDir>/captures/<id>/. */
export async function writeCapture(dataDir, files, id = CAPTURE_ID) {
  const dir = join(dataDir, 'captures', id);
  await mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), data);
  return dir;
}
