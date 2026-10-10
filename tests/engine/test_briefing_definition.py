"""Briefings are served with the EBITDA definition they were written under.

THE RULING (owner, 2026-09-26): account 711 ("Variația stocurilor de
produse") and 72x are inside EBITDA and the operating result; margins divide
by net turnover. A briefing is prose written once from the numbers of its
day, so one written before the ruling quotes an EBITDA the statements no
longer serve. Design A9: "Briefings: served with their definition revision;
a briefing written under the old definition is hidden with a one-line note,
never shown with stale numbers." The engine stamps and serves; the page hides.

WHAT THIS REDS ON (TC-11): a briefing write that does not stamp the
definition (every new briefing would read as stale — or, worse, a stale one
as current once the page trusts the stamp); GET /api/period serving a
briefing without its definition status; an unstamped (pre-ruling) row served
as current; the migration not declaring the column (every briefing upsert
would 400 in production and the narrate stage — non-fatal — would drop the
briefing silently).

Everything runs over the tenancy double through the REAL create_app and the
REAL stage_persist_narrative; no network, no model call.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D
from engine.api import pipeline as P
from engine.country_packs.ro_romania.chart_of_accounts import (
    EBITDA_DEFINITION_PREVIOUS_REVISIONS, EBITDA_DEFINITION_REVISION)

REPO = Path(__file__).resolve().parents[2]
USER = "7b0c0f3e-0000-4000-8000-0000000b7ef1"
ORG = "0c0f0000-0000-4000-8000-0000000b7ef1"
PID = "b7ef0000-0000-4000-8000-0000000b7ef1"
WORK = {"units": 0}


def _double():
    return RA.seed_double(
        orgs=[{"id": ORG, "name": "agras", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book("agras"), PID, ORG, "2025-01-01", "2025-12-31")])


def _served_briefing(double):
    app = RA.build_app()
    with RA.installed(double):
        client = TestClient(app, raise_server_exceptions=False)
        r = client.get("/api/period/%s" % PID, headers={
            "Authorization": "Bearer " + D.mint_jwt(USER), "X-Org-Id": ORG})
    assert r.status_code == 200, r.text[:400]
    return r.json()["briefing"]


#: THE NOTE, pinned byte for byte. GENERIC (deploy-readiness review of
#: feat/rulings-2, 2026-09-29): the stamp has moved twice (2026-09-26: 711 /
#: 72x inside; 2026-09-28: provisions outside, 7411 in turnover), and the
#: note used to say the earlier definition was "without the stock variation
#: and own work capitalised" — false for a briefing stamped 2026-09-26.
GENERIC_NOTE = {
    "ro": "Comentariul a fost scris sub o definiție anterioară a EBITDA și "
          "este ascuns; reanalizați perioada pentru un comentariu nou.",
    "en": "This briefing was written under an earlier EBITDA definition and "
          "is hidden; re-analyse the period for a new one.",
}
#: What a note naming one earlier definition's content would carry.
_CONTENT_WORDS = ("711", "72x", "stock variation", "own work", "stocurilor",
                  "imobilizat", "provision", "provizi", "7411")


def test_the_status_of_a_stored_briefing():
    assert P.briefing_definition_status(None) is None
    old = P.briefing_definition_status({"body": "x"})
    assert old["written_under"] is None and old["written_under_previous_definition"] is True
    assert old["note"] == GENERIC_NOTE
    new = P.briefing_definition_status({"body": "x", "ebitda_definition": EBITDA_DEFINITION_REVISION})
    assert new["written_under_previous_definition"] is False and new["note"] is None
    assert new["current_definition"] == EBITDA_DEFINITION_REVISION
    WORK["units"] += 3


def test_a_briefing_stamped_with_an_earlier_revision_gets_the_generic_note():
    """A briefing written 2026-09-26 (711 and 72x ALREADY inside) is not
    current since R2 / R3 — and its note names no content an earlier
    definition lacked, because this one did not lack it."""
    assert EBITDA_DEFINITION_PREVIOUS_REVISIONS, "the previous revision is named"
    for stamp in EBITDA_DEFINITION_PREVIOUS_REVISIONS:
        st = P.briefing_definition_status({"body": "x", "ebitda_definition": stamp})
        assert st["written_under"] == stamp and st["written_under_previous_definition"] is True
        assert st["note"] == GENERIC_NOTE, st["note"]
        text = (st["note"]["ro"] + " " + st["note"]["en"]).lower()
        assert not [w for w in _CONTENT_WORDS if w.lower() in text], text
        WORK["units"] += 1


def test_a_briefing_written_before_the_ruling_is_served_as_such_through_the_real_route():
    double = _double()
    double.add("briefings", {"period_id": PID, "org_id": ORG, "body": "EBITDA was 10.8M.",
                             "language": "en", "model": "old"})
    briefing = _served_briefing(double)
    assert briefing["body"] == "EBITDA was 10.8M."
    assert briefing["definition"]["written_under_previous_definition"] is True
    assert briefing["definition"]["note"] == GENERIC_NOTE
    WORK["units"] += 1


def test_the_narrate_write_stamps_the_definition_and_the_route_serves_it_current(monkeypatch):
    double = _double()
    with RA.installed(double):
        P.stage_persist_narrative(
            {"org_id": ORG, "id": "doc-b7ef"}, PID,
            {"briefing": "EBITDA is 11.8M.", "recommendations": [], "alerts": []}, [])
    rows = double.tables["briefings"]
    assert len(rows) == 1 and rows[0]["ebitda_definition"] == EBITDA_DEFINITION_REVISION, rows
    briefing = _served_briefing(double)
    assert briefing["definition"]["written_under_previous_definition"] is False
    assert briefing["definition"]["note"] is None
    WORK["units"] += 2


def test_the_migration_declares_the_column_and_reloads_the_schema_cache():
    sql = (REPO / "supabase" / "schema_phase_briefing_ebitda_definition.sql").read_text("utf-8")
    assert re.search(r"alter\s+table\s+public\.briefings\s+add\s+column\s+if\s+not\s+exists"
                     r"\s+ebitda_definition\s+text", sql)
    assert sql.rstrip().endswith("NOTIFY pgrst, 'reload schema';")
    assert "ebitda_definition" in RA.migration_columns()["briefings"]
    WORK["units"] += 2


def test_zz_scope(capsys):
    with capsys.disabled():
        print("\nSCOPE briefing-definition: GET /api/period over the tenancy double "
              "(agras), stage_persist_narrative; GATE-WORK briefing-definition units=%d"
              % WORK["units"])
    assert WORK["units"] >= 8
