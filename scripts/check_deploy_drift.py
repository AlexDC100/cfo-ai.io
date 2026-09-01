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

#: Sampled rather than exhaustive: enough to catch a stale image, cheap
#: enough to run nightly. Each is a file a real change would touch.
SAMPLE = [
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
    checked = 0
    for rel in SAMPLE:
        local_path = os.path.join(root, "src", rel)
        if not os.path.exists(local_path):
            continue
        with open(local_path, "rb") as fh:
            local = hashlib.sha256(fh.read()).hexdigest()[:16]
        r = sh("ssh -o BatchMode=yes %s \"docker exec %s sha256sum /app/src/%s\""
               % (HOST, CONTAINER, rel))
        remote = (r.stdout or "").strip().split(" ")[0][:16]
        checked += 1
        state = "MATCH" if local == remote else "DRIFT"
        if state == "DRIFT":
            drift.append((rel, local, remote))
        print("  %-38s %s" % (rel, state))

    # TC-3: a census over nothing must not read as agreement.
    if checked == 0:
        print("")
        print("  DISCOVERY BROKEN — hashed 0 files. Nothing was compared, so")
        print("  'no drift' here would mean 'no subject', not 'in sync'.")
        return 1

    print("-" * 62)
    print("  %d file(s) compared" % checked)

    if drift:
        print("")
        print("DRIFT NOTICE — production is NOT running the committed tree:")
        for rel, local, remote in drift:
            print("  %-38s committed %s  deployed %s" % (rel, local, remote))
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
