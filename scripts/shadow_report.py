#!/usr/bin/env python3
"""SHADOW divergence report — legacy vs pack classification, per corpus case.

ZERO-BEHAVIOR-CHANGE PHASE. For every case under corpus/<case_id>/ this
script runs BOTH classification lanes over the same input and prints a
per-case, per-account diff table (EMPTY == GREEN):

  deterministic lanes (saga_10_col / saga_compact_6_col / generic_4_col
  / csv / pdf_positional)
      legacy = the REAL production composition: pack parse
               (RomaniaPack.parse_trial_balance[_csv]) ->
               RomaniaPack.assemble_parsed_tb (line items + telemetry);
      pack   = engine.passes.classify over the FRONT-END IR
               (engine.frontends adapter parse of the same bytes).
  ro_llm_fallback
      the case's MOCKED extract rows (mock_model_response.json
      parse_document accounts) through the REAL assemble_statements
      (legacy) vs pack rule lookup (see engine/passes/shadow.py for the
      amount-space side convention). No model is ever called.
  hu_ai_lane
      SKIPPED, explicitly: jurisdiction HU has no data pack
      (engine.packs.resolve raises NoPackFoundError) and the HU lane's
      classification is model-owned — there is no deterministic HU
      table to shadow. The skip is printed, not silently swallowed.

Comparable form + normalizations: engine/passes/shadow.py module
docstring. Divergence policy: fix the PACK (scripts/port_ro_pack.py),
never the engine — unless the pack model cannot express the rule, which
is a Phase-2 design finding to report.

Usage:
  .venv/bin/python scripts/shadow_report.py --all
  .venv/bin/python scripts/shadow_report.py --case saga_10_col --case csv
  .venv/bin/python scripts/shadow_report.py            # same as --all

Exit codes: 0 all green (skips count as green, loudly), 1 any
divergence, 2 internal error.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


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

import yaml  # noqa: E402  (declared project dependency)

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack  # noqa: E402
from engine.frontends.registry import resolve_front_end  # noqa: E402
from engine.packs import CompiledPack, NoPackFoundError  # noqa: E402
from engine.passes.shadow import (  # noqa: E402
    DEFAULT_PERIOD_END,
    ShadowResult,
    load_ro_pack,
    render_result,
    shadow_compare_accounts,
    shadow_compare_tb,
)

DEFAULT_CORPUS = REPO / "corpus"

#: Same vocabulary as scripts/corpus_replay.py.
DETERMINISTIC_PARSERS = (
    "saga_10_col", "saga_compact_6_col", "generic_4_col", "csv", "pdf_positional",
)


@dataclass
class CaseOutcome:
    """One case's shadow outcome: a comparison, or an explicit skip."""

    case_id: str
    kind: str  # 'compared' | 'skipped_no_pack'
    report: Optional[ShadowResult] = None
    reason: str = ""
    notes: List[str] = field(default_factory=list)

    @property
    def green(self) -> bool:
        if self.kind == "compared":
            return self.report is not None and self.report.green
        return True  # explicit skips are green-with-note


def _load_meta(case_dir: Path) -> Dict[str, Any]:
    meta = yaml.safe_load((case_dir / "meta.yaml").read_text(encoding="utf-8"))
    if not isinstance(meta, dict):
        raise RuntimeError("%s/meta.yaml did not parse to a mapping" % case_dir.name)
    return meta


def _input_path(case_dir: Path) -> Path:
    candidates = sorted(case_dir.glob("input.*"))
    if len(candidates) != 1:
        raise RuntimeError(
            "%s: expected exactly one input.<ext>, found %d"
            % (case_dir.name, len(candidates))
        )
    return candidates[0]


