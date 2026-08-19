#!/usr/bin/env python3
"""GOLDEN-CHANGE GUARD — corpus goldens never change silently.

The golden corpus (corpus/<case_id>/expected/*.json) is the frozen
end-to-end truth of the pipeline. A diff there is either a caught
regression or a DELIBERATE, explained contract change — never routine
churn. This guard enforces the paper trail:

  · If NO file under corpus/*/expected/ changed vs the base ref → PASS.
  · If any did, the PR body (env PR_BODY) MUST contain a line starting
    with `golden-change:` explaining WHY the frozen artifacts moved
    (e.g. "golden-change: sv2 envelope adds status_presentation.locale").
    Otherwise this script exits 1 with the flow explained.

Where the base ref comes from:
  CI     the workflow passes --base ${{ github.event.pull_request.base.sha }}
         and PR_BODY from the event payload (checkout needs fetch-depth: 0
         so the base sha is present locally).
  local  defaults to origin/main — the pre-push habit:
             .venv/bin/python scripts/check_golden_change_guard.py
         If it fails, you are changing goldens: re-freeze deliberately
         (UPDATE_GOLDEN=1 scripts/corpus_replay.py), eyeball the diff,
         and put a `golden-change: <reason>` line in your PR body
         (locally you can simulate: PR_BODY='golden-change: reason' ...).

Detection is git-diff based and also counts staged / unstaged / untracked
expected-files, so a locally re-frozen golden is caught before push.

Stdlib-only, Python 3.9+. Exit codes: 0 pass, 1 guard violation, 2 git /
usage error (e.g. base ref not fetched).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import List

GOLDEN_RE = re.compile(r"^corpus/[^/]+/expected/")
MARKER = "golden-change:"


def _repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / ".git").exists():
            return candidate
    return here.parent


def _git(root: Path, *args: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(
        ["git", *args], cwd=str(root), capture_output=True, text=True
    )


def changed_goldens(root: Path, base: str) -> List[str]:
    """Every corpus/*/expected/ path that differs from `base`, including
    committed (merge-base three-dot diff), staged, unstaged and untracked
    changes. Raises RuntimeError when git cannot resolve the base."""
    paths = set()

    committed = _git(root, "diff", "--name-only", "--no-renames",
                     "%s...HEAD" % base)
    if committed.returncode != 0:
        raise RuntimeError(
            "git diff against base %r failed: %s\n"
            "(in CI make sure actions/checkout uses fetch-depth: 0 so the "
            "PR base sha exists locally; locally run `git fetch origin main`)"
            % (base, committed.stderr.strip())
        )
    paths.update(committed.stdout.splitlines())

    # Local working-tree changes (no-ops on a clean CI checkout).
    worktree = _git(root, "diff", "--name-only", "--no-renames", "HEAD")
    if worktree.returncode == 0:
        paths.update(worktree.stdout.splitlines())
    untracked = _git(root, "ls-files", "--others", "--exclude-standard",
                     "corpus")
    if untracked.returncode == 0:
        paths.update(untracked.stdout.splitlines())

    return sorted(p for p in paths if GOLDEN_RE.match(p))


def pr_body_has_marker(body: str) -> bool:
    return any(line.strip().startswith(MARKER) for line in body.splitlines())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
    )
    parser.add_argument(
        "--base",
        default="origin/main",
        help="base ref to diff against (CI passes the PR base sha; "
             "default: origin/main for the local pre-push habit)",
    )
    args = parser.parse_args(argv)
    root = _repo_root()

    try:
        goldens = changed_goldens(root, args.base)
    except RuntimeError as exc:
        print("golden-change guard: GIT ERROR\n%s" % exc)
        return 2

    if not goldens:
        print("golden-change guard: PASS — no corpus/*/expected/ files "
              "changed vs %s" % args.base)
        return 0

    body = os.environ.get("PR_BODY", "")
    if pr_body_has_marker(body):
        marker_lines = [line.strip() for line in body.splitlines()
                        if line.strip().startswith(MARKER)]
        print("golden-change guard: PASS — %d golden file(s) changed, "
              "declared in the PR body:" % len(goldens))
        for line in marker_lines:
            print("  %s" % line)
        for p in goldens:
            print("  ~ %s" % p)
        return 0

    print("golden-change guard: FAIL")
    print()
    print("These frozen corpus goldens changed vs %s:" % args.base)
    for p in goldens:
        print("  ~ %s" % p)
    print()
    print("A golden change is a pipeline CONTRACT change and must be "
          "declared, never slipped through:")
    print("  1. Re-freeze deliberately:  UPDATE_GOLDEN=1 "
          ".venv/bin/python scripts/corpus_replay.py")
    print("  2. Eyeball the diff — every changed field is a served-number "
          "change users will see.")
    print("  3. Add a line starting `%s` to the PR body explaining why, "
          "e.g." % MARKER)
    print("       golden-change: auto-reconcile receipt gains "
          "suppressed_at (sv1 additive)")
    print("  (local dry-run: PR_BODY='%s reason' %s)"
          % (MARKER, Path(sys.argv[0]).name))
    return 1


if __name__ == "__main__":
    sys.exit(main())
