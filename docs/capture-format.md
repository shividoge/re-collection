# Capture package format v1

The contract between the iPhone app (Shivin), the guide server (Shivin) and the web app (Firdavs). The phone writes it, the guide server stores and serves it, and the web reads it.

Status markers:
- **[built]**: the phone writes this today. The sample capture has it.
- **[next]**: on Shivin's list for the next phone build (see TASKS.md). Build against it, but expect it to be missing from the sample.

## Sample capture

A real capture of the MLH Hardware Lab table at Cal Hacks is attached to the GitHub release `sample-capture-1`:

```bash
gh release download sample-capture-1 --repo shividoge/braindance
unzip capture-aa8ba104-6d9c-462f-ab5c-a172b1e0b95e.zip
```

It's 93 MB zipped: a 46 s room scan, then a 28 s moment at 30 fps, with 1,064,340 room points. Use it for development. Don't commit it to git.

## Folder

```
capture-<uuid>/
  manifest.json      [built] what's in the folder; read this first
  room.bin           [built] the room's point cloud, compact format for the web
  room.ply           [built] same cloud for MeshLab / CloudCompare
  room.splat.ply     [optional] the room as 3D Gaussians, trained off the phone; see "room splat"
  video.mp4          [built on ios/upload] H.264 + AAC, so every browser can play it. The sample capture predates this and has video.mov (HEVC)
  frames.jsonl       [built] one line per frame: camera pose, intrinsics, depth index
  depth.bin          [built] 10 Hz depth frames, UInt16 millimeters
  confidence.bin     [built] 10 Hz confidence frames, UInt8
  thumb.jpg          [built] one frame about 2 s into the moment
  transcript.json    [built on ios/upload] on-device speech recognition with word times
  keyframes/kNNNN.jpg [built on ios/upload] one frame per second of the moment, long side 1024
```

Always read file names from `manifest.json` (`video.file`, `room.bin`, and so on) instead of hard-coding them.

## Coordinates (everything uses these)

- **World:** ARKit world, meters, right-handed, **y up**, gravity-aligned. The floor is a plane of constant y; in the sample it's at y ≈ -1.49. The origin is where the phone was when the scan started.
- **Camera space (ARKit):** x right, y up, camera looks down **-z**.
- **Images and depth** are stored in the sensor's native landscape orientation (`"imageOrientation": "landscapeRight"`), never rotated. When the filmer holds the phone in landscape, which is recommended, they're upright.
- **Unprojecting** depth pixel (u, v) with depth d meters (the same math is on the phone in `ios/Capture/CameraMath.swift`; keep the web identical):
  1. Scale intrinsics to the depth grid: `fx' = fx·256/W`, `fy' = fy·192/H`, `cx' = cx·256/W`, `cy' = cy·192/H` (W×H = video size).
  2. Image-camera space: `x = (u − cx')·d/fx'`, `y = (v − cy')·d/fy'`, `z = d`.
  3. ARKit camera space: `(x, −y, −z)`.
  4. World: multiply by `T` (camera-to-world) from that frame's line.
- Depth pixel (u, v) maps to video pixel `(u·W/256, v·H/192)`; both are 4:3.

## manifest.json [built]

```json
{
  "format": "braindance.capture",
  "version": 1,
  "id": "aa8ba104-6d9c-462f-ab5c-a172b1e0b95e",
  "createdAt": "2026-10-24T13:34:58Z",
  "device": "iPhone17,2",
  "title": "",
  "attendees": [],
  "coordinates": "arkit-world-meters-y-up",
  "imageOrientation": "landscapeRight",
  "video": { "file": "video.mov", "width": 1920, "height": 1440, "fps": 30, "durationSec": 28.434, "frameCount": 853 },
  "audio": { "inVideo": true, "sampleRate": 48000, "channels": 1 },
  "depth": { "file": "depth.bin", "confidenceFile": "confidence.bin", "width": 256, "height": 192, "unit": "mm", "rateHz": 10, "count": 741 },
  "mesh": { "present": false },
  "room": { "ply": "room.ply", "bin": "room.bin", "points": 1064340, "voxelMeters": 0.01, "source": "on-device" },
  "phases": { "scan": { "tStart": -49.868, "tEnd": -4.133 }, "moment": { "tStart": 0, "tEnd": 28.434 } },
  "warnings": []
}
```

- `title` and `attendees` are filled in on the phone's review screen [next]. Until then they're empty. Attendee names come from the family, never from face recognition.
- Newer captures add `"transcript": { "file": "transcript.json", "locale": "en-US", "onDevice": true }` and `"keyframes": { "dir": "keyframes", "everySec": 1, "count": 29 }` (one per whole second with video). Treat both as optional and check for them; the sample capture has neither.
- `warnings` lists anything that went wrong during recording, such as dropped frames. Show these to the family, don't hide them.
- `room.splat` is optional; see "room splat" below. Without it, everything works as described here.

## room.bin [built]

