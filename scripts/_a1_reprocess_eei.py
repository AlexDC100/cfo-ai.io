"""A1 re-process for EEI — atomic execution under v2.1+f3.7a+f3.7b.

Run inside cfo-ai-backend container with admin Supabase credentials.

Flow:
  1. Find EEI document by original_filename, capture pre-state.
  2. Delete its financial_periods row (cascades line_items, metrics, briefings).
  3. Clear documents.period_id/error/duration_ms, set status='queued'.
  4. Run pipeline synchronously (_run_pipeline_sync).
  5. Read the new period back, verify v2.1+f3.7a+f3.7b state.
"""
from __future__ import annotations
import sys
import time
import json
from datetime import datetime, timezone

from engine.api import _supabase
from engine.api import pipeline as _pl

EEI_FILENAME = "balanta verificare EEI dec 2025.pdf"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_eei_doc(ac) -> dict:
    docs = ac.select(
        "documents",
        filters={"original_filename": f"eq.{EEI_FILENAME}"},
        columns="id,original_filename,period_id,status,org_id,created_at",
    )
    if not docs:
        sys.exit(f"FATAL: no document matched filename '{EEI_FILENAME}'")
    # Pick the MOST RECENT non-deleted one
    docs.sort(key=lambda d: d.get("created_at", ""), reverse=True)
    return docs[0]


def main() -> None:
    print("=" * 70)
    print("A1 RE-PROCESS — EEI (under v2.1+f3.7a+f3.7b)")
    print("=" * 70)

    with _supabase.admin() as ac:
        doc = _find_eei_doc(ac)
        print(f"\nDocument:")
        print(f"  id:       {doc['id']}")
        print(f"  filename: {doc['original_filename']}")
        print(f"  status:   {doc['status']}")
        print(f"  period:   {doc.get('period_id','(none)')}")

        doc_id = doc["id"]
        old_period_id = doc.get("period_id")

        # Capture pre-state if there's a current period
        pre_total_assets = None
        pre_bs_delta = None
        pre_total_equity = None
        if old_period_id:
            periods = ac.select(
                "financial_periods",
                filters={"id": f"eq.{old_period_id}"},
                columns="id,extraction_confidence",
            )
            if periods:
                p = periods[0]
                # calculated_metrics schema: name/value/unit/direction
                metrics = ac.select(
                    "calculated_metrics",
                    filters={"period_id": f"eq.{old_period_id}"},
                    columns="name,value",
                )
                m_by_key = {m["name"]: m.get("value") for m in metrics}
                pre_total_assets = m_by_key.get("total_assets")
                pre_bs_delta = m_by_key.get("bs_balance_delta")
                pre_total_equity = m_by_key.get("total_equity")
                print(f"\nPRE-state (period {old_period_id[:8]}):")
                print(f"  total_assets:     {pre_total_assets}")
                print(f"  total_equity:     {pre_total_equity}")
                print(f"  bs_balance_delta: {pre_bs_delta}")

    # === DESTRUCTIVE WIPE ===
    print(f"\n[1/3] WIPE: deleting period + alerts + clearing doc fields…")
    with _supabase.admin() as ac:
        if old_period_id:
            ac.delete("financial_periods", filters={"id": f"eq.{old_period_id}"})
            print(f"  - deleted financial_periods/{old_period_id[:8]}")
        ac.delete("alerts", filters={"document_id": f"eq.{doc_id}"})
        print(f"  - deleted alerts for doc {doc_id[:8]}")
        ac.update(
            "documents",
            {
                "period_id": None,
                "error": None,
                "duration_ms": None,
                "status": "queued",
                "pipeline_started_at": _now_iso(),
            },
            filters={"id": f"eq.{doc_id}"},
        )
        print(f"  - documents/{doc_id[:8]} → queued")

    # === PIPELINE RE-RUN (sync) ===
    print(f"\n[2/3] PIPELINE: _run_pipeline_sync({doc_id[:8]}) …")
    t0 = time.time()
    try:
        _pl._run_pipeline_sync(doc_id)
    except Exception as e:
        print(f"  PIPELINE EXCEPTION: {type(e).__name__}: {e}")
        sys.exit(1)
    elapsed = time.time() - t0
    print(f"  done in {elapsed:.1f}s")

    # === VERIFY ===
    print(f"\n[3/3] VERIFY: reading new period state…")
    with _supabase.admin() as ac:
        doc2 = ac.select(
            "documents",
            filters={"id": f"eq.{doc_id}"},
            columns="id,status,period_id,error,duration_ms",
        )[0]
        print(f"  document status:  {doc2['status']}")
        print(f"  document error:   {doc2.get('error') or '(none)'}")
        print(f"  duration_ms:      {doc2.get('duration_ms')}")
        new_period_id = doc2.get("period_id")
        if not new_period_id:
            print("  WARN: no new period_id on document")
            sys.exit(2)
        print(f"  NEW period_id:    {new_period_id}")

        metrics = ac.select(
            "calculated_metrics",
            filters={"period_id": f"eq.{new_period_id}"},
            columns="name,value",
        )
        m = {x["name"]: x.get("value") for x in metrics}
        line_items = ac.select(
            "statement_line_items",
            filters={"period_id": f"eq.{new_period_id}"},
            columns="id",
        )
        print(f"  line_items count: {len(line_items)}")
        print(f"\nNEW state:")
        print(f"  total_assets:     {m.get('total_assets')}")
        print(f"  total_equity:     {m.get('total_equity')}")
        print(f"  bs_balance_delta: {m.get('bs_balance_delta')}")

    # Compare to pre-state
    if pre_total_assets is not None:
        ta_diff = (m.get("total_assets") or 0) - (pre_total_assets or 0)
        te_diff = (m.get("total_equity") or 0) - (pre_total_equity or 0)
        bd_diff = (m.get("bs_balance_delta") or 0) - (pre_bs_delta or 0)
        print(f"\nDelta vs pre-A1-reprocess:")
        print(f"  Δ total_assets:     {ta_diff:+,.2f}")
        print(f"  Δ total_equity:     {te_diff:+,.2f}")
        print(f"  Δ bs_balance_delta: {bd_diff:+,.2f}")

    print("\n" + "=" * 70)
    print("EEI A1 re-process COMPLETE")
    print("=" * 70)


if __name__ == "__main__":
    main()