def run_case_shadow(
    case_dir: Path, pack: Optional[CompiledPack] = None
) -> CaseOutcome:
    """Shadow one corpus case. Reused verbatim by
    tests/engine/test_shadow_divergence.py so the gate and the report
    can never drift apart."""
    case_id = case_dir.name
    meta = _load_meta(case_dir)
    parser = str(meta["expected_parser"])
    period_end = str(meta.get("period_end") or DEFAULT_PERIOD_END)

    if parser in DETERMINISTIC_PARSERS:
        pack = pack or load_ro_pack(period_end=period_end)
        input_path = _input_path(case_dir)
        content = input_path.read_bytes()
        legacy_pack = get_pack("RO")
        if parser == "csv":
            tb_rows = legacy_pack.parse_trial_balance_csv(content, input_path.name)
        else:
            tb_rows = legacy_pack.parse_trial_balance(content, input_path.name)
        front_end = resolve_front_end(parser)
        doc, _diagnostics = front_end.parse(content, {"filename": input_path.name})
        report = shadow_compare_tb(tb_rows, pack, doc=doc, case_id=case_id)
        return CaseOutcome(case_id=case_id, kind="compared", report=report)

    if parser == "ro_llm_fallback":
        pack = pack or load_ro_pack(period_end=period_end)
        mock_path = case_dir / "mock_model_response.json"
        response_text = json.loads(
            mock_path.read_text(encoding="utf-8")
        )["parse_document"]
        accounts = json.loads(response_text).get("accounts") or []
        report = shadow_compare_accounts(accounts, pack, case_id=case_id)
        return CaseOutcome(case_id=case_id, kind="compared", report=report)

    if parser == "hu_ai_lane":
        jurisdiction = str(meta.get("jurisdiction") or "HU")
        try:
            from engine.packs import discover_packs, resolve
            from engine.passes.shadow import default_packs_root

            resolve(discover_packs(default_packs_root()), jurisdiction, period_end)
        except NoPackFoundError as exc:
            return CaseOutcome(
                case_id=case_id,
                kind="skipped_no_pack",
                reason=(
                    "no %s data pack (%s); the AI-lane classification is "
                    "model-owned — nothing deterministic to shadow"
                    % (jurisdiction, exc)
                ),
            )
        raise RuntimeError(
            "%s: a %s pack now exists — wire the AI-lane shadow comparison "
            "deliberately instead of skipping" % (case_id, jurisdiction)
        )

    raise RuntimeError("%s: unknown expected_parser %r" % (case_id, parser))


def discover_cases(corpus_root: Path) -> List[Path]:
    return sorted(
        p for p in corpus_root.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "meta.yaml").is_file()
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus-root", default=str(DEFAULT_CORPUS))
    parser.add_argument("--all", action="store_true",
                        help="run every corpus case (the default when no --case)")
    parser.add_argument("--case", action="append", default=None,
                        help="run only this case id (repeatable)")
    args = parser.parse_args(argv)

    corpus_root = Path(args.corpus_root)
    if not corpus_root.is_dir():
        print("corpus root not found: %s" % corpus_root)
        return 2
    cases = discover_cases(corpus_root)
    if args.case:
        wanted = set(args.case)
        cases = [c for c in cases if c.name in wanted]
        missing = wanted - {c.name for c in cases}
        if missing:
            print("unknown case id(s): %s" % ", ".join(sorted(missing)))
            return 2
    if not cases:
        print("no cases discovered under %s" % corpus_root)
        return 2

    pack = load_ro_pack()
    print("shadow_report: RO pack %s (%s@%s), %d case(s)\n"
          % (pack.pack_hash[:12], pack.identity.pack_id,
             pack.identity.version, len(cases)))

    diverged = 0
    for case_dir in cases:
        outcome = run_case_shadow(case_dir, pack=pack)
        if outcome.kind == "skipped_no_pack":
            print("SKIP    %-28s %s" % (outcome.case_id, outcome.reason))
            continue
        report = outcome.report
        assert report is not None
        if report.green:
            print("GREEN   %-28s accounts=%d" % (outcome.case_id,
                                                 report.accounts_compared))
            for note in report.notes:
                print("        note: %s" % note)
        else:
            diverged += 1
            print(render_result(report))
        sys.stdout.flush()

    print()
    if diverged:
        print("SHADOW REPORT: DIVERGENCE in %d case(s) — fix the PACK "
              "(scripts/port_ro_pack.py), never the engine; if the pack "
              "model cannot express the rule, record a Phase-2 finding."
              % diverged)
        return 1
    print("SHADOW REPORT: GREEN — zero divergence across %d case(s)" % len(cases))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        import traceback
        traceback.print_exc()
        print("shadow_report: internal error: %s" % exc, file=sys.stderr)
        sys.exit(2)
