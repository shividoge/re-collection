# Demo video plan (3:00)

Task M10. IBS27 edits from 04:00 to 07:30; everyone films their own part. The backbone is `docs/THEME.md` §7. The visit's specifics (the dish, the gift, who's there, the consent note) are in `docs/filming-prep.md`. This file never invents them.

**Two changes from THEME.md §7, both for honesty (CLAUDE.md §8):**

1. THEME says "Days later". Our sessions happen hours after the visit, so the card says **"Later that night"** (or "The next morning") plus the real clock time from the session. Never "days later", never "day 3".
2. The song runs **30 s in total** (THEME §6), not from 1:35 to the end: 26 s from the reveal, then the last 4 s on the end card.

---

## 1. Shot list

Times add up to exactly 3:00. **Dependency** tells you when the shot can be filmed.

| # | Time | Len | Beat / narration | On screen | Device | How it's captured | Who films | Dependency |
|---|---|---|---|---|---|---|---|---|
| S1 | 0:00–0:08 | 8 s | Opener card (no VO) | Black. Cream serif text: *"The morning after the whole family came for her birthday, she asked when someone would visit."* | — | Made in the editor (Fraunces or Instrument Serif, `#f6eee4` on black) | IBS27 | can film now |
| S2 | 0:08–0:18 | 10 s | The stand-in grandparent alone by a window. A family member on the phone, quietly: "She doesn't remember we came." | The grandparent, natural light, wide then close | — | Second camera (spare phone, landscape, tripod or braced) | IBS27 | needs the 20:00 capture (same shoot) |
| S3 | 0:18–0:36 | 18 s | VO line 3, then the family's own voices | (a) The Relive app's room scan: dots lighting up as the phone moves (8 s). (b) The visit being recorded: family talking, the dish, the gift, a laugh (10 s) | iPhone | (a) iOS screen recording during the real scan. (b) Second camera over Shivin's shoulder showing the phone and the room | Shivin (screen), IBS27 (second camera) | needs the 20:00 capture |
| S4 | 0:36–0:54 | 18 s | VO line 4 | Facts page: "What should she relive?" (or "Facts" before the rename), each fact beside its keyframe or quote. Click a quote → video seeks. Tap **Approve**; mark one **Don't bring this up** | Laptop | Laptop screen recording of the real first review (M8) | Shivin | needs the 20:00 capture |
| S5 | 0:54–1:06 | 12 s | VO line 5 | The grounding log: a sentence Claude tried to say in a real session, the reason it was dropped. See "Grounding shot" below | Laptop | Laptop screen recording | Firdavs | needs real Revisit sessions (01:00–04:00) |
| S6 | 1:06–1:30 | 24 s | Card "Later that night · <real time>". The grandparent with the iPad. **Begin the visit**: the room fills in, the family replays in 3D, Claude narrates a real approved fact. **Song in at ~1:08, as the points fill in** | iPad landscape: the visit view (`#/capture/<id>`, caption line at the bottom). Second camera: her face and the iPad | iPad landscape | iPadOS screen recording (mic off; captures the narration audio) + second camera on her | Whoever runs the session (iPad), IBS27 (second camera) | needs real Revisit sessions |
| S7 | 1:30–1:44 | 14 s | She says a detail back on her own (**only if it really happens**; otherwise she listens and Claude's next line plays). Song ducks under her voice, out by 1:34 | Her face; the iPad caption | iPad + second camera | Same take as S6 | Same as S6 | needs real Revisit sessions |
| S8 | 1:44–1:56 | 12 s | VO line 8: "this was an old video" | Split: the flat source clip on the left, the same moment in 3D on the right, with **"Estimated from a video, not measured"** visible | Laptop | Laptop screen recording: play the source clip, then the viewer (`web/video-estimated` or later) | Firdavs | can film now (team-data-1 clips); better with M5's real family video |
| S9 | 1:56–2:10 | 14 s | VO line 9: the museum walk | Memory Museum (`#/museum`): "Your memories", picture frames, tap one → walk to it; a video-made frame shows "Estimated from a video" | iPad landscape | iPadOS screen recording | Firdavs | needs Firdavs's museum fix (M1) |
| S10 | 2:10–2:22 | 12 s | VO line 10: a helper joins from a phone | Phone and iPad side by side on a table. Helper types the code, taps a frame on the phone, the iPad walks there. Phone taps **Step into this moment**, the iPad opens it. The iPad shows "<name> is with you" | Phone + iPad together | Second camera from above/front showing both screens and hands; both screen recordings as cutaways | IBS27 | needs Visit together (M3) + museum fix |
| S11 | 2:22–2:34 | 12 s | VO line 11: Memory Window with head tracking | Memory Window full screen. A person moves their head left/right; the view shifts like a window | iPad landscape | Second camera over the shoulder showing the person's head **and** the iPad screen (screen recording alone can't show head tracking). iPadOS screen recording as cutaway | Firdavs (on the iPad), IBS27 or a tripod (second camera) | can film now (needs the HTTPS tunnel) |
| S12 | 2:34–2:46 | 12 s | VO line 12: research line | Dashboard: recall chart with the real session times on the x-axis, unprompted vs after a cue; "Older memories it brought up" / "Memories it brought back" (only if a real one happened) | Laptop | Laptop screen recording, slow scroll | Firdavs | needs real Revisit sessions (3+, M9) |
| S13 | 2:46–3:00 | 14 s | VO line 13 (pitch close), then the end card. Song's last 4 s from 2:56 | Smile-arc logo, **Relive With A Smile**, tagline, credits (below) | — | Made in the editor | IBS27 | can film now |

