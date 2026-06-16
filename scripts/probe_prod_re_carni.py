"""F3.16-3b.2 / 3b.1.5 — prod forensic trace for RealEstate + Carniprod.
Read-only. Walks ALL prod periods + their documents to find anything
matching RealEstate or Carniprod by filename.
"""
from __future__ import annotations

import sys
from typing import Any, Dict, List

from engine.api import _supabase


def main() -> int:
    with _supabase.admin() as ac:
        periods = ac.select("financial_periods", limit=2000)
        docs = ac.select("documents", limit=2000)

        print(f"Total periods: {len(periods or [])}")
        print(f"Total documents: {len(docs or [])}")
        print()

        # Build lookup
        doc_by_id = {d.get("id"): d for d in (docs or [])}

        # Print all docs, find matches by filename
        print("=== All documents (truncated to 30) ===")
        for d in (docs or [])[:30]:
            fn = (d.get("original_filename") or "").lower()
            tag = ""
            if "realestate" in fn or "real_estate" in fn or "real estate" in fn:
                tag = " ← REALESTATE"
            elif "carniprod" in fn or "carni" in fn:
                tag = " ← CARNIPROD"
            print(f"  doc {d.get('id')[:8]}: {d.get('original_filename')!r} period_id={d.get('period_id')}{tag}")

        # Find matching periods via docs
        targets = []
        for d in (docs or []):
            fn = (d.get("original_filename") or "").lower()
            if "realestate" in fn or "real_estate" in fn or "carniprod" in fn:
                pid = d.get("period_id")
                if pid:
                    matching_period = next((p for p in (periods or []) if p.get("id") == pid), None)
                    if matching_period:
                        targets.append((d, matching_period))

        if not targets:
            print()
            print("=== No periods linked to RealEstate or Carniprod documents ===")
            print()
            print("Periods table contents (raw):")
            for p in (periods or [])[:15]:
                src = p.get("source_document_id")
                doc = doc_by_id.get(src) if src else None
                fn = doc.get("original_filename") if doc else None
                print(f"  pid={(p.get('id') or '')[:8]} pe={p.get('period_end')} doc={fn!r} ce_pnl={p.get('current_year_pnl') if 'current_year_pnl' in (p or {}) else 'n/a'}")
            return 1

        print()
        print(f"=== {len(targets)} matching period(s) found ===")
        for doc, p in targets:
            pid = p.get("id")
            print()
            print(f"--- {doc.get('original_filename')!r} ---")
            print(f"  period_id:           {pid}")
            print(f"  period_end:          {p.get('period_end')}")
            print(f"  source_document_id:  {p.get('source_document_id')}")
            print(f"  document.detected_type: {doc.get('detected_type')!r}")
            print(f"  document.extraction_method: {doc.get('extraction_method')!r}")

            canonical = p.get("assembled_canonical_v1")
            if isinstance(canonical, dict):
                rt = canonical.get("round_trip_check") or {}
                hl = canonical.get("headline") or {}
                print(f"  canonical:           present")
                print(f"    round_trip_passed: {rt.get('passed')}")
                print(f"    max_dev_pct:       {rt.get('max_deviation_pct')}")
                print(f"    net_income:        {hl.get('net_income')!r}")
                print(f"    total_assets:      {hl.get('total_assets')!r}")
                print(f"    total_equity:      {hl.get('total_equity')!r}")
            else:
                print(f"  canonical:           ABSENT")

            items = ac.select(
                "statement_line_items",
                filters={"period_id": f"eq.{pid}"},
                limit=2000,
            ) or []
            items_121 = [it for it in items if str(it.get("ro_account_code") or "").startswith("121")]
            sum_121 = sum(float(it.get("amount") or 0) for it in items_121)
            ce = [it for it in items if (it.get("bucket") or "") == "currentYearPnl"]
            sum_ce = sum(float(it.get("amount") or 0) for it in ce)
            print(f"  line_items total: {len(items)}")
            print(f"  121 rows: {len(items_121)} (sum {sum_121:,.2f})")
            print(f"  currentYearPnl bucket rows: {len(ce)} (sum {sum_ce:,.2f})")
            for it in items_121[:5]:
                print(f"    121: code={it.get('ro_account_code')} bucket={it.get('bucket')!r} amount={it.get('amount')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
