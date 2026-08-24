#!/usr/bin/env python3
"""generate_sbom.py — CycloneDX SBOM for the engine image's dependency closure.

WHAT
    Emits a CycloneDX 1.5 JSON bill of materials describing EXACTLY what
    the backend image installs: the hash-locked closure in
    requirements-lock.txt plus the application component itself
    (scandia-engine @ pyproject version, git commit recorded).  The SBOM
    is a per-build artifact — generated fresh on every build/deploy,
    written under deploy/artifacts/ which is GITIGNORED (an SBOM is
    derived output; committing one would instantly drift from the lock).

TOOLCHAIN (documented choice)
    1. `syft` when the binary is on PATH — the industry scanner sees the
       full picture (OS packages too, when pointed at an image).  Invoked
       as `syft dir:<repo> -o cyclonedx-json`.
    2. FALLBACK (the mode this repo actually runs today — no syft binary
       on the dev machine, and the gate must not download tools): a
       lock-derived CycloneDX built from requirements-lock.txt itself.
       This is deliberately the LOCK, not `pip list` over some venv: the
       venv carries dev extras (pytest, hypothesis…) that never enter
       the image, while the lock IS the image's install set — C3 of
       scripts/check_supply_chain.py guarantees no other channel exists.
       Per-component sha256 digests come straight from the lock's
       `--hash=` lines (every non-yanked PyPI artifact of the pinned
       version), and license names are enriched best-effort from local
       installed-dist metadata when the SAME version is present locally
       (offline-safe: absent metadata simply omits the field).

    The active mode is stamped into the SBOM itself at
    metadata.properties["scandia:sbom:mode"] = "syft" | "lock".

DETERMINISM
    The fallback SBOM is reproducible for a given (commit, lock):
    serialNumber is a UUIDv5 over both digests and the timestamp honors
    SOURCE_DATE_EPOCH when set.  (syft output is whatever syft emits.)

USAGE
    .venv/bin/python scripts/generate_sbom.py                  # deploy/artifacts/sbom.cdx.json
    .venv/bin/python scripts/generate_sbom.py --output PATH
    .venv/bin/python scripts/generate_sbom.py --no-syft        # force the lock fallback

Exit codes: 0 = written, 1 = inputs invalid, 2 = could not run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO / "requirements-lock.txt"
DEFAULT_OUT = REPO / "deploy" / "artifacts" / "sbom.cdx.json"

_PIN_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._\-]*)==([A-Za-z0-9.!+*_\-]+)\s*\\?\s*$")
_HASH_RE = re.compile(r"^--hash=sha256:([0-9a-f]{64})\s*\\?\s*$")


class SbomError(RuntimeError):
    pass


def _git(*args: str) -> str:
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(REPO),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001 — SBOMs must generate outside git too
        pass
    return ""


def _timestamp() -> str:
    """UTC ISO-8601; SOURCE_DATE_EPOCH wins for reproducible builds."""
    sde = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if sde.isdigit():
        dt = datetime.fromtimestamp(int(sde), tz=timezone.utc)
    else:
        dt = datetime.now(timezone.utc)
    return dt.replace(microsecond=0).isoformat()


def parse_lock_with_hashes(text: str) -> List[Tuple[str, str, List[str]]]:
    """[(name, version, [sha256, …])] from the lock.  Shape is trusted:
    scripts/check_supply_chain.py C1 fails the build on anything that
    is not `name==version` + `--hash=sha256:…` lines."""
    out: List[Tuple[str, str, List[str]]] = []
    current: Optional[Tuple[str, str, List[str]]] = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        h = _HASH_RE.match(line)
        if h and current is not None:
            current[2].append(h.group(1))
            continue
        m = _PIN_RE.match(line)
        if m:
            current = (m.group(1), m.group(2), [])
            out.append(current)
    if not out:
        raise SbomError("no pins parsed from %s" % LOCK_PATH.name)
    return out


def _local_license(name: str, version: str) -> Optional[str]:
    """License string from local dist metadata, ONLY when the locally
    installed version matches the pin (else it would describe the wrong
    release). Best-effort and offline — absence just omits the field."""
    try:
        from importlib import metadata as im  # py3.8+

        dist = im.distribution(name)
        if (dist.version or "") != version:
            return None
        meta = dist.metadata
        lic = (meta.get("License-Expression") or "").strip()
        if not lic:
            lic = (meta.get("License") or "").strip()
        if lic and lic.upper() != "UNKNOWN" and len(lic) < 120:
            return lic
        for classifier in meta.get_all("Classifier") or []:
            if classifier.startswith("License ::"):
                return classifier.split("::")[-1].strip()
    except Exception:  # noqa: BLE001
        pass
    return None


def _app_version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"',
                  (REPO / "pyproject.toml").read_text(encoding="utf-8"),
                  re.M)
    return m.group(1) if m else "0.0.0"


def build_lock_sbom() -> Dict[str, Any]:
    lock_text = LOCK_PATH.read_text(encoding="utf-8")
    lock_digest = hashlib.sha256(lock_text.encode("utf-8")).hexdigest()
    commit = _git("rev-parse", "HEAD") or "unknown"
    version = _app_version()

    components: List[Dict[str, Any]] = []
    for name, pin_version, hashes in parse_lock_with_hashes(lock_text):
        purl = "pkg:pypi/%s@%s" % (name.lower(), pin_version)
        component: Dict[str, Any] = {
            "type": "library",
            "bom-ref": purl,
            "name": name,
            "version": pin_version,
            "purl": purl,
        }
        if hashes:
            # One entry per locked PyPI artifact of this version — the
            # exact set --require-hashes will accept at image build.
            component["hashes"] = [
                {"alg": "SHA-256", "content": sha} for sha in hashes
            ]
        lic = _local_license(name, pin_version)
        if lic:
            component["licenses"] = [{"license": {"name": lic}}]
        components.append(component)

    serial = uuid.uuid5(uuid.NAMESPACE_URL,
                        "scandia-engine-sbom:%s:%s" % (commit, lock_digest))
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": "urn:uuid:%s" % serial,
        "version": 1,
        "metadata": {
            "timestamp": _timestamp(),
            "tools": [{
                "vendor": "scandia-engine",
                "name": "scripts/generate_sbom.py",
                "version": "1.0.0",
            }],
            "component": {
                "type": "application",
                "bom-ref": "pkg:generic/scandia-engine@%s" % version,
                "name": "scandia-engine",
                "version": version,
                "properties": [
                    {"name": "scandia:git:commit", "value": commit},
                ],
            },
            "properties": [
                {"name": "scandia:sbom:mode", "value": "lock"},
                {"name": "scandia:sbom:source", "value": LOCK_PATH.name},
                {"name": "scandia:lock:sha256", "value": lock_digest},
            ],
        },
        "components": components,
    }


def run_syft(out_path: Path) -> bool:
    syft = shutil.which("syft")
    if not syft:
        return False
    proc = subprocess.run(
        [syft, "dir:%s" % REPO, "-o", "cyclonedx-json"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        print("syft failed (%d), falling back to lock-derived SBOM:\n%s"
              % (proc.returncode,
                 proc.stderr.decode("utf-8", "replace")[-1000:]),
              file=sys.stderr)
        return False
    try:
        doc = json.loads(proc.stdout.decode("utf-8"))
        meta = doc.setdefault("metadata", {})
        meta.setdefault("properties", []).append(
            {"name": "scandia:sbom:mode", "value": "syft"})
        payload = json.dumps(doc, indent=2, sort_keys=False)
    except Exception:  # noqa: BLE001 — ship syft's bytes untouched
        payload = proc.stdout.decode("utf-8", "replace")
    out_path.write_text(payload + "\n", encoding="utf-8")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--no-syft", action="store_true",
                        help="skip the syft probe; always emit the "
                             "lock-derived SBOM")
    args = parser.parse_args(argv)
    try:
        if not LOCK_PATH.is_file():
            print("SBOM FAILED — %s missing; run scripts/generate_lock.py"
                  % LOCK_PATH.name, file=sys.stderr)
            return 1
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if not args.no_syft and run_syft(args.output):
            print("wrote %s (mode=syft)" % args.output)
            return 0
        sbom = build_lock_sbom()
        args.output.write_text(
            json.dumps(sbom, indent=2) + "\n", encoding="utf-8")
        print("wrote %s (mode=lock, %d components)"
              % (args.output, len(sbom["components"])))
        return 0
    except SbomError as exc:
        print("SBOM FAILED — %s" % exc, file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print("SBOM ERROR — %s: %s" % (type(exc).__name__, exc),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
