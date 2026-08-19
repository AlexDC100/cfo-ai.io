#!/usr/bin/env bash
# deploy.sh — one-command production deploy.
#
# Replaces the manual sequence we've been running:
#   1) rsync each changed file by name
#   2) ssh in, docker compose build, docker compose up -d
#   3) curl health and hope it's green
#
# §14 (CLAUDE.md) safety:
#   · Tree-mirror sync with --delete is fine for src/ and scandi-desk-main/src/
#     since basenames in those trees match destination. The per-file rsync
#     footgun only applies when source filenames differ from destination
#     basenames — not the case here.
#   · `.env`, `files/`, `data/`, `node_modules/`, `dist/` are excluded so we
#     never overwrite host secrets or sync junk.
#   · ALWAYS runs --dry-run first and shows the diff for human confirmation
#     (skip with --yes for CI). Catches the rare case where someone
#     deleted a tracked file by accident.
#
# Usage:
#   ./scripts/deploy.sh              # interactive — shows dry-run, asks to proceed
#   ./scripts/deploy.sh --yes        # non-interactive (CI / automation)
#   ./scripts/deploy.sh --backend    # backend only (skip FE rebuild — faster)
#   ./scripts/deploy.sh --frontend   # FE only (skip backend rebuild)

set -euo pipefail

VPS="${VPS_HOST:-root@187.124.0.37}"
REMOTE="${REMOTE_PATH:-/opt/cfo-ai}"
HEALTH_URL="${HEALTH_URL:-https://cfo-ai.io/api/health}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# History note: the host once had TWO compose files (legacy scandia-* at
# /opt/cfo-ai/docker-compose.yml + cfo-ai-* at deploy/cfo-ai-vps/...).
# On 2026-05-25 we installed the cfo-ai-* file as the root compose
# (backup at .legacy-scandia.<ts>). So `cd /opt/cfo-ai && docker compose`
# now naturally picks the right file — no `-f` flag needed.
#
# The relative paths in deploy/cfo-ai-vps/docker-compose.yml (e.g.
# `context: ./scandi-desk-main`) resolve relative to the compose file's
# own location. If you pass `-f deploy/cfo-ai-vps/docker-compose.yml`
# docker looks for `scandi-desk-main` inside `deploy/cfo-ai-vps/`, which
# doesn't exist — hence the comment to NOT pass `-f`.

YES_FLAG=""
BUILD_BACKEND=1
BUILD_FRONTEND=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES_FLAG=1 ;;
    --backend) BUILD_FRONTEND=0 ;;
    --frontend) BUILD_BACKEND=0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Exclude list — drop anything that shouldn't cross the network.
# Critically: NEVER sync `.env` (host secrets) or `files/` (build context
# data the Dockerfile mounts separately).
EXCLUDES=(
  --exclude='.git'
  --exclude='.gitignore'
  --exclude='node_modules'
  --exclude='.venv'
  --exclude='dist'
  --exclude='build'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='.DS_Store'
  --exclude='._*'
  # ALL host env files — the FE moved to the repo root (2026-07), so the
  # VPS-local .env.production / .env.bak-testmode now live at the root too;
  # the old bare '.env' exclude left them exposed to --delete.
  --exclude='.env*'
  --exclude='.claude'
  --exclude='/files/'
  --exclude='/data/'
  --exclude='/scandi-desk-main/.env*'
  --exclude='/scandi-desk-main/dist/'
  --exclude='/scandi-desk-main/node_modules/'
  --exclude='/scandi-desk-main/.next/'
  --exclude='*.log'
)

cd "$REPO_ROOT"

echo "→ Dry-run sync to ${VPS}:${REMOTE} (no changes yet)"
echo "  Excluded paths above will be preserved on the VPS."
echo

DRY_RUN_OUT=$(rsync -avzn --delete "${EXCLUDES[@]}" ./ "$VPS:$REMOTE/" 2>&1)
# Filter rsync's stats footer; show only the file list. `|| true` guards the
# SIGPIPE from `head` closing the pipe on long diffs — under `set -o pipefail`
# that killed the whole script BEFORE the real sync (silent no-op deploy).
echo "$DRY_RUN_OUT" | grep -vE '^(sending|sent|total |building|^$)' | head -40 || true
LINES_TO_CHANGE=$(echo "$DRY_RUN_OUT" | grep -cE '^(deleting |[^[:space:]])' || true)
echo
echo "  → ${LINES_TO_CHANGE} paths would change."

if [ -z "$YES_FLAG" ]; then
  read -r -p "Proceed with real sync? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

echo
echo "→ Real sync to ${VPS}:${REMOTE}"
rsync -avz --delete "${EXCLUDES[@]}" ./ "$VPS:$REMOTE/"

# Decide which services to build/restart
SERVICES=()
[ "$BUILD_BACKEND" = "1" ]  && SERVICES+=("backend")
[ "$BUILD_FRONTEND" = "1" ] && SERVICES+=("frontend")
SERVICES_STR="${SERVICES[*]}"

echo
echo "→ Building + recreating: $SERVICES_STR"
ssh "$VPS" "cd $REMOTE && \
  docker compose build $SERVICES_STR && \
  docker compose up -d --force-recreate $SERVICES_STR"

echo
# Retry loop instead of a fixed 6s: the backend's boot_verify (anthropic
# key check + stripe probe) can take 20-40s, and the old single-shot probe
# produced three false "Deploy RED" alarms on perfectly good deploys.
echo "→ Waiting for containers (up to 90s)..."
HEALTH_JSON='{"ok":false,"error":"unreachable"}'
for i in $(seq 1 18); do
  sleep 5
  HEALTH_JSON=$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || echo '{"ok":false,"error":"unreachable"}')
  if echo "$HEALTH_JSON" | grep -q '"ok": *true'; then break; fi
done

echo
echo "→ Smoke test: ${HEALTH_URL}"
echo "$HEALTH_JSON" | python3 -m json.tool 2>/dev/null || echo "$HEALTH_JSON"

OK_FIELD=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))" 2>/dev/null || echo "False")
MODE=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mode', '?'))" 2>/dev/null || echo "?")

echo
if [ "$OK_FIELD" = "True" ]; then
  echo "✓ Deploy GREEN — mode=${MODE} — $(date -u +%H:%M:%SZ)"
  exit 0
else
  echo "✗ Deploy RED — /api/health did not return ok=true."
  echo "  Container logs: ssh $VPS 'docker logs cfo-ai-backend --tail 40'"
  exit 1
fi
