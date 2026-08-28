"""Lane 3 — the storefront pages: model, templates, OG, router.

Everything here is OFFLINE and AI-free (wave contract): a real
``PublicRoStore`` on a tmp SQLite file (the ``PUBLIC_RO_DB_PATH`` idiom
from test_public_compliance.py) plus hand-built filing dicts shaped like
the verified FY2019-FY2025 indicator layout (revenue = i13, net result =
i18 - i19, total capital = i10, liabilities = i7, employees = i20 —
whole-RON ints). No network, no clock, no randomness.

The invariants pinned here are the ones the storefront cannot regress
silently:

  PS3  byte-identical renders (HTML and the OG PNG) — the page cache and
       the CDN both assume the renderer is a pure function.
  PS5  the LOCKED ratio cards leak NO numeric value. This is the paywall:
       a single digit inside a locked card gives away a metric the
       summary file structurally cannot support.
  Health flags are FACTUAL — the exact i18n wording is pinned, both
       languages, with the year present and no judgment vocabulary.
  Serving discipline — real HTML 404 / 410, canonical-slug 301, the
       canonical <link> always the clean https://cfo-ai.io form,
       non-canonical hosts noindex, cache headers, EN/RO parity.
  Self-containment — zero external origins, zero <script src>, and the
       one inline script must point at a route that actually exists.
"""

from __future__ import annotations

import re
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

from engine.public_ro import ratelimit, takedown  # noqa: E402
from engine.public_ro.pages import og as og_mod  # noqa: E402
from engine.public_ro.pages import router as router_mod  # noqa: E402
from engine.public_ro.pages.i18n import LANGS, STRINGS  # noqa: E402
from engine.public_ro.pages.model import (  # noqa: E402
    LOCKED_RATIO_KEYS,
    build_health_flags,
    build_page_model,
    estimate_percentile,
    fmt_compact_ron,
    fmt_int,
    fmt_pct,
    net_result_of,
    total_assets_of,
)
from engine.public_ro.pages.templates import (  # noqa: E402
    render_company_page,
    render_error_page,
    render_index_page,
    accountant_url,
    signup_url,
)
from engine.public_ro.store import PublicRoStore  # noqa: E402

BASE = "https://cfo-ai.io"
CANON = {"host": "cfo-ai.io"}
OTHER_HOST = {"host": "api.cfo-ai.io"}

CUI_OK = 123456          # publishable, 5 filing years, healthy
CUI_FLAGS = 234567       # publishable, 5 filing years, every flag fires
CUI_PRIVATE = 777001     # filings but publishable=0 (PS7)
CUI_NOFILINGS = 888002   # publishable but zero filings
CUI_REMOVED = 999002     # publishable + filings, taken down (PS8)
CUI_ABSENT = 4242424     # never seen

PAGE_WEIGHT_BUDGET = 60 * 1024

# Judgment vocabulary the factual-signal copy must never contain.
JUDGMENT_WORDS = (
    "risk", "risky", "distress", "bankrupt", "insolven", "failing",
    "poor", "weak", "unhealthy", "danger", "warning", "troubled",
    "concerning", "alarming", "unsafe",
    "risc", "faliment", "periculos", "slab", "prost", "ingrijorator",
    "alarmant", "nesanatos", "vulnerabil",
)


