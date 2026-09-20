"""A legitimate member of one workspace may not read another's data.

THE GAP THIS FILLS. `test_identity_wall` proves a FORGED bearer is refused
and that a firm viewer holding only a read cell cannot WRITE. Neither is
the adversary of the two P0s found on 2026-09-09. Both of those were a
fully legitimate, signed-in user — a real membership, a valid signature,
their own workspace — reaching an id belonging to somebody else's:

  · `documents.storage_path` naming another org's folder, and the engine
    signing it with the service role;
  · `documents.period_id` naming another org's period, and the engine
    deleting that period's entire analysis.

Nothing drove a cross-org READ against a product route, which is why the
first of those was found by reading code rather than by a red gate.

WHAT THIS FILE DOES. It takes ORG_A1's real period and document ids and
asks for them as SOLO and as B_OWNER — two users with genuine, correctly
signed memberships in workspaces of their own and none in ORG_A1 — across
every product read route that takes an id in its path. A route must answer
403 or 404. Answering 200 with another tenant's figures is the finding.

WHAT IT REDS ON, with the boundary intact (TC-11):
  · any id-addressed product read route serving a non-member
  · a route that answers 200 with an empty/None body where it should have
    refused (a silent leak is still a leak of existence)
  · the route list going empty, which would make the sweep vacuous
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import tests.engine.test_firm_tenancy as T
from tests.engine.test_identity_wall import app, hdr, world  # noqa: F401  (fixtures)


#: Product routes that take an OWNED id in the path, as (method, path,
#: json_body, expected_success) (plan/2 B6, plan_contract_v2 1.6). Each is
#: formatted with ORG_A1's own ids, then requested by a stranger. POST
#: recompute is a read-only compute and belongs here: it projects another
#: tenant's period if the wall is missing. 422 never counts as a refusal.
RECOMPUTE_BODY = {"horizon": {"total_years": 3, "monthly_months": 12}}


def _routes():
    p = T.PERIOD_A1
    return [
        ("GET", "/api/period/%s" % p, None, 200),
        ("GET", "/api/period/%s/valuation" % p, None, 200),
        # NOTE: /valuation-assumptions is PUT-only; a GET there is 405,
        # which is a wrong-method answer and not a boundary result, so it
        # belongs in the write census (test_identity_wall), not here.
        ("GET", "/api/forecast/%s" % p, None, 200),
        ("POST", "/api/forecast/%s/recompute" % p, RECOMPUTE_BODY, 200),
    ]


@pytest.fixture
def book_world(world):  # noqa: F811
    """ORG_A1's period carrying a REAL book (the agras corpus fixture), so
    the owner's forecast answers 200 rather than the engine's refusal of an
    empty book: the positive control of 1.6 needs a route that serves."""
    import json
    from pathlib import Path
    book = json.loads((Path(__file__).resolve().parent / "fixtures" / "firm"
                       / "saga_10_col_agras.json").read_text(encoding="utf-8"))
    from engine.api import _forecast_history
    _forecast_history.clear_cache()
    for row in world.tables["financial_periods"]:
        if row.get("id") == T.PERIOD_A1:
            row["assembled_canonical_v1"] = book["envelope"]
            row["period_end"] = book["period_end"]
            row["currency"] = book["currency"]
    columns = set(world.columns["statement_line_items"])
    for n, item in enumerate(book["line_items"]):
        full = dict((k, v) for k, v in item.items() if k in columns)
        full.update(id="00000000-0000-0000-0000-%012x" % (0xb60000 + n),
                    period_id=T.PERIOD_A1)
        if "org_id" in columns:
            full["org_id"] = T.ORG_A1
        world.tables["statement_line_items"].append(full)
    yield world
    _forecast_history.clear_cache()


def _ask(client, method, path, body, headers):
    if body is None:
        return client.request(method, path, headers=headers)
    return client.request(method, path, headers=headers, json=body)


#: Users with a real, signed membership — in a DIFFERENT workspace.
STRANGERS = [
    ("SOLO", T.SOLO, T.ORG_S),
    ("B_OWNER", T.B_OWNER, T.ORG_B1),
]

REFUSAL_CODES = {401, 403, 404}


def test_the_route_list_is_not_empty():
    """TC-3. A sweep over nothing passes."""
    assert _routes(), "no id-addressed read routes under test — this file proves nothing"


@pytest.mark.parametrize("who,uid,own_org", STRANGERS, ids=[s[0] for s in STRANGERS])
def test_a_member_of_another_workspace_cannot_read_org_a1(app, world, who, uid, own_org):  # noqa: F811
    """The adversary is legitimate: correctly signed, a real membership,
    just not in THIS workspace."""
    client = TestClient(app)
    leaks = []
    for method, path, body, _ok in _routes():
        # Asked BOTH ways: with the stranger's own org header (the honest
        # request) and with the victim's org header (the attempt). Neither
        # may serve the victim's data.
        for label, org_header in (("own-org-header", own_org), ("victim-org-header", T.ORG_A1)):
            r = _ask(client, method, path, body, hdr(uid, org_header))
            if r.status_code not in REFUSAL_CODES:
                leaks.append("%s %s [%s] -> %s %s"
                             % (method, path, label, r.status_code, r.text[:160]))
    assert not leaks, (
        "CROSS-ORG READ — %s holds a membership in %s and none in ORG_A1, but "
        "these routes answered with something other than a refusal:\n  %s"
        % (who, own_org, "\n  ".join(leaks))
    )


def test_every_route_serves_the_owner_of_org_a1_its_expected_success(app, book_world):  # noqa: F811
    """POSITIVE CONTROL (plan/2 B6, 1.6; retires "any route served", under
    which ONE live route hid every dead one). Every listed route answers its
    own expected_success for ORG_A1's owner. Without it the sweep above would
    pass on a route that refuses everyone, which is an outage, not a wall.

    /api/period/{id}/valuation is excluded by name: it answers 404 to its own
    owner in this world (no such GET is mounted), as it did before B6; it
    stays in the stranger sweep, where a 404 is a refusal either way."""
    client = TestClient(app)
    wrong = []
    for method, path, body, expected in _routes():
        if path.endswith("/valuation"):
            continue
        r = _ask(client, method, path, body, hdr(T.A_OWNER, T.ORG_A1))
        if r.status_code != expected:
            wrong.append("%s %s -> %s (expected %s) %s"
                         % (method, path, r.status_code, expected, r.text[:200]))
    assert not wrong, "\n  ".join(wrong)


def test_a_stranger_cannot_recompute_the_book_the_owner_can(app, book_world):  # noqa: F811
    """The POST wall on a period that really projects: the owner gets fp1.2,
    a stranger gets a refusal with either org header, and never a body that
    names the victim's period."""
    client = TestClient(app)
    path = "/api/forecast/%s/recompute" % T.PERIOD_A1
    owner = client.post(path, headers=hdr(T.A_OWNER, T.ORG_A1), json=RECOMPUTE_BODY)
    assert owner.status_code == 200 and owner.json()["contract"] == "fp1.2", owner.text[:200]
    for who, uid, own_org in STRANGERS:
        for org_header in (own_org, T.ORG_A1):
            r = client.post(path, headers=hdr(uid, org_header), json=RECOMPUTE_BODY)
            assert r.status_code in REFUSAL_CODES, (who, org_header, r.status_code, r.text[:160])
            assert "body_hash" not in r.text, (who, org_header)


def test_a_stranger_and_the_owner_get_different_answers(app, book_world):  # noqa: F811
    """The sharpest form: for each route the owner CAN read, a stranger
    must not get the same body. Catches a route that returns 200 with the
    victim's payload under any status the list above might tolerate."""
    client = TestClient(app)
    same = []
    for method, path, body, _ok in _routes():
        owner = _ask(client, method, path, body, hdr(T.A_OWNER, T.ORG_A1))
        if owner.status_code != 200:
            continue
        for _who, uid, own_org in STRANGERS:
            stranger = _ask(client, method, path, body, hdr(uid, own_org))
            if stranger.status_code == 200 and stranger.content == owner.content:
                same.append("%s served byte-identical content to %s and to a stranger"
                            % (path, T.A_OWNER))
    assert not same, "\n  ".join(same)
