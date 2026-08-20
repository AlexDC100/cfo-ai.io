#!/usr/bin/env bash
#
# scrub_sibiu.sh — remove the plaintext Sibiu trial-balance blob from
# this repository's history. OPERATOR-ONLY. NEVER AUTOMATED.
#
# This script REWRITES GIT HISTORY. That is a one-way operation with a
# blast radius of every clone and every open branch in existence. It
# refuses to do anything at all unless a human passes BOTH confirmation
# flags AND is sitting at a terminal:
#
#     ./scrub_sibiu.sh --i-understand-force-push --maintainer "Your Name"
#
# Read the runbook next to this script FIRST. The rewrite is the last
# action here, after every guard; the coordination it requires (freezing
# pushes, announcing, re-cloning, rebasing in-flight branches) is not
# something a script can do for you.
#
# NOTE ON THIS FILE'S OWN TEXT: it deliberately never spells the name of
# the directory it lives in. scripts/check_scrub_tooling_unreachable.py
# sweeps every executable file in the tree and fails any that names this
# tooling, because such a file is one `run:` line away from being
# reachable from automation. Paths here are derived from $0 instead.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
RUNBOOK="${HERE}/RUNBOOK.md"
ADR_REL="docs/decisions/ADR-corpus-history-sibiu.md"

# ── Defaults, taken from the ADR's blob-identification table. Override
#    with --blob / --path if the record ever changes.
DEFAULT_BLOBS=(
  "cdba88b9deb61a9b96f6ce2a1b841b6f6657bced"  # plaintext PDF, 188,048 bytes
  "78ae5b1e9e08fff3c8f822a913215f5eaf566904"  # baseline w/ legal name (R4)
  "d6319e2831604072ea4849efcd9ab435c0deb44b"  # archived baseline    (R4)
  "ed877592dbb6186f8a6b6e77cbb7d6380eba4027"  # archived baseline    (R4)
)
DEFAULT_PATHS=(
  "corpus/pdf_positional/input.pdf"
  "src/engine/country_packs/ro_romania/fixtures/pdf_samples/scandia_sibiu_2019.pdf"
  "src/engine/country_packs/ro_romania/fixtures/regression_baselines/sibiu_dec_2019.json"
  "src/engine/country_packs/ro_romania/fixtures/regression_baselines/archive/sibiu_dec_2019_pre_f3.7d.json"
  "src/engine/country_packs/ro_romania/fixtures/regression_baselines/archive/sibiu_dec_2019_pre_f3.8.json"
)

BLOBS=()
PATHS=()
CONFIRMED=0
MAINTAINER=""

# ──────────────────────────────────────────────────────────────────────
# STEP 0 — BEFORE ANYTHING ELSE: say where the decision lives and what
# is supposed to have happened before anyone got here. This prints on
# EVERY invocation, including the refusals below. A refusal that also
# teaches is worth more than a refusal that only says no.
# ──────────────────────────────────────────────────────────────────────
cat <<BANNER

================================================================================
  GIT HISTORY REWRITE — Sibiu plaintext trial balance
================================================================================

  Decision record : ${ADR_REL}
  Runbook         : ${RUNBOOK}
  Repository      : ${REPO}

  This tooling exists because the decision recorded in the ADR was
  "history RETAINED, scrub DEFERRED". Deferred is not cancelled. You
  should be here because one of these REVIEW TRIGGERS has fired:

    [ ] A new collaborator gains read access to this repository
        (employee, contractor, reviewer, or auditor).
    [ ] A new CI system, bot, or third-party integration gains repo
        read access — scanners, coverage services and AI review tools
        all clone full history by default.
    [ ] Repository visibility changes (private -> internal -> public,
        or the org default changes underneath it).
    [ ] The repository is migrated, forked, mirrored or transferred.
        Forks inherit the object store and cannot be un-forked.
    [ ] The client or their counsel requests deletion, or a legal or
        regulatory duty attaches.
    [ ] A leak is suspected or confirmed by any route.

  READ THIS BEFORE YOU RUN IT: a rewrite REDUCES exposure, it does not
  ERASE it. The plaintext stays recoverable from every clone that
  already exists, and the hosting provider keeps unreachable objects
  addressable by SHA in its own caches and fork object pools. Purging
  that requires a SUPPORT REQUEST to the provider. Do not report this
  script's success as "the data is gone".

