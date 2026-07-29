#!/usr/bin/env bash
# Fail if country-specific upload copy reappears in user-facing source.
#
# The product positions itself as a multi-country European platform.
# Strings like "Paste Romanian trial balance" make every non-Romanian
# user wonder if the product supports their format — even when the
# pipeline does. The replacement is always neutral copy ("trial balance"),
# not a translation of the country name.
#
# Scope: only TSX / TS sources under src/ — i18n JSON files are exempt
# (Romanian users SEE "balanța de verificare" because that's what they
# call it). Code comments + library files (trialBalanceParser.ts,
# invoiceAnalytics.ts) describe the parser internals and are exempt;
# they're never rendered.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Banned phrases (regex). Each must not appear in user-facing files.
PATTERNS=(
  "Paste a Romanian trial balance"
  "Paste Romanian"
  "Drop a Romanian"
  "Upload a Romanian"
  "Romanian Ministry of Finance"
  "Romanian companies"
  "Romanian SME"
  "balanța de verificare here"
)

# User-facing files only — exclude library internals + i18n JSON.
INCLUDES=(
  "$ROOT/src/components/cfo"
  "$ROOT/src/pages/cfo"
  "$ROOT/src/app"
)
EXCLUDES=(
  "trialBalanceParser.ts"
  "invoiceAnalytics.ts"
  "_ro_coa"
)

found_any=0
for pattern in "${PATTERNS[@]}"; do
  for dir in "${INCLUDES[@]}"; do
    [ -d "$dir" ] || continue
    matches=$(grep -rIn -E "$pattern" "$dir" --include="*.tsx" --include="*.ts" 2>/dev/null \
      | grep -v -E "$(IFS='|'; echo "${EXCLUDES[*]}")" \
      || true)
    if [ -n "$matches" ]; then
      echo "ERROR: country-specific copy '$pattern' found:"
      echo "$matches"
      found_any=1
    fi
  done
done

if [ $found_any -ne 0 ]; then
  echo
  echo "Replace with country-agnostic copy. The pipeline supports multiple"
  echo "European chart-of-account formats; the UI should reflect that. Per-"
  echo "language strings live in src/i18n/*.json — never inline 'Romanian'"
  echo "or other country names in user-facing components."
  exit 1
fi

echo "OK: no country-specific upload copy in user-facing src/"
