# On-device checks

Everything here needs the iPhone 16 Pro Max. Claude Code can't run the app, so each checkpoint stops here until someone checks it on the phone. Checkpoints follow `IOS_CAPTURE_PLAN.md` Section 10.

## Checkpoint 1 (07:00): upright camera feed at 60 fps

- [ ] The app installs and launches from Xcode on the phone
- [ ] Home shows "Scan the room". Tapping it asks for camera access the first time
- [ ] The camera feed fills the screen edge to edge with no black bars or stretching
- [ ] Portrait: the image is upright and moves the right way when you pan
- [ ] Landscape left and landscape right: still upright and not mirrored
- [ ] The HUD reads about 60 fps and stays there while you sweep the room
- [ ] Colors look natural: skin isn't green and whites aren't grey (this checks the BT.601 full-range matrix)
- [ ] Covering the camera or pointing at a blank wall shows a tracking hint like "Point at something with more detail"
- [ ] Deny camera access in Settings, then start a scan: you see the "needs camera access" message, not a black screen
- [ ] Mid-scan, swipe to the home screen and come back: "Capture stopped" appears
- [ ] Mid-scan, lock the phone and unlock it: "Capture stopped" appears
- [ ] Tap Stop: you're back on Home, and scanning again works
- [ ] Xcode console shows no "delegate is retaining N ARFrames" warning

## Checkpoint 2 (08:30): live points accumulate and render over the camera

- [ ] Unit tests pass: in Xcode, choose an iPhone simulator and press Cmd+U. These cover the coordinate math
- [ ] Sweep a desk: colored points appear over the surfaces as you move
- [ ] Points stay locked to real objects as you walk around them, with no swimming or lag
- [ ] Point colors match the real objects (a red mug gives red points)
- [ ] The cloud's scale looks right: points on the desk edge sit on the real edge, not in front of or behind it
- [ ] Standing still adds no new points; the count in the HUD holds steady
- [ ] The count rises steadily while you move (around 10k points per step)
- [ ] "Cloud only" shows the points on black and still looks like the room
- [ ] It rotates correctly in landscape too
- [ ] The HUD holds about 60 fps with more than 1M points
- [ ] Scanning to the 4M cap shows "Room captured" and the count stops rising
- [ ] Stop, then start a new scan: the old points are gone

## Checkpoint 3 (09:30): `room.ply` opens on a laptop with correct colors and scale

