#!/usr/bin/env python3
"""Capture the METRICS half of ``GET /api/period/{id}`` from REAL ENGINE
OUTPUT, for the four firm books already committed in this directory.

``capture.py`` next door captures ``statements`` (the assembled envelope).
A served period response carries a SECOND half the report reads just as
hard — ``metrics``, the ``calculated_metrics`` rows that
``pipeline.stage_compute()`` produces — and section 5 of the report
(Financial Ratios) and the KPI tile's margin sub-label render from it,
not from ``statements``.

Two halves of one response, each with its own arithmetic, is exactly the
shape that let ``net_income_statutory`` carry two different numbers in
one payload. So the frontend gates render the report over BOTH halves as
the engine really produces them, rather than over a hand-written metrics
list that could agree with the statements by construction and prove
nothing.

    .venv/bin/python tests/engine/fixtures/firm/capture_served_metrics.py
    .venv/bin/python tests/engine/fixtures/firm/capture_served_metrics.py --check

Output: ``served_metrics.json`` — ``{book: {metric_name: value}}``.

``stage_compute`` persists to ``calculated_metrics`` at the end of its
body; the Supabase admin client is stubbed here so the capture runs with
no network and no database. Nothing else about the function is touched —
the metric list is whatever the real code path builds.

The engine gate ``tests/engine/test_one_concept_one_value.py`` recomputes
these live and asserts the committed file still matches, so a stale
fixture cannot quietly keep the frontend gates green.
"""

from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterator, List

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "src"))

BOOKS = ("agras", "carniprod", "realestate", "retail")
OUT = HERE / "served_metrics.json"


class _NoDatabase:
    """`stage_compute` ends by wiping + re-inserting `calculated_metrics`.
    Capturing what it COMPUTES needs neither, and must never touch a real
    project."""

    def delete(self, *_a: Any, **_k: Any) -> None:
        return None

    def insert(self, *_a: Any, **_k: Any) -> None:
        return None


@contextlib.contextmanager
def _no_database() -> Iterator[_NoDatabase]:
    yield _NoDatabase()


def served_metrics_for(book: str) -> Dict[str, Any]:
    """The `metrics` array of `GET /api/period/{id}` for one book, as a
    name -> value map, computed by the real `stage_compute`."""
    from engine.api import pipeline

    pipeline._supabase.admin = _no_database  # type: ignore[attr-defined]

    fixture = json.loads((HERE / f"saga_10_col_{book}.json").read_text("utf-8"))
    assembled = {
        "statements": fixture["statements"],
        "source_data_quality": (fixture.get("envelope") or {}).get("source_data_quality") or {},
    }
    metrics: List[Dict[str, Any]] = pipeline.stage_compute(
        {"org_id": "capture"}, assembled, "capture"
    )
    return {m["name"]: m["value"] for m in metrics}


def capture() -> Dict[str, Dict[str, Any]]:
    return {book: served_metrics_for(book) for book in BOOKS}


def main() -> int:
    fresh = capture()
    body = json.dumps(fresh, indent=2, sort_keys=True) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists():
            print(f"MISSING {OUT}")
            return 1
        if OUT.read_text("utf-8") != body:
            print(f"DRIFT {OUT} — re-run without --check")
            return 1
        print(f"OK {OUT}")
        return 0
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT} ({len(fresh)} books)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
