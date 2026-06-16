"""F3.16-3b.5 — read-only classification probe for canonical-envelope
backfill design.

Walks every prod financial_period and classifies its backfill
strategy:
  · re-assemble: line_items intact + 121 row present + source doc available
  · re-extract: line_items sparse OR 121 missing — need source xlsx re-pull
  · unrecoverable: neither source nor intact line items
"""
from __future__ import annotations
import sys
from typing import Any, Dict, List
from engine.api import _supabase


def classify_period(p: Dict[str, Any], items: List[Dict], doc: Dict) -> str:
    canonical = p.get("assembled_canonical_v1")
    if isinstance(canonical, dict) and canonical.get("schema_version"):
        return "already_backfilled"
    items_121 = [it for it in items if str(it.get("ro_account_code") or "").startswith("121")]
    has_line_items = len(items) >= 50
    has_source = bool(doc and doc.get("storage_path"))
    if has_line_items and items_121 and has_source:
        return "re-assemble"
    if has_source:
        return "re-extract"
    return "unrecoverable"


def main() -> int:
    with _supabase.admin() as ac:
        periods = ac.select("financial_periods", limit=2000) or []
        docs = ac.select("documents", limit=2000) or []
        doc_by_id = {d.get("id"): d for d in docs}

        print(f"Total prod periods: {len(periods)}")
        print(f"Total prod documents: {len(docs)}")
        print()

        by_strategy: Dict[str, List[Dict]] = {
            "already_backfilled": [],
            "re-assemble": [],
            "re-extract": [],
            "unrecoverable": [],
        }

        for p in periods:
            pid = p.get("id")
            sd = p.get("source_document_id")
            doc = doc_by_id.get(sd) if sd else {}
            items = ac.select(
                "statement_line_items",
                filters={"period_id": f"eq.{pid}"},
                limit=2000,
            ) or []
            strat = classify_period(p, items, doc or {})
            by_strategy[strat].append({
                "period_id": pid,
                "period_end": p.get("period_end"),
                "doc_filename": doc.get("original_filename") if doc else None,
                "doc_status": doc.get("status") if doc else None,
                "line_items_count": len(items),
                "items_121_count": sum(
                    1 for it in items
                    if str(it.get("ro_account_code") or "").startswith("121")
                ),
                "has_source": bool(doc and doc.get("storage_path")),
            })

        print("=" * 80)
        for strat, items in by_strategy.items():
            print(f"  {strat:>22s}: {len(items)} period(s)")
            for entry in items[:10]:
                print(
                    f"    pid={entry['period_id'][:8]} "
                    f"end={entry['period_end']} "
                    f"items={entry['line_items_count']} "
                    f"121={entry['items_121_count']} "
                    f"src={entry['has_source']} "
                    f"file={entry['doc_filename']!r}"
                )
            if len(items) > 10:
                print(f"    ... and {len(items) - 10} more")
        print()

        print("=" * 80)
        print("Backfill batch plan:")
        print(f"  · re-assemble candidates: {len(by_strategy['re-assemble'])} (low risk)")
        print(f"  · re-extract candidates:  {len(by_strategy['re-extract'])} (medium risk — re-pulls xlsx)")
        print(f"  · unrecoverable:          {len(by_strategy['unrecoverable'])} (permanent ADR gap)")
        print(f"  · already_backfilled:     {len(by_strategy['already_backfilled'])} (skip)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
