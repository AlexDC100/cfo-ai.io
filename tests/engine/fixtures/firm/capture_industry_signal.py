#!/usr/bin/env python3
"""Capture the ``industry_signal`` block of ``GET /api/period/{id}`` from
REAL ENGINE OUTPUT, for the four firm books committed in this directory.

``capture.py`` captures ``statements``; ``capture_served_metrics.py``
captures ``metrics``. This captures the THIRD thing that response carries
since the industry gate landed — what the account mix says the company
does, the evidence for it, and whether that agrees with the workspace's
``organizations.industry_key``.

The frontend gate ``frontend/pages/cfo/__tests__/industryBlock.test.tsx``
(G5) renders the report over this file. Writing that block by hand in the
test would make it agree with the module by construction and prove
nothing — the point of the gate is that the SERVED reading blocks the
SERVED sector content, so both halves have to be what production emits.

    .venv/bin/python tests/engine/fixtures/firm/capture_industry_signal.py
    .venv/bin/python tests/engine/fixtures/firm/capture_industry_signal.py --check

Output: ``industry_signal.json`` — ``{book: {workspace_key: <block>}}``.
Two workspace settings are captured per book, because the gate needs
both halves of the same question:

  · ``real_estate_residential`` — the setting the Agras report actually
    shipped with, i.e. the disagreement the block exists for
  · the book's own family key — the agreement case, which is what keeps
    the gate from passing by blocking everything

``tests/engine/test_structural_industry_signal.py`` regenerates these
live and reds if this file goes stale, so a frontend gate cannot stay
green over a payload the engine no longer serves.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "src"))

from engine.industry import build_industry_signal  # noqa: E402

BOOKS = ("agras", "carniprod", "realestate", "retail")

# The workspace settings each book is captured under. The first is the
# mis-set one from the live Agras report; the second is the setting that
# agrees with the book, so the gate can prove the block is conditional.
SETTINGS: Dict[str, Dict[str, str]] = {
    "agras":      {"real_estate_residential": "Real estate · residential rental",
                   "manufacturing": "Manufacturing · industrial"},
    "carniprod":  {"real_estate_residential": "Real estate · residential rental",
                   "manufacturing": "Manufacturing · industrial"},
    "retail":     {"real_estate_residential": "Real estate · residential rental",
                   "retail_ecom": "Retail · e-commerce"},
    "realestate": {"manufacturing": "Manufacturing · industrial",
                   "real_estate_residential": "Real estate · residential rental"},
}

OUT = HERE / "industry_signal.json"


def build() -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for book in BOOKS:
        fixture = json.loads((HERE / ("saga_10_col_%s.json" % book)).read_text())
        line_items = fixture.get("line_items") or []
        per_setting: Dict[str, Any] = {}
        for key, display in SETTINGS[book].items():
            # Same call the route makes: the bases come from the line
            # items, so every share is reproducible from the accounts the
            # evidence names.
            per_setting[key] = build_industry_signal(
                line_items,
                industry_key=key,
                industry_display=display,
            )
        out[book] = per_setting
    return out


def main() -> int:
    built = build()
    text = json.dumps(built, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists():
            print("MISSING %s" % OUT)
            return 1
        if OUT.read_text() != text:
            print("STALE %s — re-run without --check" % OUT)
            return 1
        print("FRESH %s" % OUT)
        return 0
    OUT.write_text(text)
    print("wrote %s (%d books)" % (OUT, len(built)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
