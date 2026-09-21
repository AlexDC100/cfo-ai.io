"""period-loader-parity (plan/2 B5, plan_contract_v2 1.4).

``engine.api.pipeline.load_period_rows`` is the one module-scope period
reader. The statements it rebuilds must be the statements GET
/api/period/{period_id} serves: a forecast that opened on a different
balance sheet than the one the dashboard shows would be a second authority.

Through create_app and the mounted handler, with only the org and per-user
seams replaced by a row server over one committed book (as-built B0-6), on
the four corpus books: assembled_pl, assembled_bs, assembled_cf and
assembled_canonical_v1 from load_period_rows equal, byte for byte, the ones
get_period serves.

RED ON, AFTER THE REPAIR (TC-11): any byte of the four keys differing on any
book, named by key and book; a key absent on either side (TC-3); the loader
swallowing a rebuild failure instead of raising StatementsRebuildError; a
period outside the resolved workspace being returned.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "realestate", "retail")
KEYS = ("assembled_pl", "assembled_bs", "assembled_cf", "assembled_canonical_v1")
WORK = {"units": 0}


def _measure():
    scripts = str(REPO / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import measure_plan_blast_radius as M
    return M


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _served(M, book, period_id, org_id):
    from fastapi.testclient import TestClient
    with M._patched(book, period_id, org_id):
        res = TestClient(M._app(), raise_server_exceptions=False).get(
            "/api/period/%s" % period_id,
            headers={"Authorization": "Bearer loader-parity"}, follow_redirects=False)
    assert res.status_code == 200, (res.status_code, res.text[:300])
    return res.json()["statements"]


def _loaded(M, book, period_id, org_id, drop_last=False):
    from engine.api import pipeline
    server = M._RowServer(book, period_id, org_id)
    if drop_last:
        server._tables["statement_line_items"].pop()
    return pipeline.load_period_rows(server, period_id, org_id=org_id, rebuild=True)


def differences(served, loaded):
    out = []
    for key in KEYS:
        if key not in served or key not in loaded or served[key] is None:
            out.append("%s absent (served %s, loaded %s)" % (
                key, key in served and served[key] is not None, key in loaded))
        elif _canonical(served[key]) != _canonical(loaded[key]):
            out.append("%s differs" % key)
    return out


@pytest.mark.parametrize("name", BOOKS)
def test_loader_statements_equal_the_statements_get_period_serves(name):
    M = _measure()
    book = M._corpus_book(name)
    served = _served(M, book, "loader-parity-period", "loader-parity-org")
    loaded = _loaded(M, book, "loader-parity-period", "loader-parity-org")["statements"]
    found = differences(served, loaded)
    assert not found, "%s: %s" % (name, "; ".join(found))
    WORK["units"] += len(KEYS)


def test_the_comparison_sees_a_dropped_line_item():
    """The gate's own sensitivity, in process: the statements rebuilt from
    one row fewer are not the served ones."""
    M = _measure()
    book = M._corpus_book("agras")
    served = _served(M, book, "loader-parity-period", "loader-parity-org")
    loaded = _loaded(M, book, "loader-parity-period", "loader-parity-org",
                     drop_last=True)["statements"]
    assert differences(served, loaded), "dropping a row moved none of %s" % (KEYS,)
    WORK["units"] += 1


def test_a_rebuild_failure_raises_and_a_foreign_org_is_not_found(monkeypatch):
    from engine.api import pipeline
    M = _measure()
    book = M._corpus_book("retail")
    server = M._RowServer(book, "p", "org-a")
    with pytest.raises(pipeline.PeriodNotFound):
        pipeline.load_period_rows(server, "p", org_id="org-b")

    def _boom(*_a, **_k):
        raise RuntimeError("SYNTHETIC rebuild failure")

    monkeypatch.setattr(pipeline, "_rebuild_assembled_for_briefing", _boom)
    with pytest.raises(pipeline.StatementsRebuildError) as caught:
        pipeline.load_period_rows(server, "p", org_id="org-a")
    assert caught.value.sentence()["code"] == "statements_rebuild_failed"
    # and the route answers 409 with that sentence, never a projection
    from fastapi.testclient import TestClient
    with M._patched(book, "p", "org-a"):
        res = TestClient(M._app(), raise_server_exceptions=False).get(
            "/api/forecast/p?horizon=3",
            headers={"Authorization": "Bearer x", "X-Org-Id": "org-a"})
    assert res.status_code == 409, (res.status_code, res.text[:200])
    assert res.json()["detail"]["code"] == "statements_rebuild_failed"
    WORK["units"] += 3


def test_the_rebuild_s_own_swallowed_failure_is_a_rebuild_failure(monkeypatch):
    """B5V-6: _rebuild_assembled_for_briefing catches its canonical
    re-assembly failure and returns statements with no assembled P&L. The
    loader accepted that dict, the GET answered 422 about a cost pool, and
    scripts/measure_statement_rebuilds.py counted the period as rebuilt — the
    owner's live count before B13 would have read a false zero.

    RED ON: the assembled_pl / assembled_bs presence check removed from
    load_period_rows."""
    from engine.api import pipeline
    M = _measure()
    book = M._corpus_book("agras")
    server = M._RowServer(book, "p", "org-a")

    def _boom(*_a, **_k):
        raise RuntimeError("SYNTHETIC inner assembly failure")

    monkeypatch.setattr(pipeline, "_assemble_with_statutory_anchor", _boom)
    # TC-3: the inner failure really is swallowed by the rebuild itself
    rebuilt = pipeline._rebuild_assembled_for_briefing(
        server._tables["statement_line_items"], server._tables["financial_periods"][0],
        None)
    assert not isinstance((rebuilt.get("statements") or {}).get("assembled_pl"), dict), (
        "TC-3: the rebuild no longer swallows its assembly failure; this case is vacuous")
    with pytest.raises(pipeline.StatementsRebuildError):
        pipeline.load_period_rows(server, "p", org_id="org-a")
    from fastapi.testclient import TestClient
    with M._patched(book, "p", "org-a"):
        res = TestClient(M._app(), raise_server_exceptions=False).get(
            "/api/forecast/p?horizon=3",
            headers={"Authorization": "Bearer x", "X-Org-Id": "org-a"})
    assert res.status_code == 409, (res.status_code, res.text[:300])
    assert res.json()["detail"]["code"] == "statements_rebuild_failed"
    # and the owner's count sees it
    import measure_statement_rebuilds as counter
    tally = {}
    ok, failed = counter._count("agras", server, ["p"], "org-a", tally)
    assert (ok, failed) == (0, 1), (ok, failed, tally)
    WORK["units"] += 3


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE period-loader-parity (plan/2 B5, contract 1.4): books %s; keys %s; "
              "reach: create_app + GET /api/period/{id} against "
              "pipeline.load_period_rows over the same rows; SYNTHETIC: the rebuild "
              "failure" % (", ".join(BOOKS), ", ".join(KEYS)))
        print("GATE-WORK period-loader-parity units=%d" % WORK["units"])
    assert WORK["units"] >= len(BOOKS) * len(KEYS)
