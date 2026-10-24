#!/usr/bin/env bash
# Push the site and the captures you marked public to the Vultr server.
#
#   ./deploy/deploy.sh root@<server ip>            deploy
#   ./deploy/deploy.sh root@<server ip> --dry-run  build and stage, send nothing
#
# Only captures marked public (npm --prefix guide run publish -- <id>) are
# copied, with their finished sessions. Unpublishing a capture and deploying
# again removes it from the server. Nothing from guide/.env is ever sent.
set -euo pipefail

TARGET="${1:-}"
DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="--dry-run"
if [ -z "$TARGET" ]; then
  echo "Usage: ./deploy/deploy.sh root@<server ip> [--dry-run]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/braindance
STAGE="$(mktemp -d)/stage"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

echo "==> Building the website"
[ -d "$ROOT/web/node_modules" ] || npm --prefix "$ROOT/web" ci --silent
npm --prefix "$ROOT/web" run build --silent

echo "==> Staging the public captures"
(cd "$ROOT/guide" && node scripts/stage-public.mjs "$STAGE")
if [ -z "$(ls -A "$STAGE/captures" 2>/dev/null)" ]; then
  echo "Nothing is marked public, so the site would be empty. Mark one first:" >&2
  echo "  npm --prefix guide run publish -- <capture id>" >&2
  [ -z "$DRY" ] && exit 1
fi

SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
RS=(rsync -az --delete $DRY -e "$SSH")

echo "==> Sending code and website"
"${RS[@]}" --exclude node_modules --exclude data --exclude .env --exclude test \
  "$ROOT/guide/package.json" "$ROOT/guide/package-lock.json" "$ROOT/guide/src" "$ROOT/guide/scripts" \
  "$TARGET:$APP/guide/"
"${RS[@]}" "$ROOT/web/dist/" "$TARGET:$APP/web/dist/"

echo "==> Sending the public captures"
"${RS[@]}" --exclude .braindance-stage "$STAGE/" "$TARGET:$APP/guide/data/"

if [ -n "$DRY" ]; then
  echo "Dry run: nothing was sent or restarted."
  exit 0
fi

echo "==> Installing dependencies and restarting"
$SSH "$TARGET" "chown -R braindance:braindance $APP && cd $APP/guide && runuser -u braindance -- npm ci --omit=dev --silent && systemctl restart braindance"

echo "==> Checking the site"
HOST="$($SSH "$TARGET" "awk 'NR==1{print \$1}' /etc/caddy/Caddyfile")"
for i in 1 2 3 4 5 6; do
  if curl -fsS "https://$HOST/health" >/dev/null 2>&1; then
    echo "Live: https://$HOST"
    curl -fsS "https://$HOST/public/captures" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length+" public capture(s) online"))'
    exit 0
  fi
  sleep 3
done
echo "Deployed, but https://$HOST didn't answer yet. Check: ssh $TARGET journalctl -u braindance -n 30" >&2
exit 1