Little-endian:
1. `UInt32` point count N
2. N × 3 `Float32`: x, y, z for every point (all positions first)
3. N × 3 `UInt8`: r, g, b for every point (then all colors), sRGB

The cloud is voxel-downsampled to 1 cm. It's built on the phone during the scan, before the moment, so people who arrive later aren't smeared into it.

```ts
function parseRoomBin(buf: ArrayBuffer) {
  const n = new DataView(buf).getUint32(0, true);
  const positions = new Float32Array(buf, 4, n * 3);   // 4-byte aligned, so no copy
  const colors = new Uint8Array(buf, 4 + n * 12, n * 3);
  return { n, positions, colors };
}
```

## room splat [optional]

A 3D Gaussian splat of the static room, made after the capture (never on the phone). It never replaces `room.bin`, which stays required alongside it: the points are the measured (or, for a video, estimated) data, and the web always offers them as "Points (raw)".

```json
"room": { "ply": "room.ply", "bin": "room.bin", "points": 171618, "voxelMeters": 0.015, "source": "estimated-from-video",
          "splat": { "file": "room.splat.ply", "format": "3dgs-ply", "count": 312000, "shDegree": 0, "source": "trained-from-video" } }
```

| Field | Meaning |
|---|---|
| `file` | The splat file in the capture folder. |
| `format` | Always `3dgs-ply` for now. |
| `count` | Number of Gaussians (`element vertex` in the PLY header). |
| `shDegree` | Spherical-harmonics degree, 0 to 3. The file has `3·((shDegree+1)² − 1)` `f_rest_*` properties. |
| `source` | `trained-from-video` (optimized against an old video's frames) or `trained-from-lidar-capture` (optimized against a phone capture's frames). |

The file is the standard INRIA 3DGS PLY, `binary_little_endian 1.0`, one `vertex` element with float properties: `x y z`, optional `nx ny nz`, `f_dc_0..2`, `f_rest_*`, `opacity` (a logit), `scale_0..2` (natural log), `rot_0..3` (quaternion, w first). It is in the **same world coordinates as `room.bin` and `frames.jsonl`** (ARKit world, meters, y up), so it lines up with the camera path and the people replay with no transform.

Rules:
- People are masked out; the splat is the static room only. People come from `depth.bin` as before.
- Gaussians come only from this capture's own frames: they are optimized to reproduce them. No generative fill, no inpainting of surfaces the camera never saw: those areas stay empty (CLAUDE.md "Nothing fake").
- The guide checks on `complete` that the header says `binary_little_endian`, has `count` vertices and the required properties, and that the file size matches.

## frames.jsonl [built]

One JSON object per line. Scan lines come first, then moment lines.

```json
{"i":0,"t":0.000000,"T":[16 floats],"K":[fx,fy,cx,cy],"track":"normal","d":0,"phase":"moment"}
```

| Field | Meaning |
|---|---|
| `i` | Index of the video frame. `null` on scan lines, which have no video. |
| `t` | Seconds from the moment's first video frame. **Negative during the scan.** Video time = `t`. |
| `T` | 4×4 camera-to-world, **column-major** (translation is elements 12, 13, 14). |
| `K` | `[fx, fy, cx, cy]` for the full-resolution video frame. |
| `track` | `normal`, `limited` or `notAvailable`. Treat poses that aren't `normal` with suspicion. |
| `d` | Index into depth.bin / confidence.bin when this frame has depth, else `null`. |
| `phase` | `scan` or `moment`. |

Moment lines number exactly `video.frameCount`, one per video frame in order. To find the pose for video time `currentTime`, use the moment line with the nearest `t`.

## depth.bin and confidence.bin [built]

- `depth.bin`: `depth.count` frames × 256 × 192 × `UInt16` millimeters, little-endian, row-major. Frame k starts at byte `k·256·192·2` (98,304 bytes per frame). **0 means no data.**
- `confidence.bin`: same frames × 256 × 192 × `UInt8` (0 low, 1 medium, 2 high). Frame k starts at `k·256·192`.
- Recorded at 10 Hz during both the scan and the moment, so `d` indices run across both phases. Use range requests to fetch only the frames you need.

## transcript.json [built on ios/upload]

Apple's on-device speech recognition, run on the phone right after recording. Times are in moment seconds (same clock as `t`).

```json
{
  "locale": "en-US",
  "segments": [
    { "start": 3.12, "end": 5.40, "text": "Mom, I brought the mango cake",
      "words": [ { "start": 3.12, "end": 3.30, "word": "Mom" } ] }
  ]
}
```

If recognition fails or the phone has no on-device model for the locale, the file is missing and the manifest says why in `warnings`. Nothing is guessed.

## keyframes/ [built on ios/upload]

`kNNNN.jpg` where NNNN is the whole second of moment time (`k0000.jpg` = t 0 s). Long side 1024 px, stored the same way as the video. These are what Claude sees when extracting facts, and what the family review screen shows as evidence.
