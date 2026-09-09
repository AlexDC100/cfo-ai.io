#!/usr/bin/env bash
# Serve the PRODUCTION build to the phone (2026-09-10): `vite build --watch`
# rebuilds dist/ on every source change (~7 s) and `vite preview` serves it
# on :5173 with the same /api proxy as the dev server. A built page is
# ~77 requests instead of the dev server's ~560 unbundled modules, which is
# what a WebView over Wi-Fi feels most. No HMR — pull the page down to
# reload after a change. Stop the Docker dev server first (same port):
#   docker compose --profile dev stop frontend-dev
set -euo pipefail
cd "$(dirname "$0")/.."
npx vite build --watch --logLevel warn &
build=$!
trap 'kill "$build" 2>/dev/null || true' EXIT
# First build must finish before preview has anything to serve.
until [ -f dist/index.html ]; do sleep 1; done
exec npx vite preview --host 0.0.0.0 --port 5173 --strictPort