================================================================================

BANNER

# ──────────────────────────────────────────────────────────────────────
# STEP 1 — parse arguments. Nothing has touched the repository yet and
# nothing will until every guard below has passed.
# ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --i-understand-force-push) CONFIRMED=1; shift ;;
    --maintainer)              MAINTAINER="${2:-}"; shift 2 ;;
    --maintainer=*)            MAINTAINER="${1#*=}"; shift ;;
    --blob)                    BLOBS+=("${2:-}"); shift 2 ;;
    --path)                    PATHS+=("${2:-}"); shift 2 ;;
    -h|--help)
      echo "usage: $(basename "$0") --i-understand-force-push --maintainer \"Name\""
      echo "                        [--blob SHA]... [--path REPO/REL/PATH]..."
      echo
      echo "Both confirmation flags are mandatory. Read ${RUNBOOK} first."
      exit 2
      ;;
    *)
      echo "REFUSED: unknown argument '$1'." >&2
      echo "         Nothing was changed. See --help." >&2
      exit 2
      ;;
  esac
done

# ──────────────────────────────────────────────────────────────────────
# STEP 2 — THE REFUSAL. Both flags, or nothing happens. Exits non-zero
# with zero side effects: no fetch, no gc, no index write, no ref move.
# ──────────────────────────────────────────────────────────────────────
missing=()
[[ "${CONFIRMED}" -eq 1 ]] || missing+=("--i-understand-force-push")
[[ -n "${MAINTAINER}" ]]   || missing+=("--maintainer \"<name>\"")

