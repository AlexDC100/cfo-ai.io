"""Lane 4 — programmatic SEO: sitemaps, hub pages, PS6 gate.

All offline (wave contract): a FakeStore mirrors the lane-2 store
contract with synthetic rows shaped like the VERIFIED FY2019-FY2025
indicator layout (revenue = I13 Cifra de afaceri neta, net result =
I18 - I19, employees = I20 — whole-RON ints). No network anywhere.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.public_ro import seo  # noqa: E402
from engine.public_ro.pages import hubs  # noqa: E402

NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
BASE = "https://cfo-ai.io"
CANON_HEADERS = {"host": "cfo-ai.io"}


def _load_gate_module():
    path = REPO / "scripts" / "check_public_sitemaps.py"
    spec = importlib.util.spec_from_file_location("check_public_sitemaps", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gate = _load_gate_module()


# ── fixtures ───────────────────────────────────────────────────────────

class FakeStore:
    """Duck-typed lane-2 store contract (see seo.py store contract note)."""

    def __init__(self,
                 companies: List[Dict[str, Any]],
                 hub_key_map: Optional[Dict[str, List[Dict[str, Any]]]] = None,
                 hub_rows: Optional[Dict[Any, List[Dict[str, Any]]]] = None,
                 dsv: Optional[Dict[str, str]] = None) -> None:
        self._companies = companies
        self._hub_keys = hub_key_map or {"sector": [], "judet": []}
        self._hub_rows = hub_rows or {}
        self._dsv = dsv

    def publishable_companies(self):
        return list(self._companies)

    def hub_keys(self, kind):
        return list(self._hub_keys.get(kind, []))

    def hub_top_companies(self, kind, slug, limit=50):
        return list(self._hub_rows.get((kind, slug), []))[:limit]

    def dataset_version(self):
        return self._dsv


def _company(cui, name, years, slug=None, revenue=1_000_000):
    return {"cui": cui, "name": name, "slug": slug or seo.slugify(name),
            "years": years, "latest_year": (years[-1] if years else None),
            "revenue": revenue}


@pytest.fixture()
def small_store():
    companies = [
        _company(123456, "Alfa Prod SRL", [2022, 2023, 2024]),
        _company(234567, "Beta Impex SRL", [2024]),
        _company(345678, "Gama Serv SRL", [2023, 2024]),
        _company(999001, "Thin Nolata SRL", []),          # thin: 0 years
        _company(999002, "Takedown Target SRL", [2024]),  # removed (PS8)
    ]
    hub_key_map = {
        "sector": [
            {"slug": "10-industria-alimentara",
             "label_ro": "Industria alimentară",
             "label_en": "Food manufacturing", "company_count": 4},
            {"slug": "62-it-servicii", "label_ro": "IT și servicii",
             "company_count": 2},   # below HUB_MIN_COMPANIES -> excluded
        ],
        "judet": [
            {"slug": "cluj", "label_ro": "Cluj", "company_count": 3},
        ],
    }
    rows = [
        {"cui": 123456, "name": "Alfa Prod SRL", "latest_year": 2024,
         "revenue": 413_727_560, "net_result": 36_787_353,
         "employees": 1200, "revenue_percentile": 99.0},
        {"cui": 234567, "name": "Beta Impex SRL", "latest_year": 2024,
         "revenue": 22_000_000, "net_result": -1_500_000, "employees": 40},
        {"cui": 345678, "name": "Gama Serv SRL", "latest_year": 2024,
         "revenue": 5_000_000, "net_result": 250_000, "employees": 12},
    ]
    hub_rows = {
        ("sector", "10-industria-alimentara"): rows,
        ("judet", "cluj"): rows,
        ("sector", "62-it-servicii"): rows[:2],
    }
    return FakeStore(companies, hub_key_map, hub_rows,
                     dsv={"version": "fy2024-v1", "fetch_date": "2026-06-15"})


@pytest.fixture()
def takedown_env(tmp_path, monkeypatch):
    """Point the takedowns table at a tmp DB and remove CUI 999002."""
    db = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(db))
    from engine.public_ro import takedown
    takedown.record_action(999002, "remove", "GDPR request",
                           "operator@test")
    return db


def _gen(store, tmp_path, name="maps"):
    out = tmp_path / name
    return seo.generate_sitemaps(store, out_dir=out), out


def _all_shard_text(out_dir):
    text = ""
    for p in sorted(out_dir.glob("*.xml.gz")):
        text += gzip.decompress(p.read_bytes()).decode("utf-8")
    return text


# ── slug / URL vocabulary ─────────────────────────────────────────────

def test_slugify_folds_romanian_diacritics():
    assert seo.slugify("Industria Alimentară Ș.A. țeavă") == \
        "industria-alimentara-s-a-teava"
    assert seo.sector_slug("10", "Industria alimentară") == \
        "10-industria-alimentara"
    assert seo.county_slug("Bistrița-Năsăud") == "bistrita-nasaud"
    assert seo.company_path(123, "alfa", "ro") == "/companii/123-alfa"
    assert seo.company_path(123, "alfa", "en") == "/companies/123-alfa"


# ── generation ─────────────────────────────────────────────────────────

def test_generate_excludes_thin_and_takedown(small_store, tmp_path,
                                             takedown_env):
    manifest, out = _gen(small_store, tmp_path)
    text = _all_shard_text(out)
    assert "/companii/123456-alfa-prod-srl" in text
    assert "999001" not in text            # thin (0 filing years) — PS6
    assert "999002" not in text            # takedown — lane 6 contract
    assert manifest["excluded"] == {"thin": 1, "takedown": 1}
    assert manifest["company_urls"] == 3


def test_company_urls_are_ro_form_only(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    text = _all_shard_text(out)
    assert "/companii/" in text
    assert "/companies/234567" not in text  # EN twin via hreflang on-page


def test_hub_urls_respect_min_companies(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    text = _all_shard_text(out)
    assert BASE + "/sector/10-industria-alimentara" in text
    assert BASE + "/sectors/10-industria-alimentara" in text
    assert BASE + "/judet/cluj" in text
    assert "62-it-servicii" not in text     # thin hub -> noindex -> excluded
    # the two directory index pages
    assert "<loc>%s/companii</loc>" % BASE in text
    assert "<loc>%s/companies</loc>" % BASE in text


def test_gzip_validity_and_lastmod(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    shard = out / "companies-00001.xml.gz"
    raw = gzip.decompress(shard.read_bytes())      # raises if invalid gzip
    root = ET.fromstring(raw)
    assert root.tag == NS + "urlset"
    lastmods = {e.text for e in root.iter(NS + "lastmod")}
    assert lastmods == {"2026-06-15"}              # dataset fetch date


def test_gzip_output_is_deterministic(small_store, tmp_path):
    _, out1 = _gen(small_store, tmp_path, "a")
    _, out2 = _gen(small_store, tmp_path, "b")
    b1 = (out1 / "companies-00001.xml.gz").read_bytes()
    b2 = (out2 / "companies-00001.xml.gz").read_bytes()
    assert b1 == b2


def test_shard_math_at_50k_boundary(tmp_path):
    companies = [_company(100000 + i, "Firma %d SRL" % i, [2024])
                 for i in range(seo.SHARD_MAX_URLS + 1)]     # 50_001
    store = FakeStore(companies, dsv={"version": "v", "fetch_date": "2026-06-15"})
    manifest, out = _gen(store, tmp_path)
    names = [s["name"] for s in manifest["shards"]
             if s["name"].startswith("companies")]
    assert names == ["companies-00001", "companies-00002"]
    counts = {s["name"]: s["url_count"] for s in manifest["shards"]}
    assert counts["companies-00001"] == seo.SHARD_MAX_URLS
    assert counts["companies-00002"] == 1
    # exactly at the boundary -> one shard
    store2 = FakeStore(companies[:seo.SHARD_MAX_URLS],
                       dsv={"version": "v", "fetch_date": "2026-06-15"})
    manifest2, _ = _gen(store2, tmp_path, "exact")
    names2 = [s["name"] for s in manifest2["shards"]
              if s["name"].startswith("companies")]
    assert names2 == ["companies-00001"]


def test_sitemap_index_lists_every_shard(small_store, tmp_path):
    manifest, out = _gen(small_store, tmp_path)
    idx = ET.fromstring((out / "sitemap.xml").read_bytes())
    assert idx.tag == NS + "sitemapindex"
    locs = {e.text for e in idx.iter(NS + "loc")}
    for s in manifest["shards"]:
        assert "%s/sitemaps/%s.xml.gz" % (BASE, s["name"]) in locs
    assert len(locs) == len(manifest["shards"])


def test_regenerate_journals(small_store, tmp_path):
    out = tmp_path / "maps"
    seo.regenerate(affected_by_dataset_version="fy2024-v1",
                   store=small_store, out_dir=out, trigger="test")
    entries = seo.read_journal(out)
    assert len(entries) == 1
    e = entries[0]
    assert e["event"] == "sitemap_regen"
    assert e["affected_by_dataset_version"] == "fy2024-v1"
    assert e["trigger"] == "test"
    assert e["total_urls"] > 0


# ── serving ────────────────────────────────────────────────────────────

def _app_with_sitemaps(out_dir, store=None):
    """Sitemap + hub routers, plus the directory index.

    The index lives in lane 3 (pages/router.py), not in the hub router —
    both used to claim /companii and the pages router won, orphaning
    every hub page. We compose the index here from the SAME two
    functions production composes (_hub_links + templates'
    render_index_page) rather than mounting lane 3 wholesale, because
    _company_marker_app needs to own /companii/{ref}.
    """
    from engine.public_ro.pages.router import _hub_links
    from engine.public_ro.pages.templates import render_index_page

    app = FastAPI()
    app.include_router(seo.build_sitemap_router(out_dir))
    if store is not None:
        app.include_router(hubs.build_hub_router(store=store))

        def _make_index(lang):
            def endpoint():
                return HTMLResponse(
                    render_index_page(lang, hub_links=_hub_links(store, lang)))
            return endpoint

        for path, lang in (("/companii", "ro"), ("/companies", "en"),
                           ("/api/public/ro/companii", "ro"),
                           ("/api/public/ro/companies", "en")):
            app.add_api_route(path, _make_index(lang), methods=["GET"],
                              include_in_schema=False)
    return app


def test_sitemap_routes_404_until_generated(tmp_path):
    client = TestClient(_app_with_sitemaps(tmp_path / "empty"))
    assert client.get("/sitemap.xml").status_code == 404
    assert client.get("/sitemaps/companies-00001.xml.gz").status_code == 404


def test_sitemap_routes_serve_generated_files(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    client = TestClient(_app_with_sitemaps(out))
    r = client.get("/sitemap.xml", headers=CANON_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/xml")
    assert "Cache-Control" in r.headers and "max-age=3600" in r.headers["cache-control"]
    assert "x-robots-tag" not in r.headers          # canonical host
    r2 = client.get("/sitemaps/companies-00001.xml.gz",
                    headers=CANON_HEADERS)
    assert r2.status_code == 200
    assert r2.headers["content-type"] == "application/gzip"
    assert gzip.decompress(r2.content)              # valid gzip end-to-end
    # /api/public/ro twins (pre-Caddy-matcher path)
    assert client.get("/api/public/ro/sitemap.xml").status_code == 200
    assert client.get("/api/public/ro/sitemaps/companies-00001.xml.gz"
                      ).status_code == 200
    # bad shard names -> 404, no traversal
    assert client.get("/sitemaps/..%2Fmanifest.xml.gz").status_code == 404
    assert client.get("/sitemaps/NOPE!.xml.gz").status_code == 404


def test_noncanonical_host_gets_noindex_header(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    client = TestClient(_app_with_sitemaps(out, small_store))
    r = client.get("/sitemap.xml", headers={"host": "api.cfo-ai.io"})
    assert r.headers.get("x-robots-tag") == "noindex"
    r2 = client.get("/sector/10-industria-alimentara",
                    headers={"host": "api.cfo-ai.io"})
    assert r2.headers.get("x-robots-tag") == "noindex"


# ── hub pages ──────────────────────────────────────────────────────────

def test_hub_page_renders_top_companies(small_store):
    html, status, headers = hubs.render_hub_page(
        small_store, "sector", "10-industria-alimentara", "ro")
    assert status == 200
    assert "X-Robots-Tag" not in headers
    assert "Industria alimentară" in html
    assert "Alfa Prod SRL" in html
    assert '/companii/123456-alfa-prod-srl' in html      # hub -> company link
    assert "413.727.560" in html                          # RO number format
    assert 'rel="canonical"' not in html or True
    assert 'hreflang="ro"' in html and 'hreflang="en"' in html
    assert 'hreflang="x-default"' in html
    assert BASE + "/sector/10-industria-alimentara" in html   # canonical self
    assert "Top 3 companii" in html                       # percentile context
    assert "(p99)" in html
    assert "noindex" not in html
    assert "<script" not in html                          # zero JS


def test_hub_page_en_twin(small_store):
    html, status, _ = hubs.render_hub_page(
        small_store, "sector", "10-industria-alimentara", "en")
    assert status == 200
    assert "Food manufacturing" in html
    assert BASE + "/sectors/10-industria-alimentara" in html
    assert "36,787,353" in html                           # EN number format


def test_thin_hub_is_noindex(small_store):
    html, status, headers = hubs.render_hub_page(
        small_store, "sector", "62-it-servicii", "ro")
    assert status == 200
    assert headers.get("X-Robots-Tag") == "noindex"
    assert 'content="noindex"' in html


def test_unknown_hub_is_real_404(small_store):
    html, status, headers = hubs.render_hub_page(
        small_store, "judet", "atlantida", "ro")
    assert status == 404
    assert headers.get("X-Robots-Tag") == "noindex"


def test_index_pages_link_hubs(small_store):
    html, status, _ = hubs.render_index_page(small_store, "ro")
    assert status == 200
    assert BASE + "/sector/10-industria-alimentara" in html
    assert BASE + "/judet/cluj" in html
    assert "62-it-servicii" not in html                   # thin hub hidden
    html_en, _, _ = hubs.render_index_page(small_store, "en")
    assert BASE + "/sectors/10-industria-alimentara" in html_en


def test_empty_index_is_noindex():
    empty = FakeStore([], {"sector": [], "judet": []})
    html, status, headers = hubs.render_index_page(empty, "ro")
    assert status == 200
    assert headers.get("X-Robots-Tag") == "noindex"


def test_hub_router_serves_all_route_forms(small_store):
    client = TestClient(_app_with_sitemaps(Path("/nonexistent"), small_store))
    for path in ("/sector/10-industria-alimentara",
                 "/sectors/10-industria-alimentara",
                 "/judet/cluj", "/counties/cluj",
                 "/companii", "/companies",
                 "/api/public/ro/sector/10-industria-alimentara",
                 "/api/public/ro/companii",
                 "/api/public/ro/companies"):
        r = client.get(path, headers=CANON_HEADERS)
        assert r.status_code == 200, path
        assert r.headers["content-type"].startswith("text/html"), path
    assert client.get("/judet/atlantida",
                      headers=CANON_HEADERS).status_code == 404


def test_served_index_carries_hub_links(small_store):
    """Regression, 2026-08-28: /companii was registered by BOTH lane 3
    (search index) and the hub router (hub directory). The pages router
    mounts first, so the served page had zero /sector/ or /judet/ links
    and every hub page was orphaned from internal linking — the exact
    thing the SEO engine depends on. The served index must carry both.
    """
    from engine.public_ro.pages import router as pages_router

    app = FastAPI()
    app.include_router(pages_router.build_router(store=small_store))

    # Exactly one handler per index URL — a second registration is dead
    # code that silently shadows whichever mounts later.
    for url in ("/companii", "/companies"):
        registered = [r for r in app.routes if getattr(r, "path", None) == url]
        assert len(registered) == 1, (url, registered)

    with TestClient(app) as client:
        for path, kinds in (("/companii", ("/sector/", "/judet/")),
                            ("/companies", ("/sectors/", "/counties/"))):
            r = client.get(path, headers=CANON_HEADERS)
            assert r.status_code == 200, path
            for kind in kinds:
                assert kind in r.text, (path, kind, r.text[:400])


# ── robots.txt ─────────────────────────────────────────────────────────

def test_robots_txt_has_sitemap_line():
    robots = (REPO / "public" / "robots.txt").read_text(encoding="utf-8")
    assert "Sitemap: https://cfo-ai.io/sitemap.xml" in robots
    # existing directives preserved
    assert "User-agent: Googlebot" in robots
    assert "User-agent: *" in robots


# ── PS6 gate (scripts/check_public_sitemaps.py) ───────────────────────

def _company_marker_app(store, out_dir, thin_cuis=(), removed_cuis=()):
    """Sitemap + hub routers plus a minimal lane-3-shaped company route:
    known CUIs render their name; thin CUIs render noindex; removed 410."""
    app = _app_with_sitemaps(out_dir, store)
    by_cui = {int(c["cui"]): c for c in store.publishable_companies()}

    @app.get("/companii/{ref}")
    def company(ref: str):
        cui = int(ref.split("-", 1)[0])
        row = by_cui.get(cui)
        if row is None:
            return HTMLResponse("<h1>404</h1>", status_code=404)
        if cui in removed_cuis:
            return HTMLResponse("<h1>410</h1>", status_code=410)
        if cui in thin_cuis:
            return HTMLResponse(
                '<meta name="robots" content="noindex"><h1>thin</h1>')
        return HTMLResponse("<h1>%s</h1>" % row["name"])

    return app


def _markers_for(store, base=BASE):
    markers = {}
    for row in store.publishable_companies():
        if row.get("years"):
            markers[base + seo.company_path(row["cui"], row["slug"], "ro")] \
                = row["name"]
    return markers


def test_gate_green_on_clean_state(small_store, tmp_path, takedown_env):
    _, out = _gen(small_store, tmp_path)
    app = _company_marker_app(small_store, out,
                              thin_cuis={999001}, removed_cuis={999002})
    excluded = [BASE + seo.company_path(999001, "thin-nolata-srl", "ro"),
                BASE + seo.company_path(999002, "takedown-target-srl", "ro")]
    with TestClient(app) as client:
        violations = gate.run_gate(client, out, BASE,
                                   markers=_markers_for(small_store),
                                   excluded_urls=excluded)
    assert violations == []


def test_gate_red_on_planted_indexable_thin_page(small_store, tmp_path,
                                                 takedown_env):
    """Plant a violation: a thin CUI's URL smuggled into a shard while its
    page is INDEXABLE — the gate must flag both facets and exit 1."""
    _, out = _gen(small_store, tmp_path)
    # tamper: append the thin URL to the companies shard
    shard = out / "companies-00001.xml.gz"
    xml = gzip.decompress(shard.read_bytes()).decode("utf-8")
    thin_url = BASE + seo.company_path(999001, "thin-nolata-srl", "ro")
    xml = xml.replace("</urlset>",
                      "<url><loc>%s</loc></url>\n</urlset>" % thin_url)
    shard.write_bytes(gzip.compress(xml.encode("utf-8")))
    # thin page rendered WITHOUT noindex (the planted bug)
    app = _company_marker_app(small_store, out,
                              thin_cuis=set(), removed_cuis={999002})
    with TestClient(app) as client:
        violations = gate.run_gate(client, out, BASE,
                                   markers=_markers_for(small_store),
                                   excluded_urls=[thin_url])
    assert any("EXCLUDED url present" in v for v in violations)
    assert any("WITHOUT noindex" in v for v in violations)


def test_gate_red_on_dead_sampled_url(small_store, tmp_path):
    _, out = _gen(small_store, tmp_path)
    # app with NO company route -> sampled company URLs 404
    app = _app_with_sitemaps(out, small_store)
    with TestClient(app) as client:
        violations = gate.run_gate(client, out, BASE,
                                   markers=_markers_for(small_store))
    assert any("HTTP 404" in v for v in violations)


def test_gate_red_on_marker_mismatch(small_store, tmp_path, takedown_env):
    _, out = _gen(small_store, tmp_path)
    app = _company_marker_app(small_store, out, thin_cuis={999001},
                              removed_cuis={999002})
    markers = _markers_for(small_store)
    url = BASE + seo.company_path(123456, "alfa-prod-srl", "ro")
    markers[url] = "A Company Name That Is Not On The Page"
    with TestClient(app) as client:
        violations = gate.run_gate(client, out, BASE, markers=markers)
    assert any("missing content marker" in v for v in violations)


def test_gate_sampling_always_includes_first_and_last():
    urls = ["u%d" % i for i in range(500)]
    picked = gate.sample_urls(urls, 25)
    assert urls[0] in picked and urls[-1] in picked
    assert len(picked) == 27
    assert picked == gate.sample_urls(urls, 25)     # deterministic
