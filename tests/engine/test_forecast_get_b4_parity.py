"""forecast-get-b4-parity (plan/2 B5, plan_contract_v2 28.3 B5).

B5 moves GET /api/forecast/{period_id} onto ``project_plan`` through
``load_plan_inputs``. Nothing a reader is served may move: the fp1 bytes of
the four corpus books at horizons 3 and 5 stay equal to the bytes the B4
tree (wave/plan-b4 5bf8b23) served, recorded in
``tests/engine/fixtures/forecast/get_b4.json`` by this file's own recorder
(``python tests/engine/test_forecast_get_b4_parity.py --record`` run with
PYTHONPATH on the B4 tree) in B5's first commit.

THE ONE ALLOWED DIFFERENCE, BY NAME (contract 1.1, 1.4). The B4 route passed
no organization row to the statements rebuild and read ``company_name`` off
``financial_periods``, which has no such column, so it served null. From B5
the loader reads the organizations row, and ``company_name`` is
``organizations.name``. The harness gives the org a name so that difference
is exercised rather than assumed; every field in ORG_ROW_FIELDS is printed
with both values, and any other byte reds.

RED ON, AFTER THE REPAIR (TC-11): any served byte outside ORG_ROW_FIELDS that
differs from the recorded B4 GET on any book or horizon; a status other than
the recorded one; a fixture with no cells (TC-3). It never pins a defect: B6
retires it by name when fp1.2 replaces the bytes (plan_gates.json retired_in).

Reach: create_app, the mounted route, its loader, rebuild, engine, adapter,
contract and boundary guard; only ``_org.resolve_org`` and
``_supabase.per_user`` are replaced, by a row server over one committed book
(as-built B0-6: the harness of scripts/measure_plan_blast_radius.py).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "get_b4.json"
SCHEMA = "get_b4/1"
BOOKS = ("agras", "carniprod", "realestate", "retail")
HORIZONS = (3, 5)
ORG_NAME = "SYNTHETIC ORG NAME (get-b4-parity)"
#: The served fields that may differ because the organizations row now
#: reaches the loader (contract 28.3 B5 "Ships because"). Paths from the root.
ORG_ROW_FIELDS = ("company_name",)


def _measure():
    scripts = str(REPO / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import measure_plan_blast_radius as M
    return M


class _NamedOrgServer(object):
    """The blast-radius row server with the organization NAMED, so the one
    allowed difference is exercised. Built lazily over M._RowServer."""

    @staticmethod
    def build(M, book, period_id, org_id):
        server = M._RowServer(book, period_id, org_id)
        for row in server._tables["organizations"]:
            row["name"] = ORG_NAME
        return server


def _get(M, name: str, horizon: int) -> Tuple[int, Any]:
    from fastapi.testclient import TestClient
    from engine.api import _org, _supabase

    book = M._corpus_book(name)
    period_id, org_id = "get-b4-period", "get-b4-org"
    saved = (_org.resolve_org, _supabase.per_user)
    _org.resolve_org = lambda jwt, requested: ("get-b4-user", org_id)
    _supabase.per_user = lambda jwt: _NamedOrgServer.build(
        M, book, period_id, org_id)
    try:
        client = TestClient(M._app(), raise_server_exceptions=False)
        res = client.get("/api/forecast/%s?horizon=%d" % (period_id, horizon),
                         headers={"Authorization": "Bearer get-b4",
                                  "X-Org-Id": org_id},
                         follow_redirects=False)
    finally:
        _org.resolve_org, _supabase.per_user = saved
    try:
        return res.status_code, res.json()
    except ValueError:
        return res.status_code, {"detail": res.text}


def _canonical(body: Any) -> str:
    return json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _sha(value: Any) -> str:
    import hashlib
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def digest(status: int, body: Any) -> Dict[str, Any]:
    """The recorded form of one GET. The full bodies are ~5 MB each (every
    figure repeats its attribution), so the fixture holds the sha256 of the
    canonical bytes of the whole body with ORG_ROW_FIELDS removed, which is
    what decides red or green, plus the digests that let a red NAME what
    moved: one per root key, and one per figure keyed by line and period
    with its amount in clear."""
    if not isinstance(body, dict):
        return {"status": status, "body_sha256": _sha(body)}
    rest = dict((k, v) for k, v in body.items() if k not in ORG_ROW_FIELDS)
    return {
        "status": status,
        "body_sha256": _sha(rest),
        "org_row_fields": dict((k, body.get(k)) for k in ORG_ROW_FIELDS),
        "root_keys": dict((k, _sha(v)) for k, v in rest.items() if k != "figures"),
        "figures": [[f.get("line"), f.get("period"), f.get("amount_minor"),
                     _sha(f)[7:23]] for f in rest.get("figures") or []],
    }


def _explain(key: str, was: Dict[str, Any], now: Dict[str, Any]) -> List[str]:
    out = []  # type: List[str]
    for root in sorted(set(was.get("root_keys", {})) | set(now.get("root_keys", {}))):
        if was.get("root_keys", {}).get(root) != now.get("root_keys", {}).get(root):
            out.append("%s root key %r moved" % (key, root))
    a = dict(((l, p), (m, h)) for l, p, m, h in was.get("figures", []))
    b = dict(((l, p), (m, h)) for l, p, m, h in now.get("figures", []))
    for cell in sorted(set(a) | set(b), key=str):
        if a.get(cell) != b.get(cell):
            out.append("%s figure %s %s: recorded %s, served %s"
                       % (key, cell[0], cell[1],
                          a.get(cell, ("<absent>",))[0], b.get(cell, ("<absent>",))[0]))
    return out or ["%s body bytes moved (no root key or figure digest names it)" % key]


def record(path: Path = FIXTURE) -> None:
    M = _measure()
    cells = {}  # type: Dict[str, Any]
    for name in BOOKS:
        for horizon in HORIZONS:
            status, body = _get(M, name, horizon)
            again_status, again = _get(M, name, horizon)
            assert (status, _canonical(body)) == (again_status, _canonical(again)), (
                "the GET is not byte-stable within one process: %s h%d"
                % (name, horizon))
            cells["%s:h%d" % (name, horizon)] = digest(status, body)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(
        {"schema": SCHEMA,
         "recorded_from": "wave/plan-b4 5bf8b23 (the B4 tree's GET through create_app)",
         "org_name": ORG_NAME, "cells": cells},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8")
    print("recorded %d cells to %s" % (len(cells), path))


def test_get_bytes_equal_the_recorded_b4_get_except_the_named_org_fields(capsys):
    M = _measure()
    recorded = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert recorded["schema"] == SCHEMA
    cells = recorded["cells"]
    expected = set("%s:h%d" % (n, h) for n in BOOKS for h in HORIZONS)
    assert set(cells) == expected, "TC-3: the fixture does not cover %s" % sorted(
        expected - set(cells))
    units = 0
    allowed_lines = []  # type: List[str]
    reds = []  # type: List[str]
    for key in sorted(cells):
        name, horizon = key.split(":h")
        status, body = _get(M, name, int(horizon))
        now = digest(status, body)
        was = cells[key]
        if now["status"] != was["status"]:
            reds.append("%s status %s, recorded %s" % (key, status, was["status"]))
            continue
        if now["body_sha256"] != was["body_sha256"]:
            reds.extend(_explain(key, was, now))
        for field in ORG_ROW_FIELDS:
            a, b = was["org_row_fields"].get(field), now["org_row_fields"].get(field)
            if a != b:
                allowed_lines.append("%s %s: %r -> %r" % (key, field, a, b))
        units += 1
    with capsys.disabled():
        print("\nSCOPE forecast-get-b4-parity (plan/2 B5, contract 28.3 B5): "
              "books %s; horizons %s; period: each book's own anchor; "
              "reach: create_app + the mounted GET, org and per-user seams "
              "replaced by a row server (as-built B0-6); SYNTHETIC: the "
              "organization name" % (", ".join(BOOKS), HORIZONS))
        print("allowed org-row fields %s; differences observed in them: %d"
              % (list(ORG_ROW_FIELDS), len(allowed_lines)))
        for line in allowed_lines:
            print("  org-row field " + line)
        print("GATE-WORK forecast-get-b4-parity units=%d" % units)
    assert not reds, "GET moved off the recorded B4 bytes:\n  " + "\n  ".join(reds[:40])
    assert units == len(expected)


if __name__ == "__main__":
    if "--record" in sys.argv:
        record()
    else:
        raise SystemExit("usage: --record (run with PYTHONPATH on the B4 tree)")
