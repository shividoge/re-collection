# AGENTS.md

Instructions for any coding agent (Codex, Claude Code, others) working in this repo.

**Read `CLAUDE.md` first.** It is the project plan, the rules (§0, §13), the current Status and the handoff protocol. Everything there applies to you. Then read `TASKS.md` for your person's slice.

## New checkout or worktree: environment files

`guide/.env` is gitignored, so a fresh worktree doesn't have it. Without it the guide starts, but every Claude step (fact extraction, narration, scoring) fails with "No ANTHROPIC_API_KEY in guide/.env".

1. Check whether `guide/.env` exists and has a non-empty `ANTHROPIC_API_KEY`. Don't print the value; check with something like `grep -c '^ANTHROPIC_API_KEY=.' guide/.env`.
2. If it's missing, run the machine's setup script if there is one:
   - **IBS27's Fedora machine:** `bash ~/.config/braindance/setup-worktree.sh "$PWD"`. It creates `guide/.env` from `guide/.env.example` and fills in the key from `~/.config/braindance/secrets.env`. The values already there (`PORT`, `DATA_DIR`, ...) are kept. T3 Code runs it automatically when it creates a worktree for this project.
   - **Shivin's MacBook:** the key lives in `guide/.env` in `~/Developer/braindance` (see `CLAUDE.md` → "Local machine notes"). Copy that file into the new worktree's `guide/`.
3. Otherwise, copy `guide/.env.example` to `guide/.env` and ask the person for the key. Never invent one, and never use `MOCK_CLAUDE=1` for anything shown as real.

Rules for secrets:
- Never commit, print or paste `guide/.env` or any key. Not in commits, PRs, logs or chat.
- Keys go only in `guide/.env`, never in `web/`, `ios/` or `guide/.env.example`.
- Running two guides on one machine: give each its own `PORT` (and usually its own `DATA_DIR`) in that worktree's `guide/.env`.

## The ASUS GX10 (GPU box for long videos)

- **Access:** `ssh asus@100.104.38.89` over Tailscale (host `gx10-f548`). Password login; ask the person for the password, and never write it into the repo. From scripts, pass it through the environment (`SSHPASS=… sshpass -e ssh …`), not on the command line.
- **What it's for:** Depth Anything 3 fits 240 frames in one pass there (128 GB unified memory) against about 60–82 on the Fedora RTX 5060 Ti. Videos longer than about 6–8 s must run there: on the 16 GB card they're split into chunks whose joins drift (a 21 s phone video drifted 68 cm and 15° against its ARKit poses, which doubles walls and doors). See `workers/gpu/README.md` → "Routing".
- **Layout:** `~/braindance/video2capture/.venv` (Python 3.12, torch cu130, gsplat, fused-ssim), DA3 models in `~/braindance/video2capture/models`, system ffmpeg. It isn't a git checkout: copy the code you need with `rsync` (e.g. `tools/video2capture/` to `~/braindance/dense/video2capture/`, symlinking `models` and `da3` from `~/braindance/video2capture/`).
- **GPU worker:** `workers/gpu/README.md` (systemd unit and env). If the captures page shows only a `fedora-…` worker online, the GX10 worker isn't running.
