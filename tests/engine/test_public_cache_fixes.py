"""Cache-key correctness for the public storefront (page HTML + OG PNG).

The invariant under test, stated once: **a cached artefact must be
invalidated by ANY change to an input it renders.** Both caches keyed on
(cui, year, dataset_version, lang[, percentiles_epoch]) — a tuple that
names the FILING inputs and none of the IDENTITY inputs, even though the
page prints companies.name / county / locality / sector_label /
name_source and the OG card prints the name.

`scripts/public_ingest.py ident` (the documented annual identification
refresh) calls store.set_identification and touches neither filings nor
percentiles. Nothing in the old key moved, so after a rename the cache
kept serving the OLD company name and a <link rel="canonical"> built
from the OLD slug — a canonical pointing at a URL that now 301s, and a
public page stating a name the open data no longer supports.

Offline, like test_public_pages.py: a real PublicRoStore on tmp SQLite,
no network, no clock, no AI.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:  # pragma: no cover — conftest normally does this
    sys.path.insert(0, str(SRC))

from engine.public_ro import ratelimit  # noqa: E402
from engine.public_ro.pages import cache as cache_mod  # noqa: E402
from engine.public_ro.pages import og as og_mod  # noqa: E402
from engine.public_ro.pages import router as router_mod  # noqa: E402
from engine.public_ro.pages.model import (  # noqa: E402
    net_result_of,
    total_assets_of,
)
from engine.public_ro import store as store_mod  # noqa: E402
from engine.public_ro.store import PublicRoStore  # noqa: E402

CANON = {"host": "cfo-ai.io"}
CUI = 123456
OLD_NAME = "Alfa Prod SRL"
OLD_SLUG = "alfa-prod-srl"
NEW_NAME = "Alfa Productie SRL"
NEW_SLUG = "alfa-productie-srl"

FILINGS = [
    {"year": 2023, "i13": 130_000_000, "i18": 8_000_000, "i19": 0,
     "i10": 52_000_000, "i7": 23_000_000, "i20": 230, "i1": 33_000_000,
     "i2": 38_000_000, "i6": 1_000_000},
    {"year": 2024, "i13": 140_000_000, "i18": 9_000_000, "i19": 0,
     "i10": 56_000_000, "i7": 24_000_000, "i20": 240, "i1": 34_000_000,
     "i2": 39_000_000, "i6": 1_000_000},
]

COMPANY_ROW = {
    "cui": CUI, "name": OLD_NAME, "county": "Cluj",
    "locality": "Cluj-Napoca", "caen": "1071", "caen_rev": None,
    "reg_number": "J12/345/2001", "tip_contrib": "PJ", "publishable": True,
    "name_source": "mfinante_datagov_identificare",
    "updated_at": "2026-06-15T00:00:00Z",
    "provenance": {"name_source": "mfinante_datagov_identificare",
                   "updated_at": "2026-06-15T00:00:00Z"},
}


# ── fixtures ───────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(tmp_path / "public_ro.db"))
    monkeypatch.setenv("PUBLIC_RO_PAGES_DIR", str(tmp_path / "pages"))
    monkeypatch.setenv("PUBLIC_RO_OG_DIR", str(tmp_path / "og"))
    monkeypatch.setenv("PUBLIC_RO_RATE_PER_MIN", "100000")
    monkeypatch.delenv("PUBLIC_AI_NARRATIVE", raising=False)
    ratelimit.reset_limiter()
    router_mod.reset_default_store()
    yield
    ratelimit.reset_limiter()
    router_mod.reset_default_store()


def _identify(store: PublicRoStore, **over: Any) -> None:
    kw: Dict[str, Any] = dict(
        name=OLD_NAME, county="Cluj", locality="Cluj-Napoca",
        reg_number="J12/345/2001", tip_contrib="PJ", publishable=True,
        name_source="mfinante_datagov_identificare")
    kw.update(over)
    store.set_identification(CUI, **kw)


@pytest.fixture()
def store(tmp_path: Path) -> PublicRoStore:
    st = PublicRoStore(tmp_path / "public_ro.db")
    st.register_dataset(
        dataset_id="uu-2024", year=2024, family="UU", sha256="a" * 64,
        source_url="https://data.gov.ro/dataset/situatii_financiare_2024",
        resource_id="res-1", license_id="CC-BY-4.0", license_note=None,
        row_count=2, fetched_at="2026-06-15T00:00:00Z")
    st.ensure_company_stub(CUI, "1071")
    _identify(st)
    for row in FILINGS:
        st.upsert_filing(
            cui=CUI, year=int(row["year"]), family="UU", dataset_id="uu-2024",
            indicators={k: v for k, v in row.items()
                        if k.startswith("i") and k[1:].isdigit()},
            total_assets=total_assets_of(row), net_result=net_result_of(row),
            caen="1071")
    st.replace_percentiles(2024, [
        {"metric": "revenue", "caen2": "10", "p10": 1e6, "p25": 5e6,
         "p50": 2e7, "p75": 1e8, "p90": 5e8, "n": 812},
    ])
    yield st
    st.close()


@pytest.fixture()
def client(store: PublicRoStore) -> TestClient:
    app = FastAPI()
    app.include_router(router_mod.build_router(store))
    return TestClient(app)


def _page(client: TestClient, slug: str = OLD_SLUG, lang: str = "ro",
          follow: bool = True):
    prefix = "/companii" if lang == "ro" else "/companies"
    return client.get("%s/%d-%s" % (prefix, CUI, slug), headers=CANON,
                      follow_redirects=follow)


def _og(client: TestClient, year: int = 2024):
    return client.get("/og/companii/%d-%d.png" % (CUI, year), headers=CANON)


def _canonical(html: str) -> str:
    m = re.search(r'<link rel="canonical" href="([^"]+)">', html)
    assert m, "page has no canonical link"
    return m.group(1)


# ──────────────────────────────────────────────────────────────────────
# DEFECT 1 — the page cache ignored every identity field it renders
# ──────────────────────────────────────────────────────────────────────

class TestPageCacheTracksIdentity:
    def test_rename_invalidates_the_cached_page_and_its_canonical(
            self, client, store):
        """`public_ingest.py ident` renames a company. Filings and
        percentiles are untouched, so nothing in the old key moved."""
        first = _page(client)
        assert first.status_code == 200
        assert OLD_NAME in first.text

        _identify(store, name=NEW_NAME)

        served = _page(client, slug=NEW_SLUG)
        assert served.status_code == 200
        assert NEW_NAME in served.text
        assert OLD_NAME not in served.text
        # The canonical must not point at a URL that now 301s.
        assert _canonical(served.text).endswith(
            "/companii/%d-%s" % (CUI, NEW_SLUG))
        # The old slug redirects, and the redirect target is the new page.
        old = _page(client, follow=False)
        assert old.status_code == 301
        assert old.headers["location"].endswith(
            "/companii/%d-%s" % (CUI, NEW_SLUG))

    def test_county_change_invalidates_the_cached_page(self, client, store):
        """Not just the name: the header card prints the county and the
        JSON-LD prints county + locality. The URL does not move here, so
        no redirect masks the staleness."""
        first = _page(client)
        assert first.status_code == 200
        assert "Cluj-Napoca" in first.text

        _identify(store, county="Timis", locality="Timisoara")

        served = _page(client)
        assert served.status_code == 200
        assert "Timis" in served.text
        assert "Timisoara" in served.text
        assert "Cluj-Napoca" not in served.text

    def test_name_source_change_invalidates_the_cached_page(self, client,
                                                            store):
        """The footer prints a SECOND licence line only when the name came
        from the identification dataset — a legal attribution string, not
        cosmetics."""
        from engine.public_ro.compliance import license_line

        ident_line = license_line("mfinante_datagov_identificare")
        first = _page(client)
        assert ident_line in first.text

        _identify(store, name_source="")

        served = _page(client)
        assert served.status_code == 200
        assert ident_line not in served.text

    def test_unchanged_identification_run_keeps_the_cached_bytes(
            self, client, store, monkeypatch):
        """The other direction: `ident` re-stamps companies.updated_at on
        EVERY row it touches, changed or not. Keying on that timestamp
        would throw the whole storefront cache away on every annual run
        while producing byte-identical pages.

        store._now_iso has SECOND precision, so two calls in one test
        normally collide and this would pass for the wrong reason —
        advance it explicitly so the re-stamp is guaranteed."""
        clock = iter(["2026-06-15T00:00:00Z", "2027-06-15T00:00:00Z"])
        monkeypatch.setattr(store_mod, "_now_iso",
                            lambda: next(clock, "2028-06-15T00:00:00Z"))
        calls: List[int] = []
        real = router_mod.render_company_page

        # *args/**kwargs on purpose: this double stands in for the real
        # renderer, and pinning its exact signature here means every new
        # render parameter breaks a cache test for no reason — the same
        # fake-drifts-from-real failure this whole suite exists to catch.
        def counting(*args: Any, **kwargs: Any) -> str:
            calls.append(1)
            return real(*args, **kwargs)

        monkeypatch.setattr(router_mod, "render_company_page", counting)

        first = _page(client)
        assert first.status_code == 200
        assert len(calls) == 1

        _identify(store)  # identical values, fresh updated_at

        second = _page(client)
        assert second.status_code == 200
        assert second.text == first.text
        assert len(calls) == 1, "identical identity re-rendered the page"


# ──────────────────────────────────────────────────────────────────────
# DEFECT 2 — the OG disk cache ignored the company name it draws
# ──────────────────────────────────────────────────────────────────────

class TestOgCacheTracksRenderedInputs:
    def test_rename_invalidates_the_cached_og_card(self, client, store):
        first = _og(client)
        assert first.status_code == 200
        assert first.content[:8] == b"\x89PNG\r\n\x1a\n"

        _identify(store, name=NEW_NAME)

        second = _og(client)
        assert second.status_code == 200
        assert second.content != first.content, \
            "social card kept the old company name after a rename"

    def test_unchanged_inputs_reuse_the_cached_card(self, client, store,
                                                    monkeypatch):
        calls: List[int] = []
        real = og_mod.render_og_png

        def counting(**kw: Any) -> bytes:
            calls.append(1)
            return real(**kw)

        monkeypatch.setattr(og_mod, "render_og_png", counting)

        first = _og(client)
        second = _og(client)
        assert first.content == second.content
        assert len(calls) == 1, "identical inputs re-rendered the PNG"

    def test_cached_card_matches_a_direct_render_of_the_same_inputs(self):
        kpis = {"Cifra de afaceri neta": "140,0 mil. RON",
                "Rezultat net": "9,0 mil. RON"}
        direct = og_mod.render_og_png(name=NEW_NAME, cui=CUI, year=2024,
                                      kpis=kpis, lang="ro")
        cached = og_mod.cached_og_png(name=NEW_NAME, cui=CUI, year=2024,
                                      dataset_version="uu-2024", kpis=kpis,
                                      lang="ro")
        assert cached == direct

    def test_kpi_row_order_is_part_of_the_key(self, tmp_path):
        """render_og_png draws the KPI rows in dict order, so the ORDER is
        a rendered input. A digest that canonicalised key order away would
        serve one card for both layouts."""
        a = {"Rezultat net": "9,0 mil. RON",
             "Cifra de afaceri neta": "140,0 mil. RON"}
        b = {"Cifra de afaceri neta": "140,0 mil. RON",
             "Rezultat net": "9,0 mil. RON"}
        first = og_mod.cached_og_png(name=OLD_NAME, cui=CUI, year=2024,
                                     dataset_version="uu-2024", kpis=a,
                                     directory=tmp_path)
        second = og_mod.cached_og_png(name=OLD_NAME, cui=CUI, year=2024,
                                      dataset_version="uu-2024", kpis=b,
                                      directory=tmp_path)
        assert first != second


# ──────────────────────────────────────────────────────────────────────
# The key itself — one authority, derived from the rendered inputs
# ──────────────────────────────────────────────────────────────────────

def _key(**over: Any):
    company = dict(COMPANY_ROW)
    company.update(over.pop("company", {}))
    filings = over.pop("filings", FILINGS)
    kw: Dict[str, Any] = dict(cui=CUI, year=2024, lang="ro",
                              percentiles_epoch="1")
    kw.update(over)
    return cache_mod.page_cache_key(company=company, filings=filings, **kw)


class TestPageCacheKey:
    def test_key_moves_for_every_company_field(self):
        base = _key()
        for field, value in (("name", NEW_NAME), ("county", "Timis"),
                             ("locality", "Timisoara"), ("caen", "4711"),
                             ("name_source", ""), ("reg_number", "J40/1/2020"),
                             ("publishable", False)):
            assert _key(company={field: value}) != base, field

    def test_key_moves_for_a_field_the_template_does_not_render_yet(self):
        """sector_label is read by the page model but no store column
        populates it yet. The day one does, the key must move on its own —
        that is the whole point of digesting the row instead of listing
        the columns someone remembered."""
        assert _key(company={"sector_label": "Industria alimentara"}) != _key()

    def test_write_timestamps_are_not_part_of_the_key(self):
        base = _key()
        assert _key(company={"updated_at": "2027-01-01T00:00:00Z"}) == base
        assert _key(company={
            "provenance": {"name_source": "mfinante_datagov_identificare",
                           "updated_at": "2027-01-01T00:00:00Z"}}) == base

    def test_key_moves_when_any_year_is_restated(self):
        """dataset_version was the LATEST filing's dataset_id, so a
        restatement of an older year left the five-year trend blocks
        cached against the superseded numbers."""
        restated = [dict(FILINGS[0], provenance={"dataset_id": "uu-2023-r2"}),
                    FILINGS[1]]
        assert _key(filings=restated) != _key()

    def test_key_separates_languages_years_and_epochs(self):
        base = _key()
        assert _key(lang="en") != base
        assert _key(year=2023) != base
        assert _key(percentiles_epoch="2") != base

    def test_key_is_stable_across_processes(self):
        """No hash(): PYTHONHASHSEED varies per process, and the disk tier
        outlives the process that wrote it."""
        code = (
            "import sys; sys.path.insert(0, %r)\n"
            "from engine.public_ro.pages.cache import page_cache_key\n"
            "k = page_cache_key(cui=1, year=2024, lang='ro',\n"
            "                   company={'cui': 1, 'name': 'Alfa \\u0218 SRL'},\n"
            "                   filings=[{'year': 2024,\n"
            "                             'provenance': {'dataset_id': 'd1'}}],\n"
            "                   percentiles_epoch='1')\n"
            "print('|'.join(str(p) for p in k))\n" % str(SRC)
        )
        seen = set()
        for seed in ("0", "1", "12345"):
            out = subprocess.run(
                [sys.executable, "-c", code], capture_output=True, text=True,
                env={"PATH": "/usr/bin:/bin", "PYTHONHASHSEED": seed,
                     "PYTHONIOENCODING": "utf-8"})
            assert out.returncode == 0, out.stderr
            seen.add(out.stdout.strip())
        assert len(seen) == 1, seen

    def test_disk_tier_round_trips_through_a_fresh_cache_object(self, tmp_path):
        key = _key()
        cache_mod.PageCache(directory=tmp_path).put(key, "<html>x</html>")
        assert cache_mod.PageCache(directory=tmp_path).get(key) \
            == "<html>x</html>"
        assert cache_mod.PageCache(directory=tmp_path).get(
            _key(company={"name": NEW_NAME})) is None

    def test_on_disk_filename_stays_safe(self, tmp_path):
        key = _key(company={"name": "../../etc/passwd Ștefan SRL"},
                   filings=[dict(FILINGS[0],
                                 provenance={"dataset_id": "../../evil id"})])
        cache = cache_mod.PageCache(directory=tmp_path)
        cache.put(key, "<html>y</html>")
        written = [p for p in tmp_path.iterdir() if p.suffix == ".html"]
        assert len(written) == 1
        assert re.fullmatch(r"[A-Za-z0-9._-]+\.html", written[0].name), \
            written[0].name
        assert written[0].parent == tmp_path
        assert cache.get(key) == "<html>y</html>"

    def test_short_legacy_keys_still_address_a_file(self, tmp_path):
        """The tuple grew twice already (epoch, then the identity digest).
        Callers built against the older shape must keep working rather
        than raising inside a public request."""
        cache = cache_mod.PageCache(directory=tmp_path)
        for key in ((CUI, 2024, "uu-2024", "ro"),
                    (CUI, 2024, "uu-2024", "ro", "1")):
            cache.put(key, "<html>%s</html>" % len(key))
            assert cache.get(key) == "<html>%s</html>" % len(key)
        assert len({p.name for p in tmp_path.iterdir()
                    if p.suffix == ".html"}) == 2