if [[ ${#missing[@]} -gt 0 ]]; then
  cat >&2 <<REFUSED
REFUSED — this script will not rewrite history without explicit,
attributed human confirmation.

  Missing: ${missing[*]}

  Both flags are required, every time, deliberately:

    --i-understand-force-push
        You are asserting that you have read ${RUNBOOK},
        that pushes are frozen, and that every clone holder has been
        told a re-clone is coming.

    --maintainer "<name>"
        A rewrite is an attributable decision. It goes in the log with
        a name on it, so the record shows WHO decided, not just that
        someone did.

  Nothing has been changed. The repository is exactly as you found it.
REFUSED
  exit 2
fi

# ──────────────────────────────────────────────────────────────────────
# STEP 3 — no terminal, no rewrite. A second line of defence behind
# scripts/check_scrub_tooling_unreachable.py: even if someone one day
# wires this into a job, a job has no TTY and this script stops here.
# ──────────────────────────────────────────────────────────────────────
if [[ ! -t 0 ]]; then
  echo "REFUSED: stdin is not a terminal. This is a human-only operation;" >&2
  echo "         it must never run unattended. Nothing was changed." >&2
  exit 2
fi

# ──────────────────────────────────────────────────────────────────────
# STEP 4 — environment guards (all read-only).
# ──────────────────────────────────────────────────────────────────────
cd "${REPO}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "REFUSED: ${REPO} is not a git work tree. Nothing was changed." >&2
  exit 2
}

if ! command -v git-filter-repo >/dev/null 2>&1 && ! git filter-repo --version >/dev/null 2>&1; then
  cat >&2 <<'MISSING_TOOL'
REFUSED: git-filter-repo is not available.

  Do NOT substitute `git filter-branch` — it is slow, it is error-prone,
  and the git project itself recommends against it.

      pipx install git-filter-repo     # or: brew install git-filter-repo

  Nothing was changed.
MISSING_TOOL
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSED: working tree is not clean. Commit or stash first — a" >&2
  echo "         rewrite over a dirty tree loses uncommitted work." >&2
  echo "         Nothing was changed." >&2
  exit 2
fi

if [[ ! -f "${REPO}/${ADR_REL}" ]]; then
  echo "REFUSED: ${ADR_REL} is missing. The decision record IS the" >&2
  echo "         authorisation for this operation. Nothing was changed." >&2
  exit 2
fi

[[ ${#BLOBS[@]} -gt 0 ]] || BLOBS=("${DEFAULT_BLOBS[@]}")
[[ ${#PATHS[@]} -gt 0 ]] || PATHS=("${DEFAULT_PATHS[@]}")

# ──────────────────────────────────────────────────────────────────────
# STEP 5 — the guard that matters most.
#
# We strip specific BLOBS, not paths, so that the REDACTED version of
# each file survives the rewrite. That only works if the redaction has
# already been committed. If a target blob is still the content at HEAD,
# stripping it would delete the file outright instead of rewinding it to
# the redacted version — turning a privacy fix into data loss.
# ──────────────────────────────────────────────────────────────────────
echo "Verifying targets (read-only)..."
present=()
for blob in "${BLOBS[@]}"; do
  if git cat-file -e "${blob}" 2>/dev/null; then
    size="$(git cat-file -s "${blob}")"
    echo "  blob ${blob:0:12}  present  ${size} bytes"
    present+=("${blob}")
  else
    echo "  blob ${blob:0:12}  ABSENT   (already removed, or never in this clone)"
  fi
done

if [[ ${#present[@]} -eq 0 ]]; then
  echo
  echo "Nothing to do: none of the target blobs exist in this repository."
  echo "Nothing was changed."
  exit 0
fi

for p in "${PATHS[@]}"; do
  head_blob="$(git rev-parse "HEAD:${p}" 2>/dev/null || true)"
  [[ -n "${head_blob}" ]] || continue
  for blob in "${present[@]}"; do
    if [[ "${head_blob}" == "${blob}" ]]; then
      cat >&2 <<UNCOMMITTED
REFUSED: ${p}
         still has the target blob ${blob:0:12} as its content AT HEAD.

  The redaction has not been committed yet. Stripping this blob now
  would remove the file from history entirely instead of leaving the
  redacted version in place.

  Commit the redacted files first, verify HEAD carries them, then run
  this again. Nothing was changed.
UNCOMMITTED
      exit 2
    fi
  done
done
echo "  HEAD does not carry any target blob — safe to strip."
echo

# ──────────────────────────────────────────────────────────────────────
# STEP 6 — last human gate before the one-way door.
# ──────────────────────────────────────────────────────────────────────
echo "About to rewrite history in: ${REPO}"
echo "  maintainer      : ${MAINTAINER}"
echo "  blobs to strip  : ${#present[@]}"
echo "  current HEAD    : $(git rev-parse HEAD)"
echo "  current branch  : $(git rev-parse --abbrev-ref HEAD)"
echo
echo "This is the point of no return. Every clone will need re-cloning"
echo "and every in-flight branch will need rebasing (RUNBOOK step 6)."
echo
printf 'Type exactly REWRITE HISTORY to proceed: '
read -r reply
if [[ "${reply}" != "REWRITE HISTORY" ]]; then
  echo "Aborted. Nothing was changed."
  exit 2
fi

# ──────────────────────────────────────────────────────────────────────
# STEP 7 — THE REWRITE. The last action, after every guard above.
# ──────────────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="${REPO}/.git/pre-rewrite-backup-${STAMP}.bundle"
IDFILE="$(mktemp)"
trap 'rm -f "${IDFILE}"' EXIT

printf '%s\n' "${present[@]}" > "${IDFILE}"

echo "Creating a local safety bundle of all refs..."
git bundle create "${BACKUP}" --all
echo "  ${BACKUP}"
echo

echo "Rewriting..."
if command -v git-filter-repo >/dev/null 2>&1; then
  git-filter-repo --force --strip-blobs-with-ids "${IDFILE}"
else
  git filter-repo --force --strip-blobs-with-ids "${IDFILE}"
fi

echo
echo "Rewrite complete. NOT YET DONE — from RUNBOOK.md:"
echo "  · verify the blobs are unreachable from every ref (step 5)"
echo "  · force-push, then have BOTH clone holders re-clone (step 6)"
echo "  · rebase in-flight branches onto the rewritten history (step 6)"
echo "  · open the provider support request for cache purge (step 7) —"
echo "    without it the blob stays addressable by SHA"
echo "  · record the run in ${ADR_REL} (step 8)"
echo
echo "Safety bundle (delete only once everyone has re-cloned):"
echo "  ${BACKUP}"
