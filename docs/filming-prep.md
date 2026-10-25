# Filming prep: the demo visit, tonight 20:00

For M7 in `TASKS.md`. Shivin films with the LiDAR iPhone at his brother's house; IBS27 preps the people and the details. Print sections 1 and 3, and bring the run sheet (section 4) on a phone.

**This is a real visit, not a skit.** The lines below are prompts so the visit contains details Claude can pick up. Say them in your own words if that's more natural. Nobody fakes an outcome: whatever Claude extracts, and whatever the grandparent says later in the Revisit sessions, is what we show.

## Blanks to fill in before 20:00

| Blank | What it is | Filled in |
|---|---|---|
| `<grandparent>` | The person playing the grandparent (section 2) | |
| `<address>` | What the visitors call them in the visit (e.g. "Mom", "Nani", "Grandma"). Set the guide to the same with `PUT /api/person` | |
| `<visitor 1>` | Brings the dish | |
| `<visitor 2>` | Brings the gift | |
| `<visitor 3>` (optional) | Tells the story | |
| `<dish>` | A named dish, easy to say and to see (e.g. "mango cake", "lemon rice") | |
| `<gift>` | A gift that's handed over and named (e.g. "a blue scarf", "a photo album") | |
| `<place>` | A real place with a name (a town, a park, a beach) | |
| `<story>` | One short true family story, 2–3 sentences, that ties to `<place>` | |
| `<don't-raise detail>` | The one thing the family will mark "don't bring this up" (detail 6), with its blank: `<late relative>` or `<street>` | |
| `<team contact email>` | The email on the consent note for withdrawal requests | |
| `<title>` | Title to type on the phone's review screen | |

Use only people who agreed to be filmed and have signed section 1. Use their real first names (Claude takes names only from what we type, and the speech recognizer has to hear them clearly).

---

## 1. Consent note (one per person filmed)

Print one copy for each person who will be in the room during the scan or the visit, including anyone who might walk through.

> **Relive With A Smile: consent to be filmed**
>
> We are a student team at Cal Hacks 13.0 (Oct 24–25, 2026) building Relive With A Smile, an app that turns a family visit into a 3D moment someone with Alzheimer's can revisit. Tonight we'd like to film a short visit (about 2 minutes) with an iPhone. Nobody in this recording has dementia; one person is playing that role.
>
> **What we record:** video and sound of the visit, and a 3D scan of the room made with the phone's depth sensor (LiDAR).
>
> **What happens to it:**
> - The phone writes down what was said (a transcript). This happens on the phone itself.
> - About 30 still frames from the video, the transcript, and the names we type are sent to Anthropic's Claude API, which suggests short facts about the visit ("<visitor 1> brought a cake"). A team member checks every fact by hand. Anthropic says it does not train its models on API data by default.
> - If you're playing the grandparent: later tonight you'll talk to the app on an iPad a few times. What you say is turned into text by the iPad's speech recognition (Apple) and sent to Claude so it can reply, and the app records which details you mention.
> - The recording is kept on our team's laptop and shared among our three team members in a private GitHub repository during the hackathon.
> - No face recognition is used. People are named only by what we type.
>
> **Where it may be shown** (tick what you agree to; leave blank to say no):
> - [ ] To the hackathon judges, live
> - [ ] In our public demo video (YouTube, unlisted or public) and on our Devpost page
> - [ ] On our public demo website (the 3D scan and clips)
>
> **Your choice, any time:** you can stop the filming, ask us to cut you out of a clip, or withdraw completely, now or later. Tell any of us or email `<team contact email>`, and we'll delete what we hold and stop using it. If something is already published, we'll take it down.
>
> Name: ______________________________ &nbsp; Signature: ______________________________ &nbsp; Date: ____________
>
> Team member: ______________________________

---

## 2. Casting the grandparent

**Chosen:** `<grandparent>` &nbsp; (decided by IBS27)

The same person plays the grandparent in the visit tonight and in the Revisit sessions on the iPad (01:00–04:00, a few hours apart), so pick someone who can be available then, or plan the sessions around them.

What the role needs:
- Comfortable on camera, and with the clip being shown to judges and maybe online.
- Speaks clearly and at a normal pace. In the Revisit sessions they hold a "Talk" button on the iPad and speak to it; the browser has to understand them.
- Can play mild-to-moderate dementia **respectfully**: warm, a little slower, sometimes unsure, still themselves.

Do:
- Be warm and present. Enjoy the visit.
- React to things honestly: smile at the dish, hold the gift, laugh at the story.
- Be a bit vague about time ("Was that last week?") if it comes naturally.
- In the Revisit sessions, answer as yourself in the role. If a real detail comes back to you, say it; if it doesn't, don't force it.

