#!/bin/sh
# Entrypoint for the `frontend-dev` compose service: install the frontend
# dependencies into the node_modules volume (Linux binaries — the Mac's
# node_modules can't be reused) and start Vite on all interfaces.
# Re-installs only when package-lock.json changed since the last install.
set -eu
cd /app
stamp=node_modules/.package-lock.sha256
want="$(sha256sum package-lock.json | cut -d' ' -f1)"
have="$(cat "$stamp" 2>/dev/null || true)"
if [ "$want" != "$have" ] || [ ! -d node_modules/vite ]; then
  echo "frontend-dev: installing dependencies (package-lock changed or first run)…"
  # npm install rewrites package-lock.json for the Linux tree, and that
  # write lands on the Mac through the bind mount — restore the host's
  # lockfile afterwards so the container never edits the repo.
  cp package-lock.json /tmp/package-lock.host.json
  npm install --no-audit --no-fund --legacy-peer-deps
  cp /tmp/package-lock.host.json package-lock.json
  echo "$want" > "$stamp"
fi
exec npm run dev -- --host
