#!/bin/sh
# NIGHTLY DEPLOY-DRIFT CHECK — runs ON THE VPS, so it does not depend on
# any laptop being awake.
#
# WHY. On 2026-09-01 production was TWENTY-TWO COMMITS BEHIND main and
# nothing said so; the drift surfaced as an owner complaint about the UI.
#
# WHAT IT COMPARES. The tip of `main` on GitHub against the files inside
# the RUNNING container. Not against /opt/cfo-ai — that is an rsync
# target, not a git checkout, so it would agree with itself after a bad
# sync and prove nothing. Comparing to the origin tip is what makes this
# answer "is production running what main says", rather than "is
# production running what someone last copied here".
set -u
REPO_URL="https://github.com/AlexDC100/cfo-ai.io"
WORK="/tmp/drift-check-$$"
LOG="/var/log/cfo-ai-drift.log"
CONTAINER="cfo-ai-backend"
FILES="engine/api/_ratio_units.py engine/api/_finding.py engine/ai/finding_sharpen.py engine/serving/facts.py engine/api/_capsule_tools.py"

stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
say() { echo "$(stamp) $*" >> "$LOG"; }

rm -rf "$WORK"
if ! git clone --quiet --depth 1 "$REPO_URL" "$WORK" 2>/dev/null; then
  say "SKIPPED — could not clone $REPO_URL. Not a pass: nothing was compared."
  rm -rf "$WORK"; exit 0
fi

HEAD_SHA=$(cd "$WORK" && git rev-parse --short HEAD)
drift=0
checked=0
for f in $FILES; do
  [ -f "$WORK/src/$f" ] || continue
  want=$(sha256sum "$WORK/src/$f" | cut -c1-16)
  got=$(docker exec "$CONTAINER" sha256sum "/app/src/$f" 2>/dev/null | cut -c1-16)
  checked=$((checked + 1))
  if [ "$want" != "$got" ]; then
    drift=$((drift + 1))
    say "DRIFT $f  main=$want deployed=$got"
  fi
done

# A census over nothing must not read as agreement (TC-3).
if [ "$checked" -eq 0 ]; then
  say "DISCOVERY BROKEN — compared 0 files. 'No drift' here would mean 'no subject'."
  rm -rf "$WORK"; exit 1
fi

if [ "$drift" -gt 0 ]; then
  say "DRIFT NOTICE — production is NOT running main ($HEAD_SHA): $drift of $checked file(s) differ."
  say "  Redeploy per CLAUDE.md 14: rsync host source FIRST, then docker compose build && up."
  rm -rf "$WORK"; exit 1
fi

say "IN SYNC — $checked file(s) match main ($HEAD_SHA)."
rm -rf "$WORK"
exit 0
