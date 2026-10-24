// Parsing for the capture package (docs/capture-format.md). The unprojection
// math lives in the DepthReplay shader and must match ios/Capture/CameraMath.swift.

export type RoomCloud = { count: number; positions: Float32Array; colors: Uint8Array };

/** room.bin: UInt32 N, then N×xyz float32, then N×rgb uint8, little-endian. */
export function parseRoomBin(buffer: ArrayBuffer): RoomCloud {
  const count = new DataView(buffer).getUint32(0, true);
  const expected = 4 + count * 15;
  if (buffer.byteLength !== expected) {
    throw new Error(`room.bin is ${buffer.byteLength} bytes but should be ${expected} for ${count} points.`);
  }
  return {
    count,
    positions: new Float32Array(buffer, 4, count * 3),
    colors: new Uint8Array(buffer, 4 + count * 12, count * 3),
  };
}

/** The moment's frames from frames.jsonl, as flat arrays for fast lookup by time. */
export type Timeline = {
  count: number;
  /** Moment seconds of each video frame, ascending. */
  times: Float64Array;
  /** Column-major camera-to-world, 16 floats per frame. */
  transforms: Float32Array;
  /** fx, fy, cx, cy per frame, at full video resolution. */
  intrinsics: Float32Array;
  /** Depth frame index per frame, or -1. */
  depthIndex: Int32Array;
  /** Camera positions during the room scan, for drawing the scan path. */
  scanPath: Float32Array;
};

type FrameLine = { i: number | null; t: number; T: number[]; K: number[]; track: string; d: number | null; phase?: string };

export function parseFrames(text: string): Timeline {
  const moment: FrameLine[] = [];
  const scan: number[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line) as FrameLine;
    if (frame.phase === 'scan') scan.push(frame.T[12], frame.T[13], frame.T[14]);
    else moment.push(frame);
  }
  moment.sort((a, b) => a.t - b.t);

  const count = moment.length;
  const timeline: Timeline = {
    count,
    times: new Float64Array(count),
    transforms: new Float32Array(count * 16),
    intrinsics: new Float32Array(count * 4),
    depthIndex: new Int32Array(count),
    scanPath: new Float32Array(scan),
  };
  moment.forEach((frame, k) => {
    timeline.times[k] = frame.t;
    timeline.transforms.set(frame.T, k * 16);
    timeline.intrinsics.set(frame.K, k * 4);
    timeline.depthIndex[k] = frame.d ?? -1;
  });
  return timeline;
}

/** Index of the frame shown at `time`: the last frame starting at or before it. */
export function frameAt(timeline: Timeline, time: number): number {
  const { times } = timeline;
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  if (time <= times[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The frame with depth closest to `frame`, searching up to `maxFrames` either
 * way (depth is 10 Hz, so at 30 fps it's within 2 frames). -1 if none.
 */
export function depthFrameNear(timeline: Timeline, frame: number, maxFrames = 3): number {
  for (let offset = 0; offset <= maxFrames; offset++) {
    for (const k of offset === 0 ? [frame] : [frame - offset, frame + offset]) {
      if (k >= 0 && k < timeline.count && timeline.depthIndex[k] >= 0) return k;
    }
  }
  return -1;
}

export type DepthFrame = {
  /** RG float pairs: depth in meters (0 = no data), confidence 0–2. Row 0 is the top row. */
  data: Float32Array;
  width: number;
  height: number;
};

/** Combines one UInt16-millimeter depth frame and its confidence frame. */
export function decodeDepthFrame(depth: ArrayBuffer, confidence: ArrayBuffer, width: number, height: number): DepthFrame {
  const mm = new Uint16Array(depth);   // little-endian on every platform browsers run on
  const conf = new Uint8Array(confidence);
  const data = new Float32Array(width * height * 2);
  for (let k = 0; k < width * height; k++) {
    data[k * 2] = mm[k] / 1000;
    data[k * 2 + 1] = conf[k];
  }
  return { data, width, height };
}
