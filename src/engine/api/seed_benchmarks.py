"""One-time loader for the industry_benchmarks table.

Reads `benchmarks_seed.json` and upserts each (caen_code, metric_name)
pair via the project's existing Supabase admin client. Idempotent —
safe to re-run after editing the JSON.

Usage:
    .venv/bin/python -m engine.api.seed_benchmarks

Picks up SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the env (loaded
by the same `.env` the FastAPI app uses). No asyncpg dependency — we
go through PostgREST like the rest of the codebase so RLS / connection
pooling / migrations stay consistent.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from . import _supabase


logger = logging.getLogger(__name__)

_SEED_FILE = Path(__file__).parent / "benchmarks_seed.json"


def _metric_type_for_unit(unit: str) -> str:
    """Map seed-JSON `unit` strings to the table's metric_type enum."""
    if unit == "pct":
        return "pct_of_revenue"
    if unit == "ratio":
        return "ratio"
    return "absolute"


def seed_benchmarks() -> int:
    """Upsert all rows from the JSON seed. Returns the number of (caen,
    metric) pairs processed. Uses the admin Supabase client because
    the catalogue write is service-role only."""
    data = json.loads(_SEED_FILE.read_text(encoding="utf-8"))
    industries = data.get("industries", [])
    if not industries:
        raise RuntimeError("benchmarks_seed.json has no `industries` array")

    rows: List[Dict[str, Any]] = []
    for industry in industries:
        caen = industry["caen_code"]
        label = industry["caen_label"]
        category = industry["industry_category"]
        source = industry["source"]
        for metric in industry.get("metrics", []):
            rows.append({
                "caen_code": caen,
                "caen_label": label,
                "industry_category": category,
                "metric_name": metric["name"],
                "metric_type": _metric_type_for_unit(metric.get("unit", "")),
                "p25_value": metric.get("p25"),
                "p50_value": metric.get("p50"),
                "p75_value": metric.get("p75"),
                "unit": metric.get("unit"),
                "source_label": source,
                "source_year": 2024,
                "confidence": "estimated",
                "notes": metric.get("notes", "") or None,
            })

    with _supabase.admin() as ac:
        # PostgREST `upsert` on the unique (caen_code, metric_name)
        # constraint replaces percentile / source fields each run so
        # the JSON stays the single source of truth.
        ac.upsert(
            "industry_benchmarks",
            rows,
            on_conflict="caen_code,metric_name",
            returning=False,
        )
    return len(rows)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    n = seed_benchmarks()
    print(f"Seeded {n} benchmark rows from {_SEED_FILE.name}")
