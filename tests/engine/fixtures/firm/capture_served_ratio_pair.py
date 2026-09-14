#!/usr/bin/env python3
"""Capture the TWO-PERIOD RATIO BLOCK the comparatives route serves, for the
export gates (report HTML, workbook, executive summary).

``GET /api/period/{id}/comparatives`` serves ``ratios`` — composed by
``engine.comparatives.ratio_compare`` from the two ``get_period`` bodies.
The frontend exporters are READERS of that block: they print its quantized
strings and embed each row serialised. Their gates therefore render over a
block the engine really produced, never a hand-written one that agrees with
the reader by construction.

    .venv/bin/python tests/engine/fixtures/firm/capture_served_ratio_pair.py
    .venv/bin/python tests/engine/fixtures/firm/capture_served_ratio_pair.py --check

THE PAIR. Two committed corpus books read back through the real router
(``tests/engine/_served_books.served_body``): agras as the current period,
carniprod as the prior. They are two different anonymised companies, so the
movements are not a real year-on-year story; what the gates need is a real
served block with crossings in both directions, a refused prior, a
not-comparable composite and demoted findings, and this pair carries all of
them. The Scandia FY2025 vs FY2024 pair is batch B8's milestone and is never
committed (client data).

The only inputs touched are the two period labels and period ids, so the
document names two distinguishable periods ("Dec 2025" / "Dec 2024") instead
of the corpus default "2025-12-31" on both sides. Every figure, band, delta,
movement and finding is the composer's output.

Output: ``served_ratio_pair.json`` — ``{"current_label", "prior_label",
"current_book", "prior_book", "current_credit_envelope",
"current_piotroski_envelope", "ratios"}``. ``--check`` recomputes and exits 1
when the committed file differs, so a stale fixture cannot keep the export
gates green; ``tests/engine/test_served_ratio_pair_fixture.py`` runs it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))

OUT = HERE / "served_ratio_pair.json"
CURRENT_BOOK, PRIOR_BOOK = "agras", "carniprod"
CURRENT_LABEL, PRIOR_LABEL = "Dec 2025", "Dec 2024"


def build() -> Dict[str, Any]:
    import _served_books as SB
    from engine.api import _comparatives as C

    cur = SB.served_body(CURRENT_BOOK)
    pri = SB.served_body(PRIOR_BOOK)
    for body, label, pid, end in ((cur, CURRENT_LABEL, "period-agras-dec2025", "2025-12-31"),
                                  (pri, PRIOR_LABEL, "period-carniprod-dec2024", "2024-12-31")):
        body["statements"]["periodLabel"] = label
        body["period"]["id"] = pid
        body["period"]["period_end"] = end
    doc = C.compare_payloads(
        cur, pri,
        current_row={"id": cur["period"]["id"], "period_end": "2025-12-31"},
        prior_row={"id": pri["period"]["id"], "period_end": "2024-12-31"},
    )
    return {
        "current_book": CURRENT_BOOK,
        "prior_book": PRIOR_BOOK,
        "current_label": doc["current"]["label"],
        "prior_label": doc["prior"]["label"],
        # The CURRENT period's served credit and Piotroski envelopes
        # (`GET /api/period` assembled_metrics), which the caller hands the
        # exporters as `CreditEnvelopes`: the report's credit cards print the
        # reader over them beside the served two-period composite rows.
        "current_credit_envelope": (cur.get("assembled_metrics") or {}).get("credit"),
        "current_piotroski_envelope": (cur.get("assembled_metrics") or {}).get("piotroski"),
        "ratios": doc["ratios"],
    }


def serialise(doc: Dict[str, Any]) -> str:
    return json.dumps(doc, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


def main(argv) -> int:
    text = serialise(build())
    if "--check" in argv:
        committed = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if committed != text:
            print("served_ratio_pair.json is stale: re-run capture_served_ratio_pair.py", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
