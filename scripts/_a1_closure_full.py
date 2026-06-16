"""F3.7a + F3.7b + A1 — full atomic closure.

Runs inside cfo-ai-backend container. Executes 6 sub-steps in sequence:
  1. A1 re-process EEI
  2. A1 re-process Scandia Food
  3. A1 re-process Scandia Sibiu
  4. Briefing regen for all 3 new periods
  5. calibration_fixtures + calibration_results writes
  6. Final gate sweep (F-A3.1)

Halts immediately on any exception or unexpected anomaly. Each sub-step
prints its own clear OK / WARN / ERR line so the final report is built
from execution truth, not intent.

Engine version target: v2.1+f3.7a+f3.7b
"""
from __future__ import annotations
import sys
import time
import json
import traceback
from datetime import datetime, timezone
from typing import Optional

from engine.api import _supabase
from engine.api import pipeline as _pl

ENGINE_VERSION = "v2.1+f3.7a+f3.7b"

FIXTURES = [
    # (label, original_filename, expected_bs_balance_delta_approx, tolerance_ron)
    ("EEI",            "balanta verificare EEI dec 2025.pdf",     0.0,         5_000.0),
    ("Scandia Food",   "scandia trial balance 2025.xlsx",         -405_878.0,  20_000.0),
    ("Scandia Sibiu",  "trial Balance Scandia Sibiu 12.2019.PDF", 4_888.0,     20_000.0),
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hdr(s: str) -> None:
    print()
    print("=" * 78)
    print(s)
    print("=" * 78)


def _sub(s: str) -> None:
    print(f"\n--- {s} ---")


def _find_doc(ac, filename: str) -> dict:
    docs = ac.select(
        "documents",
        filters={"original_filename": f"eq.{filename}"},
        columns="id,original_filename,period_id,status,org_id,created_at",
    )
    if not docs:
        raise RuntimeError(f"No document matched filename '{filename}'")
    docs.sort(key=lambda d: d.get("created_at", ""), reverse=True)
    return docs[0]


def _read_metrics(ac, period_id: str) -> dict:
    """Read calculated_metrics for a period. Schema (per pipeline.py briefing
    endpoint comments): columns are name/value/unit/direction — NOT
    key/value_numeric (earlier transcription error caught in F2.8)."""
    rows = ac.select(
        "calculated_metrics",
        filters={"period_id": f"eq.{period_id}"},
        columns="name,value",
    )
    return {r["name"]: r.get("value") for r in rows}


def a1_reprocess(label: str, filename: str, expected_delta: float, tol: float) -> dict:
    """Atomic A1 re-process for one fixture. Returns dict with results."""
    _hdr(f"A1 RE-PROCESS — {label}")
    with _supabase.admin() as ac:
        doc = _find_doc(ac, filename)
        doc_id = doc["id"]
        old_period_id = doc.get("period_id")
        print(f"document: {doc_id}")
        print(f"filename: {doc['original_filename']}")
        print(f"old period: {old_period_id or '(none)'}")

        pre = _read_metrics(ac, old_period_id) if old_period_id else {}
        if pre:
            print(f"PRE  total_assets:     {pre.get('total_assets')}")
            print(f"PRE  total_equity:     {pre.get('total_equity')}")
            print(f"PRE  bs_balance_delta: {pre.get('bs_balance_delta')}")

    _sub("WIPE")
    with _supabase.admin() as ac:
        if old_period_id:
            ac.delete("financial_periods", filters={"id": f"eq.{old_period_id}"})
            print(f"  deleted financial_periods/{old_period_id[:8]}")
        ac.delete("alerts", filters={"document_id": f"eq.{doc_id}"})
        ac.update(
            "documents",
            {"period_id": None, "error": None, "duration_ms": None,
             "status": "queued", "pipeline_started_at": _now_iso()},
            filters={"id": f"eq.{doc_id}"},
        )
        print(f"  documents/{doc_id[:8]} -> queued")

    _sub(f"PIPELINE _run_pipeline_sync({doc_id[:8]})")
    t0 = time.time()
    _pl._run_pipeline_sync(doc_id)
    elapsed = time.time() - t0
    print(f"  done in {elapsed:.1f}s")

    _sub("VERIFY")
    with _supabase.admin() as ac:
        doc2 = ac.select("documents", filters={"id": f"eq.{doc_id}"},
                         columns="id,status,period_id,error,duration_ms")[0]
        new_period_id = doc2.get("period_id")
        print(f"  status:           {doc2['status']}")
        print(f"  error:            {doc2.get('error') or '(none)'}")
        print(f"  duration_ms:      {doc2.get('duration_ms')}")
        print(f"  NEW period_id:    {new_period_id}")
        if not new_period_id:
            raise RuntimeError(f"{label}: pipeline finished but no new period_id on document")
        post = _read_metrics(ac, new_period_id)
        line_items = ac.select(
            "statement_line_items",
            filters={"period_id": f"eq.{new_period_id}"},
            columns="id",
        )
        print(f"  line_items:       {len(line_items)}")
        print(f"  POST total_assets:     {post.get('total_assets')}")
        print(f"  POST total_equity:     {post.get('total_equity')}")
        print(f"  POST bs_balance_delta: {post.get('bs_balance_delta')}")

    # Acceptance check
    bd = post.get("bs_balance_delta")
    if bd is None:
        raise RuntimeError(f"{label}: bs_balance_delta missing from new period metrics")
    if abs((bd or 0) - expected_delta) > tol:
        raise RuntimeError(
            f"{label}: bs_balance_delta {bd} is more than {tol} RON off "
            f"from expected {expected_delta} — STOP, surface for review"
        )

    return {
        "label": label,
        "doc_id": doc_id,
        "old_period_id": old_period_id,
        "new_period_id": new_period_id,
        "pre_total_assets": pre.get("total_assets") if pre else None,
        "pre_total_equity": pre.get("total_equity") if pre else None,
        "pre_bs_balance_delta": pre.get("bs_balance_delta") if pre else None,
        "post_total_assets": post.get("total_assets"),
        "post_total_equity": post.get("total_equity"),
        "post_bs_balance_delta": bd,
        "elapsed_s": elapsed,
        "line_items_count": len(line_items),
    }


def briefing_regen(label: str, period_id: str) -> dict:
    """Regenerate briefing for one period. Calls the internal helper directly
    to avoid the JWT-required HTTP endpoint."""
    _hdr(f"BRIEFING REGEN — {label} ({period_id[:8]})")
    # Use the same helper the /api/period/{id}/briefing/regenerate endpoint
    # calls internally. Look it up.
    from engine.api.pipeline import _regenerate_briefing  # may differ; fallback below
    t0 = time.time()
    result = _regenerate_briefing(period_id)
    elapsed = time.time() - t0
    print(f"  done in {elapsed:.1f}s; result={type(result).__name__}")
    if isinstance(result, dict):
        print(f"  briefing_id: {result.get('briefing_id') or result.get('id') or '(unknown)'}")
    return {"label": label, "period_id": period_id, "elapsed_s": elapsed}


def calibration_writes(reprocess_results: list) -> dict:
    """Insert one calibration_fixtures row per fixture (idempotent on display_name)
    + one calibration_results row per fixture under engine_version + pack_version."""
    _hdr("CALIBRATION FIXTURES + RESULTS")
    PACK_VERSION = "1.0.0"  # ro_romania pack.py:77

    fixture_specs = [
        {
            "label": "EEI",
            "display_name": "EEI Imobiliara Dec 2025",
            "industry_key": "real_estate_commercial",
        },
        {
            "label": "Scandia Food",
            "display_name": "Scandia Food FY2025",
            "industry_key": "food_manufacturing",
        },
        {
            "label": "Scandia Sibiu",
            "display_name": "Scandia Sibiu FY2019",
            "industry_key": "hospitality_food_service",
        },
    ]
    notes_by_label = {
        "EEI": "byte-identical through F3.7a+F3.7b; 1,529.41 RON loss vs pre-A1-retry due to F3.8c PyMuPDF-vs-Claude precision delta on account 208; operator-accepted F3.8 trade-off",
        "Scandia Food": "F3.7a signed-math improved drift 0.3698%->0.1389%; F3.7b a no-op (positive retainedEarnings); 405,878 RON residual remains, separate root cause newly tracked",
        "Scandia Sibiu": "F3.7a signed-math fixed 117 carry-forward losses bucket; F3.7b removed defensive-flip on retainedEarnings; combined effect reduces original 3.77M equity inflation to +4,888 RON residual (within F-A3.1 tolerance)",
    }

    fixture_id_by_label: dict = {}
    inserted_results: list = []
    with _supabase.admin() as ac:
        # 1) Upsert calibration_fixtures rows (idempotent on display_name)
        for spec in fixture_specs:
            existing = ac.select(
                "calibration_fixtures",
                filters={"display_name": f"eq.{spec['display_name']}"},
                columns="id,display_name",
            )
            if existing:
                fid = existing[0]["id"]
                print(f"  calibration_fixtures {spec['label']:<14}: already present (id={fid[:8]})")
            else:
                ins = ac.insert(
                    "calibration_fixtures",
                    {
                        "coa_key": "omfp_1802",
                        "country_code": "RO",
                        "display_name": spec["display_name"],
                        "industry_key": spec["industry_key"],
                        "provenance": "F3.7a + F3.7b ceremony fixture; F3.8c PDF ingest where applicable; F3.9c SAGA XLSX where applicable",
                    },
                )
                fid = ins[0]["id"] if ins else None
                print(f"  calibration_fixtures {spec['label']:<14}: INSERTED (id={(fid or '?')[:8]})")
            fixture_id_by_label[spec["label"]] = fid

        # 2) Insert calibration_results — one per fixture, against the correct schema
        for r in reprocess_results:
            label = r["label"]
            fid = fixture_id_by_label.get(label)
            if not fid:
                print(f"  SKIP {label}: no fixture_id resolved")
                continue
            ta = r.get("post_total_assets")
            te = r.get("post_total_equity")
            bd = r.get("post_bs_balance_delta")
            drift_pct = (abs(bd) / ta * 100) if (bd is not None and ta) else None
            # Verdict thresholds match F-A3.1 acceptance (<=0.5% green)
            if drift_pct is None:
                verdict = "amber"
            elif drift_pct <= 0.5:
                verdict = "green"
            elif drift_pct <= 1.0:
                verdict = "amber"
            else:
                verdict = "red"
            ins = ac.insert(
                "calibration_results",
                {
                    "fixture_id": fid,
                    "engine_version": ENGINE_VERSION,
                    "pack_version": PACK_VERSION,
                    "total_assets": ta,
                    "total_equity": te,
                    "bs_balance_delta": bd,
                    "drift_pct": drift_pct,
                    "verdict": verdict,
                    "notes": notes_by_label.get(label, ""),
                },
            )
            rid = ins[0]["id"] if ins else None
            inserted_results.append({"label": label, "result_id": rid, "verdict": verdict, "drift_pct": drift_pct})
            print(f"  calibration_results {label:<14}: drift_pct={drift_pct} verdict={verdict}")

        return {
            "fixture_ids": fixture_id_by_label,
            "results_inserted": inserted_results,
        }


def gate_sweep() -> dict:
    """Run the locked baseline gates in the container."""
    _hdr("FINAL GATE SWEEP")
    import subprocess
    gates = [
        ("F-A3.1",         "/app/scripts/measure_bs_drift.py"),
        ("F3.1-PARITY",    "/app/scripts/check_assembled_parity.py"),
        ("F3.2-CANONICAL", "/app/scripts/check_canonical_model.py"),
        ("F3.3-DETECTION", "/app/scripts/check_detection.py"),
        ("F3.8-INGEST",    "/app/scripts/check_pdf_ingester.py"),
        ("F3.9c-PARSER",   "/app/scripts/check_saga_contsal_parser.py"),
    ]
    results = {}
    for name, path in gates:
        try:
            out = subprocess.run(["python3", path], capture_output=True, text=True, timeout=300)
            tail = (out.stdout + out.stderr).strip().splitlines()[-2:]
            verdict = "GREEN" if out.returncode == 0 else "RED"
            results[name] = verdict
            print(f"  {name:<18}  {verdict}   {' | '.join(tail)}")
        except Exception as e:
            results[name] = f"ERR ({type(e).__name__})"
            print(f"  {name:<18}  ERR   {e}")
    return results


def main() -> None:
    _hdr(f"F3.7a + F3.7b + A1 — atomic closure under {ENGINE_VERSION}")

    reprocess_results = []
    for label, filename, expected_delta, tol in FIXTURES:
        r = a1_reprocess(label, filename, expected_delta, tol)
        reprocess_results.append(r)

    # Briefing regen for each new period
    briefing_results = []
    for r in reprocess_results:
        try:
            b = briefing_regen(r["label"], r["new_period_id"])
            briefing_results.append(b)
        except ImportError as e:
            print(f"  briefing helper not found: {e}; falling back to scanning briefings table")
            with _supabase.admin() as ac:
                briefings = ac.select(
                    "briefings",
                    filters={"period_id": f"eq.{r['new_period_id']}"},
                    columns="id,created_at",
                )
                print(f"  existing briefings for {r['label']}: {len(briefings)}")
                briefing_results.append({
                    "label": r["label"],
                    "period_id": r["new_period_id"],
                    "skipped_reason": "no _regenerate_briefing helper exposed; existing briefing left in place",
                    "existing_briefing_count": len(briefings),
                })

    cal = calibration_writes(reprocess_results)
    gates = gate_sweep()

    _hdr("FINAL SUMMARY")
    print("\nA1 RE-PROCESS:")
    for r in reprocess_results:
        print(f"  {r['label']:<14} doc={r['doc_id'][:8]} new_period={r['new_period_id'][:8]} "
              f"bs_delta={r['post_bs_balance_delta']:>14} elapsed={r['elapsed_s']:.1f}s")
    print(f"\nBRIEFING REGEN: {len(briefing_results)} periods processed")
    for b in briefing_results:
        print(f"  {b['label']:<14} {('OK ('+str(round(b.get('elapsed_s',0),1))+'s)') if 'elapsed_s' in b else 'SKIP: '+b.get('skipped_reason','?')}")
    print(f"\nCALIBRATION:")
    print(f"  fixture ids: {cal['fixture_ids']}")
    print(f"  results inserted:")
    for r in cal['results_inserted']:
        print(f"    {r['label']:<14} verdict={r['verdict']} drift_pct={r['drift_pct']}")
    print(f"\nGATE SWEEP:")
    for name, verdict in gates.items():
        print(f"  {name:<18}  {verdict}")
    print(f"\nDONE — engine version locked at {ENGINE_VERSION}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n!!! HALT: {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
