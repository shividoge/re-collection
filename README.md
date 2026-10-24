# Braindance

A family films a visit on a LiDAR iPhone. Braindance turns it into a moment a parent with dementia can step back into over the following days, with Claude narrating only what the recording shows and measuring which details they hold onto.

Built at Cal Hacks 13.0.

Public name: **Relive With A Smile** (`docs/THEME.md`). "Braindance" stays the internal code name.

## What works today

- **iPhone app** (`ios/`): live LiDAR room scan, visit recording (video, audio, a pose per frame, depth), on-device transcript, keyframes, review, upload or AirDrop zip.
- **Guide server** (`guide/`, Node): stores and serves captures, Claude fact extraction tied to frames and quotes, family review, revisit sessions with a code-enforced grounding check, distress handling, recall scoring.
- **Website** (`web/`): 3D room, people replayed in 3D from depth, orbit, fly and ride-along views, object selection with size and on-camera times, fact review, the Revisit screen, the family dashboard.

## Planned (plan v3, proposed, not built)

A spatial editor for the family on the same base, specified in `docs/scene-model.md`: objects and notes that persist in 3D, a layered timeline, clearest views and read text, transcript, search, share links to an exact view, measurements with uncertainty, comparing visits to the same room, cleaner audio, and "Where this came from" on everything. Estimated and filled-in data is always labeled and can be hidden with "Measured only".

## Start here

- `CLAUDE.md`: the full build plan (Claude Code reads it automatically)
- `TASKS.md`: who owns what, deadlines, and the starting prompt for each person
- `IOS_CAPTURE_PLAN.md`: the iPhone capture app
- `docs/capture-format.md`, `docs/guide-api.md`, `docs/scene-model.md`: the contracts

## Credits

The capture app follows patterns from Apple's sample "Displaying a point cloud using scene depth" and draws on lessons from the team's earlier Rumi project (HackMIT 2026); the guide server is shaped after Shivin's Déjà View guide. Both were references only. All code in this repo was written during Cal Hacks 13.0.
