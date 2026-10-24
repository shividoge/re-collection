# Sponsor plan: which prizes to aim at, and what each needs

Prizes are from the Cal Hacks 13.0 Devpost list. **Rule: only claim a sponsor whose product we really use, or whose theme we really are.** Judges can tell a bolted-on logo from a real one, and our own "nothing fake" rule applies to the pitch too. Everything below is a plan, not a promise; the first thing to check is the list at the end.

## Tier 1: we already fit, so it is mostly opting in and telling the story

| Prize | Why Braindance fits | What to do |
|---|---|---|
| **Anthropic, Claude for Public Benefit** (our primary) | Claude does the judgement (facts, narration, scoring) and code enforces the safety rules; families of people with Alzheimer's. | Opt in on Devpost. Lead the pitch with the grounding check and the family-approval gate. |
| **Cal Hacks First, Second, Third overall** | The whole loop works on real hardware with real data. | Make the 3-minute demo the full loop: phone, family approval, revisit, dashboard. |
| **Best People-First Social Impact** | A named community with a clear problem. | Say the hook and the pilot plan (the site's research section already has it). |
| **Most Technically Advanced Hack** | LiDAR depth replay of people in 3D, a code-enforced grounding check, a static public export, a custom capture format. | Show the walk-in viewer and one held-back sentence from the grounding log. |
| **Most Creative Project** | "Walk back into a visit" is not a normal Claude app. | Demo the 3D viewer, not slides. |
| **Hacker's Choice** | Votes. | Have a live thing people can touch: the public site on a tablet. |
| **Microsoft, Built for the Real World** (and the Customer Impact Award) | Real-world impact on a real problem. | Check whether it requires Microsoft technology (see the list below). |
| **Meta, Bringing People Closer Together with AI** | Families reconnecting with a parent through a shared memory. | Frame the pitch around closeness, not 3D. Round 2 is at Meta's Menlo Park campus. |
| **MLH, Commit Fellowship** | A real problem and a working prototype with a team. | Opt in on Devpost, then submit MLH's **supplemental form**. Costs nothing. |

## Tier 2: cheap, real integrations worth doing if there is time

Order by value for the effort. Each is real work, not a sticker.

1. **Vultr (MLH Best Use of Vultr).** Host the guide's read-only mirror on a Vultr server instead of GitHub Pages. We already wrote `deploy/` for it (`deploy/README.md`) and the account has the MLH $100 credit staged. It stopped at "verify your account email before deploying". About 20 minutes once the email is verified. Keep the GitHub Pages copy as a backup.
2. **Cartesia (Best Use of Cartesia).** Replace the browser's built-in voice in the Revisit screen with a Cartesia voice. A calm, natural voice matters a lot for people with dementia, so the story is honest. About 1 to 2 hours in `web/src/speech.ts` and the visit dock. Needs an API key from Cartesia; keep it in `guide/.env` and proxy through the guide, never in the web app.
3. **Tiger Data (MLH).** Recall over time is genuinely time-series data. Store session scores in Tiger Data and read the dashboard from it. About 1 to 2 hours. Only do it if it stays simple: today sessions are JSON files on disk and that works.
4. **GoDaddy Registry (MLH Best Domain Name).** A good domain for the public site (the site would also look more serious on a judge's phone). Needs a purchase, so it is Shivin's call. Point it at GitHub Pages with a CNAME.
5. **Best Hardware Hack.** A weak fit: we use the phone's LiDAR rather than building hardware. Only enter it if the pitch is about the custom sensing pipeline, and don't expect to win it.

## Tier 3: skip

Gemini API, Solana, Snowflake, Hyphenate, Visa, Fetch.ai, Factory, Armadin, Convex, Apify, Creao, Bitdeer, Elastic, Capital One, CRS, SpaceXSI, Figma, Coinbase, Notability, Planet-First, Solo, Beginner. We don't use them, and a forced integration costs time and credibility. (Figma only counts if the design was made in Figma, and ours wasn't.)

## Do this, in order

1. **Tonight:** the demo capture and real sessions. Every prize above depends on a real, working loop.
2. **Free opt-ins** when submitting on Devpost: Anthropic, Cal Hacks tracks, MLH Commit Fellowship (plus the supplemental form), Microsoft, Meta.
3. **Vultr**, if the email verifies: deploy, put the Vultr URL in the Devpost, and say what runs there.
4. **Cartesia**, then **Tiger Data** only if time allows.
5. **Devpost write-up:** one short paragraph per sponsor saying exactly what we used and where (file names help). Keep it factual.

## Check these before spending any time

- **Limits:** whether a team can win more than one prize, and whether any main-track prizes exclude each other.
- **Requirements:** Microsoft Built for the Real World: does it require Azure or another Microsoft product?
- **Opt-in:** which sponsors need a separate checkbox or form on Devpost. Missing it can disqualify us.
- **Cartesia, Vultr and Tiger Data:** their exact judging criteria, and whether free credits or keys are handed out at their booths.
- **The Anthropic track:** the exact name and rules, since it was not in the list we looked at.

## One honest line for the pitch

"Everything you see is a real scan, and everything Claude says is checked by code against what the family approved." That one sentence covers most of these judges.
