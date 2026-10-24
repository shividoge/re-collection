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

Not built yet.

## Checkpoint 7 (15:00): coverage hints, thermal and lifecycle edge cases

Not built yet.