**End card text (S13):** *She may not remember the day. She'll remember how it felt.* · Built with Claude (Anthropic) · Team: Shivin, Firdavs, IBS27 · Prior reference: Rumi (HackMIT 2026), Déjà View · Depth Anything 3 · Apple sample code "Displaying a point cloud using scene depth" · *Music: "Die With A Smile", Lady Gaga & Bruno Mars* · Small line: *Filmed with a family member standing in for a grandparent. All captures and sessions are real, shown at their real times. Scenes made from old videos are estimates.*

### Grounding shot (S5)

Show a sentence a **real** session dropped, in this order of preference:

1. **A held-back list in the UI.** The front page step "Every sentence is checked by code before they hear it" currently shows only a count ("N sentence(s) held back by the check so far"). Its own copy promises the sentence "struck through, with the reason". If Firdavs has 20 minutes after M1/M2, list `session.dropped` there (struck-through sentence + reason). This is the best shot.
2. **The session file.** Open `/api/sessions/<sid>` in Firefox (JSON viewer, zoom 150%), collapse `turns`, expand `dropped`: the sentence and its reason. Real, plain, readable.
3. **Fallback if no real session dropped anything:** run `node --test guide/test/grounding.test.mjs` in a clean terminal (no env, no key visible). Caption it **"Test run: a deliberately ungrounded sentence"**. Never present a test sentence as if it came from a session. If the facts page shows "The grounding check removed N facts" for the demo capture, add it as a 3 s cutaway (that one is real).

---

## 2. Narration script

