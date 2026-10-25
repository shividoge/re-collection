# Braindance architecture v3: Convex + R2 + workers

This is the contract for the v3 stack. It replaces `docs/guide-api.md` (the Node guide server) once the cutover checklist at the bottom passes. Until then the guide keeps running unchanged. `docs/capture-format.md` stays the contract for what the phone writes; this file adds depth v2 and the derived files.

Rule of thumb: **raw** files are what a capture source uploads (the phone, or the video converter). **Derived** files are made once by the bake worker and are the only thing the web reads for 3D, apart from the video, keyframes and `frames.jsonl`.

## 1. Pieces

| Piece | Where | Does |
|---|---|---|
| Convex backend | `backend/convex/` | All app data (captures, files, facts, review, sessions, people, museum), the job queue, every Claude call, presigned R2 URLs. Deployment on team `srinivas-i-b`, project `braindance`. |
| R2 | bucket `braindance` (prod), `braindance-dev` (dev) | Every capture file, raw and derived. Private; reached only through presigned URLs that Convex signs. |
| Bake worker | `workers/bake/` (TypeScript, Bun) | CPU job: validates the package, converts depth to v2, builds the room surface, timeline and point levels once per capture, uploads the derived files. Runs anywhere (Fedora, GX10, a laptop). |
| GPU worker | `workers/gpu/` (Python) | Old video → capture package (Depth Anything 3, people masks, fusion), then the Gaussian splat. Keeps models loaded between jobs. Fedora RTX 5060 Ti for short videos, GX10 for long ones. |
| Web | `web/` | Talks only to Convex (reactive queries, mutations, actions) and to R2 through the URLs Convex returns. |
| Phone | `ios/` | Uploads through Convex + R2 multipart; writes depth v2. |
| Shared codecs | `shared/` | Pure TypeScript encode/decode for the pack container (§4) and depth v2 (§3). Used by the bake worker, the web and backend tests. No dependencies. |

Workers only make outbound calls (to Convex and R2), so no tunnel, open port or same-network requirement.

## 2. Storage layout (R2 keys)

```
captures/<captureId>/raw/<name>        what the source uploaded, names exactly as in capture-format.md
                                       (manifest.json, room.bin, frames.jsonl, video.mp4, depth.bin,
                                        confidence.bin (v1 only), depth.index.json (v2), thumb.jpg,
                                        transcript.json, keyframes/kNNNN.jpg, room.spz, ...)
captures/<captureId>/<raw|derived>/<jobId>.<attempt>/<name>
                                       what one worker attempt wrote (bake outputs (§4), a converted
                                       package, room.spz); each attempt has its own keys (§7)
videos/<captureId>/source.<ext>        an old video uploaded for conversion (GPU job input)
```

- Every object is immutable once registered in Convex, and the `files` row holds its key (read keys from Convex, never build them). A re-upload of a raw file by a client writes the same key and bumps that file's `rev`; a re-bake writes new attempt keys, bumps the `rev` of the same names, and the replaced objects are deleted an hour later. URLs carry `?v=<rev>` semantics through the signature (§6.4), so caches never serve stale bytes.
- Derived files are stored **gzip-compressed with `Content-Encoding: gzip`** (fetch decompresses transparently) except `depth.bin`, which is chunk-compressed itself and served by Range. Raw files are stored as uploaded.
- `Cache-Control: public, max-age=31536000, immutable` on every object.

## 3. Depth v2 (`depth.bin` + `depth.index.json`)

Replaces `depth.bin` + `confidence.bin` v1. The manifest says which one a capture has:

```json
"depth": { "file": "depth.bin", "index": "depth.index.json", "encoding": "v2", "width": 256, "height": 192,
           "unit": "mm", "rateHz": 10, "count": 741 }
```
(v1 manifests have `confidenceFile` and no `encoding`; treat missing `encoding` as `v1`.)

