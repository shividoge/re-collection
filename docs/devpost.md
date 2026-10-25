# Devpost draft: Relive With A Smile

Draft for Cal Hacks 13.0. Every claim must match what is on `main` when we submit. Fill in or check everything marked `<!-- VERIFY: ... -->` or `TODO`, then delete the markers.

---

**Title:** Relive With A Smile

**Tagline:** She may not remember the day. She'll remember how it felt.

**Short description:** Relive With A Smile turns a family visit into a 3D moment someone with Alzheimer's can step back into, narrated by Claude using only details the family approved.

---

## Inspiration

The morning after the whole family came for her birthday, she asked when someone would visit.

Families visiting a parent with Alzheimer's in memory care know this. The visit mattered, and by the next day it's gone. In the SenseCam study (Woodberry et al. 2015), reviewing wearable-camera images of an event helped people with Alzheimer's recall more of it than reviewing a written diary. We wanted more than photos: let her step back into the room, see the family move and hear what they said, with a guide who never tests her and never makes anything up.

## What it does

1. **Film the visit.** A family member sweeps the room with the Relive iPhone app (LiDAR builds a colored point cloud), then records the visit in the same session: video, audio, a camera pose per frame, depth 10 times a second.
2. **Claude finds the details.** Claude Opus reads up to 30 keyframes and the transcript and proposes short facts ("Priya brought a mango cake."), each linked to the frame or quote that shows it.
3. **The family decides what she hears.** They approve, edit or reject each fact next to its evidence, and can mark one "don't bring this up" (for example, someone who has since died). Nothing reaches her without approval.
4. **She revisits it on a tablet.** The room appears, the family replays in 3D where they stood, and Claude narrates: "Priya brought the mango cake you love." She presses one large Talk button to answer. Claude offers details instead of quizzing and follows her lead. If she says "this kitchen looks like my mother's", it asks one gentle question and saves that as a memory the moment brought back.
5. **Code checks every sentence first.** A sentence that cites an unapproved or "don't bring this up" fact, or slips a name, date or place into small talk, is removed and logged.
6. **The family sees what she held on to.** After each session Claude scores which facts she brought up on her own and which only after a hint. The dashboard plots this per session at real times, with memories it brought back, distress alerts and suggested revisits (+1, +3, +7, +14 days).

**More ways in:**

- **Memory Window:** an iPad, laptop or TV with a webcam becomes a window into the moment. The front camera follows her head, so leaning looks around the room with real parallax. No headset. On a tablet she can tilt or drag instead. <!-- VERIFY: head tracking and tilt checked on the real iPad over HTTPS (TASKS.md M2); drag-to-look is on web/museum -->
- **Old videos:** a family's old video becomes the same kind of 3D moment using Depth Anything 3, labelled "Estimated from a video, not measured" everywhere it appears.
- **Memory Museum:** a calm hall with one picture frame per moment, oldest first. Tap a frame to walk to it, tap again to step into its Memory Window. <!-- VERIFY: the 3D hall renders on main (it drew blank on web/museum at 16:30) and works on the iPad -->
- **Visit together:** a family member joins the museum from their own phone with a four-letter code. When they pick a frame or step into a moment, her iPad follows. <!-- VERIFY: built? web/museum-together was in progress; cut this bullet if it isn't merged and tested iPad + phone -->

## How we built it

**iPhone app** (Swift, ARKit, Metal, no third-party packages). One ARKit session covers the room scan and the visit, so both share one coordinate system. The live point cloud renders on the GPU and exports at 1 cm. The visit is H.264 video, per-frame pose and intrinsics, and 256×192 depth at 10 Hz. Afterwards the phone transcribes the audio with Apple's Speech framework in on-device-only mode, saves one keyframe per second and uploads the package. We defined our own capture format as the contract between the three parts.

**Guide server** (Node, plain `node:http`, files on disk). Stores and validates captures, streams files with HTTP Range, and makes every Claude call. The API key never reaches a browser.

**Claude for judgement, code for guarantees.** Every call returns JSON checked against a schema.

