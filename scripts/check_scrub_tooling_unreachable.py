#!/usr/bin/env python3
"""check_scrub_tooling_unreachable.py — PROOF BY ABSENCE, ENFORCED.

WHAT THIS GATE ASSERTS
    No CI job, git hook, package script, container build, deploy script
    or pytest entry point in this repository can reach
    `scripts/history-scrub/` execution.

WHY IT EXISTS
    `scripts/history-scrub/` is the (operator-only) remedial tooling
    referenced by `docs/decisions/ADR-corpus-history-sibiu.md` and by
    `corpus/pdf_positional/meta.yaml`. Running it REWRITES GIT HISTORY.
    History rewriting is a deliberate, human-reviewed, one-way operation
    with a blast radius of every clone and every open PR in existence.
    It must therefore never be reachable from anything that runs on a
    trigger — a push, a cron, a merge, a `pip install -e .`, a
    `npm test`, an image build.

    "We would never wire that up" is a habit, not a control. Habits are
    invisible when they break. This gate turns the habit into a checked
    invariant: it enumerates every automation surface in the tree, walks
    the transitive closure of the files those surfaces invoke, sweeps
    every executable file in the tracked tree, and fails if the scrub
    tooling is named anywhere in that set. The closure it proved is
    PRINTED on every run, so the proof is auditable rather than
    asserted: you can see WHAT was covered, not merely that nothing was
    found.

THE FOUR LAYERS
    L1  AUTOMATION CONFIGS — the enumerated trigger surfaces:
        `.github/**` YAML (workflows + composite actions), tracked hook
        directories (`.githooks/`, `.husky/`), the LOCAL hook directory
        (`.git/hooks/`, non-`.sample`) which is untracked but is a real
        execution surface on this machine, `.pre-commit-config.yaml`,
        every `package.json` `scripts` block, `pyproject.toml` /
        `setup.py` / `setup.cfg` / `tox.ini`, `Makefile`,
        `Dockerfile*` / `docker-compose*.yml`, everything under
        `deploy/`, every `conftest.py` (pytest executes these at
        collection), and the other CI systems' well-known filenames
        (`.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`, ...) so that
        ADDING one of them cannot quietly open a hole.

    L2  TRANSITIVE CLOSURE — every repo-relative file path named inside
        an L1 config is itself scanned, and so on to a fixpoint. A
        workflow that runs `bash deploy/foo.sh` is only as safe as
        `deploy/foo.sh`.

    L3  WHOLE-TREE EXECUTABLE SWEEP — every tracked file with an
        executable/script suffix, whether or not automation reaches it
        today. This closes the "not wired up YET" gap: code that names
        the scrub tooling is one `run:` line away from being reachable.
        Prose (`.md`) and data payloads (`corpus/**/meta.yaml`) are NOT
        swept — documenting the tooling is the ADR's whole job.

    L4  VISIBILITY NOTICE — every tracked file that mentions the scrub
        tooling at all, prose included, is listed. Nothing about this
        subject is allowed to be invisible; the point is that the
        references that remain are the DOCUMENTED ones.

    L1-L3 are failures. L4 is output.

SELF-EXEMPTION
    This file and its pytest wrapper necessarily contain the forbidden
    token — they are the thing that looks for it. They are exempted by
    exact path, and the exemption list is printed on every run. Nothing
    else is ever exempt; there is no configurable allowlist, because an
    allowlist is exactly how a control like this dies.

Exit codes: 0 = proven absent, 1 = reachable / named, 2 = the gate could
not run.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()

#: The thing that must never be reachable. Matched case-insensitively in
#: both spellings so a rename to `history_scrub` does not slip through.
FORBIDDEN = re.compile(r"history[-_]scrub", re.IGNORECASE)

#: The two files that must contain the token in order to police it.
#:
#: NOTE THE FILENAMES. Neither contains the forbidden token, and that is
#: deliberate: a gate named `check_no_history_scrub_automation.py` cannot
#: be invoked from a workflow without the workflow tripping the gate, so
#: it would be un-passable by design — the exact failure mode this gate
#: exists to avoid creating. `tests/…::test_gate_name_is_invokable`
#: locks that property in.
#: Automation surfaces that must always be found. Absent from the
#: enumeration => the enumerator is broken, and the "no path reaches it"
#: conclusion is unearned.
CANARY_SURFACES = (
    "pyproject.toml",
    "Dockerfile",
)

SELF_EXEMPT = (
    "scripts/check_scrub_tooling_unreachable.py",
    "tests/engine/test_scrub_tooling_unreachable.py",
)

#: L1 — automation surfaces addressed by exact path.
AUTOMATION_FILES = (
    ".pre-commit-config.yaml",
    ".pre-commit-hooks.yaml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "Makefile",
    "makefile",
    "GNUmakefile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.override.yml",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    "azure-pipelines.yml",
    ".travis.yml",
    "bitbucket-pipelines.yml",
    "renovate.json",
)

#: L1 — automation surfaces addressed by directory. Every file beneath
#: is a surface; `.git/hooks` is filtered to non-`.sample` separately.
AUTOMATION_DIRS = (
    ".github",
    ".githooks",
    ".husky",
    ".circleci",
    "deploy",
    ".git/hooks",
)

#: L1 — automation surfaces addressed by glob from the repo root.
AUTOMATION_GLOBS = (
    "Dockerfile*",
    "docker-compose*.yml",
    "docker-compose*.yaml",
)

#: L1 — automation surfaces found anywhere in the tracked tree by name.
AUTOMATION_BASENAMES = (
    "package.json",
    "conftest.py",
)

#: L3 — suffixes that can EXECUTE. Prose and data payloads are excluded
#: on purpose: the ADR and the corpus meta.yaml are supposed to name the
#: tooling, and a gate that failed on its own documentation would be
#: un-passable by design.
EXECUTABLE_SUFFIXES = frozenset({
    ".py", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rb", ".pl", ".mk", ".make",
})

#: L3 — extensionless files that execute.
EXECUTABLE_BASENAMES = frozenset({
    "Makefile", "makefile", "GNUmakefile", "Jenkinsfile", "Dockerfile",
})

#: L2 — what a path reference looks like inside an automation config.
#: Requires at least one `/` so bare words are not chased, and a known
#: script/config suffix so prose nouns are not chased either.
_PATH_REF = re.compile(
    r"(?<![\w./~-])"
    r"((?:[\w.-]+/)+[\w.-]+"
    r"\.(?:py|sh|bash|zsh|ps1|bat|cmd|js|mjs|cjs|ts|tsx|rb|pl|mk|yml|yaml|toml|cfg|ini|json))"
)

#: Never chase into these — vendored trees are not this repo's automation.
_CLOSURE_EXCLUDE_PREFIXES = (
    "node_modules/", ".venv/", "venv/", "dist/", "build/", ".git/objects/",
)

#: OS detritus that Finder scatters through .github/ and deploy/. Not a
#: surface; listing it as one only makes the --verbose proof harder to
#: read, which makes the proof less likely to actually be read.
_NOISE_BASENAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini"})

_MAX_CLOSURE_ROUNDS = 12


class GateError(RuntimeError):
    pass


# ── tree access ────────────────────────────────────────────────────────


def tracked_paths() -> List[str]:
    """Repo-relative paths of everything tracked at HEAD.

    Read from the index (`ls-files`), not from a revision — this gate,
    like scripts/check_corpus_policy.py, judges the tree it is about to
    ship and never performs history archaeology.
    """
    try:
        proc = subprocess.run(
            ["git", "ls-files", "-z"], cwd=str(REPO), check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:  # pragma: no cover - environment
        raise GateError("git is not available: %s" % exc)
    except subprocess.CalledProcessError as exc:  # pragma: no cover
        raise GateError(
            "git ls-files failed: %s"
            % exc.stderr.decode("utf-8", "replace").strip()
        )
    out = proc.stdout.decode("utf-8", "replace")
    return [p for p in out.split("\0") if p and (REPO / p).is_file()]


def _read(rel: str) -> Optional[str]:
    """Text of a repo-relative file, or None when it is not readable as
    text (a binary payload cannot invoke anything)."""
    path = REPO / rel
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def _excluded(rel: str) -> bool:
    if Path(rel).name in _NOISE_BASENAMES:
        return True
    return rel.startswith(_CLOSURE_EXCLUDE_PREFIXES)


# ── L1: enumerate the automation surfaces ──────────────────────────────


def automation_surfaces(tracked: Sequence[str]) -> List[str]:
    """Every trigger surface in the tree, repo-relative and sorted.

    Includes untracked-but-real surfaces (`.git/hooks/*`), because a
    local hook executes regardless of whether git tracks it.
    """
    found: Set[str] = set()

    for name in AUTOMATION_FILES:
        if (REPO / name).is_file():
            found.add(name)

    for pattern in AUTOMATION_GLOBS:
        for path in sorted(REPO.glob(pattern)):
            if path.is_file():
                found.add(path.relative_to(REPO).as_posix())

    for dirname in AUTOMATION_DIRS:
        base = REPO / dirname
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(REPO).as_posix()
            # Git ships ~13 `*.sample` hooks in every clone; they are
            # inert by definition (git will not run a `.sample` file).
            if rel.startswith(".git/hooks/") and rel.endswith(".sample"):
                continue
            if _excluded(rel):
                continue
            found.add(rel)

    for rel in tracked:
        if _excluded(rel):
            continue
        if Path(rel).name in AUTOMATION_BASENAMES:
            found.add(rel)

    return sorted(found)


# ── L2: transitive closure over what those surfaces invoke ─────────────


def _is_invocable(rel: str) -> bool:
    """Could naming this path in a config cause it to RUN?

    Executables and automation configs can. A data payload cannot: a
    workflow whose `paths:` filter names `corpus/**` is declaring a
    TRIGGER, not invoking 17 fixtures — and sweeping data payloads into
    the closure would flag the ADR's own documented reference inside
    `corpus/pdf_positional/meta.yaml` as if it were a wired-up call.
    That reference is surfaced by the L4 notice instead, which is where
    documented prose belongs.
    """
    if Path(rel).name in EXECUTABLE_BASENAMES:
        return True
    if Path(rel).suffix in EXECUTABLE_SUFFIXES:
        return True
    # Config files count only inside an automation directory, where a
    # YAML really is a job definition rather than pack/corpus data.
    return rel.startswith(tuple(d + "/" for d in AUTOMATION_DIRS))


def _referenced_paths(text: str) -> Set[str]:
    """Repo-relative, invocable paths named in a config's text."""
    refs: Set[str] = set()
    for match in _PATH_REF.finditer(text):
        rel = match.group(1).lstrip("./")
        if not rel or _excluded(rel) or not _is_invocable(rel):
            continue
        if (REPO / rel).is_file():
            refs.add(rel)
    return refs


