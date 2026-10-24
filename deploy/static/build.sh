#!/usr/bin/env bash
# Builds the static public site (no server needed) into a folder, ready to
# publish. Nothing is uploaded; it only reads your captures marked public.
#
#   ./deploy/static/build.sh [output folder]     default: .static-site/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/.static-site}"

echo "==> Exporting the captures marked public"
rm -rf "$OUT"
mkdir -p "$OUT"
(cd "$ROOT/guide" && node scripts/export-static.mjs "$OUT")

echo "==> Building the website (static mode)"
[ -d "$ROOT/web/node_modules" ] || npm --prefix "$ROOT/web" ci --silent
# A separate output folder, so web/dist (served by the live guide) is untouched.
VITE_STATIC=1 npm --prefix "$ROOT/web" run build --silent -- --outDir "$OUT" --emptyOutDir false

touch "$OUT/.nojekyll"   # GitHub Pages: serve every file as is
echo
echo "Site is in: $OUT"
du -sh "$OUT" | awk '{print "Total size: " $1}'
echo "Look at it locally first:  node deploy/static/serve.mjs \"$OUT\"   then open http://127.0.0.1:8790"