Don't:
- No caricature: no exaggerated confusion, shaking, slurring, "funny old person" voice, or jokes about forgetting.
- Don't memorize what Claude will say or "perform" recall in the Revisit sessions. The dashboard measures what you actually say, so faking recall would make it fake.
- During the Revisit sessions, don't say the distress phrases ("I want to go home", "Where is everyone", "Where am I", "Who are you", "I'm scared/lost/confused", "Help me", "Stop it/this", "Leave me alone", "I don't like this") unless we're deliberately running the distress test. They end the session and create an alert (`guide/src/grounding.mjs`).

---

## 3. The visit's details

Claude only gets ~30 keyframes spread evenly over the clip (one every ~3–4 s for a 2-minute visit) plus the phone's transcript, and it only states what those show. So every planned detail should be **said out loud, clearly, by one person at a time**, and anything visible should **stay in frame for at least 5 seconds**. Feelings count only if someone says them out loud.

| # | Detail | Who | The line (say it naturally) | In frame |
|---|---|---|---|---|
| 1 | **Who's there** | each visitor, on arrival | "Hi `<address>`, it's `<visitor 1>`." / "Hi `<address>`, `<visitor 2>` here." | Each visitor's face toward the phone for a few seconds, next to `<grandparent>` |
| 2 | **A named dish** | `<visitor 1>` | "`<address>`, I brought `<dish>`. I know you love it." | The dish held up, then set on the table in front of `<grandparent>`, visible for 5+ s |
| 3 | **A gift, handed over and named** | `<visitor 2>` | "This is for you, a `<gift>`." (`<grandparent>`: "Oh, a `<gift>`! It's lovely.") | The hand-over and `<grandparent>` holding it up, 5+ s |
| 4 | **A place, by name** | `<visitor 3>` or `<visitor 1>` | "We drove past `<place>` on the way here." (Avoid "Do you remember…?": it puts someone with dementia on the spot.) | Faces of the speaker and `<grandparent>` |
| 5 | **A short family story** | `<visitor 3>` | 2–3 sentences of `<story>`, e.g. "At `<place>` you made everyone `<dish>` and the dog stole a piece." | The storyteller and `<grandparent>` reacting |
| 6 | **"Don't bring this up"** | any visitor | One gentle, tasteful line, e.g. "`<late relative>` used to make this too." or "Since the move from the old house on `<street>`…" | Nothing special |

Notes:
- Say `<dish>`, `<gift>` and `<place>` at least once each, clearly, without someone talking over it. The quote has to appear in the transcript for Claude's evidence to count (`guide/src/facts.mjs` drops quotes that don't match).
- A said feeling makes a good fact: "`<address>`, it's so good to see you" or the grandparent's "I'm so happy you came."
- In family review (M8), detail 6 becomes the fact Shivin marks **"don't bring this up"**. Claude must never mention it in any Revisit session; that's an acceptance check (CLAUDE.md §12).

### The branch line (for the Revisit session, not the visit)

The branch happens **later, on the iPad**, when the grandparent links the moment to an older memory. Plan a line, ideally from the grandparent's own life:

> "This kitchen looks like my mother's." or "My sister used to make `<dish>` like that."

Claude should show interest, ask one open question ("What was your mother's kitchen like?") and log the line under "Memories it brought back". Say it in one of the Revisit sessions, in your own words, once it fits. If the stand-in has a real memory like this, use that instead.

---

## 4. Run sheet for 20:00

Before leaving: phone charged (>70%), app installed and opening (free signing expires 7 days after install), guide running on Shivin's laptop with the Claude key, tunnel URL pasted in the phone's Upload settings and "Test connection" says "Connected to the guide." Bring the printed consent notes, pens, the dish and the gift.

