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

Not built yet.

## Checkpoint 3 (09:30): `room.ply` opens on a laptop with correct colors and scale

Not built yet.

## Checkpoint 4 (10:00): real `room.bin` sent to the web teammate

Not built yet.

## Checkpoint 5 (12:00): moment recording and clap test

Not built yet.

## Checkpoint 6 (13:30): review, manifest and upload

Not built yet.

## Checkpoint 7 (15:00): coverage hints, thermal and lifecycle edge cases

Not built yet.
