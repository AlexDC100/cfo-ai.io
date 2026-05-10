#!/usr/bin/env bash
# One-shot VPS bootstrap for the Scandia SKU Decision Engine.
# Tested on Ubuntu 22.04 / 24.04. Run as root:
#   curl -fsSL https://... | bash      (if you publish this somewhere)
#   OR after scp-ing the project tarball, run from /opt/scandia:
#   ./deploy/bootstrap.sh
#
# The script is idempotent — safe to re-run. It will:
#   1. Install Docker Engine + the Compose plugin (if missing).
#   2. Open ports 80/443 in ufw (if ufw is active).
#   3. Create .env from .env.example if no .env exists.
#   4. Build and start the stack with docker compose.

set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
echo "▶ Project dir: $PROJECT_DIR"

# ─── 1. Docker ──────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Installing Docker Engine…"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
                     docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "▶ Docker already installed: $(docker --version)"
fi

# ─── 2. Firewall ────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "▶ Opening 80 and 443 in ufw…"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# ─── 3. Env file ────────────────────────────────────────────────────────────
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "▶ Created .env from .env.example."
  echo "  Add the Anthropic key later by editing /opt/scandia/.env and running:"
  echo "    docker compose restart backend"
fi

# ANTHROPIC_API_KEY is OPTIONAL. If empty, the engine still classifies SKUs
# but the AI panel falls back to deterministic prose. Warn but don't block —
# you can add the key later by editing .env and running `docker compose restart backend`.
if ! grep -E '^ANTHROPIC_API_KEY=.+' "$PROJECT_DIR/.env" >/dev/null; then
  echo "▶ Note: ANTHROPIC_API_KEY is empty. AI commentary will use deterministic fallback."
  echo "  Add the key to .env later and run: docker compose restart backend"
fi

# ─── 4. Build & start ───────────────────────────────────────────────────────
echo "▶ Building and starting the stack…"
docker compose up -d --build

echo
echo "✓ Stack is up."
echo "  • Frontend + Caddy:  https://scandiafood-sku.online"
echo "  • Backend health:    https://scandiafood-sku.online/health"
echo "  • Logs:              docker compose logs -f"
echo "  • Restart:           docker compose restart"
echo "  • Update after code changes: docker compose up -d --build"
