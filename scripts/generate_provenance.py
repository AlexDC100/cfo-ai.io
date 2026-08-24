#!/usr/bin/env python3
"""generate_provenance.py — SLSA-style build provenance for the deploy artifact.

WHAT
    Emits one in-toto Statement (v1) with a SLSA provenance v1 predicate
    answering, for any running image, the three incident-postmortem
    questions the 2026-08-22 crash-loop made expensive: WHICH commit was
    this built from, WHAT dependency inputs went in (hash of the lock —
    so "the image drifted from the tree" is detectable by digest, not by
    archaeology), and WHO/WHERE built it.

SHAPE
    {
      "_type": "https://in-toto.io/Statement/v1",
      "subject": [ {name, digest{gitCommit}}, sbom file if present ],
      "predicateType": "https://slsa.dev/provenance/v1",
      "predicate": {
        "buildDefinition": {
          "buildType":          "https://scandia-engine/docker-compose-build/v1",
          "externalParameters": { repository, commit, dirty, entryPoint },
          "resolvedDependencies": [ git source, Dockerfile, pyproject,
                                    requirements-lock.txt — each with
                                    sha256 ],
          "internalParameters": { "inputsDigest": sha256 over the sorted
                                  (path, sha256) list of the build
                                  inputs — ONE value to compare between
                                  a deploy record and a rebuilt tree }
        },
        "runDetails": {
          "builder": { "id": CI builder or local:user@host },
          "metadata": { invocationId, startedOn, finishedOn }
        }
      }
    }

    Written to deploy/artifacts/provenance.slsa.json (GITIGNORED —
    provenance describes one concrete build, so it travels WITH the
    deploy artifact, never in source control).  A dirty working tree is
    recorded honestly (externalParameters.dirty=true + a stderr warning)
    rather than refused — zero-owner mode: never block a deploy, always
    tell the truth in the record.

USAGE
    .venv/bin/python scripts/generate_provenance.py            # default path
    .venv/bin/python scripts/generate_provenance.py --output PATH
    .venv/bin/python scripts/generate_provenance.py --print    # stdout too

Exit codes: 0 = written, 2 = could not run.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "deploy" / "artifacts" / "provenance.slsa.json"
SBOM_PATH = REPO / "deploy" / "artifacts" / "sbom.cdx.json"

#: The build inputs whose digests define this build.  The lock is the
#: load-bearing one (the whole dependency closure); Dockerfile and
#: pyproject pin the recipe and the declared intent.
BUILD_INPUTS = ("Dockerfile", "pyproject.toml", "requirements-lock.txt")


def _git(*args: str) -> str:
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(REPO),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _builder_id() -> str:
    """CI identity when present; otherwise an honest local identity."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return "https://github.com/actions/runner#%s" % (
            os.environ.get("GITHUB_WORKFLOW", "unknown"))
    if os.environ.get("CI"):
        return "ci:%s" % (os.environ.get("CI_NAME")
                          or os.environ.get("BUILD_ID") or "unknown")
    try:
        return "local:%s@%s" % (getpass.getuser(), socket.gethostname())
    except Exception:  # noqa: BLE001
        return "local:unknown"


def build_statement() -> Dict[str, Any]:
    started = _now()
    commit = _git("rev-parse", "HEAD") or "unknown"
    branch = _git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    origin = _git("remote", "get-url", "origin") or "local"
    dirty = bool(_git("status", "--porcelain"))

    resolved: List[Dict[str, Any]] = [{
        "uri": "git+%s@%s" % (origin, branch),
        "digest": {"gitCommit": commit},
        "name": "source",
    }]
    input_digests: List[str] = []
    for rel in BUILD_INPUTS:
        path = REPO / rel
        if not path.is_file():
            continue
        sha = _sha256_file(path)
        input_digests.append("%s:%s" % (rel, sha))
        resolved.append({
            "uri": rel,
            "digest": {"sha256": sha},
            "name": rel,
        })
    inputs_digest = hashlib.sha256(
        "\n".join(sorted(input_digests)).encode("utf-8")).hexdigest()

    subject: List[Dict[str, Any]] = [{
        "name": "scandia-engine backend image (docker compose build backend)",
        "digest": {"gitCommit": commit},
    }]
    if SBOM_PATH.is_file():
        subject.append({
            "name": "deploy/artifacts/%s" % SBOM_PATH.name,
            "digest": {"sha256": _sha256_file(SBOM_PATH)},
        })

    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": subject,
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": "https://scandia-engine/docker-compose-build/v1",
                "externalParameters": {
                    "repository": origin,
                    "branch": branch,
                    "commit": commit,
                    "dirty": dirty,
                    "entryPoint": "docker compose build backend",
                },
                "internalParameters": {
                    "inputsDigest": "sha256:%s" % inputs_digest,
                    "inputs": sorted(input_digests),
                },
                "resolvedDependencies": resolved,
            },
            "runDetails": {
                "builder": {"id": _builder_id()},
                "metadata": {
                    "invocationId": str(uuid.uuid4()),
                    "startedOn": started,
                    "finishedOn": _now(),
                },
            },
        },
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--print", action="store_true", dest="also_print")
    args = parser.parse_args(argv)
    try:
        statement = build_statement()
        payload = json.dumps(statement, indent=2) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
        ext = statement["predicate"]["buildDefinition"]["externalParameters"]
        if ext["dirty"]:
            print("WARNING: working tree is dirty — provenance records "
                  "dirty=true; a deploy from a dirty tree is not "
                  "reproducible from the recorded commit", file=sys.stderr)
        print("wrote %s (commit %s, inputsDigest %s)"
              % (args.output, ext["commit"][:12],
                 statement["predicate"]["buildDefinition"]
                 ["internalParameters"]["inputsDigest"][:19] + "…"))
        if args.also_print:
            print(payload, end="")
        return 0
    except Exception as exc:  # noqa: BLE001
        print("PROVENANCE ERROR — %s: %s" % (type(exc).__name__, exc),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
