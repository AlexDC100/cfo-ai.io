"""Dump the full shape of a financial_period row to find where the
canonical numbers live."""
from __future__ import annotations
import sys, json
from engine.api import _supabase

PID = "a64a682e-87b2-4aa6-b3ef-b30dee6b7df7"


def main() -> int:
    with _supabase.admin() as ac:
        rows = ac.select("financial_periods",
                         filters={"id": f"eq.{PID}"}, single=True)
        if not rows:
            print(f"Period {PID} not found")
            return 1
        p = rows[0]

        print(f"=== Period {PID} columns ===")
        for k, v in p.items():
            if isinstance(v, (dict, list)):
                preview = json.dumps(v)[:80]
                print(f"  {k}: <{type(v).__name__} len={len(json.dumps(v))}> {preview}…")
            else:
                print(f"  {k}: {v!r}")
        print()

        # Drill into assembled_canonical_v1
        canonical = p.get("assembled_canonical_v1")
        if isinstance(canonical, dict):
            print("=== assembled_canonical_v1 keys ===")
            for k in canonical.keys():
                v = canonical.get(k)
                if isinstance(v, dict):
                    print(f"  {k}: dict keys={list(v.keys())[:10]}")
                elif isinstance(v, list):
                    print(f"  {k}: list len={len(v)}")
                else:
                    print(f"  {k}: {v!r}")
            print()
            # Statements section
            stmts = canonical.get("statements") or {}
            if stmts:
                print("=== statements ===")
                for k in stmts.keys():
                    v = stmts.get(k)
                    if isinstance(v, dict):
                        print(f"  statements.{k}: dict keys={list(v.keys())[:15]}")
                bs = stmts.get("assembled_bs") or {}
                if bs:
                    print()
                    print("=== statements.assembled_bs ===")
                    print(f"  total_assets:      {bs.get('total_assets'):,.2f}")
                    print(f"  total_equity:      {bs.get('total_equity'):,.2f}")
                    print(f"  total_liabilities: {bs.get('total_liabilities'):,.2f}")
                    print(f"  bs_balance_delta:  {bs.get('bs_balance_delta'):,.2f}")
                    print(f"  current_year_pnl:  {bs.get('current_year_pnl'):,.2f}")
                    ta = float(bs.get('total_assets') or 0)
                    delta = float(bs.get('bs_balance_delta') or 0)
                    pct = (abs(delta) / ta * 100) if ta > 0 else 0
                    print(f"  drift %:           {pct:.4f}%")
            # Aggregates
            agg = canonical.get("aggregates") or {}
            if agg:
                print()
                print("=== aggregates (a sample) ===")
                for k in list(agg.keys())[:8]:
                    v = agg.get(k)
                    if isinstance(v, dict) and "net" in v:
                        print(f"  {k}: net={v.get('net'):,.2f}")
                    else:
                        print(f"  {k}: {v}")
            # Headline
            hl = canonical.get("headline") or {}
            if hl:
                print()
                print("=== headline ===")
                for k, v in hl.items():
                    print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
