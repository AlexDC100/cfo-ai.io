"""Locate the current_year_pnl / equity values in the new F4.1
canonical envelope shape."""
from __future__ import annotations
import sys, json
from engine.api import _supabase

PID = "a64a682e-87b2-4aa6-b3ef-b30dee6b7df7"


def main() -> int:
    with _supabase.admin() as ac:
        rows = ac.select("financial_periods",
                         filters={"id": f"eq.{PID}"}, single=True)
        p = rows[0]
        canonical = p.get("assembled_canonical_v1") or {}

        # round_trip_check
        rt = canonical.get("round_trip_check") or {}
        print("ROUND TRIP CHECK")
        for k, v in rt.items():
            print(f"  {k}: {v!r}")
        print()

        # Equity-related leaves
        leaves = canonical.get("leaves") or {}
        print(f"LEAVES (total {len(leaves)})")
        # Find any leaf that smells like equity / current_year / 121
        keys_of_interest = [
            k for k in leaves.keys()
            if "equity" in k.lower() or "current" in k.lower()
            or "pnl" in k.lower() or "121" in k.lower()
            or "retain" in k.lower() or "reserve" in k.lower()
        ]
        for k in keys_of_interest:
            v = leaves[k]
            print(f"  {k}: {v}")
        print()

        # Equity aggregates
        agg = canonical.get("aggregates") or {}
        print(f"AGGREGATES (total {len(agg)})")
        eq_aggs = [k for k in agg.keys()
                   if "equity" in k.lower() or "current" in k.lower()
                   or "pnl" in k.lower() or "retain" in k.lower()
                   or "reserve" in k.lower() or "share" in k.lower()]
        for k in eq_aggs:
            v = agg[k]
            print(f"  {k}: net={v.get('net'):,.2f}  leaves={v.get('leaves')}")
        print()

        # methodology block — contains ratios, totals, ebitda
        meth = canonical.get("methodology") or {}
        print("METHODOLOGY block")
        for k, v in meth.items():
            if isinstance(v, dict):
                print(f"  {k}: dict keys={list(v.keys())[:10]}")
            elif isinstance(v, (list, tuple)):
                print(f"  {k}: list len={len(v)}")
            else:
                print(f"  {k}: {v!r}")
        print()

        # Drill into methodology.totals if present
        totals = meth.get("totals") or {}
        if totals:
            print("methodology.totals:")
            for k, v in totals.items():
                if isinstance(v, (int, float)):
                    print(f"  {k}: {v:,.2f}")
                else:
                    print(f"  {k}: {v!r}")
            print()

        # Drill into methodology.ebitda
        eb = meth.get("ebitda") or {}
        if eb:
            print("methodology.ebitda:")
            for k, v in eb.items():
                if isinstance(v, (int, float)):
                    print(f"  {k}: {v:,.2f}")
                else:
                    print(f"  {k}: {v!r}")
            print()

        # Check statement_line_items for 121 + current_year_pnl bucket
        items = ac.select(
            "statement_line_items",
            filters={"period_id": f"eq.{PID}"},
            limit=2000,
        ) or []
        items_121 = [it for it in items if str(it.get("ro_account_code") or "").startswith("121")]
        ce_rows = [it for it in items if (it.get("bucket") or "") == "currentYearPnl"]
        print(f"LINE ITEMS: {len(items)} total")
        print(f"  121 rows: {len(items_121)}")
        for it in items_121[:5]:
            print(f"    code={it.get('ro_account_code')} bucket={it.get('bucket')!r} amount={it.get('amount')}")
        print(f"  currentYearPnl bucket rows: {len(ce_rows)}")
        for it in ce_rows[:5]:
            print(f"    code={it.get('ro_account_code')} amount={it.get('amount')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