def closure(seeds: Sequence[str]) -> Tuple[List[str], int]:
    """Fixpoint over the files reachable from `seeds` by textual path
    reference. Returns (sorted closure, rounds taken)."""
    seen: Set[str] = set(seeds)
    frontier: Set[str] = set(seeds)
    rounds = 0
    while frontier and rounds < _MAX_CLOSURE_ROUNDS:
        rounds += 1
        nxt: Set[str] = set()
        for rel in sorted(frontier):
            text = _read(rel)
            if text is None:
                continue
            for ref in _referenced_paths(text):
                if ref not in seen:
                    seen.add(ref)
                    nxt.add(ref)
        frontier = nxt
    return sorted(seen), rounds


# ── L3: whole-tree executable sweep ────────────────────────────────────


def executable_files(tracked: Sequence[str]) -> List[str]:
    out: List[str] = []
    for rel in tracked:
        if _excluded(rel):
            continue
        name = Path(rel).name
        if name in EXECUTABLE_BASENAMES or Path(rel).suffix in EXECUTABLE_SUFFIXES:
            out.append(rel)
    return sorted(out)


# ── the scan ───────────────────────────────────────────────────────────


def _hits(rel: str) -> List[str]:
    """`lineno: line` for every forbidden mention, or [] when clean."""
    if rel in SELF_EXEMPT:
        return []
    text = _read(rel)
    if text is None:
        return []
    out: List[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if FORBIDDEN.search(line):
            out.append("%d: %s" % (lineno, line.strip()[:160]))
    return out


def scan(paths: Sequence[str]) -> Dict[str, List[str]]:
    return {rel: hits for rel in paths for hits in [_hits(rel)] if hits}


# ── driver ─────────────────────────────────────────────────────────────


def run(verbose: bool = False) -> Tuple[int, List[str], Dict[str, object]]:
    lines: List[str] = []
    tracked = tracked_paths()

    surfaces = automation_surfaces(tracked)
    reachable, rounds = closure(surfaces)
    execs = executable_files(tracked)

    l1 = scan(surfaces)
    l2 = scan([p for p in reachable if p not in set(surfaces)])
    l3 = scan([p for p in execs if p not in set(reachable)])

    # L4 — visibility: everything that names it, prose included.
    mentions = sorted(scan(tracked).keys())

    scrub_dir = REPO / "scripts" / "history-scrub"
    lines.append(
        "scrub tooling on disk: %s"
        % ("scripts/history-scrub/ EXISTS" if scrub_dir.is_dir()
           else "scripts/history-scrub/ absent")
    )
    lines.append(
        "proved over: %d automation surface(s) -> %d reachable file(s) "
        "in %d closure round(s); %d executable file(s) swept; "
        "%d tracked file(s) total"
        % (len(surfaces), len(reachable), rounds, len(execs), len(tracked))
    )
    lines.append(
        "self-exempt (must name the token to police it): %s"
        % ", ".join(SELF_EXEMPT)
    )
    if mentions:
        lines.append(
            "NOTICE  documented references (prose — not automation): %s"
            % ", ".join(mentions)
        )
    else:
        lines.append("NOTICE  no tracked file mentions the scrub tooling at all")

    if verbose:
        for rel in surfaces:
            lines.append("SURFACE %s" % rel)

    failures: List[Tuple[str, str, List[str]]] = []
    for layer, table in (("L1 automation config", l1),
                         ("L2 invoked by automation", l2),
                         ("L3 executable in tree", l3)):
        for rel in sorted(table):
            failures.append((layer, rel, table[rel]))

    report: Dict[str, object] = {
        "scrub_dir_exists": scrub_dir.is_dir(),
        "surfaces": surfaces,
        "reachable_count": len(reachable),
        "executable_count": len(execs),
        "tracked_count": len(tracked),
        "documented_mentions": mentions,
        "failures": [
            {"layer": layer, "path": rel, "hits": hits}
            for layer, rel, hits in failures
        ],
    }

    if failures:
        lines.append("")
        lines.append(
            "SCRUB-TOOLING REACHABILITY: FAIL — %d file(s) name the scrub "
            "tooling from an automation path" % len(failures)
        )
        for layer, rel, hits in failures:
            lines.append("  x [%s] %s" % (layer, rel))
            for hit in hits:
                lines.append("      %s" % hit)
        lines.append("")
        lines.append(
            "  Rewriting git history is a human-reviewed, one-way operation. "
            "Remove the reference; run the tooling by hand per "
            "docs/decisions/ADR-corpus-history-sibiu.md."
        )
        return 1, lines, report

    # ── DISCOVERY CANARY ────────────────────────────────────────────
    #
    # This gate is PROOF BY ABSENCE, and absence is exactly what an
    # empty enumeration also produces. If the surface enumerator found
    # nothing, the closure is empty, nothing names the scrub tooling,
    # and the PASS line below is printed having proved precisely
    # nothing. A proof by absence must therefore first prove PRESENCE
    # of the things it enumerated over.
    #
    # The canaries are the repo's own permanent automation surfaces —
    # if they are not in the set, the enumerator is not enumerating.
    #
    # SCOPE. The canary applies to a tree that actually HAS automation —
    # i.e. one where at least one canary surface file exists. The unit
    # suite drives this same run() over synthetic minimal trees (a lone
    # `.git/hooks/pre-push.sample`, a lone `package.json`), where "zero
    # automation surfaces" is the honest answer and must stay a pass. A
    # canary that fired there would make the gate untestable, which is
    # its own kind of broken.
    discovery = []
    present_canaries = [w for w in CANARY_SURFACES if (REPO / w).exists()]
    if present_canaries:
        if not surfaces:
            discovery.append("0 automation surfaces enumerated")
        if not execs:
            discovery.append("0 executable files swept")
        if not tracked:
            discovery.append("0 tracked files listed")
        surface_set = set(surfaces)
        for want in present_canaries:
            if want not in surface_set:
                discovery.append(
                    "%s exists but was not enumerated as an automation "
                    "surface" % want)
    if discovery:
        lines.append("")
        lines.append("SCRUB-TOOLING REACHABILITY: DISCOVERY BROKEN")
        for d in discovery:
            lines.append("  x %s" % d)
        lines.append("  Proof by absence over an empty set proves nothing. "
                     "It must not print PASS.")
        return 1, lines, report

    lines.append("")
    lines.append(
        "SCRUB-TOOLING REACHABILITY: PASS — no automation path reaches "
        "scripts/history-scrub/"
    )
    return 0, lines, report


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="list every automation surface that was proved over")
    parser.add_argument("--json", action="store_true",
                        help="emit the machine-readable proof record")
    args = parser.parse_args(argv)
    try:
        code, lines, report = run(verbose=args.verbose)
    except GateError as exc:
        print("SCRUB-TOOLING REACHABILITY: ERROR — %s" % exc)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for line in lines:
            print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
