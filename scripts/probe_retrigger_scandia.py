"""Track 4 verification — re-trigger a Scandia Food doc to confirm
the wrapper-kwarg fix doesn't quietly regress non-RealEstate
periods. Sanity check; not a full re-baseline."""
from __future__ import annotations
import sys, time, logging
from engine.api import _supabase
from engine.api.pipeline import _run_pipeline_sync


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    with _supabase.admin() as ac:
        docs = ac.select("documents", limit=2000) or []
        # Find a Scandia trial balance doc that's already linked to a
        # period (so we know the path works). Pick the freshest.
        sf_docs = [
            d for d in docs
            if "scandia trial balance" in (d.get("original_filename") or "").lower()
            and d.get("period_id")
        ]
        if not sf_docs:
            print("NO LINKED SCANDIA DOC FOUND")
            return 1
        sf_docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
        d = sf_docs[0]
        doc_id = d.get("id")
        original_period_id = d.get("period_id")
        print(f"Re-triggering pipeline on Scandia doc: {doc_id}")
        print(f"  original_filename: {d.get('original_filename')!r}")
        print(f"  current period_id: {original_period_id}")

    print()
    print("Running _run_pipeline_sync...")
    t0 = time.time()
    _run_pipeline_sync(doc_id)
    print(f"Pipeline completed in {time.time() - t0:.1f}s")

    with _supabase.admin() as ac:
        # Fetch new period (re-trigger creates a new period each time)
        rows = ac.select("documents", filters={"id": f"eq.{doc_id}"}, single=True)
        d2 = rows[0] if rows else {}
        pid = d2.get("period_id")
        print(f"  post-run status: {d2.get('status')!r}")
        print(f"  post-run period_id: {pid}")

        if not pid:
            print("FAIL: no period_id after re-trigger")
            return 1

        prows = ac.select("financial_periods",
                          filters={"id": f"eq.{pid}"}, single=True)
        p = prows[0] if prows else {}
        canonical = p.get("assembled_canonical_v1") or {}
        rt = canonical.get("round_trip_check") or {}
        meth = canonical.get("methodology") or {}
        totals = meth.get("totals") or {}
        leaves = canonical.get("leaves") or {}

        print()
        print(f"Period {pid}:")
        print(f"  canonical present:    {bool(canonical)}")
        print(f"  round_trip_passed:    {rt.get('passed')}")
        print(f"  max_deviation_pct:    {rt.get('max_deviation_pct')}")
        print(f"  totals.total_assets:  {totals.get('total_assets')!r}")
        print(f"  totals.total_equity:  {totals.get('total_equity')!r}")
        print(f"  totals.revenue_net:   {totals.get('revenue_net')!r}")
        # Look for current-year leaf
        cy_leaves = {k: v for k, v in leaves.items()
                     if "current" in k.lower() or "121" in k}
        for k, v in cy_leaves.items():
            print(f"  leaf.{k}: magnitude={v.get('magnitude')} sign={v.get('sign_meaning')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
