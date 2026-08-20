#!/usr/bin/env python3
"""pack_lint — CLI over engine.packs.lint (Part C, shadow phase).

Lints jurisdiction DATA pack directories (pack.yaml / classification.yaml /
checks.yaml / statement_map.yaml / reconcile.yaml):

  * schema errors (everything load_pack validates: missing files, bad
    fields, dangling line_ids, duplicate/shadowed rules, unknown check
    impl refs, ...);
  * cross-pack effective-range tiling per (jurisdiction, pack_id):
    overlaps (ambiguous resolution) and gaps (unresolvable periods);
  * warning-level rule shadowing (range overlaps, redundant exacts);
  * optional COVERAGE mode: run the compiled rules against account codes
    from corpus files and report unmatched codes.

USAGE
  python scripts/pack_lint.py PACK_DIR [PACK_DIR ...]
  python scripts/pack_lint.py --root DIR            # discover every pack.yaml under DIR
  python scripts/pack_lint.py PACK_DIR --coverage corpus/saga_10_col/expected/classification.json
  python scripts/pack_lint.py --root DIR --json     # machine-readable report

Coverage inputs: corpus expected/classification.json (accounts[].code),
expected/extraction.json (rows[].cont), any JSON with either shape, or a
plain text/CSV file with one account code per line.

EXIT CODES: 0 = clean (warnings allowed), 1 = error findings (or, with
--coverage, unmatched codes), 2 = usage / internal error.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List


# ── Repo-root + sys.path setup — independent of cwd (same pattern as
# scripts/verify_determinism.py) ─────────────────────────────────────────


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.packs.lint import (  # noqa: E402
    LintReport,
    analyze_effective_ranges,
    coverage_report,
    extract_codes,
    find_pack_dirs,
    lint_pack,
)
from engine.packs.schema import PackError  # noqa: E402


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="pack_lint.py",
        description="Lint jurisdiction data-pack directories (engine.packs).",
    )
    parser.add_argument(
        "pack_dirs", nargs="*", metavar="PACK_DIR",
        help="pack directories to lint (each must hold a pack.yaml)",
    )
    parser.add_argument(
        "--root", metavar="DIR",
        help="discover and lint every pack.yaml under DIR (recursive)",
    )
    parser.add_argument(
        "--coverage", nargs="+", metavar="FILE", default=[],
        help="run classification rules against account codes from FILE(s) "
             "and report unmatched codes",
    )
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="emit the report as JSON",
    )
    args = parser.parse_args(argv)

    if not args.pack_dirs and not args.root:
        parser.error("give PACK_DIR(s) and/or --root DIR")

    try:
        # ONE unified pack set (root discovery + positional dirs, deduped),
        # linted per-pack then cross-analyzed once — no double-reporting.
        pack_dirs: List[Path] = []
        if args.root:
            discovered = find_pack_dirs(args.root)
            if not discovered:
                print("pack_lint: no pack.yaml found under %s" % args.root,
                      file=sys.stderr)
                return 1
            pack_dirs.extend(discovered)
        for d in args.pack_dirs:
            p = Path(d).resolve()
            if p not in [q.resolve() for q in pack_dirs]:
                pack_dirs.append(Path(d))

        report = LintReport()
        for d in pack_dirs:
            lint_pack(d, report)
        report.extend(analyze_effective_ranges(tuple(report.packs.values())))

        coverage_failed = False
        for cov_file in args.coverage:
            codes = extract_codes(cov_file)
            if not report.packs:
                print("coverage: no cleanly-loaded pack to run %s against"
                      % cov_file, file=sys.stderr)
                coverage_failed = True
                continue
            for pack in report.packs.values():
                cov = coverage_report(pack, codes, source=str(cov_file))
                report.coverage.append(cov)
                if cov["unmatched"]:
                    coverage_failed = True
    except PackError as exc:
        print("pack_lint: %s" % exc, file=sys.stderr)
        return 2
    except OSError as exc:
        print("pack_lint: %s" % exc, file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    else:
        print(report.render())
        n_err = sum(1 for f in report.findings if f.severity == "error")
        n_warn = sum(1 for f in report.findings if f.severity == "warning")
        print("-- %d pack(s) loaded, %d error(s), %d warning(s)"
              % (len(report.packs), n_err, n_warn))

    if not report.ok or coverage_failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
