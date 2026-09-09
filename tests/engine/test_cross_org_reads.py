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


#: Product read routes that take an OWNED id in the path. Each is
#: formatted with ORG_A1's own ids, then requested by a stranger.
def _routes():
    p = T.PERIOD_A1
    return [
        ("GET", "/api/period/%s" % p),
        ("GET", "/api/period/%s/valuation" % p),
        # NOTE: /valuation-assumptions is PUT-only; a GET there is 405,
        # which is a wrong-method answer and not a boundary result, so it
        # belongs in the write census (test_identity_wall), not here.
        ("GET", "/api/forecast/%s" % p),
    ]


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
    for method, path in _routes():
        # Asked BOTH ways: with the stranger's own org header (the honest
        # request) and with the victim's org header (the attempt). Neither
        # may serve the victim's data.
        for label, org_header in (("own-org-header", own_org), ("victim-org-header", T.ORG_A1)):
            r = client.request(method, path, headers=hdr(uid, org_header))
            if r.status_code not in REFUSAL_CODES:
                leaks.append("%s %s [%s] -> %s %s"
                             % (method, path, label, r.status_code, r.text[:160]))
    assert not leaks, (
        "CROSS-ORG READ — %s holds a membership in %s and none in ORG_A1, but "
        "these routes answered with something other than a refusal:\n  %s"
        % (who, own_org, "\n  ".join(leaks))
    )


def test_the_owner_of_org_a1_is_still_served(app, world):  # noqa: F811
    """POSITIVE CONTROL. Without this the test above would pass if every
    route were simply broken, and a wall that refuses everyone is not a
    wall — it is an outage."""
    client = TestClient(app)
    served = []
    for method, path in _routes():
        r = client.request(method, path, headers=hdr(T.A_OWNER, T.ORG_A1))
        if r.status_code == 200:
            served.append(path)
    assert served, (
        "not one route served ORG_A1's own owner, so the cross-org test "
        "above is passing on a dead app rather than on a boundary. "
        "Routes tried: %s" % ([p for _m, p in _routes()],)
    )


def test_a_stranger_and_the_owner_get_different_answers(app, world):  # noqa: F811
    """The sharpest form: for each route the owner CAN read, a stranger
    must not get the same body. Catches a route that returns 200 with the
    victim's payload under any status the list above might tolerate."""
    client = TestClient(app)
    same = []
    for method, path in _routes():
        owner = client.request(method, path, headers=hdr(T.A_OWNER, T.ORG_A1))
        if owner.status_code != 200:
            continue
        for _who, uid, own_org in STRANGERS:
            stranger = client.request(method, path, headers=hdr(uid, own_org))
            if stranger.status_code == 200 and stranger.content == owner.content:
                same.append("%s served byte-identical content to %s and to a stranger"
                            % (path, T.A_OWNER))
    assert not same, "\n  ".join(same)