# ── fixtures ───────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every filesystem/db side-effect lands in tmp, and the shared
    process-wide rate limiter can never make a test flaky."""
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(tmp_path / "public_ro.db"))
    monkeypatch.setenv("PUBLIC_RO_PAGES_DIR", str(tmp_path / "pages"))
    monkeypatch.setenv("PUBLIC_RO_OG_DIR", str(tmp_path / "og"))
    monkeypatch.setenv("PUBLIC_SITEMAP_DIR", str(tmp_path / "maps"))
    monkeypatch.setenv("PUBLIC_RO_RATE_PER_MIN", "100000")
    monkeypatch.delenv("PUBLIC_AI_NARRATIVE", raising=False)
    ratelimit.reset_limiter()
    router_mod.reset_default_store()
    yield
    ratelimit.reset_limiter()
    router_mod.reset_default_store()


def _filing(year: int, **slots: Optional[int]) -> Dict[str, Any]:
    row: Dict[str, Any] = {"year": year, "caen": "1071"}
    row.update({k: None for k in ("i1", "i2", "i6", "i7", "i10", "i13",
                                  "i18", "i19", "i20")})
    row.update(slots)
    return row


#: Five clean years — growth, profit throughout, no flag fires.
HEALTHY_FILINGS = [
    _filing(2020, i13=100_000_000, i18=5_000_000, i19=0, i10=40_000_000,
            i7=20_000_000, i20=200, i1=30_000_000, i2=35_000_000, i6=1_000_000),
    _filing(2021, i13=110_000_000, i18=6_000_000, i19=0, i10=44_000_000,
            i7=21_000_000, i20=210, i1=31_000_000, i2=36_000_000, i6=1_000_000),
    _filing(2022, i13=120_000_000, i18=7_000_000, i19=0, i10=48_000_000,
            i7=22_000_000, i20=220, i1=32_000_000, i2=37_000_000, i6=1_000_000),
    _filing(2023, i13=130_000_000, i18=8_000_000, i19=0, i10=52_000_000,
            i7=23_000_000, i20=230, i1=33_000_000, i2=38_000_000, i6=1_000_000),
    _filing(2024, i13=140_000_000, i18=9_000_000, i19=0, i10=56_000_000,
            i7=24_000_000, i20=240, i1=34_000_000, i2=39_000_000, i6=1_000_000),
]

#: Five years engineered so that EVERY deterministic rule fires exactly
#: once: negative equity (2022), 2 consecutive loss years (2021-2022),
#: debt +75% (2021), revenue -40% (2021), employees -40% (2021).
FLAGGED_FILINGS = [
    _filing(2020, i13=100_000_000, i18=5_000_000, i19=0, i10=50_000_000,
            i7=20_000_000, i20=200),
    _filing(2021, i13=60_000_000, i18=0, i19=3_000_000, i10=40_000_000,
            i7=35_000_000, i20=120),
    _filing(2022, i13=62_000_000, i18=0, i19=2_000_000, i10=-5_000_000,
            i7=36_000_000, i20=118),
    _filing(2023, i13=80_000_000, i18=4_000_000, i19=0, i10=10_000_000,
            i7=30_000_000, i20=130),
    _filing(2024, i13=90_000_000, i18=6_000_000, i19=0, i10=20_000_000,
            i7=28_000_000, i20=140),
]

COMPANY_OK = {
    "cui": CUI_OK, "name": "Alfa Prod SRL", "county": "Cluj",
    "locality": "Cluj-Napoca", "caen": "1071", "publishable": True,
    "name_source": "mfinante_datagov_identificare", "sector_label": None,
}
COMPANY_FLAGS = dict(COMPANY_OK, cui=CUI_FLAGS, name="Delta Semnale SRL")


def _seed(store: PublicRoStore, cui: int, name: str,
          filings: List[Dict[str, Any]], *, publishable: bool = True) -> None:
    store.ensure_company_stub(cui, "1071")
    store.set_identification(
        cui, name=name, county="Cluj", locality="Cluj-Napoca",
        reg_number="J12/345/2001", tip_contrib="PJ" if publishable else "PF",
        publishable=publishable, name_source="mfinante_datagov_identificare")
    for row in filings:
        store.upsert_filing(
            cui=cui, year=int(row["year"]), family="UU",
            dataset_id="uu-2024",
            indicators={k: v for k, v in row.items()
                        if k.startswith("i") and k[1:].isdigit()},
            total_assets=total_assets_of(row),
            net_result=net_result_of(row), caen="1071")


@pytest.fixture()
def store(tmp_path: Path) -> PublicRoStore:
    st = PublicRoStore(tmp_path / "public_ro.db")
    st.register_dataset(
        dataset_id="uu-2024", year=2024, family="UU", sha256="a" * 64,
        source_url="https://data.gov.ro/dataset/situatii_financiare_2024",
        resource_id="res-1", license_id="CC-BY-4.0", license_note=None,
        row_count=5, fetched_at="2026-06-15T00:00:00Z")
    _seed(st, CUI_OK, "Alfa Prod SRL", HEALTHY_FILINGS)
    _seed(st, CUI_FLAGS, "Delta Semnale SRL", FLAGGED_FILINGS)
    _seed(st, CUI_PRIVATE, "Ionescu Ion PFA", HEALTHY_FILINGS,
          publishable=False)
    _seed(st, CUI_NOFILINGS, "Fara Depuneri SRL", [])
    _seed(st, CUI_REMOVED, "Takedown Target SRL", HEALTHY_FILINGS)
    st.replace_percentiles(2024, [
        {"metric": "revenue", "caen2": "10", "p10": 1e6, "p25": 5e6,
         "p50": 2e7, "p75": 1e8, "p90": 5e8, "n": 812},
        {"metric": "net_result", "caen2": "10", "p10": -1e6, "p25": 0.0,
         "p50": 5e5, "p75": 4e6, "p90": 2e7, "n": 812},
        {"metric": "employees", "caen2": "10", "p10": 2, "p25": 8,
         "p50": 30, "p75": 150, "p90": 600, "n": 812},
    ])
    yield st
    st.close()


@pytest.fixture()
def client(store: PublicRoStore) -> TestClient:
    app = FastAPI()
    app.include_router(router_mod.build_router(store))
    return TestClient(app)


@pytest.fixture()
def model() -> Dict[str, Any]:
    return build_page_model(COMPANY_OK, HEALTHY_FILINGS)


#: Stored distribution rows shaped like store.get_percentiles output.
PERCENTILES = {
    "revenue": {"p10": 1e6, "p25": 5e6, "p50": 2e7, "p75": 1e8, "p90": 5e8,
                "n": 812},
    "net_result": {"p10": -1e6, "p25": 0.0, "p50": 5e5, "p75": 4e6,
                   "p90": 2e7, "n": 812},
    "employees": {"p10": 2, "p25": 8, "p50": 30, "p75": 150, "p90": 600,
                  "n": 812},
}


@pytest.fixture()
def flagged_model() -> Dict[str, Any]:
    """Every optional block populated (flags, trends, ratios, position) so
    the structural-parity test compares a maximal page."""
    return build_page_model(COMPANY_FLAGS, FLAGGED_FILINGS,
                            percentiles=PERCENTILES)


def _page(client: TestClient, cui: int = CUI_OK, slug: str = "alfa-prod-srl",
          lang: str = "ro", **kw: Any):
    prefix = "/companii" if lang == "ro" else "/companies"
    kw.setdefault("headers", CANON)
    return client.get("%s/%d-%s" % (prefix, cui, slug), **kw)


# ──────────────────────────────────────────────────────────────────────
# 1. PS3 — byte-identical renders (HTML + OG PNG)
# ──────────────────────────────────────────────────────────────────────

class TestByteIdenticalRender:
    @pytest.mark.parametrize("lang", LANGS)
    def test_company_page_render_is_byte_identical(self, model, lang):
        first = render_company_page(model, lang)
        second = render_company_page(model, lang)
        assert first == second
        # ... and identical when the model is rebuilt from the same inputs,
        # which is what the disk page cache silently assumes.
        rebuilt = build_page_model(COMPANY_OK, HEALTHY_FILINGS)
        assert render_company_page(rebuilt, lang) == first

    @pytest.mark.parametrize("lang", LANGS)
    def test_index_and_error_pages_are_byte_identical(self, lang):
        assert render_index_page(lang) == render_index_page(lang)
        rows = [{"cui": CUI_OK, "name": "Alfa Prod SRL", "county": "Cluj",
                 "caen": "1071"}]
        assert (render_index_page(lang, query="alfa", results=rows)
                == render_index_page(lang, query="alfa", results=rows))
        for status in (404, 410):
            assert (render_error_page(status, lang)
                    == render_error_page(status, lang))

    def test_ai_narrative_flag_does_not_change_bytes(self, model, monkeypatch):
        """The PUBLIC_AI_NARRATIVE seam exists but this wave ships only the
        deterministic branch — flipping it must not move a single byte."""
        before = render_company_page(model, "ro")
        monkeypatch.setenv("PUBLIC_AI_NARRATIVE", "1")
        assert render_company_page(model, "ro") == before

    def test_og_png_is_stable_and_year_sensitive(self):
        kpis = {"Cifra de afaceri neta": "140,0 mil. RON",
                "Rezultat net": "9,0 mil. RON",
                "Salariati (numar mediu)": "240"}
        a = og_mod.render_og_png(name="Alfa Prod SRL", cui=CUI_OK, year=2024,
                                 kpis=kpis)
        b = og_mod.render_og_png(name="Alfa Prod SRL", cui=CUI_OK, year=2024,
                                 kpis=kpis)
        c = og_mod.render_og_png(name="Alfa Prod SRL", cui=CUI_OK, year=2023,
                                 kpis=kpis)
        assert a == b                       # same (cui, year) -> same bytes
        assert a != c                       # the year is stamped on the card
        assert a[:8] == b"\x89PNG\r\n\x1a\n"

    def test_og_route_bytes_identical_across_requests(self, client):
        first = client.get("/og/companii/%d-2024.png" % CUI_OK, headers=CANON)
        second = client.get("/og/companii/%d-2024.png" % CUI_OK, headers=CANON)
        assert first.status_code == second.status_code == 200
        assert first.headers["content-type"] == "image/png"
        assert first.content == second.content
        other_year = client.get("/og/companii/%d-2023.png" % CUI_OK,
                                headers=CANON)
        assert other_year.status_code == 200
        assert other_year.content != first.content

    def test_served_page_is_identical_on_a_cache_hit(self, client):
        first = _page(client)
        second = _page(client)
        assert first.status_code == second.status_code == 200
        assert first.content == second.content

    def test_og_route_404s_for_a_year_with_no_filing(self, client):
        r = client.get("/og/companii/%d-1999.png" % CUI_OK, headers=CANON)
        assert r.status_code == 404
        assert client.get("/og/companii/not-a-png", headers=CANON
                          ).status_code == 404


# ──────────────────────────────────────────────────────────────────────
# 2. PS5 — the locked ratio cards must leak no number
# ──────────────────────────────────────────────────────────────────────

_LOCKED_CARD_RE = re.compile(
    r'<div class="locked-card">(.*?)</div>', re.S)
_LOCKED_VALUE_RE = re.compile(
    r'<span class="locked-value"[^>]*>(.*?)</span>', re.S)
_LOCKED_NOTE_RE = re.compile(
    r'<span class="locked-note">(.*?)</span>', re.S)


class TestLockedRatioLeak:
    @pytest.mark.parametrize("lang", LANGS)
    def test_locked_cards_contain_no_digit_anywhere(self, model, lang):
        html = render_company_page(model, lang)
        cards = _LOCKED_CARD_RE.findall(html)
        assert len(cards) == len(LOCKED_RATIO_KEYS) == 6
        for card in cards:
            assert re.search(r"\d", card) is None, card
            values = _LOCKED_VALUE_RE.findall(card)
            assert len(values) == 1
            # the value SLOT specifically — the paywall invariant
            assert re.search(r"[0-9٠-٩۰-۹]",
                             values[0]) is None, values[0]
            assert values[0].strip() != ""      # a placeholder is rendered

    @pytest.mark.parametrize("lang", LANGS)
    def test_upsell_line_present_on_every_locked_card(self, model, lang):
        html = render_company_page(model, lang)
        note = STRINGS[lang]["locked_note"]
        notes = _LOCKED_NOTE_RE.findall(html)
        assert len(notes) == len(LOCKED_RATIO_KEYS)
        assert all(n == note for n in notes)
        assert "unlock" in note.lower() or "deblo" in note.lower()

    @pytest.mark.parametrize("lang", LANGS)
    def test_locked_labels_are_the_pinned_i18n_labels(self, model, lang):
        html = render_company_page(model, lang)
        for key in LOCKED_RATIO_KEYS:
            label = STRINGS[lang]["locked_%s" % key]
            assert re.search(r"\d", label) is None, key
            assert ('<span class="locked-label">%s</span>' % label) in html

    def test_locked_section_block_has_no_digits(self, flagged_model):
        """Belt-and-braces: the whole id="locked" grid, not just the cards
        (a future edit that adds a value OUTSIDE a card is still a leak)."""
        for lang in LANGS:
            html = render_company_page(flagged_model, lang)
            block = html.split('<div class="ratios" id="locked">', 1)[1]
            block = block.split("</section>", 1)[0]
            assert re.search(r"\d", block) is None


# ──────────────────────────────────────────────────────────────────────
# 3. Health flags — deterministic rules, factual wording
# ──────────────────────────────────────────────────────────────────────

def _kinds(filings) -> List[str]:
    return [f["kind"] for f in build_health_flags(filings)]


class TestHealthFlags:
    def test_healthy_company_produces_no_flags(self):
        assert build_health_flags(HEALTHY_FILINGS) == []

    def test_negative_equity_fires_on_most_recent_occurrence(self):
        rows = [_filing(2022, i10=-5_000_000), _filing(2023, i10=1_000_000),
                _filing(2024, i10=-9_000_000)]
        flags = build_health_flags(rows)
        assert flags == [{"kind": "negative_equity", "year": 2024,
                          "value": -9_000_000}]

    def test_two_consecutive_loss_years_fire(self):
        rows = [_filing(2022, i18=0, i19=5_000_000),
                _filing(2023, i18=0, i19=3_000_000),
                _filing(2024, i18=9_000_000, i19=0)]
        assert build_health_flags(rows) == [
            {"kind": "loss_years", "year_from": 2022, "year_to": 2023,
             "count": 2}]

    def test_one_loss_year_does_not_fire(self):
        rows = [_filing(2023, i18=0, i19=5_000_000),
                _filing(2024, i18=9_000_000, i19=0)]
        assert "loss_years" not in _kinds(rows)

    def test_loss_run_requires_adjacent_reported_years(self):
        """A loss in 2019 and another in 2024 is NOT "2 consecutive years"
        — the i18n string commits to that word, so the rule must too."""
        rows = [_filing(2019, i18=0, i19=5_000_000),
                _filing(2024, i18=0, i19=3_000_000)]
        assert build_health_flags(rows) == []

    def test_debt_spike_fires_above_threshold_only(self):
        assert _kinds([_filing(2023, i7=20_000_000),
                       _filing(2024, i7=35_000_000)]) == ["debt_spike"]
        # +40% is below DEBT_SPIKE_PCT (50) -> silent
        assert _kinds([_filing(2023, i7=20_000_000),
                       _filing(2024, i7=28_000_000)]) == []

    def test_revenue_collapse_fires_above_threshold_only(self):
        assert _kinds([_filing(2023, i13=100_000_000),
                       _filing(2024, i13=60_000_000)]) == ["revenue_drop"]
        assert _kinds([_filing(2023, i13=100_000_000),
                       _filing(2024, i13=80_000_000)]) == []

    def test_employee_drop_fires_above_threshold_only(self):
        assert _kinds([_filing(2023, i20=200),
                       _filing(2024, i20=120)]) == ["employee_drop"]
        assert _kinds([_filing(2023, i20=200),
                       _filing(2024, i20=160)]) == []

    def test_yoy_rules_skip_non_adjacent_years(self):
        assert _kinds([_filing(2019, i7=10, i13=100_000_000, i20=200),
                       _filing(2024, i7=99, i13=1_000_000, i20=10)]) == []

    def test_flagged_fixture_fires_every_rule_exactly_once(self):
        assert _kinds(FLAGGED_FILINGS) == [
            "negative_equity", "loss_years", "debt_spike", "revenue_drop",
            "employee_drop"]

    # ── wording ────────────────────────────────────────────────────────

    EXPECTED_RO = [
        "A raportat capitaluri totale negative in 2022.",
        "A raportat pierdere neta in 2 ani consecutivi (2021–2022).",
        "Datoriile au crescut cu 75,0% in 2021 fata de anul anterior.",
        "Cifra de afaceri a scazut cu 40,0% in 2021.",
        "Numarul mediu de salariati a scazut cu 40,0% in 2021.",
    ]
    EXPECTED_EN = [
        "Reported negative total capital in 2022.",
        "Reported a net loss in 2 consecutive years (2021–2022).",
        "Liabilities increased by 75.0% in 2021 versus the prior year.",
        "Net turnover fell by 40.0% in 2021.",
        "The average employee count fell by 40.0% in 2021.",
    ]

    @pytest.mark.parametrize("lang,expected",
                             [("ro", EXPECTED_RO), ("en", EXPECTED_EN)])
    def test_flag_wording_is_pinned_and_rendered(self, flagged_model, lang,
                                                 expected):
        html = render_company_page(flagged_model, lang)
        items = re.findall(r'<ul class="flags">(.*?)</ul>', html, re.S)
        assert len(items) == 1
        rendered = re.findall(r"<li[^>]*>(.*?)</li>", items[0], re.S)
        assert rendered == expected

    @pytest.mark.parametrize("lang,expected",
                             [("ro", EXPECTED_RO), ("en", EXPECTED_EN)])
    def test_flag_wording_is_factual(self, lang, expected):
        for text in expected:
            assert re.search(r"\b(19|20)\d{2}\b", text), text  # names the year
            low = text.lower()
            for word in JUDGMENT_WORDS:
                assert word not in low, (word, text)

    @pytest.mark.parametrize("lang", LANGS)
    def test_clean_company_renders_the_explicit_none_line(self, model, lang):
        html = render_company_page(model, lang)
        block = re.search(r'<ul class="flags">(.*?)</ul>', html, re.S).group(1)
        assert block.strip() == ('<li class="ok">%s</li>'
                                 % STRINGS[lang]["sec_health_none"])


# ──────────────────────────────────────────────────────────────────────
# 4. Routing — 404 / 410 / 301 / canonical
# ──────────────────────────────────────────────────────────────────────

class TestRouting:
    def test_known_company_renders(self, client):
        r = _page(client)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")
        assert "Alfa Prod SRL" in r.text

    @pytest.mark.parametrize("lang,prefix", [("ro", "/companii"),
                                             ("en", "/companies")])
    def test_unknown_cui_is_a_real_html_404(self, client, lang, prefix):
        r = client.get("%s/%d-nobody" % (prefix, CUI_ABSENT), headers=CANON)
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("text/html")
        assert r.text.lstrip().startswith("<!doctype html>")
        assert STRINGS[lang]["err_404_title"] in r.text
        # NOT a JSON error body (the SPA soft-404 problem must not repeat)
        assert '"detail"' not in r.text

    def test_unparseable_key_is_404(self, client):
        for key in ("not-a-cui", "abc-123", "-", "0-zero"):
            r = client.get("/companii/%s" % key, headers=CANON)
            assert r.status_code == 404, key

    def test_unpublishable_cui_is_404_not_a_page(self, client):
        r = _page(client, CUI_PRIVATE, "ionescu-ion-pfa")
        assert r.status_code == 404
        assert "Ionescu" not in r.text          # PS7: name must not leak

    def test_publishable_company_without_filings_is_404(self, client):
        r = _page(client, CUI_NOFILINGS, "fara-depuneri-srl")
        assert r.status_code == 404

    def test_takendown_cui_is_410_via_lane6_audit_trail(self, client):
        assert _page(client, CUI_REMOVED, "takedown-target-srl"
                     ).status_code == 200
        takedown.record_action(CUI_REMOVED, "remove", "verified request",
                               "operator@test")
        r = _page(client, CUI_REMOVED, "takedown-target-srl")
        assert r.status_code == 410
        assert r.headers["content-type"].startswith("text/html")
        assert STRINGS["ro"]["err_410_title"] in r.text
        assert "Takedown Target" not in r.text
        # the OG image goes away with the page
        assert client.get("/og/companii/%d-2024.png" % CUI_REMOVED,
                          headers=CANON).status_code == 404

    def test_takendown_cui_is_410_via_store_table(self, client, store):
        store.set_takedown(CUI_REMOVED, status="remove", reason="r",
                           verified_by="operator@test")
        assert _page(client, CUI_REMOVED, "takedown-target-srl"
                     ).status_code == 410

    @pytest.mark.parametrize("lang,prefix", [("ro", "/companii"),
                                             ("en", "/companies")])
    def test_wrong_slug_redirects_to_canonical(self, client, lang, prefix):
        r = client.get("%s/%d-gresit-total" % (prefix, CUI_OK), headers=CANON,
                       follow_redirects=False)
        assert r.status_code in (301, 308)
        assert r.headers["location"] == \
            "%s%s/%d-alfa-prod-srl" % (BASE, prefix, CUI_OK)

    def test_missing_slug_redirects_to_canonical(self, client):
        r = client.get("/companii/%d" % CUI_OK, headers=CANON,
                       follow_redirects=False)
        assert r.status_code in (301, 308)
        assert r.headers["location"] == \
            "%s/companii/%d-alfa-prod-srl" % (BASE, CUI_OK)

    def test_redirect_lands_on_a_200(self, client):
        r = client.get("/companii/%d-old-name" % CUI_OK, headers=CANON,
                       follow_redirects=True)
        assert r.status_code == 200
        assert "Alfa Prod SRL" in r.text

    @pytest.mark.parametrize("headers", [CANON, OTHER_HOST, {}])
    def test_canonical_link_is_always_the_clean_https_form(self, client,
                                                           headers):
        r = _page(client, headers=headers)
        assert r.status_code == 200
        canonical = re.search(r'<link rel="canonical" href="([^"]+)">',
                              r.text).group(1)
        assert canonical == "%s/companii/%d-alfa-prod-srl" % (BASE, CUI_OK)

    def test_api_twin_serves_the_same_bytes_and_canonical(self, client):
        clean = _page(client)
        twin = client.get("/api/public/ro/companii/%d-alfa-prod-srl" % CUI_OK,
                          headers=CANON)
        assert twin.status_code == 200
        assert twin.content == clean.content       # canonical URL unchanged

    def test_en_page_canonical_is_the_en_path(self, client):
        r = _page(client, lang="en")
        assert r.status_code == 200
        canonical = re.search(r'<link rel="canonical" href="([^"]+)">',
                              r.text).group(1)
        assert canonical == "%s/companies/%d-alfa-prod-srl" % (BASE, CUI_OK)


# ──────────────────────────────────────────────────────────────────────
# 5. Host discipline
# ──────────────────────────────────────────────────────────────────────

class TestHostDiscipline:
    PATHS = (
        "/companii/%d-alfa-prod-srl" % CUI_OK,
        "/companies/%d-alfa-prod-srl" % CUI_OK,
        "/companii",
        "/companii?q=alfa",
        "/api/public/ro/search?q=alfa",
        "/companii/%d-nobody" % CUI_ABSENT,       # the 404 page too
    )

    @pytest.mark.parametrize("path", PATHS)
    def test_noncanonical_host_gets_noindex(self, client, path):
        r = client.get(path, headers=OTHER_HOST, follow_redirects=False)
        assert r.headers.get("x-robots-tag") == "noindex", path

    @pytest.mark.parametrize("path", PATHS)
    def test_canonical_host_is_indexable(self, client, path):
        r = client.get(path, headers=CANON, follow_redirects=False)
        assert "x-robots-tag" not in r.headers, path

    def test_host_with_port_still_counts_as_canonical(self, client):
        r = _page(client, headers={"host": "cfo-ai.io:443"})
        assert "x-robots-tag" not in r.headers


# ──────────────────────────────────────────────────────────────────────
# 6. Cache headers
# ──────────────────────────────────────────────────────────────────────

class TestCacheHeaders:
    def test_company_page_is_publicly_cacheable(self, client):
        cc = _page(client).headers["cache-control"]
        assert cc.startswith("public")
        assert "max-age=3600" in cc
        assert "stale-while-revalidate=86400" in cc

    def test_index_and_og_are_publicly_cacheable(self, client):
        for path in ("/companii", "/companii?q=alfa",
                     "/og/companii/%d-2024.png" % CUI_OK):
            cc = client.get(path, headers=CANON).headers["cache-control"]
            assert cc.startswith("public, max-age="), path

    def test_error_pages_use_the_short_ttl(self, client):
        r = client.get("/companii/%d-nobody" % CUI_ABSENT, headers=CANON)
        assert r.status_code == 404
        assert r.headers["cache-control"] == "public, max-age=300"


# ──────────────────────────────────────────────────────────────────────
# 7. Self-containment — no external origin, no <script src>
# ──────────────────────────────────────────────────────────────────────

_ATTR_RE = re.compile(r'\b(?:src|href)="([^"]*)"')
_SCRIPT_OPEN_RE = re.compile(r"<script\b[^>]*>")


def _assert_self_contained(html: str) -> None:
    refs = _ATTR_RE.findall(html)
    assert refs, "page has no href/src at all — regex is wrong"
    for ref in refs:
        value = ref.replace("&amp;", "&")
        if value.startswith("mailto:") or value.startswith("#"):
            continue                                  # not a network fetch
        if value.startswith("/") and not value.startswith("//"):
            continue                                  # same-origin relative
        assert value.startswith(BASE + "/") or value == BASE, \
            "external origin referenced: %r" % ref
    # no external asset can be pulled through CSS either
    assert re.search(r"url\(", html) is None
    assert "<img" not in html
    assert "<iframe" not in html


class TestSelfContainment:
    @pytest.mark.parametrize("lang", LANGS)
    def test_company_page_references_no_external_origin(self, flagged_model,
                                                        lang):
        _assert_self_contained(render_company_page(flagged_model, lang))

    @pytest.mark.parametrize("lang", LANGS)
    def test_index_and_error_pages_reference_no_external_origin(self, lang):
        rows = [{"cui": CUI_OK, "name": "Alfa Prod SRL", "county": "Cluj",
                 "caen": "1071"}]
        _assert_self_contained(render_index_page(lang, query="alfa",
                                                 results=rows))
        _assert_self_contained(render_error_page(404, lang))
        _assert_self_contained(render_error_page(410, lang))

    def test_served_page_references_no_external_origin(self, client):
        _assert_self_contained(_page(client).text)

    @pytest.mark.parametrize("lang", LANGS)
    def test_there_is_no_external_script_tag(self, model, lang):
        html = render_company_page(model, lang)
        for tag in _SCRIPT_OPEN_RE.findall(html):
            assert "src=" not in tag, tag
        # exactly two inline scripts: the JSON-LD block and the beacon
        assert len(_SCRIPT_OPEN_RE.findall(html)) == 2
        assert '<script type="application/ld+json">' in html

    def test_no_stylesheet_or_font_link_elements(self, model):
        html = render_company_page(model, "ro")
        rels = re.findall(r'<link rel="([^"]+)"', html)
        assert set(rels) <= {"canonical", "alternate"}
        assert "<style>" in html                     # the CSS is inlined

    def test_the_one_inline_script_posts_to_a_mounted_route(self, client):
        """The view beacon used to POST to /api/public/ro/funnel/beacon,
        which nothing ever mounted — every page view was lost. Pin the
        endpoint against the router's real route table."""
        html = _page(client).text
        found = re.search(r"fetch\('([^']+)'", html)
        assert found, "the page's inline beacon does not fetch() anything"
        target = found.group(1)
        mounted = {(m, r.path)
                   for r in client.app.routes
                   for m in (getattr(r, "methods", None) or ())}
        assert ("POST", target) in mounted, target

    def test_the_beacon_payload_matches_the_funnel_contract(self, client):
        """Kind and body type must be what funnel.record_event accepts —
        a valid route with an invalid kind is still a silently lost event."""
        from engine.public_ro.funnel import EVENT_KINDS

        html = _page(client).text
        kinds = set(re.findall(r"send\('([a-z_]+)'", html))
        assert kinds and kinds <= set(EVENT_KINDS), kinds
        assert "application/json" in html            # not sendBeacon/text-plain
        r = client.post("/api/public/ro/event",
                        json={"kind": "page_view",
                              "path": "/companii/%d-alfa-prod-srl" % CUI_OK})
        assert r.status_code == 204


