# Braindance web app

The family-facing viewer: drop a capture zip from the phone, see it in the gallery, and step into it in 3D.

- **Room:** the phone's scan (`room.bin`) as soft round points, every point where the LiDAR measured it. Gaps stay empty.
- **People:** the Braindance effect. Each 10 Hz depth frame is unprojected with that frame's own camera pose and colored from the video, so whoever was in the visit replays in 3D, in place, in sync with sound (`src/scene/DepthReplay.tsx`).
- **Path:** where the phone went during the scan (grey) and the moment (orange), plus a marker at the current frame.
- **Phone's view:** the camera rides the recorded pose, so the 3D lines up with the video.

The math and file formats are in `../docs/capture-format.md`; the API is `../docs/guide-api.md`.

## Run it

The guide server serves the built app at `/`, so one URL works for everything:

```bash
npm --prefix web install
npm --prefix web run build
npm --prefix guide start          # then open http://127.0.0.1:8787
```

While developing, run Vite with hot reload (it proxies `/api`, `/files` and `/health` to the guide on 8787):

```bash
npm --prefix guide start
npm --prefix web run dev          # http://127.0.0.1:5173
```

If the guide has `BRAINDANCE_KEY` set, the gallery asks for the team password once and remembers it in this browser.

## Layout

```
src/api.ts                guide client; ?key= on file URLs for <video>/<img>
src/capture.ts            room.bin and frames.jsonl parsing, frame lookup by time, depth decoding
src/upload.ts             unzip in the browser (fflate), upload file by file, then validate
src/views/Gallery.tsx     drop zone + capture cards
src/views/Viewer.tsx      3D stage, video panel, transport, view modes, layer toggles
src/scene/                RoomCloud, CameraPath/CameraMarker, DepthReplay, point material
```
