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
