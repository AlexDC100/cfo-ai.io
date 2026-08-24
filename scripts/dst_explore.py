#!/usr/bin/env python3
"""DST explorer CLI — seeded (fixture × fault × boundary) sweeps over the
REAL pipeline composition (src/engine/dst/).

Profiles:
  per-pr   bounded matrix: ONE fixture per fault class, one
           representative boundary (the PR gate — every fault class,
           fixed cost, ~2 s).
  deep     exhaustive matrix: three deterministic fixtures (+ the
           AI-lane fixture where the fault applies) × every fault ×
           every boundary (the nightly sweep, ~5 s).
           Selected by --profile deep OR env DST_PROFILE=deep.

The seed permutes the SCHEDULE (matrix run order) — scenarios are
deterministic given their config, so any seed reproduces its exact run.
Every failure is MINIMIZED (smallest lane-compatible fixture that still
fails) and archived to corpus/quarantine/dst/<sha16>/ with
{config.json, fault, seed, traceback} — the property-suite quarantine
discipline.

Faults the harness cannot inject through an existing seam are DOCUMENTED
GAPS, printed as non-blocking NOTICE lines on every run (never a silent
skip).

Usage:
  .venv/bin/python scripts/dst_explore.py                      # per-pr
  DST_PROFILE=deep .venv/bin/python scripts/dst_explore.py     # nightly
  .venv/bin/python scripts/dst_explore.py --seed 7 --fault ai_timeout
  .venv/bin/python scripts/dst_explore.py --list               # matrix only

Exit codes: 0 all green, 1 any K-invariant failure (quarantine paths
printed), 2 internal error.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.dst import FAULTS, GAPS, build_matrix, explore  # noqa: E402
from engine.dst.explorer import (  # noqa: E402
    DEFAULT_SEED,
    PROFILES,
    QUARANTINE_ROOT,
    profile_from_env,
)


def _notice(message: str) -> None:
    print("NOTICE  %s" % message)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="schedule seed (default %d)" % DEFAULT_SEED)
    parser.add_argument("--profile", choices=PROFILES, default=None,
                        help="matrix profile (default: per-pr, or deep when "
                             "DST_PROFILE=deep)")
    parser.add_argument("--fault", action="append", default=None,
                        help="run only this fault class (repeatable)")
    parser.add_argument("--fixture", action="append", default=None,
                        help="run only this fixture (repeatable)")
    parser.add_argument("--list", action="store_true",
                        help="print the matrix and exit")
    parser.add_argument("--no-minimize", action="store_true",
                        help="archive failures as-is without shrinking")
    parser.add_argument("--quarantine-root", default=str(QUARANTINE_ROOT),
                        help="failure archive dir (default corpus/quarantine/dst)")
    args = parser.parse_args(argv)

    profile = args.profile or profile_from_env()
    try:
        matrix = build_matrix(profile, faults=args.fault, fixtures=args.fixture)
    except ValueError as exc:
        print("ERROR   %s" % exc)
        return 2

    print("dst_explore: profile=%s seed=%d configs=%d fault_classes=%d"
          % (profile, args.seed, len(matrix), len(FAULTS)))
    if args.list:
        for config in matrix:
            print("  %s" % config.label())
        for gap in GAPS:
            _notice("gap (not injectable): %s" % gap["name"])
        return 0

    report = explore(
        seed=args.seed,
        profile=profile,
        faults=args.fault,
        fixtures=args.fixture,
        out_root=Path(args.quarantine_root),
        minimize=not args.no_minimize,
    )

    failed_labels = {
        "%(fault)s @ %(boundary)s [%(fixture)s]" % f["config"]
        for f in report["failed"]
    }
    # Re-print in schedule order so the seed's permutation is visible.
    for label in report["schedule"]:
        status = "FAIL" if label in failed_labels else "PASS"
        print("%s    %s" % (status, label))

    for gap in report["gaps"]:
        _notice("gap (not injectable): %s — %s"
                % (gap["name"], gap["detail"].split(". ")[0]))

    print("dst_explore: %d/%d passed" % (report["passed"], report["total"]))
    if report["failed"]:
        for failure in report["failed"]:
            err = failure.get("error") or {}
            print("FAILED  %s: %s: %s" % (
                "%(fault)s @ %(boundary)s [%(fixture)s]" % failure["config"],
                err.get("type"), (err.get("message") or "")[:300],
            ))
            print("        quarantined: %s" % failure.get("quarantine"))
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 — internal error, not a K-failure
        import traceback

        traceback.print_exc()
        print("ERROR   internal: %s: %s" % (type(exc).__name__, exc))
        sys.exit(2)