# ──────────────────────────────────────────────────────────────────────
# 8. Page-weight budget
# ──────────────────────────────────────────────────────────────────────

class TestPageWeight:
    @pytest.mark.parametrize("lang", LANGS)
    def test_company_page_is_under_the_budget(self, flagged_model, lang):
        size = len(render_company_page(flagged_model, lang).encode("utf-8"))
        assert size < PAGE_WEIGHT_BUDGET, size

    def test_served_page_body_is_under_the_budget(self, client):
        r = _page(client)
        assert len(r.content) < PAGE_WEIGHT_BUDGET
        assert int(r.headers["content-length"]) < PAGE_WEIGHT_BUDGET

    def test_index_page_is_under_the_budget(self):
        rows = [{"cui": 100000 + i, "name": "Firma %d SRL" % i,
                 "county": "Cluj", "caen": "1071"} for i in range(20)]
        html = render_index_page("ro", query="firma", results=rows)
        assert len(html.encode("utf-8")) < PAGE_WEIGHT_BUDGET


# ──────────────────────────────────────────────────────────────────────
# 9. EN / RO parity
# ──────────────────────────────────────────────────────────────────────

_LANDMARKS = {
    "kpi": r'<div class="kpi">',
    "ratio": r'<div class="rcard">',
    "locked": r'<div class="locked-card">',
    "flag": r"<li[^>]*>",
    "trend": r'<div class="tcard">',
    "position": r'<div class="row">',
    "section": r"<section",
}


