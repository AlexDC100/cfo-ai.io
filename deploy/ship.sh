#!/usr/bin/env bash
# One-shot deploy from your laptop to the Hostinger VPS.
# Run this from Terminal.app on your Mac:
#
#   bash "/Users/alex/Desktop/folder claude Scandia/deploy/ship.sh"
#
# You'll be prompted for the VPS root password TWICE — once for scp, once for
# ssh. Get the password from https://hpanel.hostinger.com/vps/1626038/overview
# (look for "Root password" or "Initial password" — there's a copy button).

set -euo pipefail

VPS_IP="187.124.0.37"
VPS_USER="root"
VPS_HOST="${VPS_USER}@${VPS_IP}"
PROJECT_DIR="/Users/alex/Desktop/folder claude Scandia"
TARBALL="/tmp/scandia-deploy.tar.gz"

# Sanity checks
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "✖ Project dir not found: $PROJECT_DIR" >&2
  exit 1
fi
if ! command -v ssh >/dev/null || ! command -v scp >/dev/null; then
  echo "✖ ssh/scp not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════"
echo " Scandia SKU Decision Engine — VPS Deploy"
echo "════════════════════════════════════════════════════════════"
echo " Source: $PROJECT_DIR"
echo " Target: $VPS_HOST  ($VPS_IP)"
echo
echo " You will be asked for the VPS root password TWICE."
echo " Get it from the Hostinger VPS overview page."
echo "════════════════════════════════════════════════════════════"
echo

# ─── 1. Package ─────────────────────────────────────────────────────────────
echo "▶ Step 1/4: Packaging project…"
parent_dir="$(dirname "$PROJECT_DIR")"
folder_name="$(basename "$PROJECT_DIR")"
cd "$parent_dir"
tar --exclude="$folder_name/.venv" \
    --exclude="$folder_name/.git" \
    --exclude="$folder_name/.pytest_cache" \
    --exclude="$folder_name/build" \
    --exclude="$folder_name/output" \
    --exclude="$folder_name/scandi-desk-main/node_modules" \
    --exclude="$folder_name/scandi-desk-main/dist" \
    --exclude="$folder_name/.DS_Store" \
    --exclude="$folder_name/files.zip" \
    --exclude="$folder_name/.claude" \
    -czf "$TARBALL" \
    "$folder_name"
tarball_size="$(du -h "$TARBALL" | awk '{print $1}')"
echo "  ✓ $tarball_size → $TARBALL"
echo

# ─── 2. Upload ──────────────────────────────────────────────────────────────
echo "▶ Step 2/4: Uploading tarball to VPS (password prompt #1)…"
scp -o StrictHostKeyChecking=accept-new "$TARBALL" "$VPS_HOST:/opt/scandia.tar.gz"
echo "  ✓ uploaded"
echo

# ─── 3. Remote bootstrap ────────────────────────────────────────────────────
echo "▶ Step 3/4: Bootstrapping on VPS (password prompt #2)…"
echo "  Installing Docker (if needed), unpacking, and starting the stack."
echo "  First build takes 3–5 minutes — pandas + npm install + nginx + Caddy."
echo

ssh -tt -o StrictHostKeyChecking=accept-new "$VPS_HOST" 'bash -s' <<'REMOTE'
set -e
echo "── On VPS: unpacking project ──"
mkdir -p /opt/scandia
tar -xzf /opt/scandia.tar.gz -C /opt/scandia --strip-components=1
cd /opt/scandia
chmod +x deploy/bootstrap.sh

echo "── On VPS: running bootstrap (Docker install + .env scaffold) ──"
./deploy/bootstrap.sh || true   # bootstrap exits 0 even when .env was just created

echo "── On VPS: bringing up the stack ──"
docker compose up -d --build

echo "── On VPS: container status ──"
docker compose ps

echo "── On VPS: waiting 5s for services to settle ──"
sleep 5

echo "── On VPS: backend health check ──"
curl -fsS http://localhost/health || echo "  (health not ready yet — check logs)"

echo "── On VPS: anthropic key status ──"
docker compose logs backend 2>&1 | grep -i anthropic | tail -5 || true

echo "── On VPS: caddy status ──"
docker compose logs caddy 2>&1 | tail -10 || true
REMOTE

echo
echo "▶ Step 4/4: Done."
echo "════════════════════════════════════════════════════════════"
echo " Stack is up. Try opening these URLs in your browser:"
echo
echo "   http://187.124.0.37            ← works immediately"
echo "   https://scandiafood-sku.online ← live as soon as DNS finishes propagating"
echo
echo " Operational commands (run on the VPS via ssh root@187.124.0.37):"
echo "   docker compose logs -f          # live logs"
echo "   docker compose restart backend  # restart after editing .env"
echo "   docker compose ps               # health of each container"
echo "════════════════════════════════════════════════════════════"
