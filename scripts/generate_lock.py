#!/usr/bin/env python3
"""generate_lock.py — produce requirements-lock.txt (full hash-locked closure).

WHY (the 2026-08-22 boot-crash incident, made impossible):
    The Dockerfile used to `pip install "anthropic>=0.30" ...` — a
    floating resolve at every image build.  When anthropic 1.0.0 moved
    its HTTP stack to httpx2, the float silently removed the transitive
    httpx that seven engine modules import directly, and the freshly
    built container crash-looped.  A hash lock removes the float
    channel entirely: the image installs EXACTLY the pinned versions,
    `--require-hashes` refuses anything unpinned or tampered, and a new
    major released to PyPI cannot enter the image until a human reruns
    this script and reviews the diff.

STRATEGY (the pip-compile strategy, implemented on pip's own JSON
report so the toolchain needs no extra dev dependency):
  1. INPUTS — the runtime dependency list from pyproject.toml
     [project.dependencies], plus the two Docker-only runtime additions
     (DOCKER_EXTRAS below: uvicorn's [standard] server extras and
     python-multipart for FastAPI uploads — both installed by the
     Dockerfile today but absent from pyproject), plus the build
     backend pins (BUILD_DEPS) so `pip install --no-deps
     --no-build-isolation -e .` needs nothing outside the lock.
  2. RESOLVE — `pip install --dry-run --ignore-installed --report` run
     under THIS interpreter.  The repo floor is py3.9 (pyproject
     requires-python >=3.9; the local venv is 3.9), so resolving on 3.9
     yields the SUPERSET closure: 3.9-era backports (typing_extensions
     etc.) install harmlessly on the Docker image's 3.11, while the
     reverse direction (resolving on 3.11) would silently drop them.
  3. HASH — for every pinned name==version, fetch sha256 digests of ALL
     non-yanked artifacts from the PyPI JSON API (exactly the set
     pip-compile --generate-hashes emits), so the same lock installs on
     macOS-arm64 dev machines and linux-amd64/arm64 images alike.
  4. GUARD — every pinned version's requires-python must admit BOTH 3.9
     and the Docker image's 3.11; the pins must SATISFY every input
     specifier (this is the incident proof: anthropic's pyproject
     ceiling `<1.0` is checked against the actual pin, so a 1.0.0 float
     cannot even be WRITTEN into the lock, and --require-hashes makes
     it uninstallable besides); httpx must be present as the direct
     dependency it always was.
  5. EMIT — deterministic requirements-lock.txt (sorted, no
     timestamps) with an `# input-digest:` header over the input spec
     list.  scripts/check_supply_chain.py recomputes that digest from
     pyproject + the declared extras and fails when the lock is stale.

USAGE
    .venv/bin/python scripts/generate_lock.py            # writes requirements-lock.txt
    .venv/bin/python scripts/generate_lock.py --check    # resolve+verify, write nothing

Exit codes: 0 = written/verified, 1 = guard failure, 2 = could not run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO / "requirements-lock.txt"
PYPROJECT = REPO / "pyproject.toml"

#: Docker-only RUNTIME additions — installed by the Dockerfile today but
#: not declared in pyproject [project.dependencies].  Kept HERE (and
#: echoed into the lock header as `# docker-extra:` lines) so the
#: lock↔pyproject sync gate can reconstruct the exact input set.
#:   uvicorn[standard]  — uvloop/httptools/websockets/watchfiles server
#:                        extras the image runs with;
#:   python-multipart   — FastAPI form/file-upload parsing (documents
#:                        upload surface).
#:   greenlet           — SQLAlchemy's async/C-extension companion. It is
#:                        a TRANSITIVE dep of sqlalchemy, but pulled through
#:                        a `platform_machine in (aarch64, x86_64, ...)`
#:                        marker that is FALSE on this repo's usual resolve
#:                        host (macOS arm64 reports 'arm64', not 'aarch64'),
#:                        so a lock resolved here silently omits it — then
#:                        the linux/amd64 image build fails under
#:                        --require-hashes ("greenlet>=1 ... not pinned").
#:                        Declared here so it is ALWAYS in the closure and
#:                        pinned with all-artifact hashes (incl. the linux
#:                        cp311 wheel) regardless of the resolving host's
#:                        platform. This is the platform-marker analogue of
#:                        the py-version superset the floor-resolve gives.
DOCKER_EXTRAS = [
    "uvicorn[standard]>=0.27",
    "python-multipart>=0.0.20",
    "greenlet>=1",
]

#: Build-backend pins (pyproject [build-system].requires) — locked so the
#: editable install runs with --no-build-isolation and NOTHING is ever
#: fetched outside the hash-checked set during an image build.
BUILD_DEPS = [
    "setuptools>=68",
    "wheel",
]

#: The two interpreter targets the lock must serve (floor = resolve env).
PY_FLOOR = "3.9"
PY_DOCKER = "3.11"

#: Representative FULL versions used for requires-python admission
#: checks.  A bare "3.9" parses as 3.9.0, which specifiers like
#: cryptography's `!=3.9.0,!=3.9.1,>=3.9` legitimately exclude while
#: still admitting the 3.9.6 this repo actually runs — so the check
#: must use real micro versions: the RESOLVING interpreter itself for
#: the floor, and a current python:3.11-slim micro for the image.
PY_FLOOR_FULL = "%d.%d.%d" % sys.version_info[:3]
PY_DOCKER_FULL = "3.11.9"


class LockError(RuntimeError):
    pass


# ── pyproject parsing (tomllib → tomli → pip's vendored tomli) ─────────


def _load_toml(path: Path) -> Dict[str, Any]:
    parsers = []
    try:
        import tomllib  # type: ignore  # py3.11+

        parsers.append(tomllib)
    except ImportError:
        pass
    try:
        import tomli  # type: ignore

        parsers.append(tomli)
    except ImportError:
        pass
    try:
        from pip._vendor import tomli as pip_tomli  # type: ignore

        parsers.append(pip_tomli)
    except ImportError:
        pass
    for parser in parsers:
        try:
            with open(path, "rb") as fh:
                return parser.load(fh)
        except Exception:  # noqa: BLE001 — try the next parser
            continue
    raise LockError("no TOML parser available (tomllib/tomli/pip vendored)")


def runtime_deps() -> List[str]:
    data = _load_toml(PYPROJECT)
    deps = (data.get("project") or {}).get("dependencies") or []
    if not deps:
        raise LockError("pyproject.toml carries no [project].dependencies")
    return [str(d).strip() for d in deps]


def input_specs() -> Tuple[List[str], List[str], List[str]]:
    """(pyproject deps, docker extras, build deps) — the full input set."""
    return runtime_deps(), list(DOCKER_EXTRAS), list(BUILD_DEPS)


def input_digest(pyproject_deps: List[str], extras: List[str],
                 build: List[str]) -> str:
    """Deterministic digest of the lock's inputs.  The sync gate
    recomputes this from pyproject + the lock's own header lines."""
    lines = (
        ["python-floor:%s" % PY_FLOOR]
        + sorted("dep:%s" % d for d in pyproject_deps)
        + sorted("docker-extra:%s" % e for e in extras)
        + sorted("build-dep:%s" % b for b in build)
    )
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


