# Braindance web app

Vite + React + TypeScript + React Three Fiber. It talks only to Convex (`../backend/convex`, contract in `../docs/architecture-v3.md`) and to R2 through the presigned URLs Convex returns. Every Claude call happens in Convex.

Package manager: **bun** (`bun.lock`; the old `package-lock.json` is gone).

## Run it

```bash
bun install --cwd web
bun run --cwd web dev          # http://127.0.0.1:5173, talks to the dev deployment in web/.env.development
bun run --cwd web typecheck    # tsc -b
bun run --cwd web lint         # oxlint
bun run --cwd web test         # vitest: parsers, pose math, data layer, uploads, museum sync
```

- `VITE_CONVEX_URL` is the Convex deployment (no secrets). Dev: `web/.env.development`. A production build needs it set (`VITE_CONVEX_URL=… bun run --cwd web build`).
- The generated `api` is imported from `../backend/convex/_generated/api`. Its `convex` imports resolve to web's copy (`paths` in `tsconfig.app.json`, `resolve.dedupe` in `vite.config.ts`). If backend code imports another package, run `bun install --cwd backend` too so typecheck can see it.
- **Static site** (GitHub Pages): `VITE_STATIC=1 bun run --cwd web build`, then copy `web/dist` into the export from `backend/scripts/export-static.ts` (`.static-site/`). Static mode reads only `data/*.json` and `data/files/` (architecture-v3.md §8), never Convex.

## Screens (hash routes, each loaded on demand)

- `#/` **Front page:** public moments only. The 3D scenes load after the page (the first download has no three.js).
- `#/p/<id>` a public moment: the viewer with the family's approved facts.
- `#/captures` **Captures:** drop a capture zip from the phone, or an old video (turned into an estimated 3D moment), or open a `room.bin` on its own. Cards show live per-stage status (facts, room bake, video → 3D, splat), the running job's progress, and which workers are online. Also: who the visits are for, and how Claude addresses them.
- `#/capture/<id>` **Viewer + Revisit:** the room, people replayed in 3D, a dot avatar showing the recorder at a fixed floor height, synced video, and the narrated visit.
- `#/facts/<id>` **Fact review:** live; approve, edit, reject, "don't bring this up", ask Claude again.
- `#/dashboard`, `#/dashboard/<id>` **Dashboard:** recall per session at real times, older memories, distress alerts, next revisits.
- `#/museum`, `#/museum/edit`, `#/window/<id>`: the museum, its editor, the Memory Window.

A red **MOCK MODE** banner shows whenever the backend runs with `MOCK_CLAUDE=1`.

## Uploads

`src/upload.ts`: the zip is opened in the browser (macOS `._` files and `room.ply` are skipped). Then `captures.begin`, and per file `uploads.start`, a single PUT or 4 parts at a time straight to R2, and `uploads.finish`; at the end `captures.complete`. Files go in this order: manifest, thumb, transcript, keyframes, room, frames, video, depth, so facts start before the big files land. Parts are retried with backoff; then `uploads.resume` gives fresh URLs. Unfinished uploads are kept in IndexedDB: drop the same zip after a reload and it carries on, skipping files the server already has. An old video works the same way: the same file (same title and people) dropped again goes on into the capture made the first time. Saved state older than 7 days is forgotten (R2 aborts unfinished multipart uploads by then). R2's CORS rules must allow `PUT` from the site and expose the `ETag` header.

## Layout

```
src/data/                  the data layer: everything goes through here
  index.ts                 DataProvider, loadCaptureAssets/useCaptureAssets, fetchBytes/fetchText, hooks
  assets.ts                CaptureAssets: the boundary the 3D code reads
  fetchCache.ts            page-wide byte cache (LRU by bytes, de-duplicated, Range-aware, abortable)
  captureAssets.ts         Convex/static payload → CaptureAssets; static-site paths
  live.ts / public.ts      family + session calls (live only) / public reads (live or static)
  museum.ts                visits, the caretaker's arrangement, Visit together rooms
  uploadPlan.ts            pure upload rules (order, parts, resume)
src/upload.ts              zip/folder reading and the upload itself
src/scene/                 the 3D viewer (render worker)
src/museum/, src/window/   the museum and the Memory Window
src/views/                 Gallery, CaptureView, FactsPanel, Dashboard, PublicView, Showcase, VisitDock
tests/                     vitest; tests/fixture.ts is a synthetic box room for tests only
```
