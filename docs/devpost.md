# Devpost submission: Re:Collection

**Team: this is everything for the Devpost form, in the order it asks. Copy each section into its field.**

Everything for the Cal Hacks 13.0 Devpost form, in the order the form asks. Copy each section into its field. Notes for us (not for Devpost) are in *italics* under "Before you submit".

---

## Project name

Re:Collection

---

## Elevator pitch

**Use this one:**

> Re:Collection turns a family visit or an old home video into a 3D Memory Palace someone with Alzheimer's can walk back into, guided by a calm voice that only says what the family approved.

Alternatives:

- A Memory Palace for families living with Alzheimer's: step back into a visit in 3D, with a guide that never makes anything up.
- They may not remember the day. Re:Collection lets them walk back into it.

---

## About the project

*(Paste everything between the two lines. Devpost math: `\\( … \\)` inline, `$$ … $$` for blocks; it's already written that way.)*

---

## Inspiration

In our HOSA public service announcement, a son sits by a fire on his graduation night and tells the man next to him he always wanted to be a doctor, but can't anymore because of his father's medical bills. The man answers: *"Your father must be proud."* He **is** the father. He just doesn't know it.

That is what Alzheimer's does to families. The visit happened, it mattered, and by the next morning it's gone for the person who needed it most. Research on reviewing recordings of real events (the SenseCam study, Woodberry et al., 2015) found people with Alzheimer's recalled more after reviewing images of an event than after reviewing a written diary. Photos help. We wanted more than photos: a way to **walk back into the room**, see the family where they stood, and hear the story told gently, by a guide that never tests them and never makes anything up.

## What it does

**Re:Collection** turns a family visit, or an old home video, into a 3D memory someone with Alzheimer's can step back into.

1. **Capture.** A family member scans the room with the Re:Collection iPhone app (LiDAR), then films the visit in the same session: video, sound, the camera's exact pose every frame, and depth 10 times a second.
2. **Or bring an old video.** Any ordinary video is rebuilt into the same kind of 3D room with Depth Anything 3, and labelled *"estimated from a video, not measured"* everywhere it appears.
3. **Claude finds what's true.** Claude proposes small, checkable details ("Priya brought a mango cake"), each pinned to the frame or the words that prove it.
4. **The family decides.** Approve, reword, or mark a detail **"don't bring this up"** (for example, someone who has since passed away). Nothing reaches the patient without a yes.
5. **The Memory Palace.** Every memory hangs as an oil painting in a calm, walkable gallery. A caregiver chooses the paintings, their order and the words on each label. Step into a painting and the room rebuilds around you in 3D, with the people replaying where they stood.
6. **A voice guide.** A slow, warm voice introduces each memory and answers questions hands-free. It waits while they search for words, and it only says what the family wrote or approved.
7. **Family, from anywhere.** Relatives open the same private link on their own phone or laptop. Their screen follows the patient's walk and steps into memories with them, and they can talk to each other.
8. **No headset.** On an iPad, the Memory Window follows the viewer's head with the front camera, so the screen behaves like a window into the room.

## How we built it

**iPhone app** (Swift, ARKit, Metal, no third-party packages). One continuous ARKit session covers the room scan and the visit, so both share one coordinate system. A live GPU point cloud is exported at 1 cm. During recording the app writes 8 Mbps H.264 video, a pose and intrinsics per frame, and compressed depth. It also makes one keyframe per second and an on-device transcript (Apple Speech) *while* recording. Uploads go straight to cloud storage in resumable parts and keep going in the background.

**Backend** (Convex + Cloudflare R2 + pull-based workers). Convex holds captures, facts, reviews, sessions, the palace and every Claude call, so no API key ever reaches a browser. A job queue with leases and heartbeats hands work to workers:
- A **bake worker** precomputes each room once, in 3 to 9 seconds. That took the browser's time to a ready room from 6.3 s to 0.7 s, and the front page's first download from 713 KB to 99 KB.
- A **GPU worker** (an RTX 5060 Ti and an ASUS GX10 with 128 GB) converts videos and trains Gaussian splats.

**Putting people back in the room.** For a depth pixel \\((u, v)\\) with depth \\(d\\), scaled intrinsics \\((f_x, f_y, c_x, c_y)\\) and that frame's camera-to-world pose \\(T\\), the world point is

$$
\mathbf{p} = T \begin{bmatrix} (u - c_x)\, d / f_x \\ -(v - c_y)\, d / f_y \\ -d \\ 1 \end{bmatrix}
$$

The web viewer (React, TypeScript, React Three Fiber) runs this in a vertex shader for every depth frame in sync with the video, coloring each point from the video. People move and talk in the scanned room, in place. Areas the camera never saw stay empty; we never fill them in.

**Old videos to 3D** (Python, PyTorch). The pipeline:
- Depth Anything 3 estimates poses and metric depth across frames.
- A second 1008 px pass per frame recovers thin details. A joint bilateral filter transfers the multi-view shape onto it without bleeding across edges.
- Mask R-CNN removes moving people from the static room.
- Pixels that neighbouring frames disagree on are dropped.
- Points are fused at 5 mm, up to 6 million.

Checked against an iPhone's own LiDAR and ARKit poses, the camera path was off by **1.4 to 4.2 cm** and depth by **1.2 to 1.3%**.

**The Memory Window.** Instead of rotating a camera, the screen is a fixed window and the viewer's eye moves behind it. With the eye at \\(\mathbf{e}\\) and the screen's edges at \\(x_l, x_r, y_b, y_t\\) in eye space, the frustum is off-axis:

$$
\text{left} = \frac{n\,(x_l - e_x)}{e_z},\quad \text{right} = \frac{n\,(x_r - e_x)}{e_z},\quad \text{bottom} = \frac{n\,(y_b - e_y)}{e_z},\quad \text{top} = \frac{n\,(y_t - e_y)}{e_z}
$$

That's what makes a flat screen read as depth. Head position comes from MediaPipe face detection in the browser; no camera image leaves the device.

**Claude for judgement, code for guarantees.**
- **Facts:** Claude Opus 5.5 reads up to 30 keyframes and the timestamped transcript. Code keeps a citation only if it points at a keyframe Claude was actually sent, or quotes words really in the transcript.
- **Conversation:** Claude Sonnet 5.5. Every reply is a list of sentences, each citing the facts it uses.
- **Grounding check, in code.** Let \\(A\\) be the approved facts and \\(N\\) those marked "don't bring this up". A sentence \\(s\\) citing facts \\(F_s\\) is kept only if

$$
F_s \neq \varnothing \;\wedge\; F_s \subseteq A \setminus N
$$

or if it's a short piece of small talk with no name, date, place or relationship word the person didn't just say. Everything dropped is logged with its reason.

**The AI guide.**
- **Cartesia Sonic 3.6** speaks, streamed at 0.9× speed.
- **Ink-2** listens hands-free with the "Patient" turn profile, so slow speakers aren't cut off. The family's names are sent as keyterms, so "Priya" is heard as Priya.
- **Moss** keeps a memory index searched only within the memory on screen, and remembers what the patient shares ("You told me this kitchen looks like your mother's").
- **Claude** writes each answer from what Moss found, under the same grounding rules.

**The Memory Palace** is a classic gallery built entirely in code (textures, frames, furniture), with an oil-painting shader on every picture that lifts away when you step in. A live visit links family screens over WebRTC, with a voice relay through Convex when a direct call can't connect.

## Challenges we ran into

- **Honest without being robotic.** A prompt can't guarantee Claude never invents a detail for someone who can't push back, so the guarantee lives in code. The hard part was not making the guide mute: words the person just said are allowed back, so it can follow their lead.
- **Lining people up with the room.** The room and the visit must come from one unbroken AR session, and the browser's math must match the phone's exactly. Our first captures recorded at 60 fps with about 12 Hz depth instead of 30 and 10; we locked both and record the real rates.
- **Old videos have no true scale, and phones store video sideways.** We detect the upright orientation from what's in the frame and label every estimate. Long videos drifted when split into chunks on a 16 GB GPU, so we ran them in one pass on the GX10, which cut the path error from 68 cm to 4.2 cm.
- **Rebuilding the backend mid-hackathon.** We moved from a single laptop server to Convex, R2 and workers on Saturday night while the website and app kept changing, and merged three people's parallel work without losing any of it.
- **Venue Wi-Fi** blocks device-to-device traffic, and the iPad only allows the camera and motion sensors over HTTPS. So everything goes through the cloud, with a voice relay for when calls can't connect.
- **Designing for dementia.** No flashing, large type, a guide that waits, no quizzing, and a patient view with nothing to break.

## Accomplishments that we're proud of

- The whole loop runs on real hardware with real data: an iPhone scan, evidence-linked facts, family approval, a walkable Memory Palace, and a voice guide that answers questions.
- People replay in 3D from the phone's own depth, in the scanned room, in sync with their voices.
- Rooms from ordinary old videos that measure within centimetres of real LiDAR.
- A grounding check we can show a judge: a sentence the model tried to say, and the logged reason code removed it.
- More than 200 automated tests across the iPhone app, backend, workers and website.

## What we learned

- Claude is excellent at the judgement calls: which details are memorable and checkable, when someone is upset. The safety rules belong in tested code around it.
- "Offer, don't quiz" changes everything about the tone, and it fits a model that's told exactly what it may say.
- Labels cost little and build trust: estimated scenes are marked, dropped sentences are logged, mock output is flagged.
- Moving heavy work off the browser (bake once, read small files) made the experience feel instant on an iPad.

## What's next

- **A pilot** at one memory care facility: the same visit reviewed with Re:Collection versus a written diary, recall measured at 2 weeks and 3 months (the SenseCam protocol). We'll track details recalled per memory, on their own versus after a hint.
- Accounts, consent records and encryption at rest, replacing today's private links.
- Gaussian splat rooms for every phone capture (in progress), and more languages for the guide.

---

## Built with (25 tags)

Type each one and press Enter. Pick Devpost's suggestion when it offers one.

claude, anthropic, convex, cloudflare-r2, cartesia, moss, swift, swiftui, arkit, lidar, metal, typescript, react, three.js, react-three-fiber, webgl, vite, bun, python, pytorch, depth-anything-3, gaussian-splatting, mediapipe, webrtc, node.js

---

## "Try it out" links

- **Live demo:** https://shividoge.github.io/braindance-site/ (all 9 rooms: 6 iPhone LiDAR scans and 3 rebuilt from old videos, plus the Memory Palace)
- **Demo video:** (the YouTube link, once uploaded)
- **Code:** https://github.com/shividoge/braindance (make the repo public first; see "Before you submit")

---

## Image gallery

Upload from `~/Downloads/re-collection-devpost-gallery/` in this order (all 3:2, under 5 MB):

1. `01-cover.jpg`: the cover (use as the thumbnail)
2. `02-the-memory-palace.jpg`
3. `03-the-story.jpg`
4. `04-capture-with-lidar.jpg`
5. `05-old-video-to-3d-room.jpg`
6. `06-claude-finds-whats-true.jpg`
7. `07-every-moment-has-a-place.jpg`
8. `08-caregiver-museum.jpg`
9. `09-architecture.jpg`
10. `10-sponsors.jpg`
11. `11-research.jpg`
12. `12-end-card.jpg`

---

## Feedback on the technology we used

**Claude (Anthropic: Opus 5.5, Sonnet 5.5 and Claude Code).** Claude is the heart of Re:Collection, and it made a sensitive project possible.
- **Structured outputs** returned every fact, reply and score in a shape our code could trust. That let us build real safety guarantees for people living with dementia, and we're proud of that.
- Opus picked out small, true, memorable details from a family visit with a care that genuinely moved us when we first read them. Sonnet was quick and gentle enough for live conversation.
- Claude Code let our three-person team build an iPhone app, a backend and a 3D website in parallel over one weekend.

Thank you, Anthropic, for building something that feels made for public benefit work like this.

**Convex.** Convex was a joy. We moved our whole backend onto it in the middle of the hackathon, and it made everything simpler:
- Reactive queries turned our live family visit (relatives joining a loved one's Memory Palace from anywhere) into a few clean functions instead of a pile of polling code.
- Actions kept every API key safely on the server.

It felt like it was designed for exactly the kind of real-time, family-together experience we wanted.

**Cartesia (Sonic 3.6 and Ink-2).** Cartesia gave our guide its voice, and it's the part people react to most.
- The **"Patient" turn profile** is a beautiful touch. People with dementia often pause to find their words, and Ink-2 waits for them instead of cutting them off.
- Keyterm prompting meant family names were heard correctly, and Sonic's warm voice at a slightly slower speed sounds calm and kind.
- Barge-in made the guide feel like a real, attentive companion.

Thank you for thinking about every kind of speaker.

**Moss.** Moss gave our guide a memory, and that changed what the project could be.
- Filtering to "the memory in front of her" was one elegant line, and the index stayed fast enough for live voice.
- Our favourite moment: adding what the patient says back into Moss, so later the guide can say "You told me this kitchen looks like your mother's." That felt like magic, and Moss made it easy.

**Cloudflare (R2 and Tunnel).** Cloudflare kept us moving all weekend.
- R2's presigned multipart uploads made our iPhone's resumable, background uploads straightforward.
- Tunnels gave us a secure link in seconds, which the iPad needs for its camera and motion sensors, so we could demo on real devices even on busy venue Wi-Fi.

**Depth Anything 3 (ByteDance Seed).** Truly impressive. Rooms rebuilt from ordinary home videos came out within a few centimetres of real iPhone LiDAR. That means a family's old videos, made long before anyone had a 3D scanner, can become places to walk back into. Thank you for releasing it openly.

**Apple ARKit and LiDAR.** ARKit's single continuous session gave us one shared coordinate system for the room and the visit, which is why the people line up perfectly with the room when they replay in 3D. LiDAR on an iPhone still feels like a superpower.

**GitHub (Pages and Releases).** GitHub Pages gave us a free, always-on public demo that stays up even with our laptops closed, and Releases made sharing big scan files across the team painless.

Thank you to every sponsor and organizer at Cal Hacks 13.0. The tools, the credits and the people at the booths made a project like this possible in one weekend.

---

## Did you implement a generative AI model or API?

**Yes. We used several generative AI models, each for a specific job.**

**Claude Opus 5.5 (Anthropic API): finding the details of a visit.** After a family films a visit, Claude reads up to 30 keyframes and the on-device transcript, and proposes short, true details ("Priya brought a mango cake"). Each one is linked to the exact frame or quote that proves it. We used structured outputs (a JSON schema), and code keeps a citation only if it points to a keyframe Claude was actually sent, or quotes words really in the transcript. **Why:** choosing what's memorable and checkable is a judgement call, and Claude is excellent at it.

**Claude Sonnet 5.5: the gentle companion and the voice guide's words.**
- When the person talks with the guide, Sonnet writes each reply as a list of sentences, and every sentence must cite the approved details it uses.
- Our grounding check (in code, not a prompt) removes any sentence that cites nothing approved or touches something the family marked "don't bring this up", and logs why.
- Claude also writes each memory's spoken intro and story when the caregiver saves the Memory Palace.

**Why:** someone with dementia can't push back on a made-up detail, so the model does the warm, natural talking, and code guarantees it never invents anything.

**Claude Opus 5.5: measuring recall.** After a session, Claude points to which of the person's own words carry each detail. Code then decides "remembered on their own" versus "after a hint" from what the guide had already said. **Why:** it gives families an honest measure of what stayed, without asking a model to guess.

**Cartesia Sonic 3.6 (text-to-speech) and Ink-2 (realtime speech-to-text): the guide's voice and ears.** A warm voice, slowed to 0.9× for clarity, reads the guide's words. Ink-2 listens hands-free with its "Patient" turn profile, so people who pause to find words aren't cut off. **Why:** a calm, natural voice matters enormously for people with dementia, and pressing buttons is hard for many of them.

**Depth Anything 3 (ByteDance Seed): turning old home videos into 3D rooms.** It estimates depth and camera motion across every frame of an ordinary video. We fuse those into a room and label the result "estimated from a video, not measured". **Why:** the moments families most want back were filmed long before anyone had a 3D scanner.

**Gaussian splatting (gsplat):** we train a small 3D scene on each video's frames, so old rooms look closer to the original footage.

**Moss: memory for the guide.** This is retrieval, not generation, but it feeds the generative models. Moss searches only the memory on screen and passes just what it finds to Claude. It also stores what the person shares, so the guide can bring it back later.

**Our rule throughout:** generative AI does the judgement and the warmth; code does the guarantees. The family approves every detail, and nothing unapproved is ever said.

---

## Before you submit (for us, not for Devpost)

- *Make the GitHub repo public, or judges get a 404 on the code link. The old API key in its history is already deleted and doesn't work.*
- *Add the demo video's YouTube link once it's uploaded.*
- *The live demo is the read-only public build of the current site: all 9 rooms, the Memory Palace scroll walk and stepping into any room. The voice guide and live family visit need the live backend, so they're not on the public copy; show them in the demo video.*
- *The video's sponsor slide and end card list Meta, Microsoft and GoDaddy Registry. Make sure each is something we entered or used; if not, fix the slide or leave image 10 out.*
- *If the live family visit wasn't tested on two devices, cut its WebRTC sentence from "How we built it".*
- *Opt in to every track and sponsor prize on the form (Anthropic, Convex, Cartesia, Moss, Cal Hacks tracks, MLH), and fill in the team members.*