About 150 wpm (2.5 words/s). Each line fits inside its shot with room for natural sound. One calm voice for all lines. Record lines 3, 4, 5, 8–13 any time before 04:00 (they don't depend on footage), three takes each.

| Line | Starts | Words / sec | VO |
|---|---|---|---|
| 3 | 0:18 | 22 / 9 s | "The next visit, the family films it with Relive. The iPhone scans the room, then records the visit: video, sound and depth." |
| 4 | 0:37 | 23 / 9 s | "Claude picks out small, true details, each linked to the frame or the words it came from. The family decides what she hears." |
| 5 | 0:55 | 22 / 9 s | "Every sentence Claude says is checked by code. If it isn't backed by an approved detail, it's removed before she hears it." |
| — | 1:06–1:44 | — | **No VO.** Claude's own narration (from the iPad audio), her voice, the song |
| 8 | 1:45 | 17 / 7 s | "Old videos work too. A depth model rebuilds them in 3D, and Relive labels them as estimates." |
| 9 | 1:57 | 15 / 6 s | "Every moment hangs in a calm Memory Museum. Tap a picture to walk to it." |
| 10 | 2:11 | 13 / 5 s | "Family can join from their own phone and walk the museum with her." |
| 11 | 2:23 | 15 / 6 s | "Step inside, and the iPad follows your head, like looking through a window. No headset." |
| 12 | 2:35 | 24 / 10 s | "The family sees what she held on to, session by session, at the real times: the measure from the SenseCam study, Woodberry 2015." |
| 13 | 2:47 | 15 / 6 s | "We can't stop her forgetting. But we can let her relive it, with a smile." |

If S8 uses Shivin's clips rather than a real family video, keep line 8 as written ("Old videos", not "her family's old videos").

**Song cue** (THEME §6–7):

| From | To | What |
|---|---|---|
| 1:08 | 1:30 | Chorus of "Die With A Smile" comes in as the room fills in on the iPad, full under S6 (natural sound and Claude's narration on top, song about −6 dB under the voice) |
| 1:30 | 1:34 | Ducks a further −12 dB under her voice, fades out by 1:34 (26 s used) |
| 2:56 | 3:00 | Last 4 s of the song resolve under the end card (total 30 s) |

Everything else: natural sound and room tone. Optional: a quiet royalty-free piano bed (YouTube Audio Library) under S8–S12 at about −24 dB.

---

## 3. Capture checklist per person

**Everyone, before every recording:**
- [ ] Do Not Disturb / Focus on (iPhone, iPad, laptop). No banners, no message previews.
- [ ] Battery charged above 50% (a red battery icon looks bad); Low Power Mode **off** (it turns the icon yellow and throttles the GPU). The status bar can stay: its real clock helps the honesty.
- [ ] No red **MOCK MODE** banner, no `[mock]` text anywhere. `MOCK_CLAUDE` unset in the guide's environment.
- [ ] Only real captures in the gallery; no test sessions on the dashboard (CLAUDE.md "Test data hygiene": delete test files in `guide/data/sessions/`, reset test review clicks).
- [ ] No terminal, `.env`, API key or Console page on screen. The tunnel URL showing is fine.
- [ ] Everyone in frame has given consent (`docs/filming-prep.md`).
- [ ] Name files by shot: `S06-ipad-screen.mov`, `S06-cam.mov`, `S11-cam.mov`.

**Second-camera settings (any spare phone):** landscape, 1080p or 4K at **30 fps** (not 60, not Cinematic), Settings → Camera → Formats → **Most Compatible** (H.264, easier on Linux), lock exposure/focus (long-press), tripod or braced on something, 3 s of still before and after each action.

**iPhone/iPad screen recordings:** Control Center → Screen Recording. Long-press it to set the mic: **off** for screens where the app speaks (the recording keeps the app's audio), on only if you need the room. Start 3 s before the action, stop 3 s after. iPad always in **landscape**.

**Laptop screen recordings:** 1920×1080, browser in full screen (F11), zoom so text is readable at 1080p (110–125%), a clean browser profile (no bookmarks bar, no other tabs, no extensions badges), cursor moves slow. Mac: Cmd+Shift+5. Linux: OBS, or GNOME's built-in recorder (Print Screen → record).

### Shivin
- [ ] **20:00 shoot, S3a:** iOS screen recording of the room scan, phone held the way the capture works best (don't change the capture for the video). If screen recording makes the phone stutter or heat up during the visit recording, stop it after the scan: the capture matters more; IBS27's over-the-shoulder shot covers S3b.
- [ ] **M8, S4:** screen-record the real first fact review. Before you start, leave a few facts pending so the recording shows real taps on **Approve**, one edit if natural, and one **Don't bring this up**. Hover a keyframe; click a quote so the video seeks.
- [ ] Note the real times of the capture and each session for the cards.
- [ ] Run the tunnel for S6, S9–S11 (Claude Code can't open it).

### Firdavs (04:00–07:30 screen recordings, earlier where possible)
- [ ] **S8 (now):** source clip, then the same clip in 3D with the badge visible. Two takes: slow orbit, and camera-path mode.
- [ ] **S11 (now, on the tunnel):** Memory Window on the iPad, landscape, **Look with your head** (allow the camera). Sit 50–70 cm away, move your head slowly left/right/up. Second camera behind your shoulder sees your head and the screen. Also record tilt and drag-to-look takes as backups.
- [ ] **S9 (after M1):** museum: "Your memories", tap a frame → walk, a video-made frame showing its badge, **Step into this moment** → Memory Window → **Back to the museum**.
- [ ] **S5 (after real sessions):** grounding shot per §1 "Grounding shot".
- [ ] **S12 (after 3+ sessions):** dashboard: hold on the chart 3 s, then the session list and older memories. Make sure the x-axis shows real times.

### IBS27
- [ ] **20:00 shoot:** S2 (the grandparent by the window; the family member's line on the phone), S3b over-the-shoulder of the visit being recorded. Also 10–20 s of B-roll: hands, the room, the dish, the gift, for cutaways.
- [ ] **S6/S7:** second camera on the grandparent during their real Revisit session(s): face and iPad in frame, landscape, 30 fps. Whoever runs the session starts the iPad screen recording before tapping **Begin the visit**. Don't prompt their lines.
- [ ] **S10 (after M3):** iPad and phone flat or propped side by side, camera from the front-above; type the code on the phone, tap a frame, iPad follows, **Step into this moment**, back. Also save both screen recordings (the 20-second capture in LAST-STEP's "Done when").
- [ ] **VO:** record lines 3–13 before 04:00 in a quiet small room (closet with clothes is good), phone voice memo 15 cm from the mouth, off-axis, three takes each.
- [ ] S1 and S13 cards in the editor.

---

## 4. Edit plan

**Editor:** **Kdenlive from Flathub** (`flatpak install flathub org.kde.kdenlive`). The Flatpak bundles full ffmpeg, so iPhone H.264/HEVC and AAC open directly. Fedora's own `ffmpeg-free` lacks some of these codecs. DaVinci Resolve also works, but the free Linux version doesn't decode H.264/HEVC/AAC, so every clip would need transcoding to DNxHR first; Kdenlive avoids that step.

**Getting iPhone/iPad files onto Fedora** (venue Wi-Fi blocks device-to-device, so avoid AirDrop-to-a-Mac-then-LAN):
1. **USB cable (best):** plug in, unlock, tap **Trust**. GNOME Files shows the device (`gvfs-afc`, `libimobiledevice`, installed on Fedora Workstation). Copy from `DCIM/`. Settings → Photos → Transfer to Mac or PC → **Keep Originals** on each device first.
2. **USB-C drive:** USB-C iPhones and iPads can save to an exFAT thumb drive from Photos → Share → Save to Files.
3. **Shared Google Drive folder:** slowest on venue Wi-Fi; fine for small screen recordings.

**Ingest:** iPhone footage is variable frame rate, which drifts audio in editors. Convert every clip to constant 30 fps first. This needs a full ffmpeg (`flatpak run --command=ffmpeg org.kde.kdenlive`, or RPM Fusion's `ffmpeg`):
```bash
for f in raw/*.{MOV,MP4,mov,mp4}; do
  ffmpeg -i "$f" -vf fps=30 -c:v libx264 -crf 16 -preset fast -c:a aac -b:a 192k -ar 48000 "cfr/$(basename "${f%.*}").mp4"
done
```

**Assembly order (04:00–07:30):**

| By | Step |
|---|---|
| 04:30 | Ingest, convert, files named by shot. Project 1920×1080, 30 fps |
| 05:15 | Rough cut in shot order S1–S13. Missing shots get a black placeholder card with the shot name, so timing stays 3:00 |
| 05:45 | VO laid in at the start times above; Claude's narration and her voice from the S6/S7 takes |
| 06:00 | Song (1:08–1:34 and 2:56–3:00), ducking, room tone under cuts |
| 06:15 | Captions, cards, light color match (warm the second-camera shots slightly; leave the 3D scans in their real colors) |
| 06:20 | **Export v1, upload unlisted to YouTube** to see whether the song gets claimed or muted. If it does, swap in the licensed cover or instrumental |
| 07:15 | Fixes, final export, upload final (unlisted), keep a copy on Google Drive |
| 07:30 | Link to Shivin for the Devpost (M11) |

**Captions:** subtitles for every VO line and every spoken line (Kdenlive's subtitle track), burned in, plus an `.srt` uploaded to YouTube. Lower-third labels in the warm serif, cream on a soft plum bar (`#140d14`): the real capture time on S3 ("Filmed Sat Oct 24, <time>"), the real session time on S6, "Estimated from a video, not measured" stays visible in S8/S9 through the UI itself.

**Export:** MP4, H.264 High, 1920×1080, 30 fps, CRF 18 (about 12–16 Mbps), AAC 48 kHz 192 kbps, **exactly 3:00 or under**. Loudness to −14 LUFS, true peak −1 dB:
```bash
ffmpeg -i relive-final.mp4 -af loudnorm=I=-14:TP=-1:LRA=11 -c:v copy -c:a aac -b:a 192k relive-final-norm.mp4
```
YouTube: unlisted, title "Relive With A Smile · Cal Hacks 13.0", description with the one-liner from THEME §2, the music credit, and the honesty line.

### Fallback for each risky shot

| Shot | Risk | Fallback |
|---|---|---|
| S3a | Screen recording missing or phone stutters | Over-the-shoulder second-camera shot of the scan; or a fresh real scan of the same room right after the visit |
| S4 | Facts extraction fails on the demo capture | Never fake it. Use one of Shivin's four real scans with approved facts (team-data-1) and say "a visit" instead of "the visit" |
| S5 | No real session dropped a sentence | Test run, captioned as a test (see "Grounding shot") |
| S6 | Push-to-talk fails | Caregiver uses **Type instead** (cut list #4); show it as is |
| S7 | She doesn't say a detail back | She listens; Claude's next line plays (THEME §7). Never re-stage it |
| S8 | No real family video (M5) | Use the team-data-1 clips; VO says "old videos" |
| S9 | Museum hall still draws nothing | Cut S9; open the Memory Window straight from the viewer (`#/window/<id>`) |
| S10 | Visit together not working | Cut S10 |
| S11 | Head tracking doesn't work on the iPad | Tilt; then drag-to-look. Change VO 11 to "Step inside, and look around by tilting or swiping. No headset." Never claim head tracking we didn't show |
| S12 | Fewer than 3 sessions | Show the ones that exist, at their real times |
| Song | Claimed or muted on upload | Licensed piano/acoustic cover or the instrumental, same cue points |

**If S9 and S10 are both cut (26 s free):** S6 +8 s (longer reveal), S11 +8 s, S12 +6 s, S8 +4 s. Re-check the song cue: it still starts at the room fill-in.

---

## 5. Honesty rules for the video

1. **Real captures only.** Every scene on screen is a real phone capture or a real old video converted by `tools/video2capture`; video-made scenes show "Estimated from a video, not measured".
2. **Real times.** Session cards and the dashboard show the actual clock times. No "days later", no "day 3" for a gap of hours.
3. **Mock mode never on screen.** No MOCK MODE banner, no `[mock]` text, no sample data.
4. **Unscripted loved one.** The grandparent's words are their own. If the smile or the recalled detail doesn't happen, we don't stage it.
5. **Say who's who.** The end card says a family member stood in for a grandparent. We don't claim they have dementia.
6. **No smile detection claims.** "Smile" is the promise, not a measurement (THEME §4).
7. **Tests look like tests.** Any test output is captioned as a test.
8. **Consent from everyone filmed** or heard, including people in old videos; parents consent for children. See `docs/filming-prep.md`.
