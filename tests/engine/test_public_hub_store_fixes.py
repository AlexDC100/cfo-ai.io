"""Hub pages + store read-API defects (lane 2 store / lane 4 hub pages).

Every test here drives the REAL ``PublicRoStore`` against a tmp SQLite
file — the previously-passing hub suite (test_public_seo.py) exercises
render_hub_page through a hand-written FakeStore, which is exactly why
four defects lived on the real store/page seam undetected:

  D1  pages/hubs.py called store.hub_top_companies(kind, slug, limit=…)
      while the store's method was keyword-only (year/caen2/county) —
      every sector + county hub URL raised TypeError -> HTTP 500.
  D2  search_companies filtered on publishable=1 only, so a CUI removed
      through the PS8 takedown flow kept surfacing in /api/public/ro/
      search and the server-rendered /companii?q=.
  D3  search_companies returned publishable CUIs with ZERO filings, so
      search published company URLs whose page 404s.
  D4  hub_keys returned the RAW county column as ``slug`` ("Satu Mare"),
      which lands verbatim inside sitemap <loc> values.

Offline: no network, no shared state — each test gets its own db file.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:  # pragma: no cover — conftest normally does this
    sys.path.insert(0, str(SRC))

BASE = "https://cfo-ai.io"
CANON_HEADERS = {"host": "cfo-ai.io"}


# ── fixture spine ──────────────────────────────────────────────────────

def _company(store, cui, name, county, reg_number, caen, publishable=True):
    # ensure_company_stub first: it owns companies.caen (the bilanț side),
    # and set_identification deliberately never touches that column.
    store.ensure_company_stub(cui, caen)
    store.set_identification(
        cui,
        name=name,
        county=county,
        locality=county,
        reg_number=reg_number,
        tip_contrib="PJ",
        publishable=publishable,
        name_source="test_ident",
    )


def _filing(store, cui, year, revenue, caen="1071"):
    store.upsert_filing(
        cui=cui,
        year=year,
        family="UU",
        dataset_id="ds-%d-UU" % year,
        indicators={"i13": revenue, "i18": 1000, "i20": 25},
        total_assets=revenue * 2 if revenue is not None else None,
        net_result=1000,
        caen=caen,
    )


@pytest.fixture()
def store(tmp_path):
    from engine.public_ro.store import PublicRoStore

    st = PublicRoStore(tmp_path / "public_ro.db")
    for year in (2023, 2024):
        st.register_dataset(
            dataset_id="ds-%d-UU" % year,
            year=year,
            family="UU",
            sha256=("%d" % year) * 16,
            source_url="https://data.gov.ro/x",
            resource_id="r-%d" % year,
            license_id="CC-BY-4.0",
            license_note=None,
            row_count=4,
        )
    # Satu Mare carries three publishable filers so the county hub clears
    # HUB_MIN_COMPANIES; the fourth (OMEGA) is taken down inside the tests.
    _company(store=st, cui=111111, name="ALFA PROD SRL", county="Satu Mare",
             reg_number="J30/1/2001", caen="1071")
    _company(store=st, cui=222222, name="BETA IMPEX SRL", county="Satu Mare",
             reg_number="J30/2/2002", caen="1071")
    _company(store=st, cui=333333, name="GAMA SERV SRL", county="Satu Mare",
             reg_number="J30/3/2003", caen="1071")
    _company(store=st, cui=444444, name="DELTA THIN SRL", county="Bucureşti",
             reg_number="J40/4/2004", caen="1071")   # publishable, NO filings
    _company(store=st, cui=555555, name="OMEGA REMOVED SRL", county="Satu Mare",
             reg_number="J30/5/2005", caen="1071")
    _filing(st, 111111, 2023, 90_000_000)
    _filing(st, 111111, 2024, 100_000_000)
    _filing(st, 222222, 2024, 50_000_000)
    _filing(st, 333333, 2024, 10_000_000)
    _filing(st, 555555, 2024, 70_000_000)
    try:
        yield st
    finally:
        st.close()


def _remove(store, cui):
    """Operator takedown through lane 6's own authority, scoped to THIS
    store's db file (never the repo-default data/public_ro.db)."""
    from engine.public_ro import takedown

    takedown.record_action(cui, "remove", "verified request", "operator",
                           db_path=store.path)


# ── D1: hub pages 500 ──────────────────────────────────────────────────

def test_sector_hub_page_renders_against_the_real_store(store):
    from engine.public_ro.pages import hubs

    html, status, headers = hubs.render_hub_page(store, "sector", "10", "ro")
    assert status == 200
    assert "ALFA PROD SRL" in html
    assert "100.000.000" in html                      # RO number formatting
    assert "2024" in html                             # resolved year column


def test_county_hub_page_renders_against_the_real_store(store):
    from engine.public_ro.pages import hubs

    html, status, _ = hubs.render_hub_page(store, "judet", "satu-mare", "ro")
    assert status == 200
    assert "Satu Mare" in html                        # human label, not slug
    assert "BETA IMPEX SRL" in html


