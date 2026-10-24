# Braindance Capture: iPhone app build plan

Target device: **iPhone 16 Pro Max** (A18 Pro, LiDAR). Owner: teammate A, working with Claude Code.
This file replaces Section 4 of `CLAUDE.md`. The capture package format in Section 5 of that file still applies, with the additions in Section 7 below.

Read `CLAUDE.md` Section 0 first. Hackathon rule: write everything fresh. Apple's public sample code ("Displaying a point cloud using scene depth") is fine to study and follow as a pattern; credit it in the README. Do not copy anything from the Rumi repo.

---

## 1. What the app does

SiteScape-style capture plus moment recording, in **one continuous ARKit session** so everything shares one coordinate system.

1. **Room scan (about 30–60 s).** The filmer sweeps the room. The phone fuses LiDAR depth and camera color into a dense colored point cloud live, drawn over the camera view, so the filmer sees coverage fill in and spots gaps. This produces the beautiful static room.
2. **Moment recording (up to 3 min).** The filmer taps "Record the visit." The app records video, audio, poses and depth for the people and conversation. Accumulation pauses, so people walking around don't smear into the room cloud.
3. **Review.** Orbit the finished cloud on the phone, play back the clip, name the moment, list who was there.
4. **Send.** Upload to the server, or AirDrop as a backup.

The session must **never reset** between phases. The room cloud and the moment's camera poses then line up exactly, which lets the web app replay people inside the scanned room.

---

## 2. Project setup

