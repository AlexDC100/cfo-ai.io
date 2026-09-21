"""forecast-cache (plan/2 B6, plan_contract_v2 1.5): the loaded-rows cache of
``engine.api._forecast_history`` never crosses a workspace and never lets a
run change what the next run reads.

Through the REAL ``create_app`` and the tenancy double (FirmWorld: row
visibility evaluated from the policy text of the migrations), with ORG_A1's
period carrying the agras corpus book.

WHAT IT REDS ON (TC-11), with the repair in place:
  · POST base, POST shocked, POST base in one process giving different base
    body_hash values (a run mutated what the cache holds);
  · a member of another workspace POSTing the same period id and getting
    anything but a refusal, in particular a cached body;
  · the cache being consulted before the org-filtered select returned the row;
  · a cached value that is not immutable bytes, or two loads handing out the
    same objects;
  · the cache never being hit at all (a gate over a cache that is off).
WHAT IT CANNOT SEE: history periods in the key (B7 extends it, gate
forecast-history); a second process (the cache is per process by design).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

import tests.engine.test_firm_tenancy as T
from tests.engine.test_cross_org_reads import (RECOMPUTE_BODY, REFUSAL_CODES,  # noqa: F401
                                               STRANGERS, book_world)
from tests.engine.test_identity_wall import app, hdr, world  # noqa: F401

PATH = "/api/forecast/%s/recompute" % T.PERIOD_A1
SHOCKED = dict(RECOMPUTE_BODY, shocks=[
    {"id": "rail:volume_index", "driver_key": "volume_index", "op": "level_pct",
     "value": "-0.20"},
    {"id": "rail:dso_days", "driver_key": "dso_days", "op": "add_days", "value": "10"}])


def _post(client, uid, org, body):
    return client.post(PATH, headers=hdr(uid, org), json=body)


def test_base_shocked_base_gives_one_base_hash_and_a_stranger_gets_no_cached_body(
        app, book_world, capsys):  # noqa: F811
    from engine.api import _forecast_history as FH
    client = TestClient(app)
    first = _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY)
    assert first.status_code == 200, first.text[:300]
    assert len(FH._CACHE) == 1, "the cache was never filled: this gate would prove nothing"
    shocked = _post(client, T.A_OWNER, T.ORG_A1, SHOCKED)
    assert shocked.status_code == 200, shocked.text[:300]
    assert shocked.json()["body_hash"] != first.json()["body_hash"], "TC-3: the shock moved nothing"
    again = _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY)
    assert again.json()["body_hash"] == first.json()["body_hash"], (
        "the base body changed after a shocked run: a run mutated the cached rows")
    assert len(FH._CACHE) == 1, "three POSTs of one period made %d entries" % len(FH._CACHE)

    asked = 0
    for who, uid, own_org in STRANGERS:
        for org_header in (own_org, T.ORG_A1):
            r = _post(client, uid, org_header, RECOMPUTE_BODY)
            asked += 1
            assert r.status_code in REFUSAL_CODES, (
                "%s [%s] was answered %s on a period whose rows are cached: %s"
                % (who, org_header, r.status_code, r.text[:160]))
            assert "body_hash" not in r.text
    for key, blob in FH._CACHE.items():
        assert key[0] == T.ORG_A1 and key[1] == T.PERIOD_A1, key
        assert isinstance(blob, bytes), "a cached value is %s, not immutable bytes" % type(blob)
    with capsys.disabled():
        print("\nSCOPE forecast-cache (plan/2 B6, contract 1.5): tenancy double, ORG_A1 "
              "period carrying the agras corpus book; owner POSTs base, shocked, base; "
              "strangers %s x own and victim org header" % ", ".join(s[0] for s in STRANGERS))
        print("GATE-WORK forecast-cache units=%d" % (3 + asked + len(FH._CACHE)))


def test_the_select_runs_on_every_request_before_the_cache_is_read(app, book_world):  # noqa: F811
    """1.5: resolve_org and the org-filtered financial_periods select run on
    every request; the cache is consulted only after that select returned the
    row. Deleting the row after a warm hit must answer 404, never the cache."""
    client = TestClient(app)
    assert _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY).status_code == 200
    rows = book_world.tables["financial_periods"]
    kept = [r for r in rows if r.get("id") != T.PERIOD_A1]
    gone = [r for r in rows if r.get("id") == T.PERIOD_A1]
    rows[:] = kept
    try:
        r = _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY)
    finally:
        rows.extend(gone)
    assert r.status_code == 404, (r.status_code, r.text[:200])


def test_two_loads_hand_out_distinct_objects_and_an_update_misses(app, book_world):  # noqa: F811
    from engine.api import _forecast_history as FH
    client = TestClient(app)
    first = _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY)
    assert first.status_code == 200
    blob = list(FH._CACHE.values())[0]
    import json
    a, b = json.loads(blob.decode("utf-8")), json.loads(blob.decode("utf-8"))
    a["line_items"][0]["amount"] = 1
    assert b["line_items"][0]["amount"] != 1 or a["line_items"][0] is not b["line_items"][0]
    for row in book_world.tables["financial_periods"]:
        if row.get("id") == T.PERIOD_A1:
            row["updated_at"] = "2099-01-01T00:00:00+00:00"
    assert _post(client, T.A_OWNER, T.ORG_A1, RECOMPUTE_BODY).status_code == 200
    assert len(FH._CACHE) == 2, "a changed updated_at reused the old entry"
