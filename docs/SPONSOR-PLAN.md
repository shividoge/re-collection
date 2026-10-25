# Sponsor plan: which prizes to aim at, and what each needs

Prizes are from the Cal Hacks 13.0 Devpost list. **Rule: only claim a sponsor whose product we really use, or whose theme we really are.** Judges can tell a bolted-on logo from a real one, and our own "nothing fake" rule applies to the pitch too. Everything below is a plan, not a promise. The rules were checked on Sat Oct 24 (see "Checked" and the "Submission checklist" at the end); entries marked *Checked:* were updated from those facts.

## Tier 1: we already fit, so it is mostly opting in and telling the story

| Prize | Why Braindance fits | What to do |
|---|---|---|
| **Anthropic, Claude for Public Benefit** (our primary) | Claude does the judgement (facts, narration, scoring) and code enforces the safety rules; families of people with Alzheimer's. | Opt in on Devpost. Lead the pitch with the grounding check and the family-approval gate. *Checked:* the four criteria are a named community, a real problem, it works, and thoughtful use of Claude, including where it could go wrong for the people using it (see "Checked" below). Say who we talked to and name the failure modes we guard against. |
| **Cal Hacks First, Second, Third overall** | The whole loop works on real hardware with real data. | Make the 3-minute demo the full loop: phone, family approval, revisit, dashboard. |
| **Best People-First Social Impact** | A named community with a clear problem. | Say the hook and the pilot plan (the site's research section already has it). |
| **Most Technically Complex Hack** (corrected name) | LiDAR depth replay of people in 3D, a code-enforced grounding check, a static public export, a custom capture format. | Show the walk-in viewer and one held-back sentence from the grounding log. |
| **Most Creative Hack** (corrected name) | "Walk back into a visit" is not a normal Claude app. | Demo the 3D viewer, not slides. |
| **Hacker's Choice** | Votes. | Have a live thing people can touch: the public site on a tablet. |
| **Microsoft, Built for the Real World** (and the Customer Impact Award) | Real-world impact on a real problem. | *Checked:* no Microsoft product is required in the public text. The track asks for "a production-minded AI agent" in finance, productivity, healthcare or another high-impact domain, judged on customer understanding, measurable usefulness, path from prototype to production, responsible design and end-to-end functionality. Pitch the companion as the agent and the recall chart as the measure; add one line on the path to production (the pilot plan). |
| **Meta, Bringing People Closer Together with AI** | Families reconnecting with a parent through a shared memory. | Frame the pitch around closeness, not 3D. Round 2 is at Meta's Menlo Park campus. *Checked:* judged on how meaningfully it strengthens human connection, how essential and well integrated the AI is, originality, and the working demo. |
| **MLH, Commit Fellowship** | A real problem and a working prototype with a team. | Opt in on Devpost, then submit MLH's **supplemental form**: https://mlh.link/commit-fellowship-form (it asks for the Devpost link, so submit Devpost first). Costs nothing. |

## Tier 2: cheap, real integrations worth doing if there is time

Order by value for the effort. Each is real work, not a sticker.

1. **Vultr (MLH Best Use of Vultr).** Host the guide's read-only mirror on a Vultr server instead of GitHub Pages. We already wrote `deploy/` for it (`deploy/README.md`) and the account has the MLH $100 credit staged. It stopped at "verify your account email before deploying". About 20 minutes once the email is verified. *Checked:* the $100 comes from an MLH promo code (register at mlh.link/vultr-discover, then enter it under Billing → Gift Code). MLH publishes no scored criteria beyond the prize description. Keep the GitHub Pages copy as a backup.
2. **Cartesia (Best Use of Cartesia).** Replace the browser's built-in voice in the Revisit screen with a Cartesia voice. A calm, natural voice matters a lot for people with dementia, so the story is honest. About 1 to 2 hours in `web/src/speech.ts` and the visit dock. Needs an API key from Cartesia; keep it in `guide/.env` and proxy through the guide, never in the web app. *Checked:* credit code `CARTESIACALHACKS` (first-time orders), key from play.cartesia.ai/keys. Cartesia also wants a two-minute demo-first presentation and a README section listing the Cartesia features used and known limitations; voice must be core to the product, which it is for the patient.
3. **Tiger Data (MLH).** Recall over time is genuinely time-series data. Store session scores in Tiger Data and read the dashboard from it. About 1 to 2 hours. Only do it if it stays simple: today sessions are JSON files on disk and that works. *Checked:* new sign-ups get $1,000 in credits for 30 days (mlh.link/tigerdata); the winner is "the most innovative, impactful, and performance-driven use of Tiger Data".
4. **GoDaddy Registry (MLH Best Domain Name).** A good domain for the public site (the site would also look more serious on a judge's phone). Needs a purchase, so it is Shivin's call. Point it at GitHub Pages with a CNAME.
5. **Best Hardware Hack.** A weak fit: we use the phone's LiDAR rather than building hardware. Only enter it if the pitch is about the custom sensing pipeline, and don't expect to win it.

## Tier 3: skip

Gemini API, Solana, Snowflake, Hyphenate, Visa, Fetch.ai, Factory, Armadin, Convex, Apify, Creao, Bitdeer, Elastic, Capital One, CRS, SpaceXSI, Figma, Coinbase, Notability, Planet-First, Solo, Beginner. We don't use them, and a forced integration costs time and credibility. (Figma only counts if the design was made in Figma, and ours wasn't.)

## Do this, in order

1. **Tonight:** the demo capture and real sessions. Every prize above depends on a real, working loop.
2. **Free opt-ins** when submitting on Devpost: Anthropic, Cal Hacks tracks, MLH Commit Fellowship (plus the supplemental form), Microsoft, Meta. Follow the "Submission checklist" at the end.
3. **Vultr**, if the email verifies: deploy, put the Vultr URL in the Devpost, and say what runs there.
4. **Cartesia**, then **Tiger Data** only if time allows.
5. **Devpost write-up:** one short paragraph per sponsor saying exactly what we used and where (file names help). Keep it factual.

## Checked (Sat Oct 24 2026, ~16:40 PT)

All sources are for Cal Hacks 13.0 (October 2026) unless marked otherwise. Main sources:

- **Devpost:** https://cal-hacks-13-0.devpost.com/ (overview: requirements, prize list, judging criteria), `/rules` (only the code of conduct), `/details/dates` (schedule).
- **Hive, the official event site:** https://hive.hackberkeley.org (prizes, FAQ, schedule, starter packs). Its data comes from `/api/live/prizes`, `/api/live/faq` and `/api/live/schedule`. The prize text below was last updated 2026-10-24 22:13 UTC.
- **MLH:** https://www.mlh.com/events/prizes, https://www.mlh.com/partners/vultr, https://mlh.com/partners/tigerdata
- **Cartesia:** https://docs.cartesia.ai/calhacks and its starter pack (Google Doc linked from Hive → Resources).

Note: the venue is the **Palace of Fine Arts, San Francisco** (3601 Lyon St), not the Berkeley campus.

### 1. Limits: more than one prize, exclusions, opt-in cap

- **Not found publicly.** The Devpost rules tab holds only the code of conduct, and neither Devpost nor the Hive FAQ says whether a team can win more than one prize, whether any prizes exclude each other, or how many prizes a project can opt into.
- Every Devpost prize lists "1 winner" except Hyphenate (5), Fetch.ai (3), Apify (5), Bitdeer (2), Elastic (2), CRS (2), Coinbase (2), Spacetime (3) and Atlassian (4). Microsoft's two awards are a single Devpost entry: "Built for the Real World (1st), Customer Impact Award (2nd)".
- **Ask in Slack #ask-directors or at the concierge desk:** "Can one project win a Cal Hacks track (e.g. People-First) and a sponsor prize (e.g. Anthropic)? Is there a maximum number of prizes we can opt into on Devpost?"
- Practical point: if the Devpost form caps opt-ins, the form will enforce it. Pick in the order of the checklist below.

### 2. Microsoft "Built for the Real World"

- **No Microsoft product or Azure requirement appears in the public text.** Hive: "Track Challenge: Build a production-minded AI agent that solves a meaningful problem in finance, productivity, healthcare, or another high-impact domain."
- Judging criteria (Hive): customer understanding, measurable usefulness, path from prototype to production, responsible design, end-to-end functionality. The Customer Impact Award (2nd) uses the same criteria.
- Prizes: 1st, a Surface laptop each, a remote talk at a Microsoft Delta/Frontier Co. FDE tech talk and 1:1 mentorship with senior FDEs. 2nd, the talk and mentorship.
- What it means for us: the word "agent" matters. Describe the companion (it decides what to say, stays grounded, detects distress and ends the session) as the agent.
- **To confirm at the Microsoft booth:** "Does Built for the Real World require any Microsoft product (Azure, Copilot, Foundry), or is any stack OK?"

### 3. Opt-ins: checkboxes, questions and external forms

| Prize | What's needed beyond the Devpost submission | Source |
|---|---|---|
| All prizes | Select each prize on the Devpost submission form. Organizers list no other forms for Cal Hacks tracks, Anthropic, Microsoft or Meta. | Devpost overview |
| **MLH Commit Fellowship** | Opt in on Devpost **and** fill in the supplemental form: **https://mlh.link/commit-fellowship-form** (Typeform "Commit Fellowship: Prize Category Submission"). It asks for: who is filling it in (name, email), the other teammates, which hackathon, **the Devpost link**, **the GitHub repo link**, the project name, how the team came together, why we built this and whether the idea came before the weekend, how the problem is solved today and what's wrong with that, the very next step after the hackathon, and (optional) existing traction. The winner is picked after the event and told by email. | Devpost, Hive, MLH prizes page |
| **Cartesia** | No extra form. It asks for a working demo, a **2-minute demo-first presentation**, a **README** (setup, Cartesia features used, known limitations), and source access for judges. | docs.cartesia.ai/calhacks |
| **Meta** | No extra form. Going on to Round 2 "is subject to eligibility verification and compliance with Meta's Round 2 Official Rules". Those rules are **not found publicly**; ask the Meta booth for them before the closing ceremony. | Devpost, Hive |
| Atlassian, SpaceXSI (not ours) | Atlassian wants the track named in the description; SpaceXSI requires Cursor and a raffle opt-in. Listed only so nobody ticks them by mistake. | Devpost, Hive |

- **Required Devpost content** (Devpost overview + Hive FAQ): team name, **table number** ("team location"), a **2–3 sentence elevator pitch**, **an image of the project**, the **GitHub repository** ("for any code to be considered"), and a **video demo** ("for sponsors evaluating asynchronously", under the Functionality criterion). The exact form fields are only visible once logged in at https://devpost.com/submit-to/29871-cal-hacks-13-0/manage/submissions.
- **MLH "Best Use of Gen AI"** (Anthropic API counts) and ElevenLabs appear on Hive and MLH's generic prize page, but **not on the Cal Hacks 13.0 Devpost prize list**, so there is no checkbox for them. Ask the MLH coach: "Is Best Use of Gen AI offered at Cal Hacks 13.0? If so, how do we enter?"

### 4. Cartesia, Vultr, Tiger Data: criteria and credits

| | Judging criteria | Credits / keys |
|---|---|---|
| **Cartesia** (Meta glasses for each member, up to 4; Devpost lists $1,516) | 25% each: problem and originality; use of Cartesia (voice central, clear, responsive, natural); execution (main flow works, edge cases handled); impact and responsibility (accessibility, privacy, responsible use). "We favor a strong working prototype over a large unfinished idea." | Sign up at play.cartesia.ai, key at play.cartesia.ai/keys. Credit code **`CARTESIACALHACKS`** for first-time orders (starter pack). Help in Slack: https://cal-hacks-13-0.slack.com/archives/C0C72S4D3LL. The starter pack's booth location is still blank ("[FILL: …]"). |
| **Vultr** (MLH; M5Stack Tab5) | No scored criteria are published. The description rewards "high-performance projects" that use Vultr's cloud compute or GPUs. | **$100**: register at mlh.link/vultr-discover for the MLH promo code (students: school name as Company, "Student" as Job Title), sign up at mlh.link/vultr-signup, enter the code under Billing → Gift Code. One registration per person. |
| **Tiger Data** (MLH; Stream Deck Mini) | "The team that demonstrates the most innovative, impactful, and performance-driven use of Tiger Data." | **$1,000** in credits for new sign-ups, valid 30 days (mlh.link/tigerdata). |

### 5. The Anthropic track

- **Exact name (Devpost):** "[Anthropic] Claude for Public Benefit". 1 winner; prize "$5000 in Claude credits and 1 year of Claude Max 20x + Office Hours" (Devpost lists it as $4,998).
- **Judging criteria (Hive; Devpost has no description):**
  1. **A named community.** "'Students' is too broad. 'Transfer students at Berkeley trying to find housing' is the right register."
  2. **A real problem.** "You have lived it, or you talked to someone who has."
  3. **It works.** "One thing done well and usable on Monday beats a broad demo."
  4. **Thoughtful use of Claude.** "Claude does something that matters to the solution, and you know where it could go wrong for the people using it."
- **No requirement was found** for a specific model, a minimum amount of API use, or a set way to describe Claude's role. Criterion 4 means the write-up should say what Claude does (fact extraction, narration, companion, scoring) **and** the failure modes we guard against (made-up details → code-enforced grounding; upsetting topics → "don't bring this up"; distress → the session ends and the family is alerted).
- Criterion 2 means saying, in the pitch, who we spoke to or what we lived through. Only say what's true.

### Other rules that could disqualify us

- **Be at the venue by Sun Oct 25, 08:00 PT.** You must have been accepted and **checked in as a hacker** to submit (Devpost). Check-in is at the information desk until Sunday (Hive FAQ). **Make sure all three of us are checked in.**
- **Deadline: 09:00 PT, hard.** Submit "with your teammates", so every member must be added to the Devpost project.
- **All work during the event.** Hacking ran Fri Oct 23 18:00 PT to Sun 09:00 PT (Hive schedule). Hive FAQ: no project "previously worked on or submitted to another hackathon"; "strict measures in place to detect cheating or prior work", and violations disqualify you from prizes. Our repo starts on Oct 24, so we're fine. In the write-up, keep calling Rumi and Déjà View references only, with no code copied.
- **Team size:** Devpost says 2–4 members (Hive FAQ says 1–4). Three is fine. Ages 18+, college students only.
- **GitHub repo:** required "for any code to be considered". **`shividoge/braindance` is private today**, so judges and the MLH form reviewers can't open the link. Shivin should decide: make it public, or publish a public copy. Before doing either, scan the history for secrets (the old Anthropic key in `guide/.env.example` is already revoked, but check for anything else).
- **Pitch:** 3 minutes plus 2 minutes of questions; judges have 5 minutes per table. A live or pre-recorded demo is required. No video length limit is published. Cartesia wants its own 2-minute demo-first version.
- **Sunday schedule (Hive, PT):** 08:00 at the venue · **09:00 submissions close** · **10:30–12:30 judging at our table** (Main Hacking Space & Mezzanine) · 12:30–14:00 lunch · 13:00–14:00 project gallery and mixer · **14:00–16:00 closing ceremony** (Devpost: winners announced 16:00) · 16:00 winners' photos (Hyphenate Lounge).
- **Main judging criteria (Devpost):** Application, Intentionality, Functionality (including the Devpost video), Creativity, Technical Complexity.

## Submission checklist (Shivin, in order)

1. All three teammates are checked in at the venue by 08:00 and added to the Devpost project.
2. Repo visibility decided: public repo or a public copy, with the history checked for secrets.
3. Devpost fields: project name, team name, **table number**, 2–3 sentence elevator pitch, full description, at least one **project image**, the **GitHub link**, the **demo video** link, and "Built with".
4. Description: one short, factual paragraph per sponsor we opt into, saying what we used and where (Anthropic: the four Claude roles plus the failure modes and guards).
5. Prize opt-ins on Devpost, in priority order in case there's a cap:
   1. [Anthropic] Claude for Public Benefit
   2. Cal Hacks First Overall, Second Overall, Third Overall (each is its own Devpost prize)
   3. Cal Hacks Best People-First Social Impact Hack
   4. [Meta] Bringing People Closer Together with AI
   5. Cal Hacks Most Technically Complex Hack
   6. [Microsoft] Built for the Real World / Customer Impact Award
   7. Cal Hacks Most Creative Hack
   8. Cal Hacks Hacker's Choice
   9. [MLH] Commit Fellowship Prize Category
   10. Only if really integrated: [Cartesia] Best Use of Cartesia, [MLH] Best Use of Vultr, [MLH] Best Use of Tiger Data, [MLH] Best Domain Name from GoDaddy Registry
6. Submit before 09:00 (aim for 08:30).
7. **MLH Commit Fellowship form**, right after submitting (it needs the Devpost link): https://mlh.link/commit-fellowship-form
8. If Cartesia is in: README section (setup, Cartesia features used, known limitations) and a 2-minute demo-first pitch ready.
9. Be at the table 10:30–12:30 with the tablet and phone charged; closing ceremony at 14:00.

## One honest line for the pitch

"Everything you see is a real scan, and everything Claude says is checked by code against what the family approved." That one sentence covers most of these judges.
