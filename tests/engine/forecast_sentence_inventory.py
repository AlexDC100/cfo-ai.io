"""THE SENTENCES THE FORECAST AND SCENARIOS PAGES PAINT, read off the real
route (forecast-scenarios-live, RO + EN).

The engine explains every driver, refusal and convention in an English
sentence composed from the book's own figures. The pages print those
sentences in the reader's language: English verbatim, Romanian through
frontend/lib/forecastSentencesRo.ts (one rule per engine template, under a
digit law). This module is the INVENTORY that keeps the two honest: every
sentence the pages can paint, served by the REAL create_app over the tenancy
double on the four committed corpus books — the forecast at both horizons,
every scenario template, and a set of lever overrides — with the served code
and the kind of place it is painted.

  · tests/engine/fixtures/forecast/served_sentences.json is ``collect()``'s
    output, written by scripts/gen_fp1_2_fixtures.py;
  · tests/engine/test_forecast_served_sentences.py pins it to the route, so
    an engine that rewords, adds or drops a sentence reds in the engine suite;
  · frontend/lib/__tests__/forecastSentencesRo.test.ts translates every entry
    of it and reds on one the Romanian rules do not say in full.

The owner's local books never enter it: corpus books only (agras is
files/agras_tb_2025.xlsx, the preliminary close, not the filed year), plus
agras paired with carniprod dated one year back — a SYNTHETIC pairing,
labelled, the one way a committed book reaches the [book] growth rung.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000c5e1"
ORG = "0c0f0000-0000-4000-8000-00000000c5e1"
CUR, PRI = "sn-cur", "sn-pri"
H5 = {"monthly_months": 12, "total_years": 5}

#: (world label, book, workspace CAEN, paired prior book or None)
WORLDS: Tuple[Tuple[str, str, Optional[str], Optional[str]], ...] = (
    ("agras", "agras", None, None),
    ("agras_caen1011", "agras", "1011", None),
    ("agras_caen1011_paired", "agras", "1011", "carniprod"),
    ("carniprod", "carniprod", None, None),
    ("retail", "retail", None, None),
    ("realestate", "realestate", None, None),
)

#: Lever overrides a reader can make on the rail: each exercises a user tier,
#: a funding draw or a refusal the base plan does not.
OVERRIDES: Tuple[Dict[str, Any], ...] = (
    {"dso_days": {"values": ["60", None, None, None, None]}},
    {"dividend_payout_pct": {"values": ["0.5"] * 5}},
    {"revenue_growth": {"values": ["0.05"] * 5}},
    {"capex_pct_of_revenue": {"values": ["0.06"] * 5}},
)

#: Where a served string is painted, by the path it is served at. A string
#: at any other path (a formula, a label, a note, a method) is not an
#: explanation the pages print as a sentence.
PAINTED: Tuple[Tuple[str, "re.Pattern[str]"], ...] = tuple(
    (kind, re.compile(pattern)) for kind, pattern in (
        ("driver.basis", r"^drivers\.[^.]+(?:\.[^.]+)?\.basis\.sentence\.text$"),
        ("driver.alternative", r"^drivers\.[^.]+(?:\.[^.]+)?\.alternatives\.[a-z]+\.basis\.sentence\.text$"),
        ("driver.ladder", r"^drivers\.[^.]+(?:\.[^.]+)?\.(?:alternatives\.[a-z]+\.)?basis\.fallback_steps\[\]\.reason\.text$"),
        ("driver.inert", r"^drivers\.[^.]+(?:\.[^.]+)?\.inert_in_this_plan\.text$"),
        ("driver.macro_source", r"^drivers\.[^.]+(?:\.[^.]+)?\.(?:alternatives\.[a-z]+\.)?basis\.macro\.source$"),
        ("convention", r"^conventions\.[a-z_]+\.sentence$"),
        ("summary.runway", r"^summary\.runway\.sentence\.text$"),
        ("summary.facility_limit", r"^summary\.runway\.facility_limit\.refused\.text$"),
        ("summary.funding_rate", r"^summary\.funding_rate_basis\.sentence\.text$"),
        ("refused", r"^(?:summary|strip)\.[a-z_]+\.refused\.text$"),
        ("refused", r"^(?:series\.[a-z_]+|figures)\[\]\.refused\.text$"),
        ("refusal", r"^refusal\.sentence\.text$"),
        ("unserved", r"^client\.unserved\[\]\.sentence\.text$"),
        ("detail", r"^detail\.text$"),
    ))


def _kind(path: str) -> Optional[str]:
    for kind, pattern in PAINTED:
        if pattern.match(path):
            return kind
    return None


def _walk(node: Any, path: str, code: Optional[str], found: Dict[Tuple[str, str], set]) -> None:
    if isinstance(node, dict):
        own = node.get("code") if isinstance(node.get("code"), str) else None
        for key, value in node.items():
            here = ("%s.%s" % (path, key)).lstrip(".")
            if isinstance(value, str):
                kind = _kind(here)
                if kind and value.strip():
                    found.setdefault((value, own or code or ""), set()).add(kind)
            else:
                _walk(value, here, own or code, found)
    elif isinstance(node, list):
        for value in node:
            _walk(value, path + "[]", code, found)


def _templates() -> List[str]:
    from engine.forecast.scenario_templates import load_templates
    return [t.id for t in load_templates().templates]


def _world(book: str, caen: Optional[str], prior: Optional[str]):
    org = {"id": ORG, "name": "Sentence Co", "default_currency": "RON"}
    if caen:
        org["caen_code"] = caen
    periods = [(SB.book(book), CUR, ORG, "2025-01-01", "2025-12-31")]
    if prior:
        periods.append((SB.book(prior), PRI, ORG, "2024-01-01", "2024-12-31"))
    return RA.seed_double(
        orgs=[org], memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                                  "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=periods)


def collect() -> List[Dict[str, Any]]:
    """Every (sentence, code) the pages can paint on the corpus worlds, with
    the kinds of place it is painted, sorted — the fixture's exact content."""
    from engine.api import _forecast_history
    found: Dict[Tuple[str, str], set] = {}
    templates = _templates()
    for _label, book, caen, prior in WORLDS:
        double = _world(book, caen, prior)
        _forecast_history.clear_cache()
        try:
            with RA.installed(double):
                client = TestClient(RA.build_app(), raise_server_exceptions=False)
                headers = {"Authorization": "Bearer " + D.mint_jwt(USER), "X-Org-Id": ORG}
                for horizon in (3, 5):
                    r = client.get("/api/forecast/%s?horizon=%d" % (CUR, horizon), headers=headers)
                    assert r.status_code == 200, (book, horizon, r.status_code, r.text[:300])
                    _walk(r.json(), "", None, found)
                bodies = [{"template": t, "horizon": dict(H5)} for t in templates]
                for overrides in OVERRIDES:
                    for template in ("base", "recession"):
                        bodies.append({"template": template, "horizon": dict(H5),
                                       "overrides": overrides})
                for body in bodies:
                    r = client.post("/api/forecast/%s/scenario" % CUR, headers=headers, json=body)
                    assert r.status_code in (200, 409, 422), (book, body, r.status_code, r.text[:300])
                    _walk(r.json(), "", None, found)
        finally:
            _forecast_history.clear_cache()
    return [{"text": text, "code": code, "kinds": sorted(kinds)}
            for (text, code), kinds in sorted(found.items())]