class TestLanguageParity:
    def test_i18n_key_sets_match(self):
        assert set(STRINGS["ro"]) == set(STRINGS["en"])
        assert set(STRINGS) == set(LANGS)
        for key in STRINGS["ro"]:
            assert STRINGS["ro"][key].strip()
            assert STRINGS["en"][key].strip()

    def test_placeholder_sets_match_across_languages(self):
        ph = re.compile(r"\{(\w+)\}")
        for key in STRINGS["ro"]:
            assert set(ph.findall(STRINGS["ro"][key])) == \
                set(ph.findall(STRINGS["en"][key])), key

    def test_structural_landmark_counts_are_equal(self, flagged_model):
        ro = render_company_page(flagged_model, "ro")
        en = render_company_page(flagged_model, "en")
        for name, pattern in _LANDMARKS.items():
            assert len(re.findall(pattern, ro)) == \
                len(re.findall(pattern, en)) > 0, name

    def test_both_languages_carry_the_hreflang_pair(self, flagged_model):
        for lang in LANGS:
            html = render_company_page(flagged_model, lang)
            alts = dict(re.findall(
                r'<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">',
                html))
            assert alts == {
                "ro": "%s/companii/%d-delta-semnale-srl" % (BASE, CUI_FLAGS),
                "en": "%s/companies/%d-delta-semnale-srl" % (BASE, CUI_FLAGS),
                "x-default":
                    "%s/companii/%d-delta-semnale-srl" % (BASE, CUI_FLAGS),
            }

    def test_index_pages_carry_the_hreflang_pair(self):
        for lang in LANGS:
            html = render_index_page(lang)
            alts = dict(re.findall(
                r'<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">',
                html))
            assert alts == {"ro": BASE + "/companii",
                            "en": BASE + "/companies",
                            "x-default": BASE + "/companii"}

    def test_lang_attribute_and_copy_actually_switch(self, model):
        ro = render_company_page(model, "ro")
        en = render_company_page(model, "en")
        assert '<html lang="ro">' in ro and '<html lang="en">' in en
        assert STRINGS["ro"]["kpi_revenue"] in ro
        assert STRINGS["en"]["kpi_revenue"] in en
        assert STRINGS["en"]["sec_trends"] not in ro
        # RO uses the decimal comma / dot grouping, EN the anglo forms
        assert fmt_int(1_234_567, "ro") == "1.234.567"
        assert fmt_int(1_234_567, "en") == "1,234,567"
        assert fmt_pct(12.5, "ro") == "12,5%" and fmt_pct(12.5, "en") == "12.5%"
        assert fmt_compact_ron(140_000_000, "ro") == "140,0 mil. RON"
        assert fmt_compact_ron(140_000_000, "en") == "140.0 M RON"

    def test_router_serves_both_language_routes(self, client):
        for prefix in ("/companii", "/companies",
                       "/api/public/ro/companii", "/api/public/ro/companies"):
            r = client.get("%s/%d-alfa-prod-srl" % (prefix, CUI_OK),
                           headers=CANON)
            assert r.status_code == 200, prefix