- **Pixel:** `UInt16` little-endian, `value = (mm & 0x3FFF) | (confidence << 14)`. `mm` 0 = no data, max 16 383 mm. `confidence` 0 low, 1 medium, 2 high (3 unused). A v1 pixel converts as `min(mm, 16383) | conf << 14`.
- **Chunks:** frames are grouped in order, `framesPerChunk` frames per chunk (10 = one second at 10 Hz; the last chunk may be shorter). Each chunk is the frames' pixels back to back (row-major, frame after frame), compressed with **raw DEFLATE** (`deflate-raw`; Apple `COMPRESSION_ZLIB`, browser `DecompressionStream('deflate-raw')`, Node `zlib.inflateRawSync`).
- `depth.bin` is the chunks concatenated. `depth.index.json`:
  ```json
  { "format": "braindance.depth", "version": 2, "width": 256, "height": 192, "count": 741,
    "framesPerChunk": 10, "filter": "row-delta", "chunks": [[0, 41234], [41234, 39876], ...] }
  ```
  `chunks[c] = [byteOffset, byteLength]` in `depth.bin`. Frame k is in chunk `floor(k / framesPerChunk)`.
- **Filter (optional):** `"filter": "row-delta"` means that before compression, in every row of every frame, each pixel after the first was replaced by its difference from the pixel to its left (`(v[i] − v[i−1]) & 0xFFFF`); readers undo it after inflating (`v[i] = (d[i] + v[i−1]) & 0xFFFF`, left to right). No `filter` key = unfiltered. The bake writes `row-delta` (43% smaller than unfiltered on a 30 s capture: 35.4 → 20.3 MB at DEFLATE level 6); the phone may write either, and the bake copies v2 files as is.
- Codec: `shared/depth.ts` (`encodeDepthV2`, `decodeChunk`, `packV1`, `rowDelta`, `chunkOfFrame`).

## 4. Derived files (bake outputs)

All under `captures/<id>/derived/`. The capture's derived manifest is registered in Convex (`captures.derived`, §6) and also written as `derived/derived.json`:

```json
{ "format": "braindance.derived", "version": 1, "captureId": "...", "bakedAt": "ISO", "bakeVersion": "git sha or semver",
  "files": { "points": "points.pack", "surface": "surface.pack", "timeline": "timeline.pack",
             "depth": "depth.bin", "depthIndex": "depth.index.json" },
  "stats": { "points": 871234, "surfaceTriangles": 412345, "timelineVoxels": 23456, "bakeMs": 3120 } }
```
`surface` and `timeline` are absent when there's no depth for them (e.g. a capture without a scan phase); `depth` is always present when the capture has depth. For v2 phone captures the bake copies the phone's depth files as is.

### 4.1 Pack container (`*.pack`)

One binary container for every derived array file. Codec: `shared/pack.ts` (`encodePack`, `decodePack`).

```
bytes 0..3    magic "BDPK"
bytes 4..7    UInt32 LE version = 1
bytes 8..11   UInt32 LE headerBytes (H)
bytes 12..    H bytes of UTF-8 JSON header, then zero padding to a multiple of 16
then          array data, each array starting on a 16-byte boundary
```
Header JSON: `{ "kind": "points" | "surface" | "timeline", "meta": {...}, "arrays": [{ "name", "type", "count", "offset", "byteLength", "components" }] }`
- `type` ∈ `f32 u32 u16 i16 u8 i8`; `count` = number of elements (scalars); `components` = elements per item (e.g. 3 for xyz); `offset` = byte offset from the start of the file.
- Unknown arrays and meta keys must be ignored by readers (forward compatible).

### 4.2 `points.pack` (kind `points`)

