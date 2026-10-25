# Braindance

A family films a visit on a LiDAR iPhone. Braindance turns it into a moment a parent with dementia can step back into over the following days, with Claude narrating only what the recording shows and measuring which details they hold onto.

Built at Cal Hacks 13.0.

**Team: what to work on right now is at the top of [`TASKS.md`](TASKS.md)** (Sat 16:00–18:00, Firdavs and IBS27 own everything).

## Start here

- `CLAUDE.md`: the full build plan (Claude Code reads it automatically)
- `TASKS.md`: who owns what, deadlines, and the starting prompt for each person
- `IOS_CAPTURE_PLAN.md`: the iPhone capture app

## The AI guide: voice in the Memory Palace (Cartesia, Moss, Claude, Convex)

In her Memory Palace, **🗣 Guide** turns on a voice that tells her about each memory and answers what
she asks. The caretaker writes the story behind each picture in the editor ("Tell the AI guide about
this memory", plus a "Never bring up" line); the guide says nothing else. It gives a short intro at
the frame and the fuller story once she steps inside, and she can ask anything, any time, without
pressing a button. The music fades down gradually while it speaks.

**Cartesia: the guide's voice and ears** (`web/src/museum/guide/cartesia.ts`)
- **Sonic 3.6** text-to-speech over the WebSocket API, streamed and played as it arrives, at
  `generation_config.speed` 0.9 (a little slower, for clarity). Cancelled mid-sentence when she speaks.
- **Ink-2 Realtime STT (Auto)**, `/stt/turns/websocket`, for hands-free turn-taking: `turn.start`
  stops the guide (barge-in), `turn.eager_end` starts working out the answer, `turn.resume` drops
  it, `turn.end` speaks it.
- The **"Patient" turn profile** (end threshold 0.1, 8 s timeout), because people with dementia
  pause to find words and shouldn't be cut off.
- **Keyterm prompting**: the family's names and places from the notes are sent as `keyterm`s, so
  "Priya" is heard as Priya.
- **Access tokens**: Convex mints a 10-minute token (`guideNode.voiceToken`); the API key never
  reaches the browser.

**Moss: the guide's memory** (`backend/convex/guideNode.ts`, `backend/convex/lib/guide.ts`)
- One persistent index, `braindance-palace`: each memory's notes and approved facts are documents
  tagged with `metadata.memory`, upserted when the caretaker saves.
- A question is a hybrid search **filtered to the memory in front of her** (top 5), held in the
  Convex process with `autoRefresh`, so lookups are local and fast. Only what Moss finds goes to Claude.
- **What she shares is remembered**: anything she says (four words or more) is added to the index
  under that memory, so later in the visit, or next time, the guide can come back to it ("You told
  me this kitchen looks like your mother's").

**Claude** writes each memory's intro and story when the caretaker saves (so they play instantly)
and answers from what Moss found; every sentence must cite its source, and code drops any that
don't, or that touch "Never bring up". **Convex** holds the notes and the written words (live), and
makes every outside call with the keys server-side.

**Setup:** set `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` (redeem the code `CALHACKS` in the Moss portal)
and `CARTESIA_API_KEY` (play.cartesia.ai/keys), optionally `CARTESIA_VOICE_ID`, on the Convex
deployment (`bunx convex env set …`), then deploy. Details: `docs/architecture-v3.md` §6.6.1.

**Known limitations**
- What she says is stored in Moss (under her family's project) so the guide can remember it; a
  real deployment needs her family's consent and a way to delete it.
- While the guide speaks, only clearly louder sound counts as her talking, so its own voice from
  the speaker doesn't interrupt it; a quiet voice may need to wait for it to finish.
- English only for now (Ink-2), and the guide knows only what the family wrote.

## Credits

The capture app follows patterns from Apple's sample "Displaying a point cloud using scene depth" and draws on lessons from the team's earlier Rumi project (HackMIT 2026). All code in this repo was written during Cal Hacks 13.0.
