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

- [ ] Starting a scan asks for speech recognition permission (along with camera and microphone)
- [ ] After "Stop recording" you see "Making keyframes…", then "Transcribing on the phone…", then the review screen
- [ ] The review screen plays the clip; tapping a transcript line jumps the video there
- [ ] The transcript is roughly right, with times that match when things were said
- [ ] Typing a title and names, then leaving the field, saves them (they appear in manifest.json)
- [ ] Settings: paste the guide's tunnel URL, tap "Test connection", and see "Connected to the guide."
- [ ] Wrong key in Settings shows "Connected, but the key is wrong."
- [ ] "Upload to the guide" shows progress per file and ends with "Uploaded. The guide checked every file."
- [ ] On the laptop, `curl <guide>/api/captures` lists the capture with its title and `"upload": "done"`
- [ ] Turning on Airplane mode mid-upload ends in a clear error; "Try again" finishes the upload
- [ ] "AirDrop the capture (zip)" sends a zip that includes manifest.json with the title, transcript.json and keyframes/
- [ ] The video plays in Chrome on a laptop (it's H.264 video.mp4 now)
- [ ] Locking the phone during "Transcribing…" doesn't lose the capture; it finishes when you come back

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
- [ ] Review shows "Step 3 of 3", three stat tiles, a "Send to your family's guide" button, and a buzz when the upload succeeds
- [ ] A normal capture still works end to end and the zip still imports into the guide

