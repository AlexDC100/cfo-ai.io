#!/usr/bin/env python3
"""check_supply_chain.py — the trust-boundary gate for what ships in the image.

Five checks, an exemption register, and a planted-violation self-test.
Born from the 2026-08-22 boot-crash: an UNPINNED `anthropic>=0.30` in
the Dockerfile floated to 1.0.0, whose new httpx2 stack removed the
transitive httpx seven engine modules import directly — the freshly
built container crash-looped.  This gate makes that entire class of
failure impossible to reintroduce silently.

CHECK C1 — LOCK SHAPE
    requirements-lock.txt exists, and every entry is `name==version`
    with at least one `--hash=sha256:`.  No ranges, no editables, no
    VCS refs — a lock that carries a float is not a lock.

CHECK C2 — LOCK ↔ PYPROJECT SYNC (the incident proof)
    The lock's `# input-digest:` header is recomputed from pyproject
    [project.dependencies] + the lock's own `# docker-extra:` /
    `# build-dep:` declarations (via scripts/generate_lock.py — ONE
    digest definition).  Any dependency edit without a regenerated lock
    fails here.  Additionally every pyproject specifier must be
    SATISFIED by its pin — so `anthropic>=0.30,<1.0` is proven against
    the pinned version on every run (a 1.0.0 float cannot pass), and
    httpx must be pinned (the direct-dep regression guard).

CHECK C3 — DOCKERFILE INSTALLS FROM THE LOCK
    The engine Dockerfile must copy requirements-lock.txt and install
    with `--require-hashes -r requirements-lock.txt`; the project
    install must be `--no-deps` (and build-isolation-free once build
    deps are locked) so NO pip invocation in the image build can reach
    the resolver.  Any `pip install` argument that names a package
    (pinned or not) outside the lock file is a floating install —
    exactly the F1-incident shortcut — and fails.

CHECK C4 — NO FLOATING IMAGE TAGS
    Every `FROM` in Dockerfile* and every `image:` in docker-compose*
    must carry an explicit, non-floating reference: `:latest`, a
    missing tag, or a bare-major tag (`python:3`) all fail; a digest
    pin (`@sha256:…`) always passes; stage aliases and `scratch` are
    understood.  (Digest pinning is recommended, not required — this
    machine has no docker daemon/registry access to resolve digests
    truthfully, and a gate must never invent one.)

CHECK C5 — SECRETS SCAN, over the tracked tree
    High-precision credential detectors (private-key blocks, Anthropic
    / OpenAI / Stripe-live / AWS / GitHub / Slack / Google key shapes,
    and JWTs whose DECODED payload claims a privileged role such as
    service_role) over every text unit of the shipping tree.  File
    enumeration and binary-safe text extraction are REUSED from
    scripts/check_corpus_policy.py (the corpus gate's tree-only
    machinery — that script is not touched); the lexicon precision
    philosophy is inherited: shapes alone are chosen so that the
    baseline tree scans CLEAN, and anything weaker is not a detector.
    Matches are printed MASKED — a gate that echoes a live secret into
    CI logs would itself be the leak.

EXEMPTIONS — scripts/supply_chain_allowlist.txt
    `path | selector | reason`, selector is a CATEGORY name (c4_image
    / c5_<detector> / …) — never the matched text, so the register can
    never smuggle a secret into the tree.  Every fired exemption prints
    on every run; stale entries are reported.

SELF-TEST — `--self-test`
    Planted violations, asserted CAUGHT: a floating `FROM python:latest`
    and a tagless image; an unhashed lock line; a floating `pip install
    "anthropic>=0.30"`; planted credentials (concatenated at runtime —
    the plants never exist as literals in this file) including a
    service-role JWT; plus clean fixtures asserted PASSING (the
    false-positive half of the contract).  CI runs `--self-test` first,
    then the live gate.

Exit codes: 0 = pass, 1 = violations, 2 = the gate could not run.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import check_corpus_policy as ccp  # noqa: E402  (tree enumeration + text units — reused, not touched)
import generate_lock as glock  # noqa: E402  (the ONE input-digest definition)

#: Pins that must be present in the lock for C1/C2 to have read it.
#: `anthropic` is the incident dependency itself and `httpx` is the
#: transitive it removed — the two the gate was built around.
CANARY_PINS = ("anthropic", "httpx")

LOCK_NAME = "requirements-lock.txt"
ALLOWLIST_PATH = "scripts/supply_chain_allowlist.txt"

#: The engine image build file (the one that must install from the lock).
ENGINE_DOCKERFILE = "Dockerfile"


class GateError(RuntimeError):
    pass


class Violation(tuple):
    """(path, category, detail) — one supply-chain finding."""

    __slots__ = ()

    def __new__(cls, path: str, category: str, detail: str):
        return super().__new__(cls, (path, category, detail))

    @property
    def path(self) -> str:
        return self[0]

    @property
    def category(self) -> str:
        return self[1]

    @property
    def detail(self) -> str:
        return self[2]


def _mask(secret: str) -> str:
    """Never echo a credential: first 6 chars + length."""
    return "%s… (%d chars)" % (secret[:6], len(secret))


# ── C1: lock shape ─────────────────────────────────────────────────────

_PIN_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._\-\[\],]*)==([A-Za-z0-9.!+*_\-]+)\s*\\?\s*$")
_HASH_RE = re.compile(r"^--hash=sha256:[0-9a-f]{64}\s*\\?\s*$")


def parse_lock(text: str, path: str = LOCK_NAME) -> Tuple[Dict[str, str], Dict[str, int], List[Violation], List[str], List[str], str]:
    """Parse a lock file's text.

    Returns (pins {name: version}, hash counts {name: n}, violations,
    docker-extra lines, build-dep lines, declared input digest)."""
    pins: Dict[str, str] = {}
    hash_counts: Dict[str, int] = {}
    violations: List[Violation] = []
    extras: List[str] = []
    build: List[str] = []
    declared_digest = ""
    current: Optional[str] = None

    for line_no, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            current = None
            continue
        if line.startswith("#"):
            body = line.lstrip("#").strip()
            if body.startswith("docker-extra:"):
                extras.append(body[len("docker-extra:"):].strip())
            elif body.startswith("build-dep:"):
                build.append(body[len("build-dep:"):].strip())
            elif body.startswith("input-digest:"):
                declared_digest = body[len("input-digest:"):].strip()
            continue
        if line.startswith("--hash="):
            if current is None:
                violations.append(Violation(
                    path, "c1_lock_shape",
                    "line %d: hash with no preceding pin" % line_no))
            elif not _HASH_RE.match(line):
                violations.append(Violation(
                    path, "c1_lock_shape",
                    "line %d: malformed hash line" % line_no))
            else:
                hash_counts[current] = hash_counts.get(current, 0) + 1
            continue
        match = _PIN_RE.match(line)
        if not match:
            violations.append(Violation(
                path, "c1_lock_shape",
                "line %d: not an exact hash-locked pin: %r "
                "(ranges/editables/VCS refs are floats, not locks)"
                % (line_no, line[:80])))
            current = None
            continue
        name = glock.normalize_name(re.sub(r"\[.*\]", "", match.group(1)))
        pins[name] = match.group(2)
        hash_counts.setdefault(name, 0)
        current = name

    for name, count in sorted(hash_counts.items()):
        if count == 0:
            violations.append(Violation(
                path, "c1_lock_shape",
                "%s==%s carries NO --hash — an unhashed pin is "
                "tamperable and --require-hashes will refuse it"
                % (name, pins.get(name, "?"))))
    return pins, hash_counts, violations, extras, build, declared_digest


def check_lock_shape(repo: Path) -> Tuple[Dict[str, str], List[str], List[str], str, List[Violation]]:
    lock = repo / LOCK_NAME
    if not lock.is_file():
        return {}, [], [], "", [Violation(
            LOCK_NAME, "c1_lock_shape",
            "requirements-lock.txt does not exist — generate it with "
            "scripts/generate_lock.py")]
    pins, _counts, violations, extras, build, digest = parse_lock(
        lock.read_text(encoding="utf-8"))
    if not pins and not violations:
        violations.append(Violation(
            LOCK_NAME, "c1_lock_shape", "lock file carries no pins"))
    return pins, extras, build, digest, violations


# ── C2: lock ↔ pyproject sync + the incident proof ─────────────────────


def check_lock_sync(repo: Path, pins: Dict[str, str], extras: List[str],
                    build: List[str], declared_digest: str
                    ) -> Tuple[List[Violation], List[str]]:
    violations: List[Violation] = []
    proofs: List[str] = []
    if not pins:
        return violations, proofs  # C1 already failed loudly
    try:
        pyproject_deps = glock.runtime_deps()
    except Exception as exc:  # noqa: BLE001
        raise GateError("cannot read pyproject dependencies: %s" % exc)

    expected = "sha256:%s" % glock.input_digest(pyproject_deps, extras, build)
    if declared_digest != expected:
        violations.append(Violation(
            LOCK_NAME, "c2_lock_sync",
            "input-digest mismatch (lock declares %r, pyproject + declared "
            "extras compute %r) — a dependency changed without regenerating "
            "the lock; run scripts/generate_lock.py"
            % (declared_digest or "<missing>", expected)))

    Requirement, _S, Version = glock._packaging()
    for spec in pyproject_deps + list(extras) + list(build):
        try:
            req = Requirement(spec)
        except Exception:  # noqa: BLE001
            violations.append(Violation(
                "pyproject.toml", "c2_lock_sync",
                "unparseable dependency specifier %r" % spec))
            continue
        name = glock.normalize_name(req.name)
        pinned = pins.get(name)
        if pinned is None:
            violations.append(Violation(
                LOCK_NAME, "c2_lock_sync",
                "declared dependency %r has no pin in the lock" % spec))
            continue
        if req.specifier and not req.specifier.contains(Version(pinned),
                                                        prereleases=False):
            violations.append(Violation(
                LOCK_NAME, "c2_lock_sync",
                "pin %s==%s VIOLATES declared specifier %r"
                % (name, pinned, spec)))
        else:
            proofs.append("%s==%s satisfies %r" % (name, pinned, spec))
    if "httpx" not in pins:
        violations.append(Violation(
            LOCK_NAME, "c2_lock_sync",
            "httpx is not pinned — it is a DIRECT engine dependency; its "
            "absence is exactly the 2026-08-22 crash-loop class"))
    return violations, proofs


# ── C3: the Dockerfile installs from the lock ──────────────────────────

_CONTINUATION = re.compile(r"\\\s*\n")


def _logical_lines(text: str) -> List[Tuple[int, str]]:
    """Dockerfile text as (first line number, continuation-joined line).

    Comment lines (first non-blank char `#`) are dropped BEFORE
    continuation joining — exactly Docker's own parse order — so a
    comment that quotes a forbidden instruction (e.g. this repo's
    Dockerfile documenting the incident's `pip install "anthropic>=0.30"`
    line) can never fire a violation, and a comment inside a continued
    RUN does not sever the continuation."""
    physical = [
        (idx + 1, line)
        for idx, line in enumerate(text.splitlines())
        if not line.lstrip().startswith("#")
    ]
    out: List[Tuple[int, str]] = []
    i = 0
    while i < len(physical):
        start_no, line = physical[i]
        while line.rstrip().endswith("\\") and i + 1 < len(physical):
            i += 1
            line = line.rstrip()[:-1] + " " + physical[i][1]
        out.append((start_no, line))
        i += 1
    return out


def check_dockerfile_lock_install(text: str,
                                  path: str = ENGINE_DOCKERFILE
                                  ) -> List[Violation]:
    violations: List[Violation] = []
    copies_lock = False
    has_hashed_install = False

    for line_no, line in _logical_lines(text):
        stripped = line.strip()
        if re.match(r"(?i)^copy\b", stripped) and LOCK_NAME in stripped:
            copies_lock = True
        for m in re.finditer(r"\bpip3?\s+install\b([^&|;]*)", line):
            args = m.group(1)
            tokens = args.split()
            uses_lock = ("-r" in tokens or "--requirement" in tokens) \
                and any(LOCK_NAME in t for t in tokens)
            hashed = "--require-hashes" in tokens
            if uses_lock and hashed:
                has_hashed_install = True
            elif uses_lock and not hashed:
                violations.append(Violation(
                    path, "c3_dockerfile_lock",
                    "line %d: installs from the lock WITHOUT "
                    "--require-hashes — hash enforcement is the point"
                    % line_no))
            # Editable/self install: must not re-resolve dependencies.
            if "-e" in tokens or "--editable" in tokens or "." in tokens:
                if "--no-deps" not in tokens:
                    violations.append(Violation(
                        path, "c3_dockerfile_lock",
                        "line %d: project install without --no-deps — pip "
                        "could resolve NEW floating deps outside the lock"
                        % line_no))
            # Any bare package argument = a floating install.
            skip_next = False
            for tok in tokens:
                if skip_next:
                    skip_next = False
                    continue
                if tok in ("-r", "--requirement", "-c", "--constraint",
                           "-e", "--editable", "--index-url",
                           "--extra-index-url", "--report", "--platform",
                           "--python-version", "--implementation", "--abi",
                           "--target", "--prefix", "--root"):
                    skip_next = True
                    continue
                if tok.startswith("-") or tok in (".",):
                    continue
                if LOCK_NAME in tok:
                    continue
                violations.append(Violation(
                    path, "c3_dockerfile_lock",
                    "line %d: floating dependency install %r — every "
                    "runtime dep must come from %s (the 2026-08-22 "
                    "incident channel)" % (line_no, tok.strip("\"'"),
                                           LOCK_NAME)))

    if not copies_lock:
        violations.append(Violation(
            path, "c3_dockerfile_lock",
            "does not COPY %s into the build context" % LOCK_NAME))
    if not has_hashed_install:
        violations.append(Violation(
            path, "c3_dockerfile_lock",
            "no `pip install --require-hashes -r %s` — the image is not "
            "built from the lock" % LOCK_NAME))
    return violations


# ── C4: no floating image tags ─────────────────────────────────────────

_FROM_RE = re.compile(r"(?i)^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)"
                      r"(?:\s+AS\s+(\S+))?\s*$")
_IMAGE_KEY_RE = re.compile(r"^\s*image:\s*[\"']?([^\"'#\s]+)")


def _image_ref_violation(ref: str) -> Optional[str]:
    """None when the reference is acceptably pinned; else the reason."""
    if "@sha256:" in ref:
        return None  # digest-pinned — immutable, the gold standard
    if ref == "scratch":
        return None
    if "$" in ref:
        return ("variable image reference %r — resolve to an explicit "
                "pinned reference" % ref)
    # Split a possible registry:port prefix from the tag colon.
    name, _sep, tag = ref.rpartition(":")
    if not name or "/" in tag:
        return "no tag — an untagged image silently means :latest"
    if tag == "latest":
        return "`:latest` is a floating tag"
    if re.fullmatch(r"\d+", tag):
        return ("bare-major tag %r floats across minor/patch releases — "
                "pin at least major.minor" % tag)
    return None


def check_image_tags(files: Sequence[Tuple[str, str]]) -> List[Violation]:
    """`files` = [(path, text)] of Dockerfile*/docker-compose* content."""
    violations: List[Violation] = []
    for path, text in files:
        base = Path(path).name.lower()
        if base.startswith("dockerfile") or base.endswith(".dockerfile"):
            aliases: set = set()
            for line_no, line in _logical_lines(text):
                m = _FROM_RE.match(line)
                if not m:
                    continue
                ref, alias = m.group(1), m.group(2)
                if ref in aliases:  # multi-stage: FROM <earlier stage>
                    continue
                reason = _image_ref_violation(ref)
                if reason:
                    violations.append(Violation(
                        path, "c4_image_tags",
                        "line %d: FROM %s — %s" % (line_no, ref, reason)))
                if alias:
                    aliases.add(alias)
        else:  # docker-compose*
            for line_no, line in enumerate(text.splitlines(), 1):
                m = _IMAGE_KEY_RE.match(line)
                if not m:
                    continue
                reason = _image_ref_violation(m.group(1))
                if reason:
                    violations.append(Violation(
                        path, "c4_image_tags",
                        "line %d: image: %s — %s"
                        % (line_no, m.group(1), reason)))
    return violations


def _container_build_files(paths: Sequence[str]) -> List[str]:
    out = []
    for p in paths:
        base = Path(p).name.lower()
        if base.startswith("dockerfile") and not base.endswith(".dockerignore"):
            out.append(p)
        elif base.endswith(".dockerfile"):
            out.append(p)
        elif base.startswith("docker-compose") and base.endswith((".yml", ".yaml")):
            out.append(p)
    return out


# ── C5: secrets scan ───────────────────────────────────────────────────

#: (category, compiled pattern).  PRECISION RULE (inherited from the
#: corpus gate): a detector ships only if the CLEAN TREE scans clean —
#: shape-only guesses that fire on fixtures/coordinates are not
#: detectors.  All shapes verified zero-noise on this repo 2026-08-23.
SECRET_PATTERNS: List[Tuple[str, Any]] = [
    ("c5_private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("c5_anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{24,}")),
    ("c5_openai_key", re.compile(r"\bsk-proj-[A-Za-z0-9_\-]{24,}|\bsk-[A-Za-z0-9]{48}\b")),
    ("c5_stripe_live_key", re.compile(r"\b[sr]k_live_[A-Za-z0-9]{16,}")),
    ("c5_aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("c5_github_token", re.compile(r"\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("c5_slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("c5_google_api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
]

_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")

#: JWT payload roles that mean "this token bypasses RLS" — a tracked
#: file carrying one is a live privileged credential.  `anon` keys are
#: PUBLIC by design and never flagged.
PRIVILEGED_JWT_ROLES = ("service_role", "supabase_admin")


def _privileged_jwt_role(token: str) -> Optional[str]:
    try:
        seg = token.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        payload = json.loads(base64.urlsafe_b64decode(seg))
        role = str(payload.get("role") or "")
        return role if role in PRIVILEGED_JWT_ROLES else None
    except Exception:  # noqa: BLE001 — not a decodable JWT → not a finding
        return None


def scan_text_for_secrets(text: str) -> List[Tuple[str, str]]:
    """[(category, MASKED match)] for one text unit."""
    found: List[Tuple[str, str]] = []
    for category, pattern in SECRET_PATTERNS:
        for m in pattern.finditer(text):
            found.append((category, _mask(m.group(0))))
    for m in _JWT_RE.finditer(text):
        role = _privileged_jwt_role(m.group(0))
        if role:
            found.append((
                "c5_privileged_jwt",
                "%s [decoded role=%s]" % (_mask(m.group(0)), role)))
    return found


def check_secrets(paths: Sequence[str]) -> Tuple[List[Violation], List[str]]:
    violations: List[Violation] = []
    skipped: List[str] = []
    for path in paths:
        units, reason = ccp.text_units(path)
        if reason:
            if reason != "binary":
                skipped.append("%s: %s" % (path, reason))
            continue
        seen: set = set()
        for unit in units:
            for category, masked in scan_text_for_secrets(unit):
                key = (category, masked)
                if key in seen:
                    continue
                seen.add(key)
                violations.append(Violation(path, category, masked))
    return violations, skipped


# ── exemption register (category selectors only — no term smuggling) ───


def load_allowlist(repo: Path) -> Tuple[List[Tuple[str, str, str, int]], List[Violation]]:
    full = repo / ALLOWLIST_PATH
    entries: List[Tuple[str, str, str, int]] = []
    failures: List[Violation] = []
    if not full.is_file():
        return entries, failures
    known = {c for c, _p in SECRET_PATTERNS} | {
        "c5_privileged_jwt", "c1_lock_shape", "c2_lock_sync",
        "c3_dockerfile_lock", "c4_image_tags",
    }
    for line_no, raw in enumerate(full.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        where = "%s:%d" % (ALLOWLIST_PATH, line_no)
        if len(parts) != 3 or not all(parts[:2]):
            failures.append(Violation(
                ALLOWLIST_PATH, "allowlist",
                "%s: expected `path | category | reason`" % where))
            continue
        path, selector, reason = parts
        if not reason:
            failures.append(Violation(
                ALLOWLIST_PATH, "allowlist",
                "%s: exemption without a reason — an unjustified exemption "
                "is a hole in the control" % where))
            continue
        if selector not in known:
            failures.append(Violation(
                ALLOWLIST_PATH, "allowlist",
                "%s: selector %r is not a known CATEGORY (%s) — matched "
                "text is never written here"
                % (where, selector, ", ".join(sorted(known)))))
            continue
        entries.append((path, selector, reason, line_no))
    return entries, failures


def apply_exemptions(
    violations: List[Violation],
    entries: Sequence[Tuple[str, str, str, int]],
) -> Tuple[List[Violation], List[str], List[str]]:
    live: List[Violation] = []
    exempted: List[str] = []
    fired: set = set()
    for v in violations:
        entry = next((e for e in entries
                      if e[0] == v.path and e[1] == v.category), None)
        if entry is None:
            live.append(v)
        else:
            fired.add(entry[3])
            exempted.append("EXEMPT  %s: %s (%s:%d) — %s"
                            % (v.path, v.category, ALLOWLIST_PATH,
                               entry[3], entry[2]))
    stale = ["NOTICE  stale exemption: %s:%d (%s in %s) matches nothing"
             % (ALLOWLIST_PATH, e[3], e[1], e[0])
             for e in entries if e[3] not in fired]
    return live, exempted, stale


# ── self-test (planted violations, plants built at runtime) ────────────


def self_test() -> Tuple[int, List[str]]:
    lines: List[str] = []
    failures: List[str] = []

    def expect(label: str, condition: bool) -> None:
        mark = "ok" if condition else "FAIL"
        lines.append("  [%s] %s" % (mark, label))
        if not condition:
            failures.append(label)

    # C1 — planted unhashed pin caught; hashed lock passes.
    dirty_lock = "anthropic==0.30.0\nhttpx==0.27.0 \\\n    --hash=sha256:%s\n" % ("a" * 64)
    _p, _h, viol, _e, _b, _d = parse_lock(dirty_lock, path="<planted>")
    expect("C1 catches a pin with no hash",
           any(v.category == "c1_lock_shape" and "anthropic" in v.detail
               for v in viol))
    clean_lock = "httpx==0.27.0 \\\n    --hash=sha256:%s\n" % ("a" * 64)
    _p, _h, viol, _e, _b, _d = parse_lock(clean_lock, path="<planted>")
    expect("C1 passes a fully hashed pin", viol == [])
    _p, _h, viol, _e, _b, _d = parse_lock("anthropic>=0.30\n", path="<planted>")
    expect("C1 refuses a range (a float is not a lock)",
           any(v.category == "c1_lock_shape" for v in viol))

    # C3 — the incident Dockerfile caught; the wired form passes.
    floating = 'FROM python:3.11-slim\nRUN pip install "anthropic>=0.30" "pandas>=2.0"\n'
    viol = check_dockerfile_lock_install(floating, path="<planted>")
    expect("C3 catches the floating `pip install \"anthropic>=0.30\"`",
           any("anthropic" in v.detail for v in viol))
    wired = (
        "FROM python:3.11-slim\n"
        "COPY requirements-lock.txt ./\n"
        "RUN pip install --require-hashes -r requirements-lock.txt\n"
        "RUN pip install --no-deps --no-build-isolation -e .\n"
    )
    expect("C3 passes the lock-wired Dockerfile",
           check_dockerfile_lock_install(wired, path="<planted>") == [])
    unhashed = (
        "COPY requirements-lock.txt ./\n"
        "RUN pip install -r requirements-lock.txt\n"
        "RUN pip install --no-deps -e .\n"
    )
    viol = check_dockerfile_lock_install(unhashed, path="<planted>")
    expect("C3 catches a lock install missing --require-hashes",
           any("--require-hashes" in v.detail for v in viol))
    commented = (
        "# the old `pip install \"anthropic>=0.30\"` line caused the crash\n"
        "COPY requirements-lock.txt ./\n"
        "RUN pip install --require-hashes -r requirements-lock.txt\n"
        "RUN pip install --no-deps --no-build-isolation -e .\n"
        "# FROM python:latest would also be wrong\n"
    )
    expect("C3/C4 ignore Dockerfile comments (a comment installs nothing)",
           check_dockerfile_lock_install(commented, path="<planted>") == []
           and check_image_tags([("<planted>/Dockerfile", commented)]) == [])

    # C4 — planted floating tags caught; pinned forms pass.
    planted = [
        ("planted/Dockerfile", "FROM python:latest\nFROM node\nFROM python:3\n"),
        ("planted/docker-compose.yml", "services:\n  cache:\n    image: redis\n"),
    ]
    viol = check_image_tags(planted)
    expect("C4 catches `FROM python:latest`",
           any("latest" in v.detail and v.path == "planted/Dockerfile"
               for v in viol))
    expect("C4 catches a tagless FROM",
           any("no tag" in v.detail and v.path == "planted/Dockerfile"
               for v in viol))
    expect("C4 catches a bare-major tag",
           any("bare-major" in v.detail for v in viol))
    expect("C4 catches a tagless compose image:",
           any(v.path == "planted/docker-compose.yml" for v in viol))
    pinned = [(
        "planted/Dockerfile",
        "FROM python:3.11-slim AS base\nFROM base\n"
        "FROM nginx:1.27-alpine@sha256:%s\n" % ("b" * 64),
    )]
    expect("C4 passes explicit tags, stage refs and digest pins",
           check_image_tags(pinned) == [])

    # C5 — planted credentials caught (plants CONCATENATED at runtime so
    # this file never carries a credential-shaped literal itself).
    fake_aws = "AKIA" + "IOSFODNN7EXAMPLE"
    fake_key_block = "-----BEGIN RSA " + "PRIVATE KEY-----"
    fake_anthropic = "sk-" + "ant-" + "a" * 30
    def _b64(obj: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(obj).encode()).decode().rstrip("=")
    service_jwt = ".".join([
        _b64({"alg": "HS256"}), _b64({"role": "service_role"}), "e" * 20,
    ])
    anon_jwt = ".".join([
        _b64({"alg": "HS256"}), _b64({"role": "anon"}), "e" * 20,
    ])
    hits = scan_text_for_secrets(
        "cfg = '%s'\n%s\nkey=%s\n" % (fake_aws, fake_key_block, fake_anthropic))
    got = {c for c, _m in hits}
    expect("C5 catches a planted AWS access key", "c5_aws_access_key" in got)
    expect("C5 catches a planted private-key block", "c5_private_key" in got)
    expect("C5 catches a planted Anthropic key", "c5_anthropic_key" in got)
    expect("C5 flags a service_role JWT",
           any(c == "c5_privileged_jwt"
               for c, _m in scan_text_for_secrets("k=" + service_jwt)))
    expect("C5 does NOT flag the public anon JWT",
           scan_text_for_secrets("k=" + anon_jwt) == [])
    expect("C5 masks the match (never echoes the credential)",
           all(fake_aws not in m for _c, m in hits))

    if failures:
        lines.append("SELF-TEST: FAIL — %d assertion(s)" % len(failures))
        return 1, lines
    lines.append("SELF-TEST: PASS — every planted violation caught, every "
                 "clean fixture passed")
    return 0, lines


# ── driver ─────────────────────────────────────────────────────────────


def run(verbose: bool = False) -> Tuple[int, List[str]]:
    lines: List[str] = []
    violations: List[Violation] = []

    pins, extras, build, digest, c1 = check_lock_shape(REPO)
    violations.extend(c1)

    c2, proofs = check_lock_sync(REPO, pins, extras, build, digest)
    violations.extend(c2)
    for proof in proofs:
        if verbose:
            lines.append("PROOF   %s" % proof)
    # The incident proof prints on EVERY run, verbose or not.
    anth = next((p for p in proofs if p.startswith("anthropic==")), None)
    if anth:
        lines.append("PROOF   %s — a 1.0.0 float cannot enter the image "
                     "(pin + --require-hashes)" % anth)

    dockerfile = REPO / ENGINE_DOCKERFILE
    if dockerfile.is_file():
        violations.extend(check_dockerfile_lock_install(
            dockerfile.read_text(encoding="utf-8")))
    else:
        violations.append(Violation(
            ENGINE_DOCKERFILE, "c3_dockerfile_lock",
            "engine Dockerfile missing"))

    tracked = ccp.tracked_paths()
    build_files = [
        (p, (REPO / p).read_text(encoding="utf-8", errors="replace"))
        for p in _container_build_files(tracked)
    ]
    violations.extend(check_image_tags(build_files))
    lines.append("checked image refs in: %s"
                 % ", ".join(p for p, _t in build_files))

    secret_violations, skipped = check_secrets(tracked)
    violations.extend(secret_violations)
    if verbose:
        for entry in skipped:
            lines.append("SKIP    %s" % entry)

    entries, allow_failures = load_allowlist(REPO)
    violations.extend(allow_failures)
    live, exempted, stale = apply_exemptions(violations, entries)
    lines.extend(exempted)
    lines.extend(stale)

    lines.append(
        "checked %d tracked file(s); lock pins=%d; %d exemption(s) on file"
        % (len(tracked), len(pins), len(entries)))

    # ── DISCOVERY CANARY ────────────────────────────────────────────
    #
    # C1/C2 read the lock, C3-C5 sweep the tracked tree. An unreadable
    # lock parsed to zero pins and an empty file sweep both produce zero
    # violations, and "SUPPLY CHAIN: PASS" reads the same either way.
    # The incident this gate exists for (an unpinned anthropic>=0.30
    # floating to 1.0.0) is invisible to a gate that read no pins.
    discovery = []
    if not tracked:
        discovery.append("0 tracked files swept")
    if not pins:
        discovery.append("the lock parsed to 0 pins — C1/C2 checked nothing")
    for want in CANARY_PINS:
        if want not in pins:
            discovery.append(
                "%r is not among the %d pin(s) read from the lock — either "
                "the dependency left the image (update this canary "
                "deliberately) or the lock reader is broken"
                % (want, len(pins)))
    if discovery:
        lines.append("")
        lines.append("SUPPLY CHAIN: DISCOVERY BROKEN")
        for d in discovery:
            lines.append("  x %s" % d)
        lines.append("  Zero violations over zero inputs is not a clean "
                     "supply chain.")
        return 1, lines

    if live:
        lines.append("")
        lines.append("SUPPLY CHAIN: FAIL — %d violation(s)" % len(live))
        for v in live:
            lines.append("  x [%s] %s: %s" % (v.category, v.path, v.detail))
        return 1, lines
    lines.append("SUPPLY CHAIN: PASS")
    return 0, lines


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--self-test", action="store_true",
                        help="planted-violation self-test (no repo scan)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            code, lines = self_test()
        else:
            code, lines = run(verbose=args.verbose)
    except (GateError, ccp.GateError) as exc:
        print("SUPPLY CHAIN: ERROR — %s" % exc)
        return 2
    for line in lines:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