- **Facts:** Claude Opus 5.5 at high effort, given images and the timestamped transcript. Code keeps a citation only if it points at a keyframe Claude was actually sent, or quotes words that are really in the transcript; a fact with no surviving evidence is dropped. Names come only from the family, never from faces.
- **Narration and conversation:** Claude Sonnet 5.5 at low effort for speed. Each reply is a list of `{ sentence, factIds }` plus `branch` and `distress`.
- **Grounding check** (`guide/src/grounding.mjs`): drops sentences citing unknown, unapproved or "don't bring this up" facts. A sentence citing nothing counts as small talk and is dropped if it has a number, day, place, relationship word or name, unless she just said that word or it's how she likes to be addressed ("Mom"). One small-talk sentence per reply, two after distress or a shared memory. If nothing survives she hears "I'm right here with you." Every drop is logged with a reason.
- **Distress:** flagged by Claude or by phrases matched in code ("I want to go home", "where is everyone"). The session ends with reassurance and the family gets an alert.
- **Scoring:** Claude Opus says which of her lines carries each fact. Code decides "unprompted" versus "after a hint" from whether the companion had already said that fact.
- Tests (`node:test`) run all of this against a stubbed Claude, including an ungrounded sentence that must be dropped.

**Web app** (React, TypeScript, React Three Fiber). The room renders as soft points. **DepthReplay** brings the people back: a vertex shader unprojects a 256×192 grid from the depth frame nearest the video's current time, using that frame's pose, and colors each point from the video. People stand in the scanned room in sync with their voices. Areas the phone never saw stay empty. Speech uses the browser's synthesis and recognition, with a caregiver text box as fallback.

**Memory Window.** The screen is a fixed window in front of the recorded camera and the viewer's eye moves behind it, which gives an off-axis frustum instead of a rotated camera. That's what makes it read as 3D without glasses. Head position comes from MediaPipe face detection in the browser; no camera image leaves the device.

**Old video to 3D** (`tools/video2capture`, Python). Depth Anything 3 estimates pose, intrinsics and depth per frame. We convert its poses to ARKit's convention and write the same package a phone writes, marked `"source": "video"` and `"estimated": true`, so review, sessions and both viewers work on it unchanged.

## Challenges

- **Honest without being robotic.** A prompt can't guarantee Claude never invents a detail for someone who can't push back, so the guarantee lives in code. The hard part was not making her companion mute: words she just said are allowed back, so "What was your father's workshop like?" passes right after she mentions him, while a name she never said doesn't.
- **Scoring fairly.** Asking a model "did she remember this unprompted?" invites guessing. Claude finds the line; code checks the log.
- **People lining up with the room.** Room and visit must come from one unbroken ARKit session, and the browser's unprojection must match the phone's math exactly. Our first real captures had 60 fps video and roughly 12 Hz depth instead of 30 fps and 10 Hz; we locked both and now record the real rate in the manifest.
- **Venue Wi-Fi** blocks device-to-device traffic, so the phone and tablet use an HTTPS tunnel, with AirDrop as fallback. HTTPS also turned out to be required for the iPad's camera and tilt sensor.
- **Old videos have no true scale.** We label the estimate everywhere instead of hiding it, and never fill gaps.

## Accomplishments

- The full loop runs on real hardware with real data: phone scan, evidence-linked facts, family approval, a narrated revisit on a tablet, scoring, dashboard.
- We can show a judge a sentence Claude tried to say and the logged reason code removed it.
- People replay in 3D from the phone's own depth, in the scanned room, in sync with sound.
- Depth on an ordinary screen with no headset.
- We ran TODO real revisit sessions this weekend, TODO hours apart, shown at their real times. <!-- VERIFY: session count and spacing -->

## What we learned

- Claude is good at the judgement calls: which details are memorable and checkable, when someone is upset, which line carries a fact. The safety rules belong in tested code around it.
- "Offer, don't quiz" changes the whole tone, and it fits a model that is told exactly what it may say.
- Labels cost little and build trust: mock output is marked, estimated scenes are marked, dropped sentences are logged.

## What's next

- **Pilot** at one memory care facility: the same visit reviewed with Relive versus a written diary, recall tested at 2 weeks and 3 months, following the SenseCam protocol. Primary measure: details recalled per moment, unprompted versus after a hint. Secondary: memories brought back, session length, distress rate.
- A caregiver view for running sessions and receiving alerts.
- A slower, more natural voice than the browser's.
- Accounts, encryption at rest and consent records, replacing one laptop and a room code.

## Built with

claude, anthropic-sdk, swift, swiftui, arkit, metal, lidar, apple-speech, avfoundation, node.js, javascript, typescript, react, vite, three.js, react-three-fiber, webgl, glsl, mediapipe, web-speech-api, python, pytorch, depth-anything-3, cloudflare-tunnel, github-pages

---

## Tracks

**Anthropic, Claude for Public Benefit.** Claude does what needs judgement and care: finding true details in a recording, talking with someone who has dementia without testing them, noticing distress, scoring recall. Code does what needs guarantees: family approval gates every fact, every sentence must cite an approved fact or pass the small-talk rules, and every drop is logged. Opus 5.5 runs the accuracy-critical offline steps; Sonnet 5.5 runs the live conversation. All calls go through `guide/src/claude.mjs` with schema-checked JSON. The community is specific: families visiting a parent with Alzheimer's in memory care.

