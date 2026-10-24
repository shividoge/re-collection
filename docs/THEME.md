# Theme: Relive With A Smile

Decided by Shivin, Sat Oct 24. The project's public name changes from **Braindance** to **Relive With A Smile**, themed on Lady Gaga & Bruno Mars's **"Die With A Smile"**. It is the same move as Déjà View (*déjà vu* → *View*): one word of a song every judge knows changes, and the title now says what the project does.

**Die** → **Relive**. The song is about wanting to be beside someone if the world ends. For a family watching someone slowly forget, that is the whole feeling. The project's answer: the world is ending a little every day, so let her live the good parts again, and smile.

The tone is **bittersweet, leaning warm**: we acknowledge the loss, and we end on the smile.

---

## 1. The name, and how to write it

| Where | Write it as |
|---|---|
| Devpost title, site hero, video title card, slides | **Relive With A Smile** |
| Phone home screen (12 characters max), tab titles, buttons, short mentions | **Relive** |
| Sentences | "Relive" ("Open it in Relive", "Relive turns a visit into…") |
| Internal code, file formats, repo, guide server, `braindance.capture` | **Unchanged.** Renaming identifiers breaks captures, tests and teammates' branches for no judge-visible gain |

Never write "Die" anywhere in the product. The song is for the video and the pitch only (see section 6).

## 2. The lines we repeat

- **Tagline:** *She may not remember the day. She'll remember how it felt.*
- **One-liner:** Relive With A Smile turns a family visit into a 3D moment someone with Alzheimer's can step back into, narrated by Claude using only details the family approved.
- **Pitch opener:** "The morning after the whole family came for her birthday, she asked when someone would visit."
- **Pitch close:** "We can't stop her forgetting. But we can let her relive it, with a smile."
- **Trust line** (from the sponsor plan, keep it): "Everything you see is a real scan, and everything Claude says is checked by code against what the family approved."

## 3. Look and feel

The song's music video is warm, golden-hour, slightly retro. The product should feel like a memory at sunset, not a sci-fi editor.

| | Now (Braindance) | Relive With A Smile |
|---|---|---|
| Mood | Cyberpunk editor, red-orange on near-black | Golden hour: warm, soft, a little nostalgic |
| Background | `#07080a` | Deep plum night `#140d14` (dark mode stays; scans glow on it) |
| Accent | `#ff5c3a` | Sunset amber `#ffb35c` → rose `#ff7a8a` gradient for the hero, logo and the main button |
| Text | `#e8e6e3` | Warm cream `#f6eee4`; muted `#a8999a` |
| Headings | system sans | A warm serif for emotional lines (e.g. **Fraunces** or **Instrument Serif**, Google Fonts); system sans stays for UI and data |
| Logo mark | red dot | **A smile made of LiDAR points**: a single curved arc of dots, which also reads as a horizon at sunset. Use it as the app icon, favicon and the loader |

Rules: keep it calm (the Revisit screen is for someone with dementia: high contrast, large type, no flashing). The 3D scans stay in their real colors; only UI chrome takes the warm palette. Prefer the existing `--bd-*` CSS variables in Firdavs's `web/` and change their values rather than adding new class names.

### Editor layers and provenance (plan v3, proposed)

The family's editor (`CLAUDE.md` 7.6) gets a layered timeline and labels for where everything came from (`docs/scene-model.md`). Keep it restrained: four quiet colors on the plum background, thin marks at about 60% opacity, full color only on hover or selection. The amber-to-rose gradient stays reserved for the logo and the main button.

| Layer | What it carries | Color |
|---|---|---|
| Visual | frames, when an object was on camera, clearest views | soft amber `#e8b06a` |
| Audio | speech by speaker, sound events, cleaned-up audio | dusty rose `#e08a98` |
| Geometry | the recorder's path, scan coverage, measurements, alignment | muted teal `#7fb8b0` |
| Activity | chapters, facts, events, notes | soft lavender `#b59ad8` |

