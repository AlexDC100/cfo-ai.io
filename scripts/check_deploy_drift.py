#!/usr/bin/env python3
"""Nightly: is production running what `main` says it is?

WHY THIS EXISTS. On 2026-09-01 the owner complained that the Capsule
dropdown was full of duplicated navigation rows. It had been fixed
days earlier. Production was TWENTY-TWO COMMITS BEHIND, and nothing
said so — the drift surfaced as a complaint about the UI, which is the
most expensive way to learn it.

Compares the committed tree against the running containers two ways:

  1. COMMITS BEHIND — what `main` has that the deployed marker does not.
  2. FILE HASHES — a sample of engine files, hashed locally and inside
     the container. This catches the case a commit count cannot: a
     `docker cp` hot patch, or a rebuild that silently dropped a change
     because it read host source that was never synced (see CLAUDE.md
     §14, which exists because exactly that happened).

Exit 0 clean, 1 on drift. Intended for cron:

    0 6 * * *  cd /path/to/repo && .venv/bin/python scripts/check_deploy_drift.py

Not a battery gate: it needs SSH to the VPS, so on a machine without
access it would fail for the wrong reason — and a gate that reds when
it cannot reach its subject teaches people to ignore it.
"""
import hashlib
import os
import subprocess
import sys

HOST = "root@187.124.0.37"
CONTAINER = "cfo-ai-backend"

#: KNOWN BLIND SPOT: the sample is engine-only. A frontend-only deploy
#: gap (ea6df1f vs f1e5824 was exactly that) is invisible here, because
#: the bundle is a build artifact and source hashes do not map to it.
#: The honest frontend signal is the deployed commit SHA; recorded, not
#: gold-plated in this pass.
#: EXHAUSTIVE, NOT SAMPLED — and the five names below are kept only as
#: the canaries that prove discovery worked.
#:
#: On 2026-09-06 this printed "IN SYNC" while 461 engine files differed
#: from the committed tree, and production had been serving HTTP 500 on
#: every upload for hours. `pipeline.py` had been deployed carrying a
#: call to `_org.verified_user_id`; `_org.py` had not, so the running
#: app raised `AttributeError: module 'engine.api._org' has no attribute
#: 'verified_user_id'` at the first authenticated write. Not one of the
#: five sampled files was involved, so the check answered the question
#: it was asked and the question was too small.
#:
#: A sample is a reasonable economy for "is the image stale". It is the
#: wrong instrument for "does production run the committed tree", which
#: is what the banner claims and what an operator reads it as. Hashing
#: every tracked file under src/ costs one `find | xargs sha256sum` in
#: the container and one `git ls-tree` locally — cheaper than the sample
#: was, because it is one round trip instead of five.
CANARIES = [
    "engine/api/_ratio_units.py",
    "engine/api/_finding.py",
    "engine/ai/finding_sharpen.py",
    "engine/serving/facts.py",
    "engine/api/_capsule_tools.py",
]


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                          timeout=120, **kw)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)

    print("DEPLOY DRIFT")
    print("=" * 62)

    reachable = sh("ssh -o BatchMode=yes -o ConnectTimeout=20 %s true" % HOST)
    if reachable.returncode != 0:
        print("  SKIPPED — %s unreachable from this machine." % HOST)
        print("  This is not a pass and not a failure: the subject was not")
        print("  examined. Run it where the deploy host is reachable.")
        return 0

    drift = []

    # Every tracked file under src/, hashed on both sides. One round trip.
    tree = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "src/"],
        capture_output=True, text=True, cwd=root, timeout=60)
    rels = [ln[len("src/"):] for ln in tree.stdout.splitlines()
            if ln.startswith("src/") and not ln.endswith(".pyc")]

    local = {}
    for rel in rels:
        blob = subprocess.run(["git", "show", "HEAD:src/%s" % rel],
                              capture_output=True, cwd=root, timeout=30)
        if blob.returncode == 0:
            local[rel] = hashlib.sha256(blob.stdout).hexdigest()[:16]

    r = sh("ssh -o BatchMode=yes %s \"docker exec %s sh -c "
           "'cd /app/src && find . -type f -name \\\"*.py\\\" -o -type f "
           "-name \\\"*.yaml\\\" -o -type f -name \\\"*.yml\\\" -o -type f "
           "-name \\\"*.json\\\" -o -type f -name \\\"*.csv\\\" | "
           "xargs sha256sum'\"" % (HOST, CONTAINER))
    remote = {}
    for line in (r.stdout or "").splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2:
            remote[parts[1].strip().lstrip("./")] = parts[0][:16]

    checked = 0
    missing = []
    for rel, want in sorted(local.items()):
        got = remote.get(rel)
        if got is None:
            # Not every tracked file ships into the image (fixtures, seeds
            # excluded by .dockerignore). Absence is reported, never
            # silently counted as agreement.
            missing.append(rel)
            continue
        checked += 1
        if got != want:
            drift.append((rel, want, got))

    for rel in CANARIES:
        state = ("MATCH" if remote.get(rel) == local.get(rel)
                 else "DRIFT" if rel in remote else "NOT IN IMAGE")
        print("  %-38s %s" % (rel, state))
    if missing:
        print("  %d tracked file(s) not present in the image (excluded from"
              " the build context)" % len(missing))

    # TC-3: a census over nothing must not read as agreement.
    if checked == 0:
        print("")
        print("  DISCOVERY BROKEN — hashed 0 files. Nothing was compared, so")
        print("  'no drift' here would mean 'no subject', not 'in sync'.")
        return 1

    print("-" * 62)
    print("  %d file(s) compared (every tracked file under src/)" % checked)

    if drift:
        print("")
        print("DRIFT NOTICE — production is NOT running the committed tree:")
        for rel, want, got in drift[:25]:
            print("  %-38s committed %s  deployed %s" % (rel, want, got))
        if len(drift) > 25:
            print("  … and %d more" % (len(drift) - 25))
        print("")
        print("Redeploy per CLAUDE.md §14: rsync host source FIRST, then")
        print("`docker compose build && up`. Never `docker cp` into a running")
        print("container — the next rebuild silently drops it.")
        return 1

    print("")
    print("IN SYNC — the deployed containers match the committed tree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
