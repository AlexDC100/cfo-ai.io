#!/usr/bin/env bash
# Re-point the mobile shell's dev WebView at THIS Mac's current LAN IP.
#
# The phone loads the Vite dev server over Wi-Fi, so mobile/.env must carry
# the Mac's LAN address — and that address changes whenever the Mac joins a
# different network (a stale one shows as an endless spinner or "Can't reach
# CFO AI" in the shell). Run this, then restart Expo (`npx expo start -c`
# in mobile/) and rescan the QR code. Engine calls need nothing: they go
# through the Vite proxy (VITE_API_URL is empty in .env.local).
set -euo pipefail
cd "$(dirname "$0")/.."
ip=""
for ifc in en0 en1 en2; do
  ip="$(ipconfig getifaddr "$ifc" 2>/dev/null || true)"
  [ -n "$ip" ] && break
done
[ -n "$ip" ] || { echo "no LAN IP found on en0/en1/en2 — is Wi-Fi on?" >&2; exit 1; }
url="http://${ip}:5173"
if grep -q '^EXPO_PUBLIC_WEB_APP_URL=' mobile/.env 2>/dev/null; then
  sed -i '' "s#^EXPO_PUBLIC_WEB_APP_URL=.*#EXPO_PUBLIC_WEB_APP_URL=${url}#" mobile/.env
else
  printf 'EXPO_PUBLIC_WEB_APP_URL=%s\n' "$url" >> mobile/.env
fi
echo "mobile/.env -> ${url}"
if [ -f docker-compose.override.yml ]; then
  # Only matters for direct :8000 access from a browser on the LAN; the app
  # itself goes through the Vite proxy.
  sed -i '' -E "s#http://[0-9.]+:5173#${url}#" docker-compose.override.yml
fi
curl -s -o /dev/null -m 3 -w "vite on ${url}: HTTP %{http_code}\n" "${url}/dashboard" || echo "vite is not answering on ${url} — start it with: npm run dev -- --host  (or in Docker: npm run dev:docker)"
echo "now: cd mobile && npx expo start -c   (then rescan the QR code)"
