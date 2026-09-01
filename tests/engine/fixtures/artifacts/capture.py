#!/usr/bin/env python3
"""Capture the artifact-lane fixtures from REAL ENGINE OUTPUT (TC-1).

Nothing in this directory is hand-written. This script runs the REAL
deterministic chain over REAL trial balances that ship in this repo —

    files/scandia_frozen_tb_2025.xlsx   (Scandia Food SRL, 382 rows)
    files/carniprod_tb_2025.xlsx        (Carniprod SRL)

— through ``pack.run_deterministic_tb`` (the same entry point
``scripts/verify_determinism.py`` uses), builds a real
``CapsuleContext`` from the resulting ``assembled_canonical_v1``
envelopes, and records what
``engine.api._artifact_resolve.resolve_artifact`` actually returns for a
handful of specs.

WHY THIS EXISTS AND NOT A LITERAL IN THE TEST FILE
--------------------------------------------------
A hand-built fixture encodes the AUTHOR'S BELIEF about the shape of
engine output, and the test then verifies the code against that belief.
The two drift silently, because the fixture keeps passing precisely
because it was built to. Three defects surfaced in this codebase the
moment ONE findings fixture switched from hand-built to real output.

WHAT IS DELIBERATELY NOT CAPTURED
---------------------------------
The envelopes themselves. They are large, they belong to the pipeline
lane, and re-deriving them from the committed XLSX on every run is
0.3 s — so the tests rebuild the context from source bytes and compare
against the captured RESOLVED payloads. That way a change in the
upstream envelope shows up as a fixture mismatch here rather than being
frozen out of sight.

Re-run:  .venv/bin/python tests/engine/fixtures/artifacts/capture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers the pack
from engine.api import _artifact_resolve as AR  # noqa: E402
from engine.api import _artifact_spec as AS  # noqa: E402
from engine.api import _capsule_tools as CT  # noqa: E402
from engine.core.country_pack_registry import get_pack  # noqa: E402

#: (source xlsx, period_id, period label, entity) — real books, in the
#: repo, with their real account counts.
SOURCES = (
    (REPO / "files" / "scandia_frozen_tb_2025.xlsx",
     "p-scandia-fy2025", "December 2025", "org-scandia"),
    (REPO / "files" / "carniprod_tb_2025.xlsx",
     "p-carniprod-fy2025", "December 2025", "org-carniprod"),
)


def build_period(path: Path, period_id: str, label: str,
                 entity_id: str) -> "CT.PeriodRef":
    """One real period, from the real deterministic chain."""
    pack = get_pack("RO")
    tb_rows, _shaped, assembled = pack.run_deterministic_tb(
        path.read_bytes(), path.name)
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-%s" % period_id,
        "content_hash": "sha256-%s" % period_id,
        "written_at": "2026-09-01T00:00:00+00:00",
    }
    accounts = tuple(
        CT.AccountRow(
            code=str(li.get("ro_account_code") or ""),
            name=str(li.get("ro_account_name") or ""),
            amount_minor=int(round(float(li.get("amount") or 0) * 100)),
            currency="RON",
            statement=str(li.get("statement") or ""),
            bucket=str(li.get("bucket") or ""),
        )
        for li in assembled["lineItems"]
        if li.get("ro_account_code")
    )
    return CT.PeriodRef(
        period_id=period_id, label=label, entity_id=entity_id,
        currency="RON", period_end="2025-12-31",
        envelope=envelope, statements=assembled["statements"],
        accounts=accounts, snapshot_id="sha256-%s" % period_id,
    ), len(tb_rows)


def build_context() -> Tuple["CT.CapsuleContext", Dict[str, int]]:
    periods = []  # type: List[CT.PeriodRef]
    rows = {}  # type: Dict[str, int]
    for path, pid, label, entity in SOURCES:
        if not path.is_file():
            raise SystemExit("FIXTURE SOURCE MISSING: %s" % path)
        period, n = build_period(path, pid, label, entity)
        periods.append(period)
        rows[pid] = n
    # A third period row that EXISTS with no attached file — the C5
    # headline case, and the one an estimate is most tempting for. Not
    # synthetic data: it is the real shape a period row has before its
    # document lands.
    periods.append(CT.PeriodRef(
        period_id="p-scandia-nofile", label="November 2025",
        entity_id="org-scandia", currency="RON"))
    # THE IDENTITY PERIOD — the SAME real book, filed under a second
    # period id of the same entity.
    #
    # Read what this does and does not prove. It is NOT a month-over-
    # month comparison: this repo carries no two consecutive periods of
    # one company, and pretending two different companies' books are one
    # company's two months would be exactly the dishonest fixture TC-1
    # exists to prevent. What it DOES prove is the identity property —
    # a book compared with itself must produce a delta of EXACTLY zero
    # minor units on every money metric, and any rounding, float detour
    # or re-derivation in the delta path breaks that immediately.
    same = periods[0]
    periods.append(CT.PeriodRef(
        period_id="p-scandia-fy2025-again", label="December 2025 (re-filed)",
        entity_id=same.entity_id, currency=same.currency,
        period_end=same.period_end, envelope=same.envelope,
        statements=same.statements, accounts=same.accounts,
        snapshot_id=same.snapshot_id))
    return CT.CapsuleContext(entity_id="org-scandia",
                             periods=tuple(periods)), rows


#: The specs captured. Each one is a real parse of a real payload — the
#: parse runs here too, so a spec that would be refused can never become
#: a fixture.
CASES = (
    ("kpi_all_metrics", {
        "kind": "kpi_grid",
        "metrics": [{"metric": m} for m in
                    ("total_assets", "total_liabilities", "equity",
                     "current_assets", "current_liabilities",
                     "working_capital", "revenue", "expenses", "ebitda",
                     "net_result", "difference", "equity_plus_liabilities")],
        "periods": ["p-scandia-fy2025"],
        "title": "Balance sheet at a glance",
    }),
    ("ratios_one_period", {
        "kind": "table",
        "metrics": [{"metric": "current_ratio"}, {"metric": "equity_ratio"},
                    {"metric": "net_margin"}],
        "periods": ["p-scandia-fy2025"],
    }),
    ("cross_entity_refused", {
        "kind": "bar",
        "metrics": [{"metric": "revenue"}],
        "periods": ["p-scandia-fy2025", "p-carniprod-fy2025"],
        "derive": "delta",
    }),
    ("absent_period_gap", {
        "kind": "line",
        "metrics": [{"metric": "revenue"}],
        "periods": ["p-scandia-fy2025", "p-scandia-nofile"],
    }),
    ("unknown_metric_gap", {
        "kind": "table",
        "metrics": [{"metric": "revenue"}, {"metric": "ebitda_margin"}],
        "periods": ["p-scandia-fy2025"],
    }),
    ("self_delta_is_exactly_zero", {
        "kind": "delta_table",
        "metrics": [{"metric": m} for m in
                    ("total_assets", "revenue", "net_result", "ebitda")],
        "periods": ["p-scandia-fy2025", "p-scandia-fy2025-again"],
        "derive": "delta",
    }),
    ("self_pct_change_is_exactly_zero", {
        "kind": "bar",
        "metrics": [{"metric": "revenue"}],
        "periods": ["p-scandia-fy2025", "p-scandia-fy2025-again"],
        "derive": "pct_change",
    }),
    ("delta_with_an_absent_period", {
        "kind": "delta_table",
        "metrics": [{"metric": "revenue"}],
        "periods": ["p-scandia-fy2025", "p-scandia-nofile"],
        "derive": "delta",
    }),
    ("ratio_delta_is_refused", {
        "kind": "delta_table",
        "metrics": [{"metric": "current_ratio"}],
        "periods": ["p-scandia-fy2025", "p-scandia-fy2025-again"],
        "derive": "delta",
    }),
    ("share_of_assets", {
        "kind": "bar",
        "metrics": [{"metric": "current_assets"}, {"metric": "equity"}],
        "periods": ["p-scandia-fy2025"],
        "derive": "share",
        "denominator": "total_assets",
    }),
)


def main() -> int:
    ctx, rows = build_context()
    captured = {
        "_meta": {
            "captured_by": "tests/engine/fixtures/artifacts/capture.py",
            "sources": [
                {"file": str(p.relative_to(REPO)), "period_id": pid,
                 "tb_rows": rows.get(pid, 0)}
                for p, pid, _l, _e in SOURCES
            ],
            "spec_version": AS.ARTIFACT_SPEC_VERSION,
            "artifact_version": AR.ARTIFACT_VERSION,
        },
        "fact_index_summary": AR.summarize_fact_index(ctx),
        "cases": {},
    }  # type: Dict[str, Any]

    for name, payload in CASES:
        parsed = AS.parse_artifact_spec(payload)
        if not parsed.ok:
            raise SystemExit(
                "case %r does not parse: %s"
                % (name, [r.to_payload() for r in parsed.refusals]))
        resolved = AR.resolve_artifact(ctx, parsed.spec, artifact_id=name)
        frames = list(AR.stream_frames(ctx, parsed.spec, artifact_id=name))
        captured["cases"][name] = {
            "payload": payload,
            "parse_report": parsed.report.to_payload(),
            "resolved": resolved.to_payload(),
            "frame_types": [f.get("type") for f in frames],
            # The FULL frames, because the frontend fold
            # (frontend/lib/artifactSpec.ts) must be tested against what
            # the engine actually emits rather than against a TypeScript
            # author's idea of it. Same TC-1 rule, one runtime over.
            "frames": frames,
        }

    out = HERE / "resolved_artifacts_REAL_engine.json"
    out.write_text(
        json.dumps(captured, indent=2, sort_keys=True, ensure_ascii=False)
        + "\n", encoding="utf-8")
    print("captured %d case(s) -> %s" % (len(CASES), out.relative_to(REPO)))
    for name in captured["cases"]:
        case = captured["cases"][name]
        r = case["resolved"]
        print("  %-24s cells=%-3d gaps=%-2d refusals=%-2d currency=%s"
              % (name, len(r["cells"]), len(r["gaps"]), len(r["refusals"]),
                 r["currency"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
