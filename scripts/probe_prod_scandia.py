"""F3.16-3b.2 — prod forensic trace for ALL existing periods.
Read-only. Walks every prod period, prints 121 status + canonical
envelope status + Path A vs Path B classification (inferred from doc
detected_type + extraction_method).
"""
from __future__ import annotations
import sys
from engine.api import _supabase


def main() -> int:
    with _supabase.admin() as ac:
        periods = ac.select("financial_periods", limit=2000) or []
        docs = ac.select("documents", limit=2000) or []
        doc_by_id = {d.get("id"): d for d in docs}

        print(f"Inspecting {len(periods)} prod periods")
        print("=" * 78)

        path_a_count = 0
        path_b_count = 0
        any_121_drift = False

        for p in periods:
            pid = p.get("id")
            pe = p.get("period_end")
            sd = p.get("source_document_id")
            doc = doc_by_id.get(sd) if sd else None
            fn = doc.get("original_filename") if doc else "?"
            dtype = doc.get("detected_type") if doc else "?"
            em = doc.get("extraction_method") if doc else "?"

            path_class = "?"
            if dtype == "trial_balance" and em in ("tb_fast_path", "deterministic_xlsx", "deterministic_pdf"):
                path_class = "A (TB fast-path)"
                path_a_count += 1
            elif em == "claude" or em == "claude_fallback":
                path_class = "B (Claude)"
                path_b_count += 1
            else:
                path_class = f"unknown (dtype={dtype!r} em={em!r})"

            canonical = p.get("assembled_canonical_v1")
            ce_envelope = "present" if isinstance(canonical, dict) else "ABSENT"

            items = ac.select(
                "statement_line_items",
                filters={"period_id": f"eq.{pid}"},
                limit=2000,
            ) or []
            items_121 = [it for it in items if str(it.get("ro_account_code") or "").startswith("121")]
            sum_121 = sum(float(it.get("amount") or 0) for it in items_121)
            ce_rows = [it for it in items if (it.get("bucket") or "") == "currentYearPnl"]
            sum_ce = sum(float(it.get("amount") or 0) for it in ce_rows)

            divergence = abs(sum_121 - sum_ce)
            if divergence > 100_000 and len(items_121) > 0:
                any_121_drift = True

            print()
            print(f"--- {fn!r} | {pe} ---")
            print(f"  period_id:                {pid}")
            print(f"  path classification:      {path_class}")
            print(f"  canonical envelope:       {ce_envelope}")
            if isinstance(canonical, dict):
                hl = canonical.get("headline") or {}
                rt = canonical.get("round_trip_check") or {}
                print(f"    headline.net_income:    {hl.get('net_income')!r}")
                print(f"    headline.total_assets:  {hl.get('total_assets')!r}")
                print(f"    headline.total_equity:  {hl.get('total_equity')!r}")
                print(f"    round_trip passed:      {rt.get('passed')}")
                print(f"    max_dev_pct:            {rt.get('max_deviation_pct')}")
            print(f"  line_items:               {len(items)}")
            print(f"    121 rows:               {len(items_121)} (sum={sum_121:,.2f})")
            print(f"    currentYearPnl rows:    {len(ce_rows)} (sum={sum_ce:,.2f})")
            print(f"    121 vs currentYearPnl:  Δ={divergence:,.2f}")
            if divergence > 100_000 and len(items_121) > 0:
                print(f"    ⚠ DIVERGENCE > 100K — Path X would shift this period")

        print()
        print("=" * 78)
        print(f"Summary: {path_a_count} Path A · {path_b_count} Path B · "
              f"{len(periods) - path_a_count - path_b_count} unknown")
        print(f"Any 121/currentYearPnl divergence > 100K: {any_121_drift}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
