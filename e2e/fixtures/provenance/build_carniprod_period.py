#!/usr/bin/env python3
"""THE PROVENANCE FIXTURE — one period, assembled from REAL ENGINE OUTPUT (TC-1).

`e2e/design/provenance.spec.ts` drives the live app against a period the
test-mode stack cannot otherwise give it: the sanctioned test workspace
holds no periods (and must never be written to — see
scripts/check_test_env_isolation.mjs), so the spec fulfils
`GET /api/period/{id}` from the browser with THIS file. Nothing in it is
hand-written:

  statements     src/engine/country_packs/ro_romania/fixtures/
                 regression_baselines/carniprod_fy2025.json — the engine's
                 assembled statements for the same company, verbatim
  canonical_bs   corpus/saga_10_col_carniprod/expected/served_envelope.json —
                 the served balance-sheet envelope, "numerics preserved to
                 the cent" per its own meta.yaml; sheet, method, pack and
                 44 rows with account codes — the chain
                 scripts/capsule_demo_partial.py proves to cells I15+I16+I17
  alerts         engine.api.findings.s_engine.run_single_period over those
                 statements — every contract row (contract_elements,
                 evidence.provenance with line_refs / snapshot_id / source)
                 exactly as the engine emits it; `id` / `alert_key` added the
                 way pipeline.py adds them at persist time
  line_items     corpus/.../expected/classification.json accounts (code,
                 name, amount) — the engine's classified accounts. Only
                 `statement` is derived here (RAS class 1-5 → BS, 6-7 → PL)
                 and `bucket` is left blank; both exist solely so
                 useActivePeriod does not read the period as an EMPTY
                 container (it requires line_items or metrics), and neither
                 is rendered by any surface the spec gates.

Deterministic: fixed period id, sorted keys, no clock. Re-run and diff to
prove it:

    .venv/bin/python e2e/fixtures/provenance/build_carniprod_period.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.api.findings import s_engine  # noqa: E402

NAME = "carniprod_fy2025"
PERIOD_ID = "0f1e2d3c-4b5a-4c6d-8e7f-a0b1c2d3e4f5"
ORG_ID = "00000000-0000-4000-8000-000000000002"  # the sentinel test org
BASELINE = (SRC / "engine" / "country_packs" / "ro_romania" / "fixtures"
            / "regression_baselines" / (NAME + ".json"))
CORPUS = REPO / "corpus" / "saga_10_col_carniprod" / "expected"


def main() -> int:
    with open(BASELINE, encoding="utf-8") as fh:
        statements = json.load(fh)["assembled"]["statements"]
    with open(CORPUS / "served_envelope.json", encoding="utf-8") as fh:
        envelope = json.load(fh)
    with open(CORPUS / "classification.json", encoding="utf-8") as fh:
        classification = json.load(fh)

    result = s_engine.run_single_period(
        statements, period_id="p-" + NAME, snapshot_id="snap-" + NAME)
    rows = result.surfaced() + result.demoted()
    alerts = []
    for i, row in enumerate(rows, start=1):
        alert = {"id": "alert-%d" % i,
                 "alert_key": "%s:%s" % (row["rule_key"], PERIOD_ID)}
        alert.update(row)
        alerts.append(alert)

    line_items = []
    for acct in classification["accounts"]:
        code = str(acct["code"])
        klass = code[:1]
        statement = "BS" if klass in "12345" else ("PL" if klass in "67" else "IGNORED")
        line_items.append({
            "statement": statement, "bucket": "",
            "ro_account_code": code,
            "ro_account_name": acct.get("name") or "",
            "amount": float(acct.get("amount") or 0),
        })

    statements = dict(statements)
    statements["canonical_bs"] = envelope
    period = {
        "period": {
            "id": PERIOD_ID, "period_end": "2025-12-31", "currency": "RON",
            "source_document": {
                "id": "doc-carniprod", "filename": "input.xlsx",
                "status": "analyzed", "detected_type": "trial_balance"},
        },
        "organization": {
            "id": ORG_ID,
            "name": statements.get("companyName") or "Carniprod",
            "industry_display_name": None},
        "statements": statements,
        "metrics": [],
        "briefing": None,
        "recommendations": [],
        "alerts": alerts,
        "valuation": None,
        "line_items": line_items,
        "canonical_version": "v2.1",
    }
    periods = {
        "active_period_id": PERIOD_ID,
        "periods": [{
            "period_id": PERIOD_ID, "period_label": "2025-12-31",
            "period_start": "2025-01-01", "period_end": "2025-12-31",
            "is_active": True, "currency": "RON",
            "documents": [{
                "id": "doc-carniprod", "display_name": "input.xlsx",
                "original_filename": "input.xlsx", "storage_path": "corpus/saga_10_col_carniprod/input.xlsx",
                "mime_type": None, "detected_type": "trial_balance",
                "size_bytes": 182318, "uploaded_at": "2026-01-01T00:00:00Z",
                "status": "analyzed", "is_active": True}],
        }],
        "public_records": [],
        "recently_deleted": [],
    }
    with open(HERE / "carniprod_period.json", "w", encoding="utf-8") as fh:
        json.dump(period, fh, indent=1, sort_keys=True)
        fh.write("\n")
    with open(HERE / "carniprod_periods.json", "w", encoding="utf-8") as fh:
        json.dump(periods, fh, indent=1, sort_keys=True)
        fh.write("\n")
    coded = sum(1 for r in envelope["rows"] if r.get("account_codes"))
    print("carniprod_period.json: %d BS rows (%d account-coded), %d alerts "
          "(%d surfaced), %d line items, sheet %r, method %r, pack %r"
          % (len(envelope["rows"]), coded, len(alerts), len(result.surfaced()),
             len(line_items), envelope["extraction"]["sheet"],
             envelope["extraction"]["method"], envelope["mapping_version"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