- [ ] After a scan, "Save room" shows "Saving room…" and then "Room saved: N points at 1 cm" within a few seconds
- [ ] The camera and frozen cloud stay live after saving (the session never resets)
- [ ] "Share room files" AirDrops `room.ply` and `room.bin` to the Mac
- [ ] The Files app shows them too: On My iPhone > Braindance > captures > capture-<id>
- [ ] `room.ply` opens in MeshLab or CloudCompare with natural colors (not green or washed out)
- [ ] Scale is right: a door measures about 2 m tall, and a desk is about 0.75 m off the floor
- [ ] The floor is flat and horizontal (ARKit's y is up, so the floor is a plane of constant y)
- [ ] Walls are thin rather than doubled or smeared

## Checkpoint 4 (10:00): real `room.bin` sent to the web teammate

Not built yet.

## Checkpoint 5 (12:00): moment recording and clap test

Not built yet.

## Checkpoint 6 (13:30): review, manifest and upload

The upload and transcript steps changed in v3; their checks are in "v3" at the bottom.

- [ ] Starting a scan asks for speech recognition permission (along with camera and microphone)
- [ ] The review screen plays the clip; tapping a transcript line jumps the video there
- [ ] The transcript is roughly right, with times that match when things were said
- [ ] Typing a title and names, then leaving the field, saves them (they appear in manifest.json)
- [ ] "AirDrop the capture (zip)" sends a zip that includes manifest.json with the title, transcript.json and keyframes/
- [ ] The video plays in Chrome on a laptop (it's H.264 video.mp4 now)
- [ ] Locking the phone during "Finishing the transcript…" doesn't lose the capture; it finishes when you come back

## Medium-confidence option (Settings > Room scan)

- [ ] Off by default: a scan with the toggle off behaves as before (point count similar to earlier scans of the same place)
- [ ] With the toggle on, scanning the same place gives more points, with no obvious floating noise
- [ ] The toggle survives quitting and relaunching the app
- [ ] Scanning still works with the toggle on (this also checks the shader's uniform layout matches the Swift struct, 112 bytes)

## Checkpoint 7 (15:00): coverage hints, thermal and lifecycle edge cases

Not built yet.

## Guided UI (home, scan, review)

- [ ] Home shows the tagline, the three steps, the tips card, one big "Start scanning" button, and the upload status line
- [ ] Scanning shows "Step 1 of 3" and a coach line that changes as the room fills (sweep slowly, good start, plenty of room)
- [ ] Moving too fast or covering the camera turns the coach line amber with the tracking message
- [ ] "Save room" stays dimmed until there are about 2,000 points, then saves with a buzz
- [ ] After saving, the coach says to let people in, and "Record the visit" is a big red button
- [ ] Recording shows a breathing red dot, a large timer, a 3:00 progress bar and "Stop recording"
- [ ] The wait screen says "Putting your visit together" and keeps the app open
- [ ] Review shows "Step 3 of 3", three stat tiles, a "Send to your family's Braindance" button, and a buzz when the upload succeeds
- [ ] A normal capture still works end to end

## v3: smaller captures, live keyframes and transcript, background uploads

Unit tests first: Cmd+U on an iPhone simulator. New ones cover depth v2 (`DepthV2Tests`, including inflating raw DEFLATE made by another library), live keyframe timing, the upload plan, Convex answers and saved upload progress (`UploadTests`). The pure upload and depth code was also compiled and tested on Linux (Swift 6.2), including a full upload against a fake Convex + R2 server, but nothing here has run on an iPhone yet.

Everything below needs the phone. Use a 30 s visit unless a step says otherwise.

**Before uploading, the Convex backend must have `uploads:*` and `captures:*` working with R2 credentials.** Until it does, "Test connection" fails with the backend's "not implemented" message, and uploads fail at `captures:begin` with a plain error.

Recording
- [ ] A capture builds and installs (XcodeGen picked up the new files: DepthV2, LiveTranscriber, ConvexClient, UploadPlan, UploadJob, UploadCenter)
- [ ] The HUD still holds about 30 fps while recording, and manifest `warnings` has no "Dropped … video frames" (live keyframes and live transcription add work during recording)
- [ ] Clap test still passes: the clap's sound lines up with the hands meeting within one frame
- [ ] A 30 s capture's `video.mp4` is about 30 MB (it was about 71 MB). In Files > Get Info, or `ls -l` on the unzipped AirDrop zip
- [ ] `ffprobe video.mp4` (on the Mac) shows h264 High, 1920x1440, about 8,000 kb/s, 30 fps, and AAC audio
- [ ] The video still looks sharp enough when you pause on a face in the review player

Depth v2
- [ ] The folder has `depth.bin` and `depth.index.json` and no `confidence.bin`
- [ ] manifest.json `depth` has `"encoding": "v2"`, `"index": "depth.index.json"`, no `confidenceFile`, and `count` equals `count` in depth.index.json
- [ ] `depth.bin` is much smaller than before (v1 was 43 MB of depth plus 22 MB of confidence for 30 s); note the size in the PR
- [ ] On the Mac: `bun -e` with `shared/depth.ts` (`parseDepthIndex`, `decodeChunk` with `zlib.inflateRawSync`) decodes every chunk, and a pixel's millimeters look plausible (a wall 2 m away reads about 2000)
- [ ] The web viewer (once it reads v2) replays people from this capture's depth

Keyframes
- [ ] There's no "Making keyframes…" step after Stop any more
- [ ] `keyframes/` has k0000.jpg up to the last whole second, with no gaps, and manifest `keyframes.count` matches
- [ ] Each keyframe is 1024x768 and matches the video at that second (open k0010.jpg and pause the video at 0:10; same picture within a frame)
- [ ] Keyframes are stored landscape like the video (a portrait recording gives sideways keyframes, as the contract says; the backend rotates them)

Transcript
- [ ] Right after Stop, "Finishing the transcript…" takes only a few seconds, even for a 2 to 3 minute visit
- [ ] The transcript's words and times match the video (tap a line in review: the video jumps to when it was said)
- [ ] A visit where nobody speaks gives "No speech detected", not an error
- [ ] Turn off speech recognition in Settings > Braindance, record: the review says why there's no transcript (manifest warning), and nothing is made up
- [ ] A 3-minute visit gets a complete transcript (live on-device recognition has no one-minute limit; if it stops early, the app falls back to the saved audio, which takes longer)

Upload
- [ ] Settings shows the Convex URL (default `https://adamant-schnauzer-171.convex.cloud`); "Test connection" says "Connected to Braindance."
- [ ] A wrong URL gives a plain error, not a spinner forever
- [ ] "Send to your family's Braindance" shows a progress bar with "N of M files", and ends with "Sent. Braindance checked every file."
- [ ] In the Convex dashboard, the capture exists with `upload: done`, and its R2 objects are under `captures/<id>/raw/` with the same sizes as on the phone; there is no `room.ply`
- [ ] Facts start as soon as the manifest, keyframes and transcript are in (before the video finishes uploading)
- [ ] Lock the phone right after tapping send, wait a few minutes, unlock: the upload kept going (or finished) while locked
- [ ] Send, then go to the home screen and open another app for a few minutes: the upload continues and finishes
- [ ] Send, then force-quit the app (swipe it away) halfway through. Reopen it: Home shows the upload resuming, and it finishes without starting over (the progress jumps back to about where it was; the Convex logs show `uploads:resume`, not new `uploads:start` calls for files that were done)
- [ ] Turn on Airplane mode mid-upload: progress stops; turn it off: it carries on. If it ends in an error instead, "Try again" finishes it
- [ ] Force-quit mid-upload of the video, turn on Airplane mode, reopen the app (so `uploads:resume` fails), then turn Airplane mode off: the upload keeps the same upload and finishes without re-sending the parts already in R2 (Convex logs: `uploads:resume` again, no new `uploads:start` for video.mp4)
- [ ] "Finish" on the review screen during an upload goes home, and Home shows "Uploading “title”… N%"
- [ ] An upload that failed for good (e.g. the backend rejected the package) shows the reason on Home with "Try again" and "Stop trying"
- [ ] A 3-minute visit (about 180 MB of video) uploads completely on venue Wi-Fi
- [ ] AirDrop of the zip still works