# ──────────────────────────────────────────────────────────────────────
# 10. Search JSON + the no-JS index page
# ──────────────────────────────────────────────────────────────────────

class TestSearchAndIndex:
    def test_search_json_shape(self, client):
        r = client.get("/api/public/ro/search?q=Alfa", headers=CANON)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/json")
        body = r.json()
        assert set(body) == {"query", "count", "results"}
        assert body["query"] == "Alfa"
        assert body["count"] == len(body["results"]) == 1
        row = body["results"][0]
        assert set(row) == {"cui", "name", "county", "caen", "slug", "url"}
        assert row["cui"] == CUI_OK
        assert row["name"] == "Alfa Prod SRL"
        assert row["slug"] == "alfa-prod-srl"
        assert row["url"] == "%s/companii/%d-alfa-prod-srl" % (BASE, CUI_OK)

    def test_search_json_empty_query_and_no_match(self, client):
        for q in ("", "zzzz-nimic"):
            body = client.get("/api/public/ro/search?q=%s" % q,
                              headers=CANON).json()
            assert body["count"] == 0 and body["results"] == []

    def test_search_json_never_surfaces_unpublishable_companies(self, client):
        body = client.get("/api/public/ro/search?q=Ionescu",
                          headers=CANON).json()
        assert body["results"] == []
        by_cui = client.get("/api/public/ro/search?q=%d" % CUI_PRIVATE,
                            headers=CANON).json()
        assert by_cui["results"] == []

    def test_index_renders_a_no_js_get_form(self, client):
        r = client.get("/companii", headers=CANON)
        assert r.status_code == 200
        form = re.search(r"<form[^>]*>.*?</form>", r.text, re.S).group(0)
        assert 'method="get"' in form
        assert 'action="/companii"' in form
        assert 'name="q"' in form
        assert "<button type=\"submit\">" in form
        # the form must work with JS off: no handlers, no JS-only controls
        assert "onsubmit" not in form and "onclick" not in form
        assert "<script" not in form

    def test_index_results_link_to_company_pages(self, client):
        r = client.get("/companii?q=Alfa", headers=CANON)
        assert r.status_code == 200
        assert 'href="/companii/%d-alfa-prod-srl"' % CUI_OK in r.text
        assert "Alfa Prod SRL" in r.text
        assert STRINGS["ro"]["search_results_for"] in r.text

    def test_index_empty_state_renders(self, client):
        r = client.get("/companii?q=zzzz-nimic", headers=CANON)
        assert r.status_code == 200
        assert STRINGS["ro"]["search_empty"] in r.text
        assert '<ul class="results"' not in r.text

    def test_en_index_uses_the_en_action_and_copy(self, client):
        r = client.get("/companies?q=Alfa", headers=CANON)
        assert r.status_code == 200
        assert 'action="/companies"' in r.text
        assert 'href="/companies/%d-alfa-prod-srl"' % CUI_OK in r.text
        assert STRINGS["en"]["search_results_for"] in r.text

    def test_search_result_pages_are_noindex_but_the_bare_index_is_not(
            self, client):
        bare = client.get("/companii", headers=CANON).text
        queried = client.get("/companii?q=alfa", headers=CANON).text
        assert '<meta name="robots" content="noindex">' not in bare
        assert '<meta name="robots" content="noindex">' in queried

    def test_error_pages_are_noindex(self):
        for status in (404, 410):
            html = render_error_page(status, "ro")
            assert '<meta name="robots" content="noindex">' in html


