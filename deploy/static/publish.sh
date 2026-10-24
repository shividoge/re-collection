#!/usr/bin/env bash
# Publishes the built static site to a GitHub repo that serves it with GitHub
# Pages. Without --publish it only shows what WOULD go public and sends nothing.
#
#   ./deploy/static/publish.sh <owner>/<repo>             preview only
#   ./deploy/static/publish.sh <owner>/<repo> --publish   push it (public!)
set -euo pipefail

REPO="${1:-}"
MODE="${2:-}"
if [ -z "$REPO" ]; then
  echo "Usage: ./deploy/static/publish.sh <owner>/<repo> [--publish]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITE="${SITE:-$ROOT/.static-site}"
if [ ! -f "$SITE/index.html" ]; then
  echo "No built site in $SITE. Run ./deploy/static/build.sh first." >&2
  exit 1
fi

echo "This would put the following on the public internet at https://github.com/$REPO"
echo "(and on its GitHub Pages site):"
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1] + "/data/captures.json", "utf8"));
if (!d.length) console.log("  (no captures: the site would be empty)");
for (const c of d) console.log("  - " + (c.title || "(untitled)") + "  [" + c.id + "], " + c.facts + " approved facts");
' "$SITE"
du -sh "$SITE" | awk '{print "  total size: " $1}'

if [ "$MODE" != "--publish" ]; then
  echo
  echo "Preview only. Nothing was sent. Add --publish when everyone filmed has agreed and you're ready."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh repo clone "$REPO" "$WORK/repo" -- --quiet
cd "$WORK/repo"
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$SITE"/. .
git add -A
if git diff --cached --quiet; then
  echo "Nothing changed since the last publish."
  exit 0
fi
git commit -q -m "Update the public site"
git push -q
echo "Published. GitHub Pages can take a minute or two to update."
