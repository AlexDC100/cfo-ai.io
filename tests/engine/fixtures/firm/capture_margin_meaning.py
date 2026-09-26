#!/usr/bin/env python3
"""Capture ``statements.margin_meaning`` of ``GET /api/period/{id}`` from
REAL ENGINE OUTPUT, for the four firm books committed in this directory.

``capture.py`` captures ``statements`` on the WRITE path, before the route
served a margin verdict; the route has served one since the margin rule
landed (``engine.ratios.margin_meaning``, ``packs/ratios/margin_meaning.yaml``).
``frontend/lib/__tests__/exportBooks.ts`` joins this file onto the captured
statements so every frontend gate renders the book as production serves it
— the developer (``realestate``) with its margins refused and its note,
every other book with a verdict that refuses nothing. Writing the block by
hand in a frontend test would make the page agree with itself.

    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 .venv/bin/python tests/engine/fixtures/firm/capture_margin_meaning.py
    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 .venv/bin/python tests/engine/fixtures/firm/capture_margin_meaning.py --check

Output: ``margin_meaning.json`` — ``{book: <block> | null}`` (null where the
route serves no verdict, i.e. the rule refuses nothing), read off the real
route through ``tests/engine/_served_books.py``.
``tests/engine/test_margin_meaning.py`` regenerates it live and reds when
this file goes stale.
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

BOOKS = ("agras", "carniprod", "realestate", "retail")
OUT = HERE / "margin_meaning.json"


def capture() -> Dict[str, Any]:
    import _served_books as SB

    # None where the route serves no verdict (a book the rule does not refuse)
    return dict((book, SB.served_body(book)["statements"].get("margin_meaning")) for book in BOOKS)


def serialise(blocks: Dict[str, Any]) -> str:
    return json.dumps(blocks, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    fresh = serialise(capture())
    if "--check" in sys.argv[1:]:
        if not OUT.is_file() or OUT.read_text("utf-8") != fresh:
            print("margin_meaning.json is stale; rerun without --check")
            return 1
        print("margin_meaning.json is what the route serves")
        return 0
    OUT.write_text(fresh, "utf-8")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