**Cal Hacks, People-First Social Impact.** A named community and a concrete problem: a visit that matters and is gone the next morning. The design follows reminiscence, errorless conversation and spaced revisits. We built the instrument to measure recall at real times, wrote a pilot plan, and say plainly that a weekend can't prove impact.

**Meta, Bringing People Closer Together with AI.** The visit lasts longer than an afternoon. She gets to share it again, and the family learns which details she held on to and which older memories it stirred, which gives them something to talk about next time. With Visit together, a grandchild on their own phone can walk her through the museum and step into a moment with her. <!-- VERIFY: keep the last sentence only if Visit together is merged -->

**Most Technically Advanced.** A custom capture format (LiDAR depth, per-frame poses, video and room cloud from one ARKit session); people reconstructed per frame in a GLSL shader from streamed depth; a head-tracked off-axis frustum with in-browser face detection; monocular video converted to the same format; and code that constrains a live LLM conversation, with tests.

**Microsoft, Built for the Real World.** Designed for a real setting: a tablet in someone's lap, large type and touch targets, no headset, family control over every word, gentle endings on distress. <!-- VERIFY: drop if this prize requires a Microsoft product (open question in SPONSOR-PLAN.md) -->

**MLH.** <!-- VERIFY: opt in on Devpost and submit MLH's supplemental form for the Commit Fellowship -->

---

## Safety, privacy and honesty

- **Family approval gates everything.** Only approved facts not marked "don't bring this up" are given to Claude, and code re-checks every sentence anyway.
- **"Don't bring this up"** respects grief: those facts never reach the session.
- **No face recognition.** Names come from the family.
- **On-device where we can:** transcription on the phone; head tracking in the browser, with no camera image leaving the device.
- **What leaves the device:** keyframes and transcript go to the Anthropic API for fact extraction, and her words go to it during a session. Push-to-talk uses the browser's speech recognition, which may use the browser vendor's servers; a caregiver can type instead.
- **Captures stay on the team's laptop** for the hackathon. The public demo site shows only scans the team made and marked public. <!-- VERIFY: public site contents at submission -->
- **Distress ends the session gently** and alerts the family. She never sees a score.
- **The museum room code is the only access control** in this hackathon build.
- **Estimates are labelled**, and areas without data stay empty.
- **Consent** from everyone filmed. <!-- VERIFY: demo visit and any old family video -->
- **A hackathon can't prove impact.** The demo shows real sessions from this weekend at their real times. The pilot is how we'd find out.

---

## Links

- Demo video: TODO
- Live site: TODO (the current https://shividoge.github.io/braindance-site/ is a snapshot from before the current web build)
- Code: TODO (repo is private; link or "available to judges on request")

## Team

- Shivin TODO (GitHub `shividoge`): iPhone app, guide server, Claude integration
- Firdavs TODO (GitHub `boliyevfirdavs`): web app, 3D viewer, Memory Museum
- Srinivas I B (GitHub `IBS27`): TODO
<!-- VERIFY: full names, roles, team size -->

## Research basis

- Woodberry et al. (2015), *Memory*: SenseCam review versus a written diary in Alzheimer's. https://www.microsoft.com/en-us/research/?p=464112
- Woods et al. (2018), Cochrane review of reminiscence therapy for dementia. https://pmc.ncbi.nlm.nih.gov/articles/PMC6494367
- Conway & Pleydell-Pearce (2000), the self-memory system. https://pubmed.ncbi.nlm.nih.gov/10789197/
- Spaced retrieval with Alzheimer's patients. https://www.termedia.pl/Spaced-retrieval-as-a-tool-to-work-with-patients-with-Alzheimer-s-disease,46,55467,1,1.html

## Credits

- **Rumi** (`IBS27/rumi`, HackMIT 2026) and **Déjà View** (Shivin's earlier project): references for which APIs work and how a guide server can be shaped. No code copied; everything was written during Cal Hacks 13.0.
- **Apple**, "Displaying a point cloud using scene depth": the pattern for the live point cloud.
- **Depth Anything 3** (ByteDance Seed, DA3-BASE, Apache-2.0): depth and pose for old videos.
- **MediaPipe** face detection: head tracking in the Memory Window.
- **Claude** Opus 5.5 and Sonnet 5.5 (Anthropic).
- Demo music: "Die With A Smile", Lady Gaga & Bruno Mars. <!-- VERIFY: only if the song stays in the final cut -->
