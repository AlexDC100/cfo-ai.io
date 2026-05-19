"""Loader for the deep-analysis benchmark dataset (Phase 7b).

Reads `benchmarks_deep_seed.json` and upserts:
  - industry_peers          (named competitor financials per CAEN)
  - industry_leader_reasons (5 structural reasons per CAEN)
  - industry_qualitative    (margin tiers + dynamics + patterns + market context)

Idempotent — re-run after editing the JSON. Uses the same admin
client as `seed_benchmarks.py`; designed to be invoked separately
from the percentile seeder so each layer can iterate independently.

Usage:
    .venv/bin/python -m engine.api.seed_benchmarks_deep
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from . import _supabase


logger = logging.getLogger(__name__)

_SEED_FILE = Path(__file__).parent / "benchmarks_deep_seed.json"


def seed_deep_benchmarks() -> Dict[str, int]:
    """Load the deep-benchmark JSON and upsert into the three tables.
    Returns row counts per table for logging."""
    data = json.loads(_SEED_FILE.read_text(encoding="utf-8"))
    industries = data.get("industries", [])
    if not industries:
        raise RuntimeError("benchmarks_deep_seed.json has no `industries` array")

    peers_rows: List[Dict[str, Any]] = []
    reasons_rows: List[Dict[str, Any]] = []
    qualitative_rows: List[Dict[str, Any]] = []

    for industry in industries:
        # An industry block can target multiple CAEN codes (e.g. 1012 +
        # 1013 both share the food-manufacturing peer set). Replicate
        # peer/reason rows under each CAEN so the engine can look up
        # by single key.
        caen_codes = industry.get("caen_codes") or [industry.get("caen_code")]
        caen_codes = [c for c in caen_codes if c]

        leader = industry.get("leader_company") or ""

        for caen in caen_codes:
            for peer in industry.get("peers", []):
                peers_rows.append({
                    "caen_code": caen,
                    "company_name": peer["company_name"],
                    "fiscal_year": peer["fiscal_year"],
                    "revenue_mlei": peer.get("revenue_mlei"),
                    "net_profit_mlei": peer.get("net_profit_mlei"),
                    "net_margin_pct": peer.get("net_margin_pct"),
                    "ebitda_margin_pct": peer.get("ebitda_margin_pct"),
                    "equity_ratio_pct": peer.get("equity_ratio_pct"),
                    "debt_to_equity": peer.get("debt_to_equity"),
                    "specialization": peer.get("specialization"),
                    "tier": peer.get("tier", "median"),
                    "source": peer.get("source", "Public filings"),
                    "notes": peer.get("notes"),
                    "display_order": peer.get("display_order", 0),
                })

            for reason in industry.get("leader_reasons", []):
                reasons_rows.append({
                    "caen_code": caen,
                    "leader_company": leader,
                    "rank": reason["rank"],
                    "title": reason["title"],
                    "description": reason["description"],
                    "margin_impact_pp": reason.get("margin_impact_pp"),
                    "evidence_source": reason.get("evidence_source"),
                })

            qual = industry.get("qualitative") or {}
            if qual:
                qualitative_rows.append({
                    "caen_code": caen,
                    "target_tiers": qual.get("target_tiers"),
                    "dynamics": qual.get("dynamics"),
                    "success_patterns": qual.get("success_patterns"),
                    "failure_modes": qual.get("failure_modes"),
                    "market_context": qual.get("market_context"),
                })

    with _supabase.admin() as ac:
        if peers_rows:
            ac.upsert(
                "industry_peers",
                peers_rows,
                on_conflict="caen_code,company_name,fiscal_year",
                returning=False,
            )
        if reasons_rows:
            ac.upsert(
                "industry_leader_reasons",
                reasons_rows,
                on_conflict="caen_code,rank",
                returning=False,
            )
        if qualitative_rows:
            ac.upsert(
                "industry_qualitative",
                qualitative_rows,
                on_conflict="caen_code",
                returning=False,
            )

    return {
        "peers": len(peers_rows),
        "leader_reasons": len(reasons_rows),
        "qualitative": len(qualitative_rows),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    counts = seed_deep_benchmarks()
    print(f"Seeded {counts['peers']} peer rows, "
          f"{counts['leader_reasons']} leader reasons, "
          f"{counts['qualitative']} qualitative blocks")