# ── name / specifier helpers (packaging → pip vendored fallback) ───────


def _packaging():
    try:
        from packaging.requirements import Requirement
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version

        return Requirement, SpecifierSet, Version
    except ImportError:
        from pip._vendor.packaging.requirements import Requirement  # type: ignore
        from pip._vendor.packaging.specifiers import SpecifierSet  # type: ignore
        from pip._vendor.packaging.version import Version  # type: ignore

        return Requirement, SpecifierSet, Version


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# ── resolution (pip's own resolver, JSON report) ───────────────────────


def resolve_closure(specs: List[str]) -> Dict[str, str]:
    """{normalized name: version} pip would install fresh for `specs`
    under THIS interpreter."""
    with tempfile.TemporaryDirectory() as tmp:
        report_path = Path(tmp) / "report.json"
        cmd = [
            sys.executable, "-m", "pip", "install",
            "--dry-run", "--ignore-installed", "--quiet",
            "--report", str(report_path),
            *specs,
        ]
        proc = subprocess.run(
            cmd, cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        if proc.returncode != 0:
            raise LockError(
                "pip resolution failed:\n%s"
                % proc.stderr.decode("utf-8", "replace")[-4000:]
            )
        report = json.loads(report_path.read_text(encoding="utf-8"))
    pins: Dict[str, str] = {}
    for item in report.get("install") or []:
        meta = item.get("metadata") or {}
        name = normalize_name(str(meta.get("name") or ""))
        version = str(meta.get("version") or "")
        if name and version:
            pins[name] = version
    if not pins:
        raise LockError("pip report contained no resolved packages")
    return pins


# ── hashes + requires-python from the PyPI JSON API ────────────────────


def fetch_release(name: str, version: str,
                  timeout: float = 30.0) -> Dict[str, Any]:
    url = "https://pypi.org/pypi/%s/%s/json" % (name, version)
    last_err: Optional[Exception] = None
    for _attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                return json.load(resp)
        except Exception as exc:  # noqa: BLE001 — retry then fail loudly
            last_err = exc
    raise LockError("PyPI metadata fetch failed for %s==%s: %s"
                    % (name, version, last_err))


def artifact_hashes(release: Dict[str, Any], name: str,
                    version: str) -> List[str]:
    digests: List[str] = []
    for artifact in release.get("urls") or []:
        if artifact.get("yanked"):
            continue
        sha = ((artifact.get("digests") or {}).get("sha256") or "").strip()
        if sha:
            digests.append(sha)
    if not digests:
        raise LockError("no non-yanked artifacts with sha256 for %s==%s"
                        % (name, version))
    return sorted(set(digests))


def check_requires_python(release: Dict[str, Any], name: str,
                          version: str) -> None:
    _Req, SpecifierSet, Version = _packaging()
    rp = ((release.get("info") or {}).get("requires_python") or "").strip()
    if not rp:
        return
    spec = SpecifierSet(rp)
    for py in (PY_FLOOR_FULL, PY_DOCKER_FULL):
        if not spec.contains(Version(py), prereleases=True):
            raise LockError(
                "%s==%s requires-python %r excludes Python %s — the lock "
                "must install on both the %s floor and the %s Docker image"
                % (name, version, rp, py, PY_FLOOR, PY_DOCKER)
            )


# ── guards (the incident proof) ────────────────────────────────────────


def verify_pins_satisfy_inputs(pins: Dict[str, str],
                               all_specs: List[str]) -> List[str]:
    """Every input specifier must be SATISFIED by its pin.  Returns
    human-readable proof lines (used for the anthropic incident proof)."""
    Requirement, _SpecifierSet, Version = _packaging()
    proofs: List[str] = []
    for spec in all_specs:
        req = Requirement(spec)
        name = normalize_name(req.name)
        pinned = pins.get(name)
        if pinned is None:
            raise LockError("input %r resolved to no pin" % spec)
        if req.specifier and not req.specifier.contains(
            Version(pinned), prereleases=False
        ):
            raise LockError(
                "pin %s==%s does not satisfy input specifier %r"
                % (name, pinned, spec)
            )
        proofs.append("%s==%s satisfies %r" % (name, pinned, spec))
    if "httpx" not in pins:
        raise LockError(
            "httpx missing from the closure — it is a DIRECT engine "
            "dependency (the 2026-08-22 incident class)"
        )
    return proofs


# ── emit ───────────────────────────────────────────────────────────────


def render_lock(pins: Dict[str, str], hashes: Dict[str, List[str]],
                pyproject_deps: List[str], extras: List[str],
                build: List[str]) -> str:
    digest = input_digest(pyproject_deps, extras, build)
    lines: List[str] = [
        "# requirements-lock.txt — FULL hash-locked runtime closure.",
        "# GENERATED by scripts/generate_lock.py — DO NOT EDIT BY HAND.",
        "# Regenerate: .venv/bin/python scripts/generate_lock.py",
        "#",
        "# Resolved on the Python %s floor; every pin's requires-python is"
        % PY_FLOOR,
        "# verified to admit %s (the Docker image) as well.  Hashes cover"
        % PY_DOCKER,
        "# EVERY non-yanked PyPI artifact of each pinned version, so the",
        "# same lock installs on dev macOS and linux images alike.",
        "# Install: pip install --require-hashes -r requirements-lock.txt",
        "#",
        "# Sync contract (enforced by scripts/check_supply_chain.py):",
        "# the input-digest below is recomputed from pyproject",
        "# [project.dependencies] + the docker-extra/build-dep lines here;",
        "# any drift fails the gate until this file is regenerated.",
        "# input-digest: sha256:%s" % digest,
    ]
    for extra in extras:
        lines.append("# docker-extra: %s" % extra)
    for dep in build:
        lines.append("# build-dep: %s" % dep)
    lines.append("")
    for name in sorted(pins):
        version = pins[name]
        entry = ["%s==%s \\" % (name, version)]
        digest_list = hashes[name]
        for i, sha in enumerate(digest_list):
            tail = " \\" if i < len(digest_list) - 1 else ""
            entry.append("    --hash=sha256:%s%s" % (sha, tail))
        lines.extend(entry)
    lines.append("")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="resolve + verify guards, write nothing")
    args = parser.parse_args(argv)
    try:
        pyproject_deps, extras, build = input_specs()
        all_specs = pyproject_deps + extras + build
        print("resolving %d input specs on Python %s (pip dry-run report)…"
              % (len(all_specs), PY_FLOOR))
        pins = resolve_closure(all_specs)
        print("closure: %d pinned packages" % len(pins))

        proofs = verify_pins_satisfy_inputs(pins, all_specs)
        for proof in proofs:
            print("  ✓ %s" % proof)

        hashes: Dict[str, List[str]] = {}
        for name in sorted(pins):
            release = fetch_release(name, pins[name])
            check_requires_python(release, name, pins[name])
            hashes[name] = artifact_hashes(release, name, pins[name])
            print("  hashed %s==%s (%d artifacts)"
                  % (name, pins[name], len(hashes[name])))

        content = render_lock(pins, hashes, pyproject_deps, extras, build)
        if args.check:
            print("CHECK OK — %d packages, nothing written" % len(pins))
            return 0
        LOCK_PATH.write_text(content, encoding="utf-8")
        print("wrote %s (%d packages, %d hashes)"
              % (LOCK_PATH.name, len(pins),
                 sum(len(v) for v in hashes.values())))
        return 0
    except LockError as exc:
        print("LOCK GENERATION FAILED — %s" % exc, file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print("LOCK GENERATION ERROR — %s: %s"
              % (type(exc).__name__, exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
