#!/usr/bin/env python3
"""Capture the ``insights`` block for the four firm books, from REAL
ENGINE OUTPUT.

``capture.py`` captures ``statements``; ``capture_served_metrics.py``
captures ``metrics``; ``capture_industry_signal.py`` captures the account-
mix reading. This captures the FOURTH thing the report will carry — what
the deterministic insight layer (``engine.insights``) notices in each
book, with the accounts and the ladder behind every finding.

WHY A CAPTURED FIXTURE AND NOT A HAND-WRITTEN ONE
=================================================
The frontend gates render the export over this file. A block written by
hand in the test would agree with the renderer by construction and prove
nothing about what a reader gets: the point of the gates is that the
ENGINE'S OWN reading survives into the printed document. So both halves
have to be what production emits.

``tests/engine/test_insights_fixture_fresh.py`` regenerates this live and
reds if the file goes stale, so a frontend gate cannot stay green over a
block the engine no longer produces.

    .venv/bin/python tests/engine/fixtures/firm/capture_insights.py
    .venv/bin/python tests/engine/fixtures/firm/capture_insights.py --check

Output: ``insights.json`` — ``{book: <InsightsBlock>}``.

PROVENANCE
==========
Source: the four ``saga_10_col_<book>.json`` fixtures in this directory,
themselves captured by ``capture.py`` from the real corpus workbooks
(``corpus/saga_10_col_<book>/input.xlsx``) through
``parse -> assemble -> stage_persist``. No synthetic input anywhere in
the chain. The advisory lane is NOT invoked (``drafter=None``), so every
narrative in the captured block is the deterministic template — the
capture stays a pure function of the books and has no model dependency
and no network call.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "src"))

from engine.insights import build_insights  # noqa: E402

BOOKS = ("agras", "carniprod", "realestate", "retail")

OUT = HERE / "insights.json"


def build() -> Dict[str, Any]:
    out = {}  # type: Dict[str, Any]
    for book in BOOKS:
        payload = json.loads((HERE / ("saga_10_col_%s.json" % book)).read_text())
        out[book] = build_insights(payload)
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