How each kind of truth looks, everywhere in the editor:

| `source` | Style |
|---|---|
| `observed` | Plain. The default look |
| `computed` | Plain, plus a small outlined `computed` tag in muted text (`#a8999a`); clicking it opens "Where this came from" |
| `estimated` | Dashed outline or 45° hatching in the layer color, plus an `estimated` tag with its confidence. In 3D, estimated surfaces are drawn fainter than measured points and vanish under "Measured only" |
| `human` | The author's name and the time, with a small cream initial |

Never use red for "estimated": red stays for errors and failed steps.

## 4. Words inside the product

Small copy changes carry most of the theme. Keep every claim true: **we do not detect smiles.** "Smile" is the promise and the metaphor, never a measured number.

| Screen | Now | Relive With A Smile |
|---|---|---|
| Website header / gallery title | BRAINDANCE | Relive (smile-arc logo) |
| Gallery empty state | "No captures yet." | "No visits yet. Film one with the Relive app." |
| Fact review heading | "Facts" | "What should she relive?" with the subline "Only what you approve is ever said to her." |
| Revisit welcome (fixed sentence in `guide/src/session.mjs`) | "Hello, Mom. Let's look back at a visit together." | Keep it. It is already gentle, and "relive" is a word for us, not for her |
| Dashboard heading | recall chart | "What she held on to", with unprompted vs after a hint, real times |
| Branches list | branches | "Memories it brought back" |
| Phone home | "Braindance" | "Relive" with the line "Film a visit. Let them relive it." |
| Phone review screen | "Review the visit" | "Review the visit" (unchanged; plain beats cute here) |

### Editor words (plan v3, proposed)

Same voice: warm, plain, true. Never promise more than the data holds.

| Feature | Words |
|---|---|
| Follow an object | **Follow** ("Follow the armchair through the visit") |
| Best captured frame | **Clearest view** |
| Annotations | **Notes**, with "Ask a question" and "Mark as a finding". Subline: "Only family can see notes. They're never read to her." |
| Search | **Find a moment** (placeholder: "the cake, a word someone said, a sign…") |
| Compare recordings | **Compare visits** |
| Trace to source | **Where this came from** |
| Hide estimated geometry | **Measured only** |
| Measurement with low certainty | "0.81 m, give or take 2 cm. **Check this in person.**" |
| Cleaned-up audio | "Clearer voice" next to "Original" (original plays by default) |
| Estimated label | "Claude's guess", with the tag `estimated` |
| Unseen area | "Not recorded" (never "missing" or "unknown") |
| Share link | "Share this view" |

## 5. Rename checklist (user-facing strings only)

Do this as one PR, `theme/relive`, after #17 and #16 merge so the site work isn't fighting conflicts. Roughly an hour.

