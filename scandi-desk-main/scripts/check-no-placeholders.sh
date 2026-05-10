#!/usr/bin/env bash
# Fail if any of the Phase 3 placeholder strings reappear in source. These
# markers signal "feature is mocked / coming later" — once the real pipeline
# ships, none of them belong in the codebase.
#
# Wire from package.json:
#   "lint:placeholders": "bash scripts/check-no-placeholders.sh"

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Strings that must not appear in source. Add new ones as you introduce real
# implementations — each entry is a regex matched literally with grep -E.
PATTERNS=(
  "Auth ships with the Supabase wiring"
  "OCR \+ extraction pipeline ships next phase"
  "OCR \+ EXTRACTION PIPELINE SHIPS NEXT PHASE"
  "ships next phase"
  "comingSoon\\(\"Profile\""
)

found_any=0
for pattern in "${PATTERNS[@]}"; do
  matches=$(grep -rIn -E "$pattern" "$ROOT/src" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "ERROR: forbidden placeholder string '$pattern' found:"
    echo "$matches"
    found_any=1
  fi
done

if [ $found_any -ne 0 ]; then
  echo ""
  echo "These markers indicate work that was deferred. They must be removed"
  echo "as real implementations land. Delete the markers (and any associated"
  echo "stub code) and re-run."
  exit 1
fi

echo "OK: no forbidden placeholders in src/"
