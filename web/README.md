# Braindance web app

Vite + React + TypeScript + React Three Fiber. Owner: Firdavs. It talks only to the guide server (`../guide`, API in `../docs/guide-api.md`); every Claude call happens there.

## Run it

The guide serves the built app at `/`, so one URL works for everything:

```bash
npm --prefix web install
npm --prefix web run build
npm --prefix guide start          # then open http://127.0.0.1:8787
```

While developing, run Vite with hot reload (it proxies `/api`, `/files` and `/health` to the guide on 8787):

```bash
npm --prefix guide start
npm --prefix web run dev          # http://127.0.0.1:5173
npm --prefix web test             # vitest: parsers, pose math, selection math
```

If the guide has `BRAINDANCE_KEY` set, the gallery asks for the team password once.

## Screens (hash routes)

- `#/` **Gallery:** drop a capture zip from the phone (uploaded to the guide), or open a `room.bin` on its own (stays in the browser). Cards show real pipeline status.
- `#/capture/<id>` **Viewer + fact review:** the room as soft points, people replayed in 3D from depth, the phone's path, synced video, and the family's fact review beside it.
  - **Orbit:** drag to see the pivot from any angle; the pivot is the room center, or whatever you click. Esc goes back to the center.
  - **Fly:** drag turns the room around you. Hold WASD to fly and steer with the mouse like a shooter (cursor hidden, keeps turning at the screen edge, comes back at the crosshair). E up, Q down, Shift faster, Alt slower.
  - **Camera view:** ride along with the phone.
  - **Select:** click an object to see its size and when the recording camera saw it (marks on the scrubber). F flies to it. Space plays and pauses.
- `#/room` a `room.bin` opened from this computer: Orbit, Fly and select.
- `#/revisit/<id>` **Revisit (patient):** welcome, slow replay with grounded narration, push-to-talk conversation, caregiver corner, goodbye.
- `#/dashboard/<id>` **Dashboard (family):** recall per session at real times, older memories, distress alerts, next revisits.

## Layout

```
src/api.ts                 guide client; ?key= on file URLs for <video>/<img>
src/upload.ts              unzip in the browser (fflate), upload file by file, then validate
src/scene/formats.ts       room.bin and frames.jsonl readers
src/scene/pose.ts          unprojection and upright-video math (matches docs/capture-format.md)
src/scene/spatial.ts       voxel index, picking, floor/wall detection, object selection, on-camera intervals
src/scene/SceneViewer.tsx  the 3D viewer: StaticCloud, CameraPath, DepthReplay, Navigation (Orbit/Fly)
src/views/                 Gallery, CaptureView, FactsPanel, RoomFile, Revisit, Dashboard
tests/                     vitest; tests/fixture.ts is a synthetic box room for tests only
```