# ──────────────────────────────────────────────────────────────────────
# Model plumbing the page depends on (thin but load-bearing)
# ──────────────────────────────────────────────────────────────────────

class TestModelPlumbing:
    def test_net_result_and_total_assets_derivations(self):
        assert net_result_of({"i18": 9, "i19": 0}) == 9
        assert net_result_of({"i18": 0, "i19": 4}) == -4
        assert net_result_of({"net_result": -7, "i18": 1, "i19": 0}) == -7
        assert net_result_of({}) is None
        assert total_assets_of({"i1": 1, "i2": 2, "i6": 3}) == 6
        assert total_assets_of({"total_assets": 99, "i1": 1}) == 99
        assert total_assets_of({}) is None

    def test_build_page_model_requires_a_filing(self):
        with pytest.raises(ValueError):
            build_page_model(COMPANY_OK, [])

    def test_model_uses_the_latest_year_and_a_five_year_window(self):
        m = build_page_model(COMPANY_OK, HEALTHY_FILINGS)
        assert m["year"] == 2024
        assert m["years"] == [2020, 2021, 2022, 2023, 2024]
        assert m["kpis"]["revenue"]["value"] == 140_000_000
        assert m["kpis"]["revenue"]["prior_year"] == 2023
        assert round(m["kpis"]["revenue"]["yoy_pct"], 4) == \
            round((140 - 130) / 130 * 100, 4)
        for trend in m["trends"]:
            assert len(trend["years"]) == 5

    def test_percentile_estimate_is_clamped_and_monotonic(self):
        dist = {"p10": 1.0, "p25": 5.0, "p50": 20.0, "p75": 100.0,
                "p90": 500.0}
        assert estimate_percentile(0.5, dist) == 3        # below p10 -> floor
        assert estimate_percentile(1000.0, dist) == 97    # above p90 -> cap
        assert estimate_percentile(20.0, dist) == 50
        mid = estimate_percentile(60.0, dist)
        assert 50 < mid < 75
        assert estimate_percentile(5.0, {"p50": 1.0}) is None   # < 2 anchors

    def test_sector_position_bars_render_from_stored_percentiles(self, client):
        r = _page(client)
        assert r.status_code == 200
        assert STRINGS["ro"]["sec_position"] in r.text
        bars = re.findall(r'<span class="pct">p(\d+)</span>', r.text)
        assert len(bars) == 3
        assert all(3 <= int(p) <= 97 for p in bars)

    def test_recomputed_percentiles_invalidate_the_cached_page(self, client,
                                                               store):
        """Regression, 2026-08-28: the page cache keyed on
        (cui, year, dataset_version, lang). Sector bars come from
        replace_percentiles, a job that reruns WITHOUT any filing's
        dataset_id changing — so a recomputed sector set could never
        reach an already-cached page, and the bars stayed stale
        indefinitely. The percentile epoch is now part of the key.
        """
        first = _page(client)
        assert first.status_code == 200
        before = re.findall(r'<span class="pct">p(\d+)</span>', first.text)
        assert len(before) == 3

        # Same filings, same dataset — only the sector distribution moves.
        # Shifting the sector far below the company must move its bars.
        store.replace_percentiles(2024, [
            {"metric": "revenue", "caen2": "10", "p10": 1.0, "p25": 2.0,
             "p50": 3.0, "p75": 4.0, "p90": 5.0, "n": 812},
            {"metric": "net_result", "caen2": "10", "p10": -10.0, "p25": -5.0,
             "p50": -1.0, "p75": 0.0, "p90": 1.0, "n": 812},
            {"metric": "employees", "caen2": "10", "p10": 1, "p25": 2,
             "p50": 3, "p75": 4, "p90": 5, "n": 812},
        ])

        after = _page(client)
        assert after.status_code == 200
        bars = re.findall(r'<span class="pct">p(\d+)</span>', after.text)
        assert len(bars) == 3
        assert bars != before, "cached page survived a percentile recompute"

    def test_overlong_query_renders_html_not_a_json_422(self, client):
        """Regression, 2026-08-28: ?q= carried max_length=80, so FastAPI
        answered an over-long query with a JSON 422 body on an HTML
        surface. The index truncates instead."""
        r = client.get("/companii", params={"q": "a" * 5000}, headers=CANON)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")

    def test_signup_cta_carries_the_attribution_params(self, model):
        url = signup_url(CUI_OK)
        assert url.startswith(BASE + "/signup?")
        assert "utm_source=public_company" in url
        assert "utm_campaign=storefront" in url
        assert "ft_cui=%d" % CUI_OK in url
        assert url in render_company_page(model, "ro").replace("&amp;", "&")

    def test_accountant_cta_points_at_a_real_destination(self, model, client):
        """Regression, 2026-08-28: the secondary CTA linked to
        /api/public/ro/funnel/teardown/{cui}, which nothing mounts — a
        dead link on the conversion page. A teardown is never
        auto-published (it stays a human act), so the CTA sends
        accountants to signup under their own campaign instead."""
        html = render_company_page(model, "ro").replace("&amp;", "&")
        assert "funnel/teardown" not in html
        url = accountant_url(CUI_OK)
        assert "utm_campaign=accountant" in url
        assert url in html
        # /signup is an SPA route (frontend/App.tsx), not a backend one —
        # assert it against the router that actually owns it, so a
        # frontend rename can't quietly re-break this CTA.
        app_tsx = (REPO / "frontend" / "App.tsx").read_text(encoding="utf-8")
        assert 'path="/signup"' in app_tsx

    @pytest.mark.parametrize("lang", LANGS)
    def test_footer_carries_source_attribution(self, model, lang):
        html = render_company_page(model, lang)
        footer = re.search(r"<footer>(.*?)</footer>", html, re.S).group(1)
        assert "Licen" in footer                  # license line present
        assert STRINGS[lang]["footer_takedown"] in footer
        assert STRINGS[lang]["footer_generated"] in footer
        assert "mailto:" in footer