def test_hub_routes_return_200_not_500(store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_ro.pages import hubs

    app = FastAPI()
    app.include_router(hubs.build_hub_router(store=store))
    with TestClient(app, raise_server_exceptions=False) as client:
        for path in ("/sector/10", "/sectors/10",
                     "/judet/satu-mare", "/counties/satu-mare",
                     "/api/public/ro/sector/10"):
            r = client.get(path, headers=CANON_HEADERS)
            assert r.status_code == 200, (path, r.status_code)
            assert r.headers["content-type"].startswith("text/html"), path


def test_hub_top_companies_defaults_to_the_latest_filing_year(store):
    rows = store.hub_top_companies("sector", "10")
    assert [r["cui"] for r in rows] == [111111, 555555, 222222, 333333]
    assert {r["latest_year"] for r in rows} == {2024}
    assert rows[0]["revenue"] == 100_000_000


def test_hub_top_companies_keyword_dimension_form_is_preserved(store):
    """The store's own dimensional API (year/caen2/county) is what the
    lane-1 spine suite and the percentile jobs speak — the hub-address
    form must be added WITHOUT breaking it."""
    rows = store.hub_top_companies(year=2023, caen2="10", limit=10)
    assert [r["cui"] for r in rows] == [111111]
    rows_county = store.hub_top_companies(year=2024, county="Satu Mare")
    assert [r["cui"] for r in rows_county][0] == 111111


def test_unknown_county_slug_lists_nothing_rather_than_everything(store):
    """An unresolvable hub slug must NOT degrade to "no county filter" —
    that would render the whole country's top companies under a county
    heading, i.e. a false statement about named companies."""
    assert store.hub_top_companies("judet", "atlantida") == []


# ── D2: takedown must reach search (PS8) ───────────────────────────────

def test_search_hides_a_taken_down_company(store):
    assert [r["cui"] for r in store.search_companies("OMEGA")] == [555555]
    _remove(store, 555555)
    assert store.search_companies("OMEGA") == []
    assert store.search_companies("555555") == []


def test_search_endpoints_hide_a_taken_down_company(store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_ro.pages import router as pages_router

    _remove(store, 555555)
    app = FastAPI()
    app.include_router(pages_router.build_router(store=store))
    with TestClient(app) as client:
        payload = client.get("/api/public/ro/search", params={"q": "OMEGA"},
                             headers=CANON_HEADERS).json()
        assert payload["count"] == 0, payload
        html = client.get("/companii", params={"q": "OMEGA"},
                          headers=CANON_HEADERS).text
        assert "OMEGA REMOVED SRL" not in html
        assert "555555" not in html


def test_hub_page_hides_a_taken_down_company(store):
    from engine.public_ro.pages import hubs

    _remove(store, 555555)
    html, status, _ = hubs.render_hub_page(store, "judet", "satu-mare", "ro")
    assert status == 200
    assert "OMEGA REMOVED SRL" not in html
    assert "ALFA PROD SRL" in html


def test_hub_keys_count_excludes_taken_down_companies(store):
    """A hub whose advertised count includes removed CUIs would be listed
    in the sitemap while its own page renders below HUB_MIN_COMPANIES and
    therefore noindex — the two policies must agree."""
    before = {e["slug"]: e["company_count"] for e in store.hub_keys("judet")}
    assert before["satu-mare"] == 4
    _remove(store, 555555)
    after = {e["slug"]: e["company_count"] for e in store.hub_keys("judet")}
    assert after["satu-mare"] == 3


# ── D3: zero-filing CUIs must not be published by search ───────────────

def test_search_hides_publishable_company_without_filings(store):
    """DELTA THIN is publishable but has no bilanț row, so its company
    page 404s — search must not hand out that URL."""
    assert store.search_companies("DELTA") == []
    assert [r["cui"] for r in store.search_companies("BETA")] == [222222]


# ── D4: hub slugs must be URL-safe ─────────────────────────────────────

def test_hub_keys_returns_url_safe_slug_and_human_label(store):
    entries = {e["slug"]: e for e in store.hub_keys("judet")}
    assert "satu-mare" in entries, sorted(entries)
    entry = entries["satu-mare"]
    assert entry["label_ro"] == "Satu Mare"
    assert entry["label_en"] == "Satu Mare"
    for slug in entries:
        assert slug == slug.lower()
        assert " " not in slug
        assert slug.isascii()


def test_sitemap_hub_locs_match_the_keys_the_route_resolves(store):
    """The sitemap normalises whatever hub_keys hands over (seo.hub_loc_slug),
    but the hub ROUTE resolves a slug by equality against hub_keys() — so a
    raw county key means the sitemap advertises a URL the route 404s."""
    from engine.public_ro import seo

    urls = seo.collect_hub_urls(store, base=BASE)
    keys = {kind: {str(e["slug"]) for e in store.hub_keys(kind)}
            for kind in ("sector", "judet")}
    assert BASE + "/judet/satu-mare" in urls
    assert BASE + "/counties/satu-mare" in urls
    for url in urls:
        assert " " not in url
        assert url.isascii(), url
        for kind, prefixes in (("judet", ("/judet/", "/counties/")),
                               ("sector", ("/sector/", "/sectors/"))):
            if any(p in url for p in prefixes):
                assert url.rsplit("/", 1)[1] in keys[kind], url


def test_hub_keys_sector_slug_resolves_back_through_the_hub_page(store):
    """Round trip: whatever hub_keys advertises must render a page —
    sitemap <loc> and the route must agree on the slug vocabulary."""
    from engine.public_ro.pages import hubs

    for kind in ("sector", "judet"):
        for entry in store.hub_keys(kind):
            _html, status, _ = hubs.render_hub_page(
                store, kind, entry["slug"], "ro")
            assert status == 200, (kind, entry["slug"])