- Xcode 16+ (or whichever version supports the phone's iOS). New project: iOS App, SwiftUI, Swift.
- Deployment target **iOS 18.0** (the 16 Pro Max ships with 18).
- Frameworks: ARKit, Metal, MetalKit, AVFoundation, SceneKit (review viewer only). **No third-party dependencies. No RoomPlan.**
- Info.plist: `NSCameraUsageDescription` ("Braindance uses the camera and LiDAR to capture the room and the visit."), `NSMicrophoneUsageDescription` ("Braindance records audio so your family can hear the visit again.").
- Signing: Personal Team, unique bundle ID like `com.<name>.braindance.capture`. Enable Developer Mode on the phone.
- Device check at launch: `ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)`. If false (or in the simulator), show an unsupported screen.

---

## 3. Architecture

```
App/
  BraindanceCaptureApp.swift      SwiftUI entry
  AppModel.swift                  phase state machine, @MainActor ObservableObject
Capture/
  CaptureEngine.swift             owns ARSession, ARSessionDelegate, fans frames out
  Renderer.swift                  MTKViewDelegate: camera background + point overlay
  PointAccumulator.swift          GPU unprojection into a point ring buffer
  Shaders.metal                   camera quad, unproject kernel, point sprites
  Recorder.swift                  AVAssetWriter video+audio, frames.jsonl, depth.bin
  PointCloudExporter.swift        voxel downsample + PLY + scene.bin
  CaptureStore.swift              capture folders on disk, manifest.json
  Uploader.swift                  per-file upload with retries
UI/
  HomeView.swift
  ScanView.swift                  MTKView wrapper + HUD
  ReviewView.swift                SceneKit point cloud orbit + AVPlayer
  SendView.swift
Tests/
  ExporterTests.swift, ManifestTests.swift, DepthConversionTests.swift, RetimeTests.swift
```

### Phase state machine (`AppModel`)
`idle → scanningRoom → readyToRecord → recordingMoment → finishing → review → uploading → done`, plus `failed(message)` from any state.
Give every capture attempt a UUID token and ignore callbacks carrying an old token, so late ARKit or writer callbacks can't revive a finished capture. Fail an active capture when the app backgrounds (`scenePhase != .active`).

---

## 4. ARKit configuration

```swift
let config = ARWorldTrackingConfiguration()
config.frameSemantics = [.smoothedSceneDepth]   // less flicker than .sceneDepth
config.providesAudioData = true                 // audio on the session clock
config.sceneReconstruction = []                  // not needed; our cloud replaces the mesh
config.environmentTexturing = .none
config.planeDetection = []
// Default 4:3 1920x1440 @ 30 fps. Keep it: matches depth aspect (256x192) and the recorder.
session.delegateQueue = captureQueue              // a dedicated serial queue, not main
session.run(config, options: [.resetTracking, .removeExistingAnchors])  // only at capture start
```

`CaptureEngine` implements:
- `session(_:didUpdate frame:)`: hands the frame to the renderer (latest-frame slot), to the accumulator (while scanning), and to the recorder (while recording). **Return fast and never store `ARFrame`s.**
- `session(_:didOutputAudioSampleBuffer:)`: forwards to the recorder while recording.
- `session(_:cameraDidChangeTrackingState:)`: updates HUD guidance.
- `sessionWasInterrupted`: fails the capture with a clear message.

---

## 5. Live point cloud (the SiteScape part)

### 5.1 GPU data
- `CVMetalTextureCache` turns `capturedImage` into two textures: Y (`r8Unorm`) and CbCr (`rg8Unorm`). Depth `depthMap` becomes an `r32Float` texture and `confidenceMap` an `r8Uint` texture, all through the same cache. No CPU copies.
- Point buffer: a `MTLBuffer` ring of `maxPoints = 4_000_000` structs `{ packed_float3 position; uchar4 color; }` (16 bytes → 64 MB). The A18 Pro handles this comfortably.
- Uniforms per frame: camera intrinsics scaled to depth resolution, camera-to-world transform, view-projection matrix for the overlay, display transform for the current orientation.

### 5.2 Accumulation kernel (`unprojectKernel`)
Run when the camera moved **more than 2 cm or rotated more than 2°** since the last accumulation (prevents piling duplicate points while standing still).
For each depth pixel `(u, v)` in 256×192, with a stride of 2 (≈12k points per pass; drop to stride 1 if it looks sparse):
1. Skip if confidence < 2 (high) or depth outside 0.2–4.5 m.
2. Unproject: `p_img = ((u − cx')·d/fx', (v − cy')·d/fy', d)`, convert to ARKit camera space `(x, −y, −z)`, then `world = T · p`.
3. Sample color: convert `(u, v)` to capturedImage UV (same 4:3 aspect, so a straight scale), read Y and CbCr, convert BT.601 full-range YCbCr to sRGB.
4. Write to the ring buffer at `atomic_fetch_add(&writeIndex, 1) % maxPoints`.

Intrinsics come from `frame.camera.intrinsics` at 1920×1440; scale by 256/1920 and 192/1440 for the depth grid.

### 5.3 Rendering (`Renderer`, 60 fps `MTKView`)
1. Full-screen quad drawing the camera image (Y + CbCr → RGB), mapped through `frame.displayTransform(for:viewportSize:)` so it stays upright.
2. Point sprites for the accumulated cloud, projected with the current camera's view and `camera.projectionMatrix(for:viewportSize:zNear:zFar:)`. Size 2–4 px, slightly brighter than the camera feed so captured areas visibly "light up."
3. A toggle in the HUD: **overlay** (cloud on camera) vs **cloud only** (black background) so the filmer can judge coverage.

### 5.4 Coverage guidance
Show a point count and a simple "coverage" hint: if the last 3 seconds added fewer than ~2k new points while moving, say "Try a new angle or the corners." If tracking is limited, say "Move slowly."

### 5.5 Perf and thermal targets
- Preview holds 60 fps; accumulation under 3 ms GPU per pass (check in Xcode's GPU frame capture).
- Watch `ProcessInfo.processInfo.thermalState`: at `.serious`, switch accumulation stride to 4 and show a warning; at `.critical`, stop scanning and keep what's captured.
- Stop accumulating automatically at 4M points and say "Room captured."

---

## 6. Moment recording

Starts from the **same session**, no reset.

| Stream | Rate | How |
|---|---|---|
| Video | every frame (30 Hz) | `AVAssetWriter`, HEVC, `AVAssetWriterInputPixelBufferAdaptor`, append `capturedImage` directly, `expectsMediaDataInRealTime = true` |
| Audio | continuous | AAC input on the same writer, from `didOutputAudioSampleBuffer` |
| Pose + intrinsics + tracking | every frame | one line per frame in `frames.jsonl` |
| Depth | 10 Hz | `smoothedSceneDepth.depthMap` Float32 → UInt16 mm, appended to `depth.bin` |
| Confidence | 10 Hz, same frames | UInt8, appended to `confidence.bin` |

- Timestamps: `t0` = first recorded frame's `frame.timestamp`; every sample (video and audio) at `CMTime(seconds: ts − t0, preferredTimescale: 600)`. Drop audio buffers that arrive before `t0`.
- Do the Float32 → UInt16 conversion immediately in the delegate (it's 49k values, microseconds), wrap the result in `Data`, and hand it to a serial file-writing queue.
- The overlay keeps showing the frozen room cloud dimmed, so the filmer still sees the room.
- Cap at 3 minutes; show a timer.
- **Clap test** on day one: clap on camera, confirm on the laptop (ffmpeg waveform vs frame) that audio and hands line up within one frame.

Also record poses and depth during the room scan into the same files with `"phase": "scan"` on each line, so the server could re-fuse the room later if needed. The video writer only runs during the moment.

---

## 7. Export and package additions

When the moment stops:
1. Finish the asset writer and close `frames.jsonl`, `depth.bin`, `confidence.bin`.
2. `PointCloudExporter` copies the ring buffer to CPU, voxel-downsamples at **1 cm** (hash `Int64` keys from floored coordinates, average colors per voxel), and writes:
   - `room.ply`: binary little-endian, `float x y z`, `uchar red green blue`.
   - `room.bin`: the web's compact format, a UInt32 point count, then float32 xyz for all points, then uint8 rgb for all points.
3. Write `manifest.json` (format from `CLAUDE.md` Section 5) with these additions:
```json
{
  "room": { "ply": "room.ply", "bin": "room.bin", "points": 1834221, "voxelMeters": 0.01, "source": "on-device" },
  "phases": { "scan": { "tStart": -48.2, "tEnd": 0 }, "moment": { "tStart": 0, "tEnd": 61.2 } }
}
```
Scan timestamps sit before 0 because `t0` belongs to the moment.

---

## 8. Review screen

- **SceneKit** point cloud: build an `SCNGeometry` from `room.bin` with a `.point` element, `pointSize = 3`, `minimumPointScreenSpaceRadius = 1`, `maximumPointScreenSpaceRadius = 4`, vertex colors. Orbit with `allowsCameraControl = true`. Load on a background queue; 2M points renders fine on this phone.
- Overlay the recorded camera path from `frames.jsonl` as a thin line.
- `AVPlayer` for the clip.
- Fields: moment title, who was there. "Rescan room" and "Re-record visit" buttons, each with a confirmation.

---

## 9. Upload

- Pairing: scan a QR from the web app (`braindance://pair?url=...&token=...`), or type the server URL in settings.
- `POST /api/captures` → `{id, uploadToken}`; then `PUT /api/captures/{id}/files/{name}` for each file using `URLSession.uploadTask(with:fromFile:)`, up to three retries per file; then `POST /api/captures/{id}/complete`.
- Upload order: `manifest.json`, `room.bin`, `thumb.jpg` first (so the web shows the room within seconds), then the large files.
- Backup: zip the folder with `NSFileCoordinator` (`.forUploading`) and present a share sheet for AirDrop.
- Venue Wi-Fi may block local traffic. Point the app at the server's `cloudflared` or Tailscale HTTPS URL.

---

## 10. Build order and checkpoints (it's ~05:30 Sat)

| By | Checkpoint | How to verify |
|---|---|---|
| 07:00 | App runs on the 16 Pro Max; MTKView shows the upright camera feed at 60 fps | Visual check in portrait and landscape |
| 08:30 | Live points accumulate and render over the camera | Sweep a desk; points stay locked to real objects as you move |
| 09:30 | Export works: `room.ply` opens in CloudCompare or MeshLab on a laptop with correct colors and scale | Measure a known object (a door is about 2 m) |
| 10:00 | **Send a real `room.bin` to the web teammate** | They render it in three.js |
| 12:00 | Moment recording: video + audio + poses + depth; clap test passes | ffmpeg waveform vs frames |
| 13:30 | Review screen + manifest + upload with retries | Server validates the package |
| 15:00 | Coverage hints, thermal handling, lifecycle edge cases (background, interruption, low storage) | Lock the phone mid-scan; app fails cleanly |
| 17:00 | Polish HUD; stretch goals below | |

Stretch, only after 15:00 checkpoint passes:
- Confidence-weighted voxel fusion on the GPU instead of the ring buffer (fewer floaters).
- Eye-dome lighting or soft round sprites in the review viewer for a nicer look.
- "Gaps" visualization: highlight screen regions where depth exists but few points landed.

---

## 11. Gotchas

- **Orientation.** `capturedImage`, depth and confidence always come in the sensor's landscape orientation. Use `displayTransform` for drawing; never rotate the stored data. Record `"imageOrientation": "landscapeRight"` in the manifest.
- **Coordinate flip.** ARKit cameras look down −z with y up; image rows go down. The `(x, −y, −z)` conversion in 5.2 handles it. Write a unit test with a synthetic depth plane at 1 m to confirm points land at z = −1 in camera space.
- **YCbCr.** Use full-range BT.601 for `capturedImage` (`420YpCbCr8BiPlanarFullRange`). Wrong matrix = washed-out or green colors.
- **Retained frames.** If Xcode logs "delegate is retaining N ARFrames," something holds a frame; fix immediately or tracking will degrade.
- **Texture cache.** Call `CVMetalTextureCacheFlush` periodically and keep the `CVMetalTexture` alive until the GPU command buffer completes (use `addCompletedHandler`).
- **Moving people during the scan.** Ask the filmer to scan the room before people gather, or while they sit still. Accumulation pauses during the moment for this reason.
- **Mirrors and windows** produce bad depth. Accept it; the confidence filter removes the worst.

---

## 12. Instructions for Claude Code

1. Generate the Xcode project as source files plus a `project.yml` for XcodeGen **or** give step-by-step instructions to create the project in Xcode and add files; the teammate runs it on the phone. You can't build or run it yourself.
2. Keep pure logic (depth conversion, voxel downsample, manifest encoding, timestamp retiming, PLY writing) in plain Swift types with XCTest coverage that runs in the simulator.
3. Write `ios/VERIFY.md`: a checklist of everything that needs the physical phone, matching Section 10.
4. Never show fake or placeholder points as if they were captured. If depth is unavailable, show a message.
5. Comment the coordinate math carefully; the server and web unproject depth with the same formulas.
