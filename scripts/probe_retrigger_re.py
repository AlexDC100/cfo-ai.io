"""Find the RealEstate doc UUID, re-trigger the pipeline, then dump
the resulting period's metrics. F3.16-3b.2 post-deploy verification."""
from __future__ import annotations
import sys, time, logging
from engine.api import _supabase
from engine.api.pipeline import _run_pipeline_sync


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    with _supabase.admin() as ac:
        docs = ac.select("documents", limit=2000) or []
        re_docs = [
            d for d in docs
            if "realestate" in (d.get("original_filename") or "").lower()
            or "real_estate" in (d.get("original_filename") or "").lower()
        ]
        if not re_docs:
            print("NO REALESTATE DOC FOUND")
            return 1

        # Pick the most recent one (any doc — they all reference the same file)
        re_docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
        d = re_docs[0]
        doc_id = d.get("id")
        print(f"Found RealEstate doc: {doc_id}")
        print(f"  original_filename: {d.get('original_filename')!r}")
        print(f"  status:            {d.get('status')!r}")
        print(f"  period_id:         {d.get('period_id')!r}")
        print(f"  org_id:            {d.get('org_id')!r}")

    print()
    print("Triggering _run_pipeline_sync...")
    t0 = time.time()
    _run_pipeline_sync(doc_id)
    print(f"Pipeline completed in {time.time() - t0:.1f}s")
    print()

    # Re-fetch the doc + period to see the result
    with _supabase.admin() as ac:
        rows = ac.select("documents", filters={"id": f"eq.{doc_id}"}, single=True)
        d2 = rows[0] if rows else {}
        print(f"Post-run doc state:")
        print(f"  status:          {d2.get('status')!r}")
        print(f"  period_id:       {d2.get('period_id')!r}")
        print(f"  pipeline_started_at: {d2.get('pipeline_started_at')}")

        pid = d2.get("period_id")
        if pid:
            p_rows = ac.select(
                "financial_periods",
                filters={"id": f"eq.{pid}"},
                single=True,
            )
            p = p_rows[0] if p_rows else {}
            print()
            print(f"Period {pid}:")
            print(f"  company_name: {p.get('company_name')!r}")
            print(f"  period_end:   {p.get('period_end')!r}")
            canonical = p.get("assembled_canonical_v1")
            if isinstance(canonical, dict):
                rt = canonical.get("round_trip_check") or {}
                hl = canonical.get("headline") or {}
                print(f"  canonical:    present")
                print(f"    round_trip passed:    {rt.get('passed')}")
                print(f"    max_deviation_pct:    {rt.get('max_deviation_pct')}")
                print(f"    net_income:           {hl.get('net_income')!r}")
                print(f"    total_assets:         {hl.get('total_assets')!r}")
                print(f"    total_equity:         {hl.get('total_equity')!r}")
                print(f"    ebitda:               {hl.get('ebitda')!r}")
                # Pull current_year_pnl from leaves or aggregates
                leaves = canonical.get("leaves") or {}
                if "retained_earnings_current_year" in leaves:
                    print(f"    current_year_pnl leaf: {leaves['retained_earnings_current_year']}")
            else:
                print(f"  canonical:    ABSENT")

            # Also try assembled_bs field on period
            bs = p.get("assembled_bs")
            if isinstance(bs, dict):
                print(f"  assembled_bs:")
                print(f"    current_year_pnl:  {bs.get('current_year_pnl')!r}")
                print(f"    total_assets:      {bs.get('total_assets')!r}")
                print(f"    total_equity:      {bs.get('total_equity')!r}")
                print(f"    bs_balance_delta:  {bs.get('bs_balance_delta')!r}")
            elif isinstance(bs, str):
                print(f"  assembled_bs (string len {len(bs)})")
            else:
                print(f"  assembled_bs: type={type(bs).__name__}")

            ce = p.get("current_year_pnl")
            ta = p.get("total_assets")
            te = p.get("total_equity")
            bbd = p.get("bs_balance_delta")
            print(f"  period.current_year_pnl: {ce!r}")
            print(f"  period.total_assets:     {ta!r}")
            print(f"  period.total_equity:     {te!r}")
            print(f"  period.bs_balance_delta: {bbd!r}")
        else:
            print()
            print("No period_id on doc after pipeline run. Doc status:", d2.get("status"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
