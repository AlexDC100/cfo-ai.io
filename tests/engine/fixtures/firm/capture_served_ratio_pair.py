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

THE CORPUS PAIRS. ``served_ratio_pairs.json`` carries the same block for
EVERY ordered pair of the four committed corpus books (12 pairs), so a
reader gate can be book-agnostic: a card that prints its headline, badge or
benchmark from a second ladder is caught on whichever book the two ladders
disagree on, not only on the one pair the gate happened to pick (the
agras / carniprod pair hides the four declared ladder divergences; retail as
the current period does not). Same labels, same composer, same router; per
book the served credit and Piotroski envelopes of the current period.

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
OUT_ALL = HERE / "served_ratio_pairs.json"
CORPUS_BOOKS = ("agras", "carniprod", "realestate", "retail")
CURRENT_BOOK, PRIOR_BOOK = "agras", "carniprod"
CURRENT_LABEL, PRIOR_LABEL = "Dec 2025", "Dec 2024"


def compose(current_book: str, prior_book: str) -> Dict[str, Any]:
    """``compare_payloads`` over two served corpus bodies, labelled as two
    distinguishable periods. Only labels, ids and period ends are set."""
    import _served_books as SB
    from engine.api import _comparatives as C

    cur = SB.served_body(current_book)
    pri = SB.served_body(prior_book)
    for body, label, pid, end in ((cur, CURRENT_LABEL, "period-%s-dec2025" % current_book, "2025-12-31"),
                                  (pri, PRIOR_LABEL, "period-%s-dec2024" % prior_book, "2024-12-31")):
        body["statements"]["periodLabel"] = label
        body["period"]["id"] = pid
        body["period"]["period_end"] = end
    doc = C.compare_payloads(
        cur, pri,
        current_row={"id": cur["period"]["id"], "period_end": "2025-12-31"},
        prior_row={"id": pri["period"]["id"], "period_end": "2024-12-31"},
    )
    return {"cur": cur, "doc": doc}


def build_all() -> Dict[str, Any]:
    """Every ordered pair of the four corpus books, plus each book's served
    credit and Piotroski envelopes (the current period's, by book)."""
    import _served_books as SB

    books: Dict[str, Any] = {}
    for bk in CORPUS_BOOKS:
        body = SB.served_body(bk)
        am = body.get("assembled_metrics") or {}
        books[bk] = {"credit_envelope": am.get("credit"), "piotroski_envelope": am.get("piotroski")}
    pairs: Dict[str, Any] = {}
    for cur in CORPUS_BOOKS:
        for pri in CORPUS_BOOKS:
            if cur == pri:
                continue
            pairs["%s|%s" % (cur, pri)] = compose(cur, pri)["doc"]["ratios"]
    return {"current_label": CURRENT_LABEL, "prior_label": PRIOR_LABEL, "books": books, "pairs": pairs}


def build() -> Dict[str, Any]:
    composed = compose(CURRENT_BOOK, PRIOR_BOOK)
    cur, doc = composed["cur"], composed["doc"]
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


def serialise_compact(doc: Dict[str, Any]) -> str:
    """The twelve-pair file, compact (it is read by gates, not by people;
    the one-pair file above stays indented for review)."""
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def main(argv) -> int:
    outputs = ((OUT, serialise(build())), (OUT_ALL, serialise_compact(build_all())))
    if "--check" in argv:
        stale = [p.name for p, text in outputs
                 if (p.read_text(encoding="utf-8") if p.is_file() else "") != text]
        if stale:
            print("%s stale: re-run capture_served_ratio_pair.py" % ", ".join(stale), file=sys.stderr)
            return 1
        return 0
    for p, text in outputs:
        p.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
