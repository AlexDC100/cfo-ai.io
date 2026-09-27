#!/usr/bin/env python3
"""Capture ``GET /api/period/{id}`` for the CONSTRUCTED books of the
``net-711-rule`` gate, for the frontend's P&L gate (``pl-one-ebitda-page``).

The four firm books cover the bridge (every one is a closed book whose 711
is derived from account 121). They do not cover what the P&L tab must also
print honestly: a REFUSED stock variation (with and without an anchor), a
closed book with no 711 postings and a 121 remainder the accounts do not
explain, own work capitalised (72x) inside EBITDA beside a bridged 711, and
an OPEN book whose 711 is its own movement. The constructed books of
``tests/engine/test_net_711_rule.py`` are exactly those cases — synthetic
figures, no client data — so they are sent through the REAL write seam
(``_deterministic_tb_parsed`` → ``stage_map`` → ``stage_persist``) and the
REAL route, and the served ``statements`` and ``line_items`` are committed
for the frontend to render. Writing the served blocks by hand in a frontend
test would make the page agree with itself.

    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 .venv/bin/python tests/engine/fixtures/one_ebitda/capture_constructed.py
    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 .venv/bin/python tests/engine/fixtures/one_ebitda/capture_constructed.py --check

Output: ``frontend/lib/__tests__/fixtures/oneEbitda/constructed_books.json``
— ``{book: {"statements": …, "line_items": […]}}``.
``tests/engine/test_one_ebitda_fe_books.py`` regenerates it live and reds
when the file goes stale.
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
sys.path.insert(0, str(REPO / "scripts"))

OUT = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "oneEbitda" / "constructed_books.json"

#: Each book, and why the P&L tab needs it.
BOOKS = (
    "closed_bridge",       # 711 derived from account 121 (the bridge)
    "closed_no_activity",  # no 711 postings; a 121 remainder stays visible
    "bridge_with_722",     # 72x inside EBITDA, outside turnover, beside 711
    "open",                # 711 is the book's own movement (sold C − sold D)
    "unanchored",          # 711 refused: account 121 absent (G2)
    "g6_uncleared",        # 711 refused though anchored (G6)
)

#: Line-item fields that identify a persisted row, not the book.
_VOLATILE = ("id", "period_id", "created_at", "updated_at", "org_id", "document_id")


def _served(name: str) -> Dict[str, Any]:
    from _pytest.monkeypatch import MonkeyPatch

    import test_net_711_rule as N
    import test_rebuild_net_income_anchor as ANCHOR

    bk = N._persisted(name)
    mp = MonkeyPatch()
    try:
        with ANCHOR._routed(bk, mp) as (client, _db):
            resp = client.get("/api/period/%s" % bk.period_id,
                              headers={"Authorization": "Bearer test"})
    finally:
        mp.undo()
    if resp.status_code != 200:
        raise SystemExit("GET /api/period answered %s for %s" % (resp.status_code, name))
    body = resp.json()
    items = [dict((k, v) for k, v in li.items() if k not in _VOLATILE)
             for li in (body.get("line_items") or [])]
    items.sort(key=lambda li: (str(li.get("statement")), str(li.get("ro_account_code"))))
    return {"statements": body["statements"], "line_items": items}


def capture() -> Dict[str, Any]:
    return dict((name, _served(name)) for name in BOOKS)


def serialise(blocks: Dict[str, Any]) -> str:
    return json.dumps(blocks, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    fresh = serialise(capture())
    if "--check" in sys.argv[1:]:
        if not OUT.is_file() or OUT.read_text("utf-8") != fresh:
            print("constructed_books.json is stale; rerun without --check")
            return 1
        print("constructed_books.json is what the route serves")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(fresh, "utf-8")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
