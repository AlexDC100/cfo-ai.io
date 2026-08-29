"""Lane 4 defect fixes — sitemap <loc> correctness + a PS6 gate that can fail.

Three confirmed defects, one test group each:

  D1  the sitemap minted its own company slug (unbounded ``seo.slugify``)
      while the page canonicalises with ``pages.slug.canonical_slug``
      (bounded to 60 chars). Any company whose name slugs longer than 60
      chars was advertised at a URL that permanently 301s.
  D2  hub <loc> values came straight out of ``store.hub_keys()``, where
      the judet key is the RAW county string, and ``_urlset_xml`` only
      XML-escapes. County "Satu Mare" emitted a <loc> containing a
      literal SPACE; diacritic counties emitted raw non-ASCII. Neither
      is a fetchable RFC-3986 URL.
  D3  the PS6 gate built ``TestClient(app)``, and starlette defaults to
      follow_redirects=True — so the liveness check read the status of
      the redirect TARGET and the "sitemap lists a URL that 301s"
      violation class was structurally undetectable.

Everything offline (wave contract): a fake store for the unit facets and
a real ``PublicRoStore`` on a tmp SQLite file for the end-to-end proof
that the sitemapped URL is the URL the real page serves 200 for.
"""

from __future__ import annotations

import gzip
import importlib.util
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if str(SRC) not in sys.path:  # pragma: no cover — conftest normally does this
    sys.path.insert(0, str(SRC))

from engine.public_ro import ratelimit  # noqa: E402
from engine.public_ro import seo  # noqa: E402
from engine.public_ro.pages import router as router_mod  # noqa: E402
from engine.public_ro.pages.slug import canonical_slug  # noqa: E402
from engine.public_ro.store import PublicRoStore  # noqa: E402

BASE = "https://cfo-ai.io"
CANON = {"host": "cfo-ai.io"}
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

#: Slugs to 87 chars — longer than canonical_slug's 60-char bound, so the
#: sitemap slug and the page slug disagree unless they share one authority.
LONG_NAME = ("Societatea Comerciala de Constructii si Instalatii Termice "
             "Industriale Transilvania SRL")
CUI_LONG = 123456


