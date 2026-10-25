# Motion video brief: "Relive With A Smile" (3:00)

**Who this is for:** the Claude session that runs the **Motion as Code** kit (TypeScript plates on the pdoom-video engine, 1920×1080, 60 fps, voiceover-timed with `analysis/align_vo.py`, cut points in `app/src/timeline.ts`, sound in `analysis/sfx_mix.py`). Read this whole file, then the kit's `README.md`, `app/src/timeline.ts` and `app/src/engine/scene.ts`. Then build the plates below.

**What we're making:** the demo video for our Cal Hacks 13.0 project, **Relive With A Smile** (code name Braindance). It must be **3:00 or shorter**.

**The shape:**
1. A short film about dementia.
2. A zoom-out from that film into a museum of memories.
3. A calm voiceover that explains, step by step and with motion graphics, how the whole system works.

The pacing and look of the technical part follow the **Déjà View** video (https://www.youtube.com/watch?v=IvfezVixEvc): Apple-keynote style. Real footage sits in rounded cards on a dark background. Each step gets one big bold headline at the bottom left with one small muted line under it. There's a pipeline diagram, a rising chart, and an end card with four big stats and a row of credits.

---

## 0. Rules (do not break these)

1. **Nothing fake.** Every screen recording, scan and number in the video is real.
   - Motion graphics may **explain** (diagrams, labels, counters, highlights), but they never invent UI, data or results.
   - Where a shot is a stylized recreation rather than the real app, it must look like a diagram, not like a screenshot.
2. **Real numbers only.** Use the stats in section 6 exactly. Don't round them up, and don't make up new ones.
3. **Calm.** This is about people with dementia. Don't flash, shake, glitch, make hard white cuts, or use anything faster than the voice. The type is large and the motion is slow and eased.
4. **The song.** "Die With A Smile" (Lady Gaga & Bruno Mars):
   - About **30 seconds in total**, only at the two cues in section 5.
   - A calm instrumental bed everywhere else.
   - Credit it on the end card.
   - If no song file is provided, use the instrumental bed for those cues too and leave a `TODO: song` note in the mix script.
5. **The opening film is a dramatization** (our HOSA class PSA, performed by students). The end card says so in small type. Don't present it as a real patient.
6. **Don't edit `app/src/engine/`.** Change only plates, `timeline.ts`, the analysis scripts and assets. Every plate is a pure function of time.
7. **Before the full render, ask.** Render stills and `--samples 4` drafts first.

---

## 1. Look and feel (our theme)

This comes from `docs/THEME.md` in our repo. The kit's default palette (ink, bone, signal orange) is replaced by these colours:

| Token | Value | Use |
|---|---|---|
| ink (background) | `#140d14` deep plum night | every background |
| bone (text) | `#f6eee4` warm cream | headlines, body |
| muted | `#a8999a` | sublines, labels, credits |
| accent | gradient `#ffb35c` (sunset amber) → `#ff7a8a` (rose) | the logo arc, highlights, progress bars, chart lines, the one emphasized word per headline |
| app orange | `#ff5c3a` | only where it appears inside real screen recordings; never added by us |

- **Type:**
  - **Archivo** (bold) for headlines.
  - **Cormorant Garamond** for the emotional lines: the title, the cold-open captions and the tagline.
  - **IBM Plex Mono** for small eyebrow labels and numbers.

  All three are already in the kit.
- **Logo:** "a smile made of LiDAR points". It's a single curved arc of about 40 small dots, which also reads as a horizon at sunset, coloured with the amber→rose gradient. It draws itself dot by dot from left to right.
- **Texture:** keep the kit's grain and halation, but gentle. Warm, golden-hour and a little nostalgic, like a memory at sunset. Not cyberpunk, not sci-fi.
- **Layout for technical plates (Déjà View style):**
  - Footage sits in a rounded card (radius 18 px) with a soft shadow, about 62% of the frame width.
  - A mono eyebrow label sits above the headline (`01 · CAPTURE`).
  - The **headline** goes bottom left (Archivo Bold, 64 px, cream), with a **subline** under it (Archivo Regular, 24 px, muted, at most 2 lines).
  - Margins are 120 px from the left and 110 px from the bottom.
  - Headlines enter with a 14 px upward drift and fade over 0.5 s, timed to the first word of their voice line. They leave by fading out over 0.4 s before the next cut.
- **Transitions:** between technical plates, use slow cross-dissolves (0.6 s) or a gentle push.
  - The **one** big special transition is the zoom-out in plate 2.
  - The only other bold transition is the push back into a painting at the start of plate 13.

---

## 2. Assets to prepare (before building)

Put everything under `assets/` in the kit project. Footage should be **image sequences**, not MP4s, so every frame is deterministic. Plates load the frame for `f.lt`:

```bash
# Turn any clip into a 60 fps JPG sequence at 1920 wide (run per clip)
mkdir -p assets/<name> && ffmpeg -i <clip>.mp4 -vf "fps=60,scale=1920:-2" -q:v 3 assets/<name>/%05d.jpg
# And keep its audio when the plate uses the clip's own sound
ffmpeg -i <clip>.mp4 -vn -ac 2 -ar 48000 assets/<name>.wav
```

| Asset | What it is | Where it comes from |
|---|---|---|
| `hosa/` + `hosa.wav` | Our HOSA PSA clip, 30.1 s, 3840×2160, subtitles burned in | `hosapsamid.mp4` (Shivin provides). Use **0:03.0 to 0:28.0** of it |
| `museum-walk/` | Screen recording of the walkable museum at `#/museum`: the hall, slow walk past 3–4 paintings | Real site: https://shividoge.github.io/braindance-site/#/museum, 1920×1080, browser full screen, music off, ~15 s |
| `museum-stepout/` | Screen recording of stepping **out** of a painting back into the hall (press "Step in" on a painting, wait, then the back button) | Same page; we need the pull-back part, ~4 s |
| `scan-live/` | iPhone screen recording of the room scan, the dots lighting up | Shivin's phone (the Relive app), ~8 s |
| `scan-orbit/` | The finished scan orbiting slowly in the viewer | `#/capture/<id>` on the live guide, or `#/p/<id>` on the public site (the bear: `138b88d3-…`), ~8 s |
| `oldvideo-flat/`, `oldvideo-3d/` | An old clip playing flat, then the same clip as 3D in the viewer with the "Estimated from a video, not measured" badge | Old clip files + the viewer on the live guide, ~6 s each |
| `facts/` | The Facts page: facts appearing beside their keyframes and quotes; clicking a quote seeks the video | Live guide, a capture with approved facts, ~8 s |
| `review/` | Tapping **Approve** on one fact and **Don't bring this up** on another | Live guide, ~6 s |
| `grounding/` | A real dropped sentence with its reason (from a real session's `dropped` list), or the grounding test run captioned "Test" | Live guide / terminal, ~5 s |
| `ipad-window/` | Over-the-shoulder camera shot: someone moving their head in front of the iPad, the Memory Window shifting with them | Phone camera, real iPad, through the HTTPS tunnel, ~8 s |
| `editor/` | The caretaker editor at `#/museum/edit`: reorder a painting, type a caption, Save, then open her museum | Public site or live guide, ~10 s |
| `together/` | iPad and phone side by side: the phone picks a painting, the iPad walks there and shows "Priya is with you" | Live guide + tunnel, camera from above, ~8 s |
| `music/die-with-a-smile.mp3` | The song (Shivin provides; used for ~30 s total) | — |
| `music/bed.mp3` | A calm royalty-free piano/ambient bed, ~3 min | YouTube Audio Library or similar; note the licence |
| `logos/` | Claude (Anthropic), Depth Anything 3, MLH, Cal Hacks | Official assets, white versions |

**If a shot isn't recorded yet**, build the plate with a clearly diagrammatic placeholder: an outlined card with the shot name in mono. Keep the timing, and list every placeholder in your summary so we can record it. Never draw a fake UI to fill the gap.

**Best version of plate 2 (do this if time allows):** convert the HOSA clip into a real 3D capture with our `tools/video2capture`, hang it in the museum with the editor as the first painting, and screen-record a real step-out from it. Then the zoom-out is the real app. Otherwise build the zoom-out as described in plate 2.

---

## 3. Voiceover

- **Voice:** ElevenLabs, one warm, calm, mid-low voice, unhurried (about 140–150 words a minute), with no "announcer" energy. Think of a kind narrator telling a family story.
- Generate `audio/voiceover.mp3` from the script below. Put the same text in `SCRIPT` in `analysis/align_vo.py`, and put the spoken forms in `SPOKEN`. Then run `align_vo.py` and `audio_vo.py` as the kit's guide describes.
- **There is no voiceover in plates 1–2.** The HOSA clip's own dialogue and sound carry it. The VO starts in plate 3. Align only the VO file; the plates' absolute times in section 4 decide where the VO file starts (place it at **35.0 s**). If the kit expects the VO from 0 s, pad the start of `voiceover.mp3` with 35.0 s of silence before aligning.

### SCRIPT (paste into `align_vo.py`)

```
That was his son's graduation night. By morning, he won't remember it.
But it doesn't have to disappear.
Relive With A Smile turns a family visit into a place he can walk back into.

It starts with a phone. While the family visits, the iPhone's LiDAR measures every surface, films every frame, and records exactly where the camera stood.

And the moments from before? Any old video works. A depth model rebuilds the room from the footage, and we label it honestly: estimated, never measured.

Then Claude watches the visit and writes down small, true details. Who came. What was said. What was on the table. Each one is pinned to the frame or the words that prove it.

The family decides. Approve a detail, reword it, or mark it: don't bring this up.

When Claude talks with him, every sentence has to point to an approved detail. Code checks it, not another prompt. If it isn't backed, it's never said.

No headset. On an iPad, the front camera follows his head, so the screen becomes a window. Lean left, and the room moves with him.

Every moment hangs in his own museum. A caregiver picks the pictures, puts them in order, and writes a few words for each one.

And family can join from anywhere, walking him from painting to painting, and into the moment itself.

One phone, one small server, and Claude. Opus finds the facts. Sonnet talks with him. Everything is checked before he hears it.

He may not remember the day. But he'll remember how it felt.
```

**SPOKEN:** no numbers or acronyms need respelling except **LiDAR** (spoken "lie-dar") and **iPad** / **iPhone** (spoken as usual). If the aligner stumbles on "LiDAR", map it to "lidar".

---

## 4. Plates (3:00 total)

Times are absolute (video time). Each technical plate cuts **0.18 s before its anchor phrase**, as the kit does. Anchor phrases are given so `timeline.ts` can use `cut('…')`. Times next to them are targets; the aligned VO decides the exact cut.

| # | Plate file | Time (s) | Anchor phrase for `cut()` |
|---|---|---|---|
| 1 | `coldopen.ts` | 0.0 – 25.0 | (fixed, no VO) |
| 2 | `zoomout.ts` | 25.0 – 35.0 | (fixed, no VO) |
| 3 | `memory.ts` | 35.0 – 49.0 | "That was his son's graduation night" |
| 4 | `capture.ts` | ~49 – 62 | "It starts with a phone" |
| 5 | `oldvideo.ts` | ~62 – 75 | "And the moments from before" |
| 6 | `facts.ts` | ~75 – 89 | "Then Claude watches the visit" |
| 7 | `family.ts` | ~89 – 98 | "The family decides" |
| 8 | `grounding.ts` | ~98 – 111 | "When Claude talks with him" |
| 9 | `window.ts` | ~111 – 124 | "No headset" |
| 10 | `museum.ts` | ~124 – 136 | "Every moment hangs in his own museum" |
| 11 | `together.ts` | ~136 – 147 | "And family can join from anywhere" |
| 12 | `pipeline.ts` | ~147 – 161 | "One phone, one small server" |
| 13 | `ending.ts` | ~161 – 180.0 | "He may not remember the day" |

If the aligned VO runs long, shorten plates 7, 9 and 11 first (hold less after the line ends). Never cut into plates 1, 2 or 13. Hard stop at 180.0 s.

### Plate 1 · `coldopen` (0.0 – 25.0)

- **Picture:** `hosa/` full frame, source 0:03.0 → 0:28.0, at real speed. Keep the burned-in subtitles. They carry the story:
  - "Congratulations"
  - "So, what's next?"
  - "Always wanted to be a doctor growing up"
  - "But I can't anymore"
  - "Because of my father's medical bills"
  - "Your father must be proud"
  - "You'll be fine"
- **The point the audience must get:** the older man is **his father**, and he doesn't recognize his own son ("Your father must be proud"). At **0:14.5–0:16.5 of the plate** ("Your father must be proud"), let the frame breathe: a very slow push-in of 3% scale. Don't add text; the line lands on its own.
- **After the father walks away**, there's a close-up of the son's eyes (source ~0:22–0:24). Then the vintage film frame of the **"Me & my Dad"** photo card (source ~0:25–0:28): a Super 8 frame with sprocket holes.
- **Sound:** `hosa.wav` only (fire crackle, the dialogue). No music. Fade up from black over the first 0.8 s.

### Plate 2 · `zoomout` (25.0 – 35.0): the signature moment

The memory turns out to be a painting in a museum.

- **25.0 – 27.5:** hold on the "Me & my Dad" film frame. The film frame's warm edges slowly become the inner edge of a **gilded picture frame** (cream mat, ornate gold border) as the camera starts to pull back. The footage keeps playing inside the frame. Its colour shifts gently toward an oil-painting look (warmer, slightly softened, faint brush texture), the same look the real museum gives its pictures.
- **27.5 – 31.5:** the camera **pulls back through the frame** and out into the museum hall. Use `museum-stepout/` as the background plate, with the HOSA frame composited into the painting the step-out ends on. The move is one long, eased dolly back (ease-in-out, no stops), with light streaks and a soft warp blur that settles as we arrive. This mirrors the museum's real step-out effect.
- **31.5 – 35.0:** settle in the hall. Rose-red walls, gilded frames, other paintings (other memories), a lantern skylight. Continue with `museum-walk/` as a slow drift.
  - Over it, the **title** draws on in the centre: the dot-arc logo draws left to right, then **Relive With A Smile** in Cormorant Garamond (88 px, cream) fades up.
  - The title holds 2 s, then lifts and fades before the VO starts.
- **Sound:** the fire crackle and room tone fade out by 27.0. **Song cue A** starts at 26.5 (the chorus, see section 5), rising under the pull-back, full by 28.5. Add a soft "air/whoosh" SFX under the pull-back (−18 dB) and a single soft chime when the title appears.

### Plate 3 · `memory` (35.0 – ~49)

- **Picture:** keep drifting slowly through the museum (`museum-walk/`). Pass 2–3 paintings at an easy pace, ending framed on one painting. No headline, only the voice. At "a place he can walk back into", the camera slowly approaches the next painting, ready to push through it into the technical part.
- **VO:** "That was his son's graduation night. By morning, he won't remember it. But it doesn't have to disappear. Relive With A Smile turns a family visit into a place he can walk back into."
- **Sound:** song cue A ends here. Fade it out under "By morning" (done by ~40.5; cue A is about 14 s). Crossfade into the instrumental bed at −24 dB.

### Plate 4 · `capture` (~49 – 62)

- **Eyebrow:** `01 · CAPTURE`  **Headline:** It starts with a visit.  **Subline:** An iPhone measures the room with LiDAR, films every frame, and logs where the camera stood.
- **Picture:** `scan-live/` in the card: dots lighting up on the phone. Then crossfade to `scan-orbit/`. In the top right of the card, a mono counter counts up to **1,064,340 points** (our largest single scan). Two small labels draw on: `depth · 10× a second` and `camera pose · every frame`.

### Plate 5 · `oldvideo` (~62 – 75)

- **Eyebrow:** `02 · OLD VIDEOS`  **Headline:** Even the ones from years ago.  **Subline:** A depth model rebuilds the room from any old video. We label it: estimated, never measured.
- **Picture:** a three-step strip, Déjà View style (three small cards in a row, each with a mono caption):
  1. `oldvideo-flat/` "One old video"
  2. a depth-map view of the same frame "Depth, every frame" (draw it as a diagram from the frame: grayscale with a blue tint is fine, clearly a visualization)
  3. `oldvideo-3d/` "Back in 3D"

  Then the third card grows to fill the main card. The badge "Estimated from a video, not measured" stays visible.

### Plate 6 · `facts` (~75 – 89)

- **Eyebrow:** `03 · CLAUDE`  **Headline:** Claude finds what's true.  **Subline:** Small, checkable details, each pinned to the exact frame or words that prove it.
- **Picture:** `facts/` in the card. Thin amber connector lines draw from two facts to their keyframe and quote ("evidence"). A mono tag in the corner reads `Claude Opus 5.5`.

### Plate 7 · `family` (~89 – 98)

- **Eyebrow:** `04 · THE FAMILY`  **Headline:** The family decides.  **Subline:** Approve, reword, or mark it "don't bring this up". Nothing reaches him without a yes.
- **Picture:** `review/`. When "don't bring this up" is pressed, a soft rose highlight circle pulses once around the button (slow, 0.8 s, no flash).

### Plate 8 · `grounding` (~98 – 111)

- **Eyebrow:** `05 · GROUNDING`  **Headline:** Nothing unapproved is ever said.  **Subline:** Every sentence must cite an approved detail. Code checks it, not another prompt.
- **Picture:** a motion-graphics diagram, centred and clearly a diagram:
  - Three sentence pills slide in from the left toward a thin vertical "gate" line.
  - Two have a small `✓ fact f3`-style tag and pass through.
  - One has no tag; it stops at the gate, a line strikes through it, and a mono reason fades in beside it (`no approved fact`).
  - After that, show the real `grounding/` shot small in the corner for 3 s as proof.

### Plate 9 · `window` (~111 – 124)

- **Eyebrow:** `06 · NO HEADSET`  **Headline:** Step inside.  **Subline:** On an iPad, the front camera follows his head. The screen becomes a window into the room.
- **Picture:** `ipad-window/` in the card. Add a small diagram in the corner: a head icon moving left and right, with a view frustum swinging with it, synced to the footage.

### Plate 10 · `museum` (~124 – 136)

- **Eyebrow:** `07 · HIS MUSEUM`  **Headline:** A museum of his life.  **Subline:** A caregiver chooses the pictures, the order and the words. He just walks in.
- **Picture:** split. On the left, the `editor/` card (reorder, caption typed). On the right, a smaller card of `museum-walk/` showing the result. A thin amber arrow draws from the left card to the right card.

### Plate 11 · `together` (~136 – 147)

- **Eyebrow:** `08 · TOGETHER`  **Headline:** Family, from anywhere.  **Subline:** A relative joins from their phone and walks him through it, painting by painting.
- **Picture:** `together/` in the card. A soft location ping animates from the phone to the iPad when the iPad follows.

### Plate 12 · `pipeline` (~147 – 161)

- **Eyebrow:** `HOW IT FITS`  **Headline:** From a phone to a place.  **Subline:** One phone, one small server, and Claude: Opus for facts, Sonnet for conversation, code for every check.
- **Picture:** Déjà View's "From a phone to a place" row: five dark rounded cards in a line, each with a small icon and two lines of mono text, lit one by one left to right as an amber progress line runs under them.

  | Card | Mono text |
  |---|---|
  | iPhone | LiDAR scan + visit / transcript on the phone |
  | Guide server | Node, files on disk / grounding check |
  | Claude | Opus 5.5: facts, scoring / Sonnet 5.5: talking with him |
  | Family | approve · reword · don't bring up |
  | iPad | museum · Memory Window · together |

### Plate 13 · `ending` (~161 – 180.0)

- **161 – 167:** push back into the **"Me & my Dad"** painting in the museum (the reverse of plate 2, slower). The fireside footage fills the screen again: the father and son sitting together by the fire (source ~0:04–0:08 of the HOSA clip, before the conversation). Over it, the VO: "He may not remember the day. But he'll remember how it felt."
- **167 – 180:** fade to plum. The end card, Déjà View style:
  - The dot-arc logo draws, with **Relive With A Smile** under it (Cormorant Garamond, 72 px).
  - Under it, the tagline in muted italic: *He may not remember the day. He'll remember how it felt.*
  - Four stats in a row (Archivo Bold 56 px numbers, mono 14 px labels):

    | Number | Label |
    |---|---|
    | **7** | memories in his museum |
    | **3,430,106** | points scanned |
    | **44** | details the family approved |
    | **214** | automated tests passing |

  - A row of white logos: Claude by Anthropic · Depth Anything 3 · Cal Hacks 13.0 · MLH.
  - Small credits at the bottom (muted, 14 px):
    - Built at Cal Hacks 13.0 by Shivin, Firdavs and Srinivas.
    - Opening scene: our HOSA public service announcement, performed by students.
    - Music: "Die With A Smile", Lady Gaga & Bruno Mars.
- **Sound:** **song cue B** comes in at 164.0 under the VO's last line and resolves by 180.0 (16 s). The bed fades out at 164.

---

## 5. Audio plan

| Layer | Where | Level |
|---|---|---|
| HOSA clip sound | 0.0 – 27.0 | as recorded, normalized; fade out 25.5 – 27.0 |
| Song cue A (chorus) | 26.5 – 40.5 (14 s) | up to −10 dB at 28.5; ducked to −20 dB under the VO from 35.0; out by 40.5 |
| Instrumental bed | 39.0 – 164.0 | −24 dB, ducked 6 dB under the VO; soft fade in and out |
| Voiceover | starts 35.0 | −16 LUFS integrated for the VO |
| Song cue B (ending) | 164.0 – 180.0 (16 s) | −12 dB under the last VO line, then up to −8 dB on the end card, resolve on a phrase end |
| SFX | sparse | whoosh under the plate 2 pull-back (−18 dB), one chime on the title (−20 dB), soft UI ticks when headlines enter in plates 4–12 (−28 dB). No other effects |

- **Total song:** about 30 s (cue A 14 s + cue B 16 s).
- **Final mix:** normalized to −14 LUFS, true peak −1 dB, as the kit already does.

---

## 6. Facts you may use (all real; don't change them)

| Fact | Value |
|---|---|
| Memories in the museum | 7 (4 LiDAR phone scans, 3 old videos rebuilt in 3D) |
| Points scanned, all captures | 3,430,106 |
| Largest single scan | 1,064,340 points (Hardware Lab table) |
| Details the family approved | 44 (of 80 Claude proposed) |
| Automated tests passing | 214 (108 guide server + 106 website) |
| Models | Claude Opus 5.5 (facts, scoring), Claude Sonnet 5.5 (conversation), Depth Anything 3 (old videos) |
| Depth rate on the phone | 10 depth maps a second, a camera pose for every frame |
| Public site | https://shividoge.github.io/braindance-site/ |

---

## 7. How to work (order of steps)

1. Read the kit and this brief. Set up the palette and type tokens from section 1 in **one** shared place (the kit's `_vo.ts` toolkit or a new `theme.ts`), not per plate.
2. Prepare `assets/` (section 2). List anything missing and ask Shivin for it. Build with placeholders meanwhile.
3. Generate the VO in ElevenLabs from section 3, then run alignment and audio analysis.
4. Build plates 1, 2 and 13 first (the story frame), and show stills of:
   - 0:20, the "Your father must be proud" moment
   - 0:29, the middle of the pull-back
   - 0:33, the title over the hall
   - 2:52, the end card
5. Build plates 3–12. Render one still per plate at its headline's full-opacity moment and show them all in one message.
6. A `--samples 4` draft of the whole video, then ask before the final render.
7. Mix the sound (section 5) and mux. Deliver `out/relive-with-a-smile.mp4`, 1920×1080, 60 fps, ≤ 3:00.

**When you report back**, list:
- every placeholder still in the video
- the final length
- where each song cue sits
- anything in this brief you couldn't do and why
