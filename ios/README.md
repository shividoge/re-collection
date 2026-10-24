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

## Credits

The camera-background rendering follows the pattern in Apple's public sample code "Displaying a point cloud using scene depth." All code here was written fresh during the event.
