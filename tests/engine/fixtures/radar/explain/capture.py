#!/usr/bin/env python3
"""Capture the Radar EXPLAIN-lane fixtures from REAL SERVED OUTPUT (TC-1).

Every fixture in this directory is what the REAL chain produces for one
real, anonymised corpus trial balance, ON THE SERVED SEAM:

    corpus/<case>/input.xlsx
      -> RomaniaPack.parse_trial_balance        (the production parser)
      -> RomaniaPack.assemble_parsed_tb         (the production assembler)
      -> pipeline.stage_persist                 (the production write seam,
                                                 corpus_replay's fake admin)
      -> pipeline._rebuild_assembled_for_briefing
             over the persisted line items with the persisted envelope on
             the period row                     (THE SERVED SEAM — what
                                                 /api/period, the Capsule's
                                                 list_findings and the Radar
                                                 route read)
      -> engine.api.findings.s_engine.run_single_period
                                                (the production detectors)
      -> engine.radar.explain.subjects_from_result
                                                (the lane's own projection)

The first capture of these files ran the ASSEMBLE path (parse ->
assemble -> detect). The serve lane's fixtures run the SERVED seam, and
the two disagree: with the persisted envelope on the row the rebuild
applies the persisted reconciliation, so served totals are the
gateway's ADJUSTED totals (agras total_assets 39,319,114.09) and not the
raw assemble-path ones (39,272,501.03). `facts_cited` differed on 4 of
21 subjects, including the 461 canary, so a fingerprint measured here
could never hit a cache record against a served row. This capture now
reaches the seam THROUGH THE SERVE LANE'S OWN CAPTURE MODULE
(`tests/engine/fixtures/radar/capture.py`, loaded by path) so there is
exactly one implementation of "what the served seam produces", and
`test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows` holds the
two fixture sets to each other subject by subject.

NET INCOME IS ACCOUNT 121, OR THE CAPTURE REFUSES. Every served surface
anchors `net_income_statutory` to the closing balance of account 121
(commit 06ee60f); the class-6/7 reconstruction is only the validation
check. This capture reads the envelope's own
`canonical_bs.invariants.p121_cross_check.p121` and REFUSES to write a
fixture whose served net income is not that figure to the cent — a
fixture written under an unanchored seam would pin the reconstruction
as expected output, which is how a repaired defect gets reverted.

Nothing is hand-built. The fixture records the SERVED statements the
detectors judged (so the tests can rebuild the SAME findings without
re-parsing the workbook), the snapshot hash (the input's content hash —
the identity a served period carries), a `_meta` block naming the seam
and both totals, and the EXPECTATION the tests hold per case: which
findings surfaced, in the SERVED order, with which numeric fingerprints
and which row fingerprints.

    .venv/bin/python tests/engine/fixtures/radar/explain/capture.py          # rewrite
    .venv/bin/python tests/engine/fixtures/radar/explain/capture.py --check  # diff only

Sources (all `synthetic: false` in their corpus meta):
  corpus/saga_10_col            the Scandia FY2025 export
  corpus/saga_10_col_agras      the 461 concentration case
  corpus/saga_10_col_carniprod  asset operator, negative EBITDA
  corpus/saga_10_col_realestate
  corpus/saga_10_col_retail

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.api import _finding as F  # noqa: E402
from engine.api import _ratio_units  # noqa: E402
from engine.api.findings import s_engine  # noqa: E402
from engine.radar import explain as X  # noqa: E402

CASES = (
    "saga_10_col",
    "saga_10_col_agras",
    "saga_10_col_carniprod",
    "saga_10_col_realestate",
    "saga_10_col_retail",
)

SEAM = "served"
ENGINE_PATH = ("parse -> assemble -> stage_persist (corpus_replay seam) -> "
               "_rebuild_assembled_for_briefing over the persisted line items + "
               "envelope (the served seam) -> s_engine.run_single_period -> "
               "engine.radar.explain.subjects_from_result")


class UnanchoredSeam(RuntimeError):
    """The served seam handed back a net income that is not account 121.
    The capture refuses rather than pin a reconstruction as expected."""


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


#: THE SERVE LANE'S capture — the one implementation of the served seam.
serve_capture = _load_by_path("radar_serve_capture",
                              HERE.parent / "capture.py")


def _envelope_p121(envelope: Dict[str, Any]) -> Optional[float]:
    cbs = envelope.get("canonical_bs") if isinstance(envelope, dict) else None
    invariants = (cbs or {}).get("invariants") or {}
    cross = invariants.get("p121_cross_check") or {}
    value = cross.get("p121")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def served_statements(case_id: str) -> Dict[str, Any]:
    """The statements every surface reads for this case, plus the meta
    that proves which seam they came from."""
    input_path, meta = serve_capture._corpus_input(case_id)
    content = input_path.read_bytes()
    period_end = str(meta.get("period_end") or "2025-12-31")
    envelope, assembled_statements, line_items, currency = serve_capture.run_engine(
        case_id, input_path.name, content, period_end)
    statements = serve_capture.served_statements(
        case_id, envelope, line_items, currency, period_end)
    p121 = _envelope_p121(envelope)
    pl = statements.get("assembled_pl") or {}
    served_net_income = pl.get("net_income_statutory")
    if p121 is None:
        raise UnanchoredSeam(
            "%s: the persisted envelope carries no account-121 cross-check, so "
            "the served net income cannot be verified against account 121."
            % case_id)
    if not isinstance(served_net_income, (int, float)) or \
            abs(float(served_net_income) - p121) >= 0.005:
        raise UnanchoredSeam(
            "%s: the served seam handed back net_income_statutory=%r "
            "(anchor source %r) while the envelope's account 121 is %r. The "
            "net-income anchor is not threaded on this seam; refusing to write "
            "a fixture that would pin the reconstruction as expected."
            % (case_id, served_net_income, pl.get("net_income_anchor_source"), p121))
    return {
        "statements": statements,
        "snapshot_hash": "sha256-" + __import__("hashlib").sha256(content).hexdigest(),
        "currency": currency,
        "_meta": {
            "source": "corpus/%s/%s" % (case_id, input_path.name),
            "synthetic": bool(meta.get("synthetic")),
            "captured_by": "tests/engine/fixtures/radar/explain/capture.py",
            "seam": SEAM,
            "engine_path": ENGINE_PATH,
            "served_through": "tests/engine/fixtures/radar/capture.py "
                              "(run_engine + served_statements, loaded by path)",
            "assemble_path_total_assets": (assembled_statements.get("assembled_bs") or {}
                                           ).get("total_assets"),
            "served_total_assets": (statements.get("assembled_bs") or {}).get("total_assets"),
            "assemble_path_net_income": (assembled_statements.get("assembled_pl") or {}
                                         ).get("net_income_statutory"),
            "served_net_income": served_net_income,
            "envelope_p121": p121,
            "net_income_anchor_source": pl.get("net_income_anchor_source"),
        },
    }


def run_chain(case_id: str) -> Dict[str, Any]:
    """served seam -> detect -> project, the production composition."""
    served = served_statements(case_id)
    statements = served["statements"]
    snapshot_hash = served["snapshot_hash"]
    period_id = "p-" + case_id
    result = s_engine.run_single_period(
        statements, period_id=period_id, snapshot_id=snapshot_hash[:23])
    # Recorded in the SERVED order (most severe first, then rule id) —
    # the order `SinglePeriodResult.surfaced()` hands a route and the
    # order the lane's projection therefore carries.
    subjects = X.subjects_from_result(
        result, org_id="org-" + case_id, period_id=period_id,
        snapshot_hash=snapshot_hash)
    surfaced = []  # type: List[Dict[str, Any]]
    for subject in subjects:
        finding = subject.finding
        surfaced.append({
            "finding_id": subject.finding_id,
            "rule_id": finding.rule_id,
            "severity": finding.severity,
            "numeric_fingerprint": F._numeric_fingerprint(finding),
            "row_fingerprint": subject.row_fingerprint,
            "money_facts": sorted(
                name for name in finding.facts_cited
                if _ratio_units.unit_for_fact(name) == _ratio_units.UNIT_MONEY),
            "facts_cited": dict((k, float(v)) for k, v in sorted(finding.facts_cited.items())),
        })
    return {
        "_meta": served["_meta"],
        "case_id": case_id,
        "source": served["_meta"]["source"],
        "captured_by": "tests/engine/fixtures/radar/explain/capture.py",
        "period_id": period_id,
        "snapshot_hash": snapshot_hash,
        "currency": str(statements.get("currency") or served["currency"] or "RON"),
        "profile_id": result.profile.profile_id,
        "profile_fingerprint": result.profile.fingerprint(),
        "statements": statements,
        "expect": {
            "surfaced_count": len(surfaced),
            "surfaced": surfaced,
            "checks_count": len(result.all_checks()),
        },
    }


def _dump(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=1,
                      default=str) + "\n"


def main(argv: List[str]) -> int:
    check = "--check" in argv
    drift = []  # type: List[str]
    for case_id in CASES:
        try:
            payload = run_chain(case_id)
        except UnanchoredSeam as exc:
            print("REFUSED %s" % exc)
            return 2
        path = HERE / (case_id + ".json")
        text = _dump(payload)
        if check:
            current = path.read_text(encoding="utf-8") if path.is_file() else ""
            if current != text:
                drift.append(case_id)
                print("DRIFT %s (%s)" % (case_id, path.name))
            else:
                print("OK    %s — %d surfaced, %d checks, served total_assets %s, "
                      "net income = account 121 = %s"
                      % (case_id, payload["expect"]["surfaced_count"],
                         payload["expect"]["checks_count"],
                         payload["_meta"]["served_total_assets"],
                         payload["_meta"]["envelope_p121"]))
            continue
        path.write_text(text, encoding="utf-8")
        print("WROTE %s — %d surfaced, %d checks, served total_assets %s "
              "(assemble path %s), net income = account 121 = %s"
              % (path.name, payload["expect"]["surfaced_count"],
                 payload["expect"]["checks_count"],
                 payload["_meta"]["served_total_assets"],
                 payload["_meta"]["assemble_path_total_assets"],
                 payload["_meta"]["envelope_p121"]))
    if check and drift:
        print("FIXTURE DRIFT — the real served seam no longer produces these "
              "fixtures: %s. Re-run without --check to recapture, deliberately."
              % ", ".join(drift))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