| Time | Step | Done when |
|---|---|---|
| 20:00 | **Consent.** Everyone who'll be in the room reads and signs section 1. Anyone who doesn't consent stays out of the room for both the scan and the recording. | A signed sheet per person |
| 20:05 | **Fill the blanks** (top of this file). Brief everyone on their one line; nobody reads from paper on camera. Set the guide's person: `PUT /api/person` with `{ "displayName": "<grandparent>", "preferredAddress": "<address>" }`. | Each visitor can say their line from memory |
| 20:10 | **Space check.** Lights on, curtains half closed if there's a bright window (no one sits with a window behind them). TV, music, fans and dishwasher off; phones on silent. Clear the table except the planned dish spot. Pick where the grandparent sits: facing the room, with space for the phone 1–2 m in front. Move or turn away big mirrors and glass if you can; turn face-down any framed photos of people who haven't consented. | Quiet, evenly lit, nobody backlit |
| 20:15 | **Room scan** (people out of the room). "Start scanning", hold the phone in **landscape**, walk slowly around the edges 1–3 m from the walls: walls, floor, table, chairs, the grandparent's chair. 60–90 s. The live dots should cover the surfaces evenly, stay locked to them as you move, and the coach line should move to "That's plenty of room". If it turns amber, slow down or point at something with more detail. Tap **Save room**. | "Room saved (N points)", ideally a few hundred thousand or more |
| 20:18 | People come in and take their places. **Don't restart the app**: the visit must be recorded in the same session as the scan so it lines up with the room. | Everyone in position |
| 20:20 | **Record the visit.** Tap "Record the visit". First thing: **clap test**. One person claps once, hands clearly in frame, about 1 m from the phone, without saying anything. Then the visit starts. | Clap visible at the very start |
| 20:20–20:22 | **The visit**, 60–120 s (the app stops at 3:00). Natural, unhurried; arrivals → dish → gift → place and story → the don't-raise line → a goodbye or a laugh. One speaker at a time; pause a beat between speakers. Everyone faces the phone at times. Filmer moves slowly and stays within ~2 m of whoever is talking. Tap **Stop recording**. | Stopped before 3:00 |
| 20:23 | Wait on "Putting your visit together" (keyframes, then transcription on the phone). **Keep the app open.** | Review screen ("Step 3 of 3") |
| 20:25 | **Review screen.** Read "What the phone heard": are `<dish>`, `<gift>`, `<place>` and the names there? Type the **title** (`<title>`) and the **attendees** exactly, comma-separated, spelled the way you'll want them said back: `<grandparent>, <visitor 1>, <visitor 2>, <visitor 3>`. Tap outside the field so it saves. | Title and names saved |
| 20:27 | **Upload:** "Send to your family's guide". Ends with "Sent. The guide checked every file." **Fallback:** "AirDrop the capture (zip)" to Shivin's Mac, then drop the zip on the website (or `npm --prefix guide run import -- <unzipped folder>`). Keep the zip either way. | The capture shows on the website's captures list |
| 20:30 | **Fact extraction** starts by itself after upload/import (status "facts running" → "done"). If it fails, read the message; "Re-extract" retries. | Facts appear in the review panel |
| 20:35 | **Check the facts** (don't approve yet; that's M8). Each planned detail (1–6) should be there with its evidence: dish, gift, place, story, names, the don't-raise line. Click a few to see the keyframe or quote line up. | 4 of the 6 details, at least, are facts with evidence |
| 20:40 | Shivin: **clap check** in the viewer, step frames around the clap: the sound should land within ±1 frame of the hands meeting (CLAUDE.md §12). | Pass or fail written in the PR/Work log |

### Retake rule

Retake (new scan + new recording) if **any** of these:
- the transcript on the review screen is missing or garbles two or more of `<dish>`, `<gift>`, `<place>` or a name;
- the clap isn't visible or isn't at the start;
- someone who hasn't consented came into frame or was heard;
- the phone lost tracking for long stretches (amber coach line most of the time) or the room scan has big holes where people sit;
- fewer than 4 planned details become facts after extraction (check the transcript first; usually it's speech).

At most **two retakes**, so filming is done by ~21:15 and Revisit testing can start. Keep the best take. Don't upload the bad ones; if one was already uploaded, stop the guide and delete its folder `guide/data/captures/<id>` (and any test session in `guide/data/sessions/`) so it doesn't reach the dashboard.

---

## 5. Pitfalls

What breaks the capture or the transcript:
- **Backlight:** a bright window behind people turns faces dark in keyframes and video. Light the faces, not the background.
- **Mirrors, glass, shiny floors:** LiDAR gives false or missing depth on them; the room fills with ghost points. Avoid scanning them head-on.
- **Fast pans and walking quickly:** tracking drops, frames blur, and the 3D replay of people tears. Move like you're carrying a full cup.
- **Background sound:** TV, music, a fan or a running tap make the on-device transcript miss words. Off, all of it.
- **Crosstalk:** two people talking at once loses both lines. One speaker at a time; pause between turns.
- **Distance from the mic:** the mic is on the phone. Someone speaking 3+ m away or facing away often isn't transcribed. Keep the speaker within ~2 m and facing the phone.
- **Portrait mode:** hold the phone in landscape the whole time; the video and depth are stored that way.
- **Restarting the app between scan and visit:** the visit won't line up with the room. Scan, save, record, all in one go.
- **Names the recognizer doesn't know:** say unusual names slowly and clearly. The typed attendee list fixes the spelling in facts, but quotes must match what the phone heard.
- **The clap, as a fact:** Claude may write "Someone clapped." Reject it in review.

**Faces and consent:** no one is filmed who hasn't signed section 1. That includes people walking through, people in the next room who might be heard, and anyone on a screen. If someone appears by accident, retake. If anyone changes their mind later, we remove the clip.