- **iPhone** (`ios/project.yml`, then `xcodegen generate`): `CFBundleDisplayName: Relive`; the four permission strings say "Relive" instead of "Braindance". `ios/UI/HomeView.swift` title and intro line; `ios/UI/ReviewView.swift` share preview ("Relive visit …") and the Files hint (the folder name on the phone comes from the app's display name, so check it after install). Keep `BraindanceCapture` as the Xcode target and the bundle ID as is, so signing and installs keep working.
- **Website** (`web/`): `index.html` title "Relive With A Smile"; `views/Gallery.tsx` header; the palette in `web/src/index.css` / `views.css` (`--bd-*` values); new favicon (`web/public/favicon.svg`) with the smile arc; copy from section 4. The upload error ("isn't a Braindance capture") may stay: it's an internal format name, but "isn't a Relive capture" reads better to a family.
- **Public site** (from #17): hero, title, walkthrough copy and Open Graph tags (`og:title`, `og:description`, a share image of a scan with the logo), so a link pasted in Discord or Slack shows the name. Republish only with Shivin's OK.
- **Docs and Devpost:** README title and first paragraph; Devpost uses the name, tagline and one-liner from section 2. `CLAUDE.md` keeps "Braindance" as the internal code name (one line saying the public name is Relive With A Smile).
- **Leave alone:** repo names, `braindance.capture` format, `X-Braindance-Key`, `guide/` logs, file paths, test names.

## 6. The song

- Use **"Die With A Smile"** only in the demo video and as walk-on music for the live pitch if the room allows it. **Never inside the product**, and never in the Revisit screen: a song about dying is not something to play to someone with dementia.
- **20 to 30 seconds**, no more. Copyrighted music in a public YouTube or Devpost video can be muted or claimed; a short clip is the usual hackathon risk (Déjà View took it too). Have a fallback: a piano or acoustic cover licensed for reuse, or the instrumental, in case the upload gets muted. Upload the video unlisted a few hours early to see whether it gets claimed.
- Credit it on the last card: *Music: "Die With A Smile", Lady Gaga & Bruno Mars.*

## 7. Demo video (3:00), with the song cue

Film real people only, with consent. Do not script the loved one's lines (CLAUDE.md "Nothing fake").

| Time | Shot | Audio |
|---|---|---|
| 0:00–0:12 | Black. White serif text: *"The morning after the whole family came for her birthday, she asked when someone would visit."* | Silence, then room tone |
| 0:12–0:30 | The stand-in grandparent alone by a window. A family member on the phone, quietly: "She doesn't remember we came." | Natural sound |
| 0:30–0:55 | The visit is filmed with the Relive app: the room scan lighting up in dots, then the family talking, a named dish, a gift, a laugh | Natural sound and the family's voices |
| 0:55–1:20 | Family review: Claude's facts next to the frames and quotes. Someone taps Approve, marks one "Don't bring this up" | Voiceover: "Claude finds the small, true details. The family decides what she hears." |
| 1:20–1:35 | The grounding log: one sentence Claude tried to say that wasn't approved, crossed out | VO: "If it isn't approved, code removes it before she hears it." |
| **1:35–2:05** | **Days later. She puts on the tablet. The 3D room fills in around her, the family walks back in, Claude says: "Priya brought the mango cake you love."** | **The chorus of "Die With A Smile" comes in exactly as the room fills in** |
| 2:05–2:25 | **She smiles and says a detail back on her own.** (Only if it really happens; if not, show her listening and the narration.) | Song continues under her voice, then dips |
| 2:25–2:45 | The family dashboard: what she held on to across sessions, at their real times; "Memories it brought back" | VO: the research line (SenseCam, Woodberry 2015) in one sentence |
| 2:45–3:00 | Logo: the smile arc of dots, **Relive With A Smile**. Tagline. Credits: Claude (Anthropic), the team, Rumi and Déjà View as prior reference, music credit | Song resolves |

## 8. How the theme helps with sponsors

- **Anthropic, Claude for Public Benefit:** lead with the trust line and the grounding log shot; the name sells the "why", the log sells the "how".
- **Meta, Bringing People Closer Together:** the whole video is a family being closer to Grandma; say "closer" in the Meta paragraph.
- **People-First Social Impact:** the pitch opener and the research line.
- **Most Creative:** the name and the 3D reveal on the chorus.
- **Cartesia (if we do it):** the narration voice is part of the smile; a warm, slow voice is the honest reason to use it.
- **GoDaddy Registry, Best Domain Name (if Shivin buys one):** look for `relivewithasmile.<tld>` or `relive.<short tld>`; check availability before deciding.

## 9. Order of work

1. **Tonight 20:00:** film the demo visit (this matters more than any rename). Get the real smile moment if it happens.
2. After #17 and #16 merge: the `theme/relive` PR (section 5). Then republish the public site with Shivin's OK.
3. Edit the video (section 7) and write the Devpost with the lines from section 2.
4. Rehearse the pitch with the opener and close.