def _load_gate_module():
    path = REPO / "scripts" / "check_public_sitemaps.py"
    spec = importlib.util.spec_from_file_location(
        "check_public_sitemaps_fixes", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gate = _load_gate_module()


# ── fixtures ───────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(tmp_path / "public_ro.db"))
    monkeypatch.setenv("PUBLIC_RO_PAGES_DIR", str(tmp_path / "pages"))
    monkeypatch.setenv("PUBLIC_SITEMAP_DIR", str(tmp_path / "maps"))
    monkeypatch.setenv("PUBLIC_RO_RATE_PER_MIN", "100000")
    ratelimit.reset_limiter()
    router_mod.reset_default_store()
    yield
    ratelimit.reset_limiter()
    router_mod.reset_default_store()


class FakeStore:
    """Duck-typed lane-2 store contract (see seo.py store contract note).

    Deliberately mirrors the REAL PublicRoStore.publishable_companies()
    projection, which carries NO 'slug' key.
    """

    def __init__(self, companies: List[Dict[str, Any]],
                 hub_key_map: Optional[Dict[str, List[Dict[str, Any]]]] = None,
                 dsv: Optional[Dict[str, str]] = None) -> None:
        self._companies = companies
        self._hub_keys = hub_key_map or {"sector": [], "judet": []}
        self._dsv = dsv or {"version": "v1", "fetch_date": "2026-06-15"}

    def publishable_companies(self):
        return [dict(c) for c in self._companies]

    def hub_keys(self, kind):
        return [dict(e) for e in self._hub_keys.get(kind, [])]

    def hub_top_companies(self, kind, slug, limit=50):
        return []

    def dataset_version(self):
        return self._dsv


def _row(cui: int, name: str, years=(2024,), **extra: Any) -> Dict[str, Any]:
    row = {"cui": cui, "name": name, "years": list(years),
           "latest_year": (years[-1] if years else None), "county": "Cluj"}
    row.update(extra)
    return row


def _shard_text(out_dir: Path) -> str:
    text = ""
    for p in sorted(out_dir.glob("*.xml.gz")):
        text += gzip.decompress(p.read_bytes()).decode("utf-8")
    return text


def _shard_locs(out_dir: Path) -> List[str]:
    locs: List[str] = []
    for p in sorted(out_dir.glob("*.xml.gz")):
        root = ET.fromstring(gzip.decompress(p.read_bytes()))
        locs.extend(e.text or "" for e in root.iter(NS + "loc"))
    return locs


def _seeded_store(tmp_path: Path) -> PublicRoStore:
    """Real store, one publishable company with a very long legal name."""
    st = PublicRoStore(tmp_path / "public_ro.db")
    st.register_dataset(
        dataset_id="uu-2024", year=2024, family="UU", sha256="a" * 64,
        source_url="https://data.gov.ro/dataset/situatii_financiare_2024",
        resource_id="res-1", license_id="CC-BY-4.0", license_note=None,
        row_count=1, fetched_at="2026-06-15T00:00:00Z")
    st.ensure_company_stub(CUI_LONG, "1071")
    st.set_identification(
        CUI_LONG, name=LONG_NAME, county="Satu Mare", locality="Satu Mare",
        reg_number="J30/1/2001", tip_contrib="PJ", publishable=True,
        name_source="mfinante_datagov_identificare")
    st.upsert_filing(
        cui=CUI_LONG, year=2024, family="UU", dataset_id="uu-2024",
        indicators={"i13": 140_000_000, "i18": 9_000_000, "i19": 0,
                    "i10": 56_000_000, "i7": 24_000_000, "i20": 240},
        total_assets=80_000_000, net_result=9_000_000, caen="1071")
    return st


# ══ D1 — the sitemap slug must BE the page's canonical slug ════════════

def test_real_store_rows_carry_no_slug_key(tmp_path: Path) -> None:
    """The premise of D1: the fallback branch is not a fallback, it is
    the only branch that ever runs."""
    st = _seeded_store(tmp_path)
    try:
        rows = st.publishable_companies()
    finally:
        st.close()
    assert rows and "slug" not in rows[0]


def test_sitemapped_company_url_serves_200_not_301(tmp_path: Path) -> None:
    """End-to-end: the URL in the shard is the URL the real page serves.

    Before the fix this got 301 -> /companii/123456-societatea-...-i
    (canonical_slug's 60-char bound), i.e. the sitemap advertised a
    permanently redirecting URL.
    """
    st = _seeded_store(tmp_path)
    try:
        out = tmp_path / "maps"
        seo.generate_sitemaps(st, out_dir=out, base_url=BASE)
        company_locs = [u for u in _shard_locs(out) if "/companii/" in u]
        assert len(company_locs) == 1
        app = FastAPI()
        app.include_router(router_mod.build_router(st))
        with TestClient(app) as client:
            resp = client.get(company_locs[0][len(BASE):], headers=CANON,
                              follow_redirects=False)
        assert resp.status_code == 200, (
            "sitemapped URL %s -> HTTP %d (Location: %s)"
            % (company_locs[0], resp.status_code,
               resp.headers.get("location")))
    finally:
        st.close()


def test_company_url_uses_bounded_canonical_slug(tmp_path: Path) -> None:
    store = FakeStore([_row(CUI_LONG, LONG_NAME)])
    urls, _ = seo.collect_company_urls(store, takedowns=frozenset(),
                                       base=BASE)
    assert urls == [BASE + seo.company_path(CUI_LONG,
                                            canonical_slug(LONG_NAME), "ro")]
    slug = urls[0].split("/companii/%d-" % CUI_LONG, 1)[1]
    assert 0 < len(slug) <= 60
    assert len(seo.slugify(LONG_NAME)) > 60   # the fix is load-bearing here


def test_store_supplied_slug_never_overrides_the_page_authority(
        tmp_path: Path) -> None:
    """One authority: a 'slug' column appearing on the store row must not
    reopen the divergence — the page canonicalises from the NAME."""
    store = FakeStore([_row(CUI_LONG, LONG_NAME, slug="whatever-the-db-said")])
    urls, _ = seo.collect_company_urls(store, takedowns=frozenset(),
                                       base=BASE)
    assert "whatever-the-db-said" not in urls[0]
    assert urls[0].endswith(canonical_slug(LONG_NAME))


def test_gate_marker_urls_use_the_same_slug_authority(tmp_path: Path,
                                                      monkeypatch) -> None:
    """The gate derived its own marker/exclusion URLs with the same
    unbounded slugify — so it looked up markers under URLs that are not
    in any shard and could never notice."""
    st = _seeded_store(tmp_path)
    try:
        monkeypatch.setattr(seo, "_open_default_store", lambda: st)
        out = tmp_path / "maps"
        seo.generate_sitemaps(st, out_dir=out, base_url=BASE)
        markers, _excluded = gate._markers_and_exclusions(BASE)
        company_markers = [u for u in markers if "/companii/" in u]
        assert company_markers == [BASE + seo.company_path(
            CUI_LONG, canonical_slug(LONG_NAME), "ro")]
        assert set(markers) >= {u for u in _shard_locs(out)
                                if "/companii/" in u}
        # hub markers must be slugged too, or the gate probes a URL that
        # is in no shard and reports nothing about the one that is.
        assert BASE + "/judet/satu-mare" in markers
    finally:
        st.close()


# ══ D2 — every <loc> must be a valid, fetchable RFC-3986 URL ═══════════

_RAW_COUNTY_HUBS = {
    "sector": [{"slug": "10", "label_ro": "Industria alimentara",
                "company_count": 9}],
    "judet": [
        {"slug": "Satu Mare", "label_ro": "Satu Mare", "company_count": 7},
        {"slug": "Bistrița-Năsăud", "label_ro": "Bistrița-Năsăud",
         "company_count": 5},
    ],
}


def test_hub_locs_have_no_space_or_non_ascii(tmp_path: Path) -> None:
    store = FakeStore([_row(1, "Alfa SRL")], _RAW_COUNTY_HUBS)
    out = tmp_path / "maps"
    seo.generate_sitemaps(store, out_dir=out, base_url=BASE)
    for loc in _shard_locs(out):
        assert " " not in loc, loc
        assert loc.isascii(), loc
        assert "%" not in loc, "slugging, not percent-escaping, is the fix"


def test_hub_locs_are_the_slug_vocabulary_this_module_owns(
        tmp_path: Path) -> None:
    store = FakeStore([_row(1, "Alfa SRL")], _RAW_COUNTY_HUBS)
    urls = seo.collect_hub_urls(store, base=BASE)
    assert BASE + seo.hub_path("judet", seo.county_slug("Satu Mare"),
                               "ro") in urls
    assert BASE + seo.hub_path("judet", seo.county_slug("Bistrița-Năsăud"),
                               "en") in urls
    assert BASE + "/judet/Satu Mare" not in urls


def test_hub_slugging_is_idempotent_for_the_already_slugged_store(
        tmp_path: Path) -> None:
    """The store-hubs lane is moving hub_keys to a proper slug; applying
    the slug functions again must be a no-op, not a second mangling."""
    slugged = {
        "sector": [{"slug": "10-industria-alimentara", "label_ro": "x",
                    "company_count": 9}],
        "judet": [{"slug": "satu-mare", "label_ro": "Satu Mare",
                   "company_count": 7}],
    }
    store = FakeStore([], slugged)
    urls = seo.collect_hub_urls(store, base=BASE)
    assert BASE + "/sector/10-industria-alimentara" in urls
    assert BASE + "/sectors/10-industria-alimentara" in urls
    assert BASE + "/judet/satu-mare" in urls
    assert BASE + "/counties/satu-mare" in urls


def test_urlset_xml_percent_encodes_unsafe_characters() -> None:
    """Belt-and-braces: whatever reaches the writer, an invalid URL can
    never leave it."""
    xml = seo._urlset_xml(["https://cfo-ai.io/judet/Satu Mare",
                           "https://cfo-ai.io/judet/Bistrița"], None)
    text = xml.decode("utf-8")
    assert "/judet/Satu Mare" not in text
    assert "Bistrița" not in text
    root = ET.fromstring(xml)
    locs = [e.text for e in root.iter(NS + "loc")]
    assert locs == ["https://cfo-ai.io/judet/Satu%20Mare",
                    "https://cfo-ai.io/judet/Bistri%C8%9Ba"]


def test_urlset_xml_still_escapes_xml_metacharacters() -> None:
    xml = seo._urlset_xml(["https://cfo-ai.io/companii?a=1&b=2"], None)
    assert b"&amp;" in xml
    root = ET.fromstring(xml)
    assert [e.text for e in root.iter(NS + "loc")] == \
        ["https://cfo-ai.io/companii?a=1&b=2"]


# ══ D3 — the gate must be able to fail on a redirecting URL ════════════

def _redirecting_app(out_dir: Path, store: Any) -> FastAPI:
    """Sitemap router + a company route that 301s every sitemapped URL to
    a different, live URL — the exact violation class D3 hid."""
    app = FastAPI()
    app.include_router(seo.build_sitemap_router(out_dir))

    @app.get("/companii/{ref}")
    def company(ref: str):
        if ref == "moved":
            return HTMLResponse("<h1>Alfa Prod SRL</h1>")
        return RedirectResponse("/companii/moved", status_code=301)

    @app.get("/companii")
    def index():
        return HTMLResponse("<h1>Companii</h1>")

    @app.get("/companies")
    def index_en():
        return HTMLResponse("<h1>Companies</h1>")

    return app


def test_gate_red_when_a_sitemapped_url_redirects(tmp_path: Path) -> None:
    store = FakeStore([_row(123456, "Alfa Prod SRL")])
    out = tmp_path / "maps"
    seo.generate_sitemaps(store, out_dir=out, base_url=BASE)
    with TestClient(_redirecting_app(out, store)) as client:
        violations = gate.run_gate(client, out, BASE)
    assert any("301" in v for v in violations), violations


def test_gate_requests_without_following_redirects(tmp_path: Path) -> None:
    """The predicate itself: every probe the gate makes must read the
    status of the URL IN THE SITEMAP, never of its redirect target."""
    seen: List[Dict[str, Any]] = []

    class SpyClient:
        def get(self, path, headers=None, **kw):
            seen.append(dict(kw, path=path))

            class R:
                status_code = 200
                headers: Dict[str, str] = {}
                text = ""
            return R()

    store = FakeStore([_row(123456, "Alfa Prod SRL")])
    out = tmp_path / "maps"
    seo.generate_sitemaps(store, out_dir=out, base_url=BASE)
    gate.run_gate(SpyClient(), out, BASE,
                  excluded_urls=[BASE + "/companii/999001-thin-srl"])
    assert seen, "gate made no requests"
    assert all(kw.get("follow_redirects") is False for kw in seen), seen


def test_gate_client_accepts_a_plain_get_signature(tmp_path: Path) -> None:
    """run_gate's documented contract is 'anything with .get(path,
    headers=...)'; a client that cannot take the kwarg must still work."""

    class PlainClient:
        def get(self, path, headers=None):
            class R:
                status_code = 200
                headers: Dict[str, str] = {}
                text = ""
            return R()

    store = FakeStore([_row(123456, "Alfa Prod SRL")])
    out = tmp_path / "maps"
    seo.generate_sitemaps(store, out_dir=out, base_url=BASE)
    assert gate.run_gate(PlainClient(), out, BASE) == []