The room cloud from `room.bin`, reordered so that **every prefix is an even sample of the room** (level of detail by draw range), with per-point splat sizes (today's `gaps.ts splatSizes`, computed once on the full cloud).

| array | type | components | meaning |
|---|---|---|---|
| `positions` | u16 | 3 | unorm16 inside `meta.min`..`meta.max`: `x = min.x + (q / 65535)·(max.x − min.x)` |
| `colors` | u8 | 3 | sRGB |
| `sizes` | u8 | 1 | `SPLAT_MIN + (q / 255)·(SPLAT_MAX − SPLAT_MIN)` meters, for the full cloud |

`meta`: `{ "count", "min": [x,y,z], "max": [x,y,z], "sizeMin": 0.008, "sizeMax": 0.035, "levels": [{ "count": 65536, "sizeScale": 2.8 }, { "count": 262144, "sizeScale": 1.6 }, { "count": N, "sizeScale": 1 }] }`
- Drawing the first `levels[i].count` points, multiply each size by `levels[i].sizeScale` so the sparser sample still closes into surfaces. Levels are ascending and the last is the full cloud.
- Ordering: shuffle by voxel (e.g. stratified by a 3D grid with a deterministic seed) so a prefix covers the whole room evenly; deterministic for the same input.

### 4.3 `surface.pack` (kind `surface`)

The fused room surface (`surface.ts buildRoomSurface`), **indexed**: vertices are shared between triangles and split only where texture coordinates or layer differ (keyframe seams).

| array | type | components | meaning |
|---|---|---|---|
| `positions` | f32 | 3 | world meters |
| `normals` | i8 | 3 | snorm8 |
| `colors` | u8 | 3 | sRGB vertex color |
| `uvs` | u16 | 2 | unorm16 texture coordinates in the keyframe image |
| `layers` | i16 | 1 | keyframe layer index into `meta.keyframes`, −1 = vertex color only |
| `indices` | u32 | 3 | triangles |

`meta`: `{ "grid": { "nx", "ny", "nz", "origin": [x,y,z], "voxel" }, "keyframes": [{ "file": "keyframes/k0012.jpg", "t": 12 }] }` — layer i of the array texture is `meta.keyframes[i]`; the web loads those raw keyframe JPEGs (decoded straight to the GPU with `createImageBitmap`, resized to at most 768 px on the long side, mipmapped).

### 4.4 `timeline.pack` (kind `timeline`)

What the visit adds to the room over time (`timeline.ts buildTimeline`) plus the replay skip mask.

| array | type | components | meaning |
|---|---|---|---|
| `positions` | f32 | 3 | voxel centers |
| `colors` | u8 | 3 | sRGB |
| `start` | f32 | 1 | seconds of moment time the voxel appears |
| `end` | f32 | 1 | seconds it disappears (`1e9` = never) |
| `skip` | u8 | 1 | one byte per voxel of `meta.grid` (index `(z·ny + y)·nx + x`); 1 = the replay draws nothing there |

`meta`: `{ "grid": { ... same as surface ... } }`

### 4.5 Splat (`raw/room.spz`)

The GPU worker writes the trained splat as **SPZ** (Niantic's compressed Gaussian format, which Spark loads natively; **version 3**, one gzip stream, smallest-three rotations, RUB coordinates = our world, no axis flip; writer `tools/video2capture/spz.py`, checked against Spark 2.4's decoder), declared in the manifest as `"room": { ..., "splat": { "file": "room.spz", "format": "spz", "count": N, "shDegree": 0|1|2|3, "source": "trained-from-video" } }`. `3dgs-ply` remains accepted for older captures. Same world coordinates and rules as `capture-format.md` "room splat".

## 5. Capture status (one object in Convex, shown live in the web)

```ts
type Stage = 'not_started' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
type CaptureStatus = {
  source: 'phone' | 'video'
  upload: 'receiving' | 'done' | 'invalid'
  uploadErrors: string[]
  warnings: string[]
  convert: Stage        // video only: the GPU worker's points capture; 'skipped' for phone captures
  facts: Stage
  bake: Stage
  splat: Stage          // video only (and later LiDAR captures); 'skipped' when not requested
  errors: { convert?: string; facts?: string; bake?: string; splat?: string }
  progress: { stage: string; fraction: number | null; message: string } | null   // from the running job
  updatedAt: number     // ms
}
```

Stage triggers (all in mutations, so they're transactional):
1. **Facts** is queued as soon as the inputs Claude needs are registered: `manifest.json`, every keyframe the manifest lists, and `transcript.json` if the manifest lists one. It doesn't wait for video or depth.
2. **Upload complete** (`captures.complete`) validates sizes against the manifest (from registered file sizes; `frames.jsonl` line count is checked by the bake). Valid → `upload: done`, **bake** queued. Invalid → `upload: invalid` with specific `uploadErrors`.
3. **Bake done** → derived manifest registered; the web switches from "processing" to the room.
4. **Video:** `videos.create` → `convert` queued (GPU). Convert done registers the raw package exactly like a phone upload (→ facts, then complete → bake) and queues `splat`. Splat done → manifest updated with `room.splat`.

## 6. Convex API

Function names are the contract (`backend/convex/<module>.ts`). Validators live in the code; types below are the shapes. All times are ms numbers in Convex and ISO strings only where the old API had them in user-facing JSON (facts, sessions).

### 6.1 Tables (`backend/convex/schema.ts`)

`captures`, `files`, `uploads`, `moments`, `sessions`, `people`, `jobs`, `workers`, `museumRooms`, `museumPresence`, `museumArrangement`. Exact fields in `schema.ts`.

### 6.2 Captures and files (phone, web, workers)

| Function | Kind | Args | Returns |
|---|---|---|---|
| `captures.begin` | mutation | `{ manifest }` (parsed manifest.json) | `{ captureId }`; idempotent per manifest `id`; also registers manifest as a file once its bytes are uploaded |
| `uploads.start` | action | `{ captureId, name, bytes, contentType }` | `{ uploadId, key, partSize, parts: [{ partNumber, url }] }` or `{ uploadId, key, single: { url, headers } }` for files ≤ 8 MiB |
| `uploads.resume` | action | `{ uploadId }` | same shape as start, listing only parts R2 doesn't have yet |
| `uploads.finish` | action | `{ uploadId, parts?: [{ partNumber, etag }] }` | `{ ok, bytes }`; completes the multipart upload, HEADs the object, registers the file (→ stage triggers). Idempotent: a repeat (e.g. after a lost answer) returns the same `{ ok, bytes }` and registers nothing twice |
| `captures.complete` | mutation | `{ captureId }` | `{ ok: true }` or throws `ConvexError({ code: 'invalid', errors })` |
| `captures.list` | query | `{}` | `CaptureSummary[]` newest first: `{ id, title, createdAt, durationSec, source, thumbUrl, status, public }` |
| `captures.get` | query | `{ captureId }` | `{ id, manifest, status, public, files: { [name]: { url, bytes, rev } }, derived: Derived | null, derivedFiles: { [name]: { url, bytes, rev } } }` |
| `captures.setPublic` | mutation | `{ captureId, public }` | `{ ok, public }` |
| `captures.remove` | mutation | `{ captureId }` | `{ ok }` (deletes rows and leaves a tombstone; a scheduled action deletes the R2 objects, then the tombstone. Until then `captures.begin` for that id throws `ConvexError({ code: 'conflict' })`) |
| `videos.create` | mutation | `{ title, attendees, fileName, bytes }` | `{ captureId }`; then upload the video with `uploads.start({ captureId, name: 'source.<ext>' ... })`, which routes to `videos/<id>/` and queues `convert` on finish |

URLs in query results are presigned GETs (§6.4). Signing is pure HMAC-SHA256 over the day-floored date, so it's deterministic and can run inside a query. **Decision (backend):** queries sign directly with a synchronous pure-JS SHA-256/HMAC (`backend/convex/lib/r2.ts`, checked against AWS's SigV4 test vectors); `crypto.subtle` also works in Convex queries (checked on the dev deployment) but isn't needed. There is no `files.urls` action: `captures.get`, `captures.list` and `public.*` return the URLs.

### 6.3 Facts and review (family)

| Function | Kind | Args | Returns |
|---|---|---|---|
| `moments.get` | query | `{ captureId }` | `Moment` (shape as in `guide-api.md`) or `null` with `status` |
| `moments.patchFact` | mutation | `{ captureId, factId, status?, editedText?, doNotRaise? }` | the updated `Fact` |
| `moments.reextract` | mutation | `{ captureId }` | `{ ok }`; queues facts (replaces pending facts, keeps reviewed ones, merged against fresh state in a mutation) |

### 6.4 Presigned URLs

- AWS SigV4 query presigning against R2's S3 API (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`), region `auto`.
- **Stable URLs for caching:** GET URLs are signed with `X-Amz-Date` floored to the start of the current UTC day and `X-Amz-Expires=604800`, so the same file has the same URL all day and the browser cache works. The object's `rev` is part of the signed URL as `x-id=<rev>` (an ignored query param covered by the signature) so a re-bake changes the URL.
- PUT/part URLs expire after 1 hour.
- Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, optional `R2_ENDPOINT` (override for tests).

### 6.5 Sessions, people, progress (patient tablet, dashboard)

Same behavior as `guide-api.md` "Revisit sessions" and "Dashboard"; grounding is the same code (`backend/convex/lib/grounding.ts`).

| Function | Kind | Args | Returns |
|---|---|---|---|
| `people.get` / `people.set` | query / mutation | – / `{ displayName, preferredAddress }` | person |
| `sessions.start` | mutation | `{ captureId }` | `{ sessionId, welcome: Reply }` |
| `sessions.narrate` | action | `{ sessionId, chapterIndex }` | `{ reply: Reply }` |
| `sessions.turn` | action | `{ sessionId, text, focus? }` | `{ reply, branch, distress }` |
| `sessions.end` | action | `{ sessionId, reason }` | `{ scores, branches, note, alerts }` (idempotent) |
| `sessions.get` | query | `{ sessionId }` | full session |
| `progress.get` | query | `{ captureId }` | `Progress` |
| `system.health` | query | `{}` | `{ ok, mock, models: { offline, live } }` |

Env: `ANTHROPIC_API_KEY`, `MODEL_OFFLINE` (default `claude-opus-5-5`), `MODEL_LIVE` (default `claude-sonnet-5-5`), `MOCK_CLAUDE` (`1` = canned `[mock]` output, as before).

### 6.6 Museum

| Function | Kind | Args | Returns |
|---|---|---|---|
| `museum.createRoom` | mutation | `{ at? }` | `{ code }` |
| `museum.room` | query | `{ code }` | `{ code, state: RoomState, peers: Peers }` or `null` (reactive; replaces SSE + polling) |
| `museum.setState` | mutation | `{ code, at, atId?, window, by, name? }` | `{ state }` (validation as in `guide-api.md`) |
| `museum.heartbeat` | mutation | `{ code, client, as, name? }` | `{ ok }`; a screen calls it every 5 s; peers counts heartbeats newer than 12 s |
| `museum.getArrangement` / `museum.setArrangement` / `museum.clearArrangement` | query / mutation / mutation | as in `guide-api.md` | arrangement |

### 6.7 Public (front page, no writes)

`public.captures`, `public.capture({ captureId })`, `public.moment({ captureId })`, `public.progress({ captureId })`, `public.session({ sessionId })`, `public.arrangement` — same filtering rules as `guide-api.md` "Public routes" (only captures marked public; approved, raisable facts in the family's wording; never status internals).

## 7. Job protocol (workers)

One `jobs` table for every background stage, including facts (run by a Convex action) so they all share leases, retries and progress.

```ts
type Job = {
  captureId: string
  kind: 'facts' | 'bake' | 'convert' | 'splat'
  status: 'queued' | 'leased' | 'done' | 'failed'
  needs: { gpu: boolean; frames?: number }   // frames: model frames a convert/splat job needs (from video length)
  attempts: number                          // max 3, then failed
  leaseUntil: number | null                 // ms
  workerId: string | null
  progress: { stage: string; fraction: number | null; message: string } | null
  error: string | null
  createdAt: number; updatedAt: number
}
```

Worker functions take `token` (env `WORKER_TOKEN` in Convex; workers read it from their own env). A wrong token throws.

| Function | Kind | Args | Returns |
|---|---|---|---|
| `worker.claim` | mutation | `{ token, workerId, kinds: string[], gpu: boolean, maxFrames?: number, protocol: 2 }` | `{ jobId, kind, captureId, attempt } \| null`; oldest queued job this worker can run (`needs.gpu` ⇒ worker has gpu; `needs.frames ≤ maxFrames`), leased for 120 s. A claim without `protocol: 2` is refused (`code: 'invalid'`), so an outdated worker takes no jobs |
| `worker.heartbeat` | mutation | `{ token, jobId, attempt, progress? }` | `{ ok, cancelled }`; extends the lease 120 s; `cancelled` = stop now (this attempt lost the lease: re-queued, superseded or the capture deleted) |
| `worker.inputs` | action | `{ token, jobId, attempt }` | `{ manifestJson, files: [{ name, area, url, bytes }] }`: presigned GETs for the capture's raw files (and the source video for convert) |
| `worker.outputUrls` | action | `{ token, jobId, attempt, files: [{ name, bytes, contentType, contentEncoding?, area: 'raw' \| 'derived' }] }` | `[{ name, target }]`, targets in the same shape as `uploads.start`, under this attempt's own keys |
| `worker.finishOutput` | action | `{ token, jobId, attempt, uploadId, parts? }` | `{ ok, bytes }`; completes the upload and **stages** the file (not visible yet); a repeat returns the same answer |
| `worker.complete` | mutation | `{ token, jobId, attempt, result }` | `{ ok }`; **publishes** every file this attempt staged, then per kind: bake → `{ kind: 'bake', derived }` (each `derived.files` name must be staged by this attempt); convert → `{ kind: 'convert', manifestJson }` (runs the same triggers as a phone upload, queues splat); splat → `{ kind: 'splat', splat }` (`splat.file` staged by this attempt, area `raw`). A repeat by the attempt that completed it returns `{ ok }` again |
| `worker.fail` | mutation | `{ token, jobId, attempt, error, retryable }` | `{ ok }`; retryable and attempts < 3 → re-queued, else `failed` |

**Attempts and ownership.** `attempt` (from `claim`) is required on every call after claim. Only the attempt holding the job's current lease may read inputs, get output URLs, finish outputs, complete or fail; every other call is refused with `ConvexError({ code: 'cancelled' })` (heartbeat answers `cancelled: true` instead), checked inside the mutation that would change anything. A worker that gets `cancelled` stops the job and reports nothing. Each attempt writes under `captures/<id>/<area>/<jobId>.<attempt>/<name>`, so a stale attempt's late PUT can never touch a published object, and its staged files are never published. The cron deletes the uploads and objects of attempts that lost their lease (again an hour later, after their PUT URLs expired, in case a late PUT recreated one).

- A cron every 30 s re-queues jobs whose lease expired (`attempts += 1`; at 3 → `failed` with "The worker stopped responding three times.").
- On worker startup, nothing special: expired leases come back on their own.
- Routing: `convert` jobs set `needs.frames` from the video duration (the converter's own frame-count formula: `min(240, max(16, floor(durationSec × 10) + 1))`, `tools/video2capture/convert.py frames_needed`); `splat` jobs need no frames (training uses at most 240 views). The Fedora worker advertises `maxFrames` ≈ 67 (16 GB), the GX10 ≈ 240. A job no live worker can take stays queued and the web says so ("Waiting for a GPU worker that can handle a 4-minute video").
- The `workers` table records `{ workerId, kinds, gpu, maxFrames, lastSeen }` from claims/heartbeats so the web can show which workers are online.

## 8. Static site export

`backend/scripts/export-static.ts` writes `.static-site/` for GitHub Pages from the public data: `data/captures.json`, `data/captures/<id>.json` (same shape as `public.capture`, with relative file URLs), `data/moments/<id>.json`, `data/progress/<id>.json`, `data/sessions/<id>.json`, `data/museum/arrangement.json`, and `data/files/<id>/...` holding the derived files (gzip removed, since Pages compresses), the video, keyframes, thumb, `frames.jsonl`, the depth v2 files and the splat. The web's static mode reads exactly these. **Every URL inside a `data/*.json` file is relative to that JSON file** (as in HTML), so the export works from any folder or sub-path: e.g. `../files/<id>/video.mp4` inside `data/captures/<id>.json`, and `files/<id>/thumb.jpg` for `thumbUrl` inside `data/captures.json`. `data/captures.json` has the shape of `public.captures`; a missing moment, progress or session file means none (the web treats a 404 as null).

## 9. Cutover checklist

The guide is retired only after all of these pass on the v3 stack:
- Existing captures (the four phone scans and the three converted clips) re-imported with their review state, sessions and person (`backend/scripts/import-guide-data.ts`), re-baked, and they render.
- CLAUDE.md §12 acceptance items: grounding drop logged, a rejected or don't-bring-up fact never narrated across 5 sessions, the distress phrase ends the session with an alert, the dashboard shows real timestamps, Revisit works on a tablet in landscape.
- A phone upload survives the app going to the background (Shivin, on the phone).
- A killed worker's job is re-queued and finishes on the next worker.
- A long video is routed to the GX10 worker.
- The public site is republished from the v3 export.
