"""THE RADAR SURFACE, WIRED — the mount flag, the identity, the industry
code, and the line items the detector lane is built from.

`src/engine/api/_radar.py` had four routes, a dismissal lane and an
explanation lane, and `build_router()` was referenced NOWHERE in
`server.py`. The third "complete and unreachable" subsystem this session
found. Wiring it exposed three defects, all of which had been returning
`None` quietly:

  · **CAEN was always absent.** `light_input` read `row.get("caen_code")`
    off a `financial_periods` row, and the light projection deliberately
    does not select it — because there is no such column;
    `schema_phase7_benchmarks.sql` put CAEN on `organizations`. So every
    served radar payload ran `s_engine.run_single_period(..., caen=None)`
    and no finding was qualified by an industry profile. The module's own
    comment records half the story: the PROJECTION was fixed after it
    400'd, and the READ was left behind.
  · **No company identity.** `PeriodInput.cui` was never set, and the
    detector lane's spine refuses without one — correctly. There is no
    CUI to set: `financial_periods` carries none. The identity is the
    WORKSPACE, which in this product IS the company.
  · **The line items were fetched and thrown away.** `load_statements`
    selected them, rebuilt the statements, and dropped the rows — the one
    account-level figure a persisted period carries, and the only thing a
    served-tier spine can be built from.

WHAT THIS REDS ON (TC-11)
  · the router being mounted without its flag, or not mounted with it;
  · CAEN being read off the period row again, or the org read vanishing;
  · a period input reaching the request with no company identity;
  · the line items being dropped between the select and the request;
  · the detector flag not being read from the environment at the route.
WHAT IT CANNOT SEE
  · what the /radar page renders. That is a different code path with its
    own gate.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import os

import pytest

from engine.api import _radar as RT
from engine.radar import series as SER


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (RT.DETECTORS_ENV, RT.DETECTOR_JURISDICTION_ENV,
                 RT.DETECTOR_PACK_ROOT_ENV, "ANOMALY_RADAR_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    yield


def _app(monkeypatch, flag):
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert ("supabase.co" in os.environ["VITE_SUPABASE_URL"]
            and "test." in os.environ["VITE_SUPABASE_URL"]), (
        "refusing to build the app against a non-manifest Supabase URL")
    if flag is None:
        monkeypatch.delenv("ANOMALY_RADAR_ENABLED", raising=False)
    else:
        monkeypatch.setenv("ANOMALY_RADAR_ENABLED", flag)
    from engine.api.server import create_app
    return create_app()


def _radar_paths(app):
    return sorted(set(
        p for p in (getattr(r, "path", "") for r in app.routes)
        if "/api/radar" in p))


# ── the mount flag ───────────────────────────────────────────────────────


def test_without_its_flag_the_whole_surface_is_absent(monkeypatch):
    """RED ON: the surface mounting by default. A route with no frontend
    caller and no menu row must be ABSENT, not half-present — the same
    treatment `/api/firm` gets without FIRM_COCKPIT_ENABLED."""
    assert _radar_paths(_app(monkeypatch, None)) == []


def test_with_its_flag_all_four_routes_are_served(monkeypatch):
    """RED ON: the flag turning on a partial surface. Dismissing a finding
    without being able to revoke it is worse than neither."""
    paths = _radar_paths(_app(monkeypatch, "1"))
    assert paths == [
        "/api/radar/{period_id}",
        "/api/radar/{period_id}/dismiss",
        "/api/radar/{period_id}/dismissals",
        "/api/radar/{period_id}/dismissals/{dismissal_id}/revoke",
    ], paths


def test_the_flag_is_read_at_create_app_not_cached_at_import(monkeypatch):
    """RED ON: the flag being read once at import. Two apps in one process
    must be able to disagree — which is what lets the test above and the
    one before it both be true."""
    assert _radar_paths(_app(monkeypatch, "1"))
    assert _radar_paths(_app(monkeypatch, "0")) == []
    assert _radar_paths(_app(monkeypatch, "true"))


# ── the detector flag, read at the route ─────────────────────────────────


def test_the_detector_flag_comes_from_the_environment_here(monkeypatch):
    """RED ON: the environment being read inside `serve.compose`, which is
    pure over its request — and where a read would also miss the cache
    key, so a flip would serve the pre-flag payload."""
    assert RT.detectors_enabled() is False
    for truthy in ("1", "true", "YES", "on"):
        monkeypatch.setenv(RT.DETECTORS_ENV, truthy)
        assert RT.detectors_enabled() is True, truthy
    for falsy in ("", "0", "no", "off", "maybe"):
        monkeypatch.setenv(RT.DETECTORS_ENV, falsy)
        assert RT.detectors_enabled() is False, falsy


def test_a_half_configured_pack_is_refused_not_guessed(monkeypatch):
    """RED ON: a pack root with no jurisdiction resolving to a default
    jurisdiction, or the reverse. Which jurisdiction's rules run is not a
    thing to guess."""
    assert RT.detector_pack() == (None, None)
    monkeypatch.setenv(RT.DETECTOR_PACK_ROOT_ENV, "/somewhere/packs")
    assert RT.detector_pack() == (None, None), (
        "a pack root with no jurisdiction named one anyway")
    monkeypatch.setenv(RT.DETECTOR_JURISDICTION_ENV, "ro")
    assert RT.detector_pack() == ("ro", "/somewhere/packs")
    monkeypatch.delenv(RT.DETECTOR_PACK_ROOT_ENV)
    assert RT.detector_pack() == ("ro", RT.DEFAULT_PACK_ROOT)


# ── CAEN comes from the org ──────────────────────────────────────────────


class _Client(object):
    """A minimal PostgREST stand-in that RECORDS what was asked for. Not a
    store: it answers from a dict handed in, and every test asserts on the
    calls rather than on a mirrored engine."""

    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def select(self, table, filters=None, columns="*", limit=None, order=None,
               single=False):
        self.calls.append((table, dict(filters or {}), columns))
        return list(self.rows.get(table, ()))


def test_caen_is_read_from_the_org_table():
    """RED ON: CAEN being read off the period row again. It returned None
    on every serve, and `caen` is what qualifies a finding's industry
    profile — so every served finding was unqualified, silently."""
    client = _Client({"organizations": [{"id": "org-7", "caen_code": "1013"}]})
    assert RT.load_caen(client, "org-7") == "1013"
    table, filters, columns = client.calls[0]
    assert table == RT.TABLE_ORGS
    assert filters == {"id": "eq.org-7"}
    assert "caen_code" in columns


def test_an_absent_caen_is_absent_and_not_an_empty_string():
    """RED ON: `""` reaching the engine as a CAEN code. An empty industry
    code is not an industry."""
    for rows in ([{"id": "org-7", "caen_code": None}],
                 [{"id": "org-7", "caen_code": "   "}],
                 []):
        assert RT.load_caen(_Client({"organizations": rows}), "org-7") is None


def test_a_caen_lookup_that_fails_does_not_take_the_payload_down():
    """RED ON: a classification raising a 500. It fails OPEN, like
    `load_dismissals`, and the finding's own profile says it is
    unqualified."""

    class _Boom(_Client):
        def select(self, *a, **kw):
            raise RuntimeError("RLS said no")

    assert RT.load_caen(_Boom({}), "org-7") is None


def test_the_light_input_takes_caen_as_an_argument_not_from_the_row():
    """RED ON: the dead read coming back. The row below CARRIES a
    `caen_code` and the input must ignore it — the column does not exist
    in production and reading it is how the value came to be None."""
    row = {"id": "p1", "period_end": "2025-12-31", "currency": "RON",
           "org_id": "org-7", "caen_code": "9999"}
    served = RT.light_input(row, 0, "org-7", "1013")
    assert served.caen == "1013", (
        "the row's phantom caen_code won over the org's real one")
    absent = RT.light_input(row, 0, "org-7", None)
    assert absent.caen is None


# ── the identity, and the line items ─────────────────────────────────────


def test_every_period_carries_the_workspace_as_its_company_identity():
    """RED ON: a period reaching the detector spine with no identity. The
    spine refuses without one — correctly — and there is no CUI to give
    it, because `financial_periods` carries none."""
    row = {"id": "p1", "period_end": "2025-12-31", "currency": "RON",
           "org_id": "org-7"}
    served = RT.light_input(row, 0, "org-7")
    assert served.cui == SER.WORKSPACE_IDENTITY_PREFIX + "org-7"
    # And it is an identity a series can actually key on.
    entity = SER.EntityKey.of_workspace("org-7")
    assert entity.cui == served.cui


def test_a_workspace_identity_can_never_collide_with_a_real_cui():
    """RED ON: the workspace identity being a bare id. A workspace whose
    id happened to normalize as digits would then match a real company,
    and a spine could span two."""
    from engine.api._firm_import import normalize_cui

    identity = SER.EntityKey.of_workspace("12345678").cui
    assert identity.startswith(SER.WORKSPACE_IDENTITY_PREFIX)
    assert normalize_cui(identity) != "12345678"
    assert SER.EntityKey.of("ws", "RO12345678").cui == "12345678"


def test_the_line_items_travel_on_the_period_input():
    """RED ON: the rows being fetched and dropped. They are the only
    account-level figure a persisted period carries, and the detector
    lane's served-tier spine is built from them; fetching them twice
    instead would be two chances for them to disagree."""
    row = {"id": "p1", "period_end": "2025-12-31", "currency": "RON",
           "org_id": "org-7"}
    items = [{"statement": "BS", "bucket": "cash", "ro_account_code": "5121",
              "ro_account_name": "Banca", "amount": 100.0}]
    client = _Client({RT.TABLE_LINE_ITEMS: items})
    statements, returned = RT.load_statements(client, row, None)
    assert list(returned) == items, (
        "load_statements read the rows and did not hand them back")
    light = RT.light_input(row, 0, "org-7")
    heavy = RT.heavy_input(_Client({RT.TABLE_LINE_ITEMS: items}), light, row)
    assert heavy.line_items, "the rows did not reach the period input"
    assert heavy.has_line_items()


def test_a_period_with_no_line_items_carries_none_not_an_empty_tuple():
    """RED ON: `()` reaching the spine as "this period has no accounts".
    A route that did not load them and a period that has none are
    different facts, and `has_line_items()` must read False for the first
    without claiming the second."""
    row = {"id": "p1", "period_end": "2025-12-31", "currency": "RON",
           "org_id": "org-7"}
    heavy = RT.heavy_input(_Client({}), RT.light_input(row, 0, "org-7"), row)
    assert heavy.line_items is None
    assert heavy.has_line_items() is False
