# Braindance Capture (iOS)

The iPhone app that scans the room as a colored point cloud and records the visit. The full plan is in `../IOS_CAPTURE_PLAN.md`, and the on-device checklist is in `VERIFY.md`.

## Setup

You need Xcode 16 or later and a LiDAR iPhone running iOS 18.

```bash
brew install xcodegen
cd ios
xcodegen generate
open BraindanceCapture.xcodeproj
```

`project.yml` is the source of truth. The `.xcodeproj` is generated and not committed, so re-run `xcodegen generate` after you pull or add files.

To sign, either set your team under Signing & Capabilities in Xcode, or put your team ID in `DEVELOPMENT_TEAM` in `project.yml` so it survives regeneration. On the phone, turn on Settings > Privacy & Security > Developer Mode.

## What it writes and where it goes (v3)

The capture folder follows `docs/capture-format.md`, with depth v2 from `docs/architecture-v3.md` §3:

- `video.mp4`: H.264 at 8 Mbps, 1920x1440, 30 fps, AAC audio (about 30 MB per 30 s).
- `depth.bin` + `depth.index.json`: depth and confidence packed into one UInt16 per pixel, in raw-DEFLATE chunks of 10 frames. There's no `confidence.bin`.
- `keyframes/kNNNN.jpg`: taken live from the camera at each whole second of the moment, long side 1024, in the sensor's landscape orientation like the video.
- `transcript.json`: recognized on the phone while recording, so it's ready at Stop. If live recognition fails, the phone transcribes the saved audio instead. Nothing is guessed.
- `room.bin`, `frames.jsonl`, `thumb.jpg`, `manifest.json` as before. `room.ply` is still written for AirDrop and MeshLab but isn't uploaded or listed in the manifest.

Uploads go through Convex and Cloudflare R2 (`docs/architecture-v3.md` §6.2): `captures:begin`, then for each file `uploads:start` (or `uploads:resume`), PUTs straight to R2 with the presigned URLs, `uploads:finish`, and last `captures:complete`. Files over 8 MiB go up as multipart parts. Every PUT runs on a background `URLSession`, so the upload continues when the phone locks or the app is in the background. Progress is saved in `Application Support/uploads/<capture id>/`, so a relaunch (even after a force-quit) resumes instead of starting over. The Convex URL is in Settings (default `https://adamant-schnauzer-171.convex.cloud`). AirDrop of the zip still works as the fallback.

## Code map

| File | Does |
|---|---|
| `Capture/Recorder.swift` | Video, audio, poses, depth v2, live keyframes, feeds the live transcriber |
| `Capture/DepthV2.swift` | Depth v2 pixel packing, raw-DEFLATE chunks, `depth.index.json` |
| `Capture/LiveTranscriber.swift`, `Capture/PostProcessor.swift` | On-device speech recognition, live with a post-hoc fallback |
| `Capture/ConvexClient.swift` | Convex HTTP API calls and errors |
| `Capture/UploadPlan.swift`, `Capture/UploadJob.swift` | Upload order, multipart parts, saved upload progress (pure, tested) |
| `Capture/Uploader.swift` | The upload itself and the background `URLSession` |
| `App/UploadCenter.swift` | The upload shown on Home and Review; resumes after a relaunch |

## Tests

Choose an iPhone simulator in Xcode and press Cmd+U, or run `xcodebuild test -project BraindanceCapture.xcodeproj -scheme BraindanceCapture -destination 'platform=iOS Simulator,name=iPhone 16 Pro'`. Everything that needs the phone is in `VERIFY.md`.

## Credits

The camera-background rendering follows the pattern in Apple's public sample code "Displaying a point cloud using scene depth." All code here was written fresh during the event.
