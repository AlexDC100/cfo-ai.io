#!/usr/bin/env python3
"""PROD CANARY REPLAY — the sentinel corpus case, offline AND against prod.

Nightly guard (called from .github/workflows/nightly-deep.yml, also
runnable by the operator over ssh — same habit as measure_bs_drift.py)
that proves the code path serving production still reproduces the frozen
sentinel golden byte-for-byte. The sentinel is the prod_scandia_frozen
case (corpus case id `saga_10_col` — the SAGA 10-col golden built from
files/prod_scandia_frozen_31.12.2025.xlsx).

Two phases:

  1. OFFLINE (always) — run scripts/corpus_replay.py --case <sentinel>
     in THIS checkout. Byte-compares every artifact (extraction /
     classification / statuses / served_envelope / gateway_facts)
     against corpus/<sentinel>/expected/. No network, no live API —
     corpus_replay's own no-live-API guard holds.

  2. PROD (only when both PROD_SSH_KEY and PROD_HOST env vars are set,
     i.e. the GitHub secrets exist) — ssh to the VPS and:
       a. docker exec cfo-ai-backend python3 /app/scripts/corpus_replay.py
          --case <sentinel>   → the replay running INSIDE the shipped
          container, against the corpus baked into the image;
       b. regenerate the sentinel's served_envelope.json inside the
          container (UPDATE_GOLDEN=1 into a /tmp copy of the case, so
          the image's own goldens are never touched) and BYTE-compare
          it against THIS checkout's corpus golden — catching an image
          whose engine drifted from the repo even if the image's baked
          goldens drifted with it.

     When the secrets are absent the phase prints a documented SKIP and
     exits 0 — CI without prod credentials stays green by design; the
     operator runs the full canary manually:
         PROD_HOST=<vps-ip> PROD_SSH_KEY="$(cat ~/.ssh/id_prod)" \\
             .venv/bin/python scripts/prod_canary_replay.py

Env: PROD_SSH_KEY (private key material), PROD_HOST, optional
PROD_SSH_USER (default root), PROD_CONTAINER (default cfo-ai-backend).

Exit codes: 0 pass (incl. documented prod SKIP), 1 canary failure,
2 internal/usage error. Python 3.9+, stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional

DEFAULT_SENTINEL = "saga_10_col"          # prod_scandia_frozen 10-col golden
DEFAULT_CONTAINER = "cfo-ai-backend"
REMOTE_REPLAY = "/app/scripts/corpus_replay.py"
REMOTE_CORPUS = "/app/corpus"
REMOTE_SCRATCH = "/tmp/prod_canary_corpus"


def _repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return here.parent


def _offline_replay(repo: Path, corpus_root: Path, case: str) -> int:
    print("── Phase 1: OFFLINE sentinel replay (%s) ──" % case)
    case_dir = corpus_root / case
    if not case_dir.is_dir():
        print("sentinel case not found: %s" % case_dir)
        print("(corpus/ must be present in this checkout — the sentinel is "
              "the frozen prod_scandia SAGA 10-col case)")
        return 2
    proc = subprocess.run(
        [sys.executable, str(repo / "scripts" / "corpus_replay.py"),
         "--corpus-root", str(corpus_root), "--case", case],
        cwd=str(repo),
    )
    if proc.returncode != 0:
        print("OFFLINE sentinel replay FAILED (exit %d)" % proc.returncode)
        return 1
    print("OFFLINE sentinel replay: PASS")
    return 0


def _ssh_base(key_path: str, user: str, host: str) -> List[str]:
    return [
        "ssh",
        "-i", key_path,
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=20",
        "%s@%s" % (user, host),
    ]


def _first_json_diffs(expected_text: str, actual_text: str,
                      limit: int = 12) -> List[str]:
    """Small field-level diff for the failure report (paths only)."""
    try:
        expected = json.loads(expected_text)
        actual = json.loads(actual_text)
    except Exception:  # noqa: BLE001 — fall back to a blunt report
        return ["(payload is not valid JSON — raw byte diff only)"]

    diffs: List[str] = []

    def walk(path: str, a, b) -> None:
        if len(diffs) >= limit:
            return
        if type(a) is not type(b):
            diffs.append("%s: type %s != %s"
                         % (path or "<root>", type(a).__name__,
                            type(b).__name__))
            return
        if isinstance(a, dict):
            for k in sorted(set(a) | set(b)):
                if k not in a:
                    diffs.append("%s.%s: only in prod" % (path, k))
                elif k not in b:
                    diffs.append("%s.%s: only in golden" % (path, k))
                else:
                    walk("%s.%s" % (path, k) if path else k, a[k], b[k])
        elif isinstance(a, list):
            if len(a) != len(b):
                diffs.append("%s: length %d != %d" % (path, len(a), len(b)))
            for i, (x, y) in enumerate(zip(a, b)):
                walk("%s[%d]" % (path, i), x, y)
        elif a != b:
            diffs.append("%s: golden=%r prod=%r" % (path, a, b))

    walk("", expected, actual)
    return diffs[:limit]


def _prod_replay(repo: Path, corpus_root: Path, case: str,
                 key_material: str, host: str, user: str,
                 container: str) -> int:
    print("── Phase 2: PROD in-container replay (%s@%s / %s) ──"
          % (user, host, container))
    key_file: Optional[str] = None
    try:
        fd, key_file = tempfile.mkstemp(prefix="prod_canary_key_")
        os.write(fd, key_material.encode("utf-8"))
        if not key_material.endswith("\n"):
            os.write(fd, b"\n")
        os.close(fd)
        os.chmod(key_file, stat.S_IRUSR | stat.S_IWUSR)
        ssh = _ssh_base(key_file, user, host)

        # 2a — the replay itself, inside the running container, against
        # the corpus goldens baked into the shipped image.
        step_a = ssh + [
            "docker exec %s python3 %s --case %s"
            % (container, REMOTE_REPLAY, case)
        ]
        proc = subprocess.run(step_a, capture_output=True, text=True)
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            print("PROD in-container replay FAILED (exit %d)"
                  % proc.returncode)
            return 1
        print("PROD in-container replay vs image goldens: PASS")

        # 2b — regenerate the served envelope INSIDE the container into a
        # scratch copy (never touching the image's goldens) and byte-
        # compare it against THIS checkout's golden. Catches an image
        # whose engine AND baked goldens drifted together.
        remote_script = (
            "set -e; "
            "rm -rf {scratch}; mkdir -p {scratch}; "
            "cp -r {corpus}/{case} {scratch}/{case}; "
            "rm -rf {scratch}/{case}/expected; "
            "UPDATE_GOLDEN=1 python3 {replay} --corpus-root {scratch} "
            "--case {case} 1>&2; "
            "cat {scratch}/{case}/expected/served_envelope.json"
        ).format(scratch=REMOTE_SCRATCH, corpus=REMOTE_CORPUS,
                 case=case, replay=REMOTE_REPLAY)
        step_b = ssh + ["docker exec %s sh -c '%s'" % (container,
                                                       remote_script)]
        proc = subprocess.run(step_b, capture_output=True, text=True)
        sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            print("PROD envelope regeneration FAILED (exit %d)"
                  % proc.returncode)
            return 1

        golden_path = corpus_root / case / "expected" / "served_envelope.json"
        if not golden_path.is_file():
            print("local golden missing: %s" % golden_path)
            return 2
        golden_text = golden_path.read_text(encoding="utf-8")
        prod_text = proc.stdout
        if prod_text.rstrip("\n") == golden_text.rstrip("\n"):
            print("PROD served envelope vs repo golden: BYTE-IDENTICAL")
            return 0
        print("PROD served envelope DIFFERS from repo golden "
              "(%d vs %d bytes):" % (len(prod_text), len(golden_text)))
        for line in _first_json_diffs(golden_text, prod_text):
            print("  ✗ %s" % line)
        return 1
    finally:
        if key_file and os.path.exists(key_file):
            os.unlink(key_file)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--case", default=DEFAULT_SENTINEL,
                        help="sentinel corpus case id (default: %s)"
                             % DEFAULT_SENTINEL)
    parser.add_argument("--corpus-root", default=None,
                        help="corpus root (default: <repo>/corpus)")
    parser.add_argument("--skip-offline", action="store_true",
                        help="run only the prod phase (operator use)")
    args = parser.parse_args(argv)

    repo = _repo_root()
    corpus_root = Path(args.corpus_root) if args.corpus_root else repo / "corpus"

    if not args.skip_offline:
        rc = _offline_replay(repo, corpus_root, args.case)
        if rc != 0:
            return rc
    print()

    key_material = os.environ.get("PROD_SSH_KEY", "").strip()
    host = os.environ.get("PROD_HOST", "").strip()
    if not key_material or not host:
        print("── Phase 2: PROD in-container replay — SKIP ──")
        print("PROD_SSH_KEY / PROD_HOST not set (the GitHub secrets do not "
              "exist or were not passed).")
        print("This is the documented degrade path: CI stays green without "
              "prod credentials; the prod half of the canary is run by the "
              "operator over ssh, same habit as measure_bs_drift.py:")
        print("    PROD_HOST=<vps> PROD_SSH_KEY=\"$(cat ~/.ssh/id_prod)\" \\")
        print("        .venv/bin/python scripts/prod_canary_replay.py")
        print("PROD CANARY: PASS (offline) + SKIP (prod — no credentials)")
        return 0

    user = os.environ.get("PROD_SSH_USER", "root").strip() or "root"
    container = (os.environ.get("PROD_CONTAINER", DEFAULT_CONTAINER).strip()
                 or DEFAULT_CONTAINER)
    rc = _prod_replay(repo, corpus_root, args.case, key_material, host,
                      user, container)
    print()
    print("PROD CANARY: %s" % ("PASS" if rc == 0 else "FAIL"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
