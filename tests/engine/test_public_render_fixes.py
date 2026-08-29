"""Public RO page-render defects: false claims the renderer could make.

Three independently-reproduced defects, each of which put a statement on
a public page about a REAL named company that the open data does not
support:

  1. the multi-year trend card labelled a neighbouring year's value with
     a year that reported nothing (PS1 — a false factual claim);
  2. the footer asserted the SOURCE-level licence (CC-BY-4.0) for every
     page, including pages built entirely from uk-ogl filings;
  3. ``estimate_percentile`` published "bottom decile of its sector" for
     a company that ties every anchor of its distribution (the sole
     filer in a CAEN division places itself).

Every test here failed against the pre-fix renderer for the reason named
in its docstring.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

import pytest

from engine.public_ro import compliance
from engine.public_ro.pages.i18n import STRINGS
from engine.public_ro.pages.model import build_page_model, estimate_percentile
from engine.public_ro.pages.templates import (
    render_company_page,
    render_error_page,
    render_index_page,
)

COMPANY = {
    "cui": 12345678,
    "name": "Alfa Prod SRL",
    "county": "Cluj",
    "locality": "Cluj-Napoca",
    "caen": "1071",
    "sector_label": None,
    "name_source": "mfinante_datagov_identificare",
}

#: Registry name of the bilanț source, used to isolate ITS footer line
#: from the identification-snapshot line (which is genuinely CC-BY-4.0).
BILANT_SOURCE_NAME = compliance.get_source("mfinante_datagov").name


def _filing(
    year: int,
    *,
    revenue: Optional[int] = None,
    net: Optional[int] = None,
    employees: Optional[int] = None,
    provenance: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One filings row shaped like ``store.get_filings`` output."""
    row: Dict[str, Any] = {
        "year": year,
        "caen": "1071",
        "i13": revenue,
        "i10": 50_000_000,
        "i7": 20_000_000,
        "i20": employees,
        "i18": net if (net or 0) > 0 else 0,
        "i19": -net if (net or 0) < 0 else 0,
        "net_result": net,
    }
    if provenance is not None:
        row["provenance"] = provenance
    return row


def _rng_of(html: str, label: str) -> str:
    """The range caption of the trend card carrying ``label``."""
    m = re.search(
        r'<div class="tcard"><span class="lbl">%s</span>.*?'
        r'<div class="rng">(.*?)</div>' % re.escape(label),
        html,
        re.S,
    )
    assert m is not None, "no trend card labelled %r" % label
    return m.group(1)


def _footer_of(html: str) -> str:
    m = re.search(r"<footer>(.*?)</footer>", html, re.S)
    assert m is not None, "page has no footer"
    return m.group(1)


def _bilant_license_lines(html: str) -> List[str]:
    """Footer paragraphs attributing the bilanț source."""
    return [
        p
        for p in re.findall(r"<p>(.*?)</p>", _footer_of(html), re.S)
        if BILANT_SOURCE_NAME in p
    ]


# ──────────────────────────────────────────────────────────────────
# DEFECT 1 — the trend card mislabelled a value with another year
# ──────────────────────────────────────────────────────────────────


class TestTrendEndpointsPairWithTheirOwnFiling:
    def test_last_reported_value_is_not_relabelled_to_a_silent_year(self):
        """PS1. Filings 2020-2024 where the 2024 filing leaves i13 empty:
        the page must not publish 2023's revenue under a 2024 label."""
        filings = [
            _filing(2020, revenue=100_000_000),
            _filing(2021, revenue=110_000_000),
            _filing(2022, revenue=120_000_000),
            _filing(2023, revenue=130_000_000),
            _filing(2024, revenue=None),
        ]
        model = build_page_model(COMPANY, filings)
        html = render_company_page(model, "ro")
        rng = _rng_of(html, STRINGS["ro"]["kpi_revenue"])

        assert "130,0 mil. RON" in rng          # the value IS reported…
        assert rng.startswith("2020:")
        assert "2024" not in rng                # …but 2023 reported it
        assert "2023: 130,0 mil. RON" in rng

    def test_same_document_cannot_say_dash_and_a_number_for_one_year(self):
        """The KPI card renders "—" for 2024 revenue. A trend caption
        ending "2024: <number>" contradicts it inside one document."""
        filings = [
            _filing(2020, revenue=100_000_000),
            _filing(2024, revenue=None),
        ]
        model = build_page_model(COMPANY, filings)
        assert model["kpis"]["revenue"]["value"] is None
        html = render_company_page(model, "ro")
        rng = _rng_of(html, STRINGS["ro"]["kpi_revenue"])
        assert not re.search(r"2024:\s*[\d—]*\d", rng)

    def test_first_reported_value_is_not_relabelled_either(self):
        """Same defect shape at the earliest end of the window."""
        filings = [
            _filing(2020, revenue=None),
            _filing(2021, revenue=110_000_000),
            _filing(2022, revenue=120_000_000),
        ]
        model = build_page_model(COMPANY, filings)
        rng = _rng_of(render_company_page(model, "ro"),
                      STRINGS["ro"]["kpi_revenue"])
        assert rng.startswith("2021: 110,0 mil. RON")
        assert "2020" not in rng

    def test_a_single_reported_year_is_not_dressed_up_as_a_range(self):
        """One reported point is one point: an arrow between a year and
        itself claims a trend that was never filed."""
        filings = [
            _filing(2020, revenue=None),
            _filing(2021, revenue=None),
            _filing(2022, revenue=120_000_000),
        ]
        model = build_page_model(COMPANY, filings)
        rng = _rng_of(render_company_page(model, "ro"),
                      STRINGS["ro"]["kpi_revenue"])
        assert rng == "2022: 120,0 mil. RON"
        assert "→" not in rng

    def test_model_carries_the_paired_endpoints_not_two_loose_lists(self):
        """The renderer must not be able to index years and values
        independently — the model hands it (year, value) pairs."""
        filings = [
            _filing(2020, revenue=100_000_000),
            _filing(2024, revenue=None),
        ]
        model = build_page_model(COMPANY, filings)
        trend = next(t for t in model["trends"] if t["key"] == "revenue")
        assert trend["first_reported"] == {"year": 2020, "value": 100_000_000}
        assert trend["last_reported"] == {"year": 2020, "value": 100_000_000}

    def test_employees_trend_uses_its_own_reported_year(self):
        """The employees card formats differently (plain int) and had the
        same mispairing."""
        filings = [
            _filing(2022, revenue=1_000_000, employees=40),
            _filing(2023, revenue=1_000_000, employees=44),
            _filing(2024, revenue=1_000_000, employees=None),
        ]
        model = build_page_model(COMPANY, filings)
        rng = _rng_of(render_company_page(model, "ro"),
                      STRINGS["ro"]["kpi_employees"])
        assert rng == "2022: 40 → 2023: 44"


# ──────────────────────────────────────────────────────────────────
# DEFECT 2 — the footer asserted a licence the data does not carry
# ──────────────────────────────────────────────────────────────────


def _uk_ogl_filings() -> List[Dict[str, Any]]:
    return [
        _filing(
            year,
            revenue=100_000_000,
            provenance={
                "source": "data.gov.ro/mfp",
                "dataset_id": "%d_UU_aaaaaaaaaaaa" % year,
                "license_id": "uk-ogl",
                "source_url": (
                    "https://data.gov.ro/dataset/situatii_financiare_%d" % year
                ),
            },
        )
        for year in (2015, 2016)
    ]


class TestFooterRendersTheLicenceOfTheDataOnThePage:
    def test_uk_ogl_filings_are_not_published_as_cc_by(self):
        """FY2015 is uk-ogl and ingestable by default; the footer used to
        state CC-BY-4.0 for it because it read the SOURCE registry."""
        model = build_page_model(COMPANY, _uk_ogl_filings())
        lines = _bilant_license_lines(render_company_page(model, "ro"))
        assert lines, "bilanț source lost its footer attribution"
        joined = " ".join(lines)
        assert "uk-ogl" in joined
        assert "CC-BY-4.0" not in joined

    def test_licence_falls_back_to_the_dataset_registry_by_slug(self):
        """A filing whose stored dataset row predates the licence column
        still resolves through compliance.dataset_license(slug)."""
        filings = [
            _filing(
                2015,
                revenue=100_000_000,
                provenance={
                    "dataset_id": "2015_UU_aaaaaaaaaaaa",
                    "license_id": None,
                    "source_url": (
                        "https://data.gov.ro/dataset/situatii_financiare_2015"
                    ),
                },
            )
        ]
        model = build_page_model(COMPANY, filings)
        joined = " ".join(_bilant_license_lines(render_company_page(model, "ro")))
        assert "uk-ogl" in joined
        assert "CC-BY-4.0" not in joined

    def test_a_page_mixing_licences_states_both_with_their_years(self):
        filings = _uk_ogl_filings() + [
            _filing(
                2020,
                revenue=100_000_000,
                provenance={
                    "dataset_id": "2020_UU_bbbbbbbbbbbb",
                    "license_id": "CC-BY-4.0",
                    "source_url": (
                        "https://data.gov.ro/dataset/situatii_financiare_2020"
                    ),
                },
            )
        ]
        model = build_page_model(COMPANY, filings)
        joined = " ".join(_bilant_license_lines(render_company_page(model, "ro")))
        assert "uk-ogl" in joined and "CC-BY-4.0" in joined
        assert "2015" in joined and "2020" in joined

    def test_unknown_licence_is_disclosed_never_upgraded_to_cc_by(self):
        """ABSENT != CC-BY-4.0. With no licence evidence at all the page
        must say so rather than inherit the source-level claim."""
        model = build_page_model(COMPANY, [_filing(2021, revenue=1_000_000)])
        joined = " ".join(_bilant_license_lines(render_company_page(model, "ro")))
        assert "CC-BY-4.0" not in joined
        assert "Licen" in joined  # the licence is named as unasserted

    def test_cc_by_filings_still_state_cc_by(self):
        """The fix must not refuse the licence that IS asserted."""
        filings = [
            _filing(
                2022,
                revenue=100_000_000,
                provenance={
                    "dataset_id": "2022_UU_cccccccccccc",
                    "license_id": "cc-by-4.0",  # ingest lowercases it
                    "source_url": (
                        "https://data.gov.ro/dataset/situatii_financiare_2022"
                    ),
                },
            )
        ]
        model = build_page_model(COMPANY, filings)
        joined = " ".join(_bilant_license_lines(render_company_page(model, "ro")))
        assert "CC-BY-4.0" in joined
        assert compliance.LICENSE_URLS["CC-BY-4.0"] in joined

    @pytest.mark.parametrize("lang", ["ro", "en"])
    def test_index_and_error_pages_assert_no_per_dataset_licence(self, lang):
        """These pages carry no filing provenance, so they cannot name a
        dataset licence — and must not guess one."""
        for html in (render_index_page(lang), render_error_page(404, lang)):
            joined = " ".join(_bilant_license_lines(html))
            assert joined, "source attribution disappeared"
            assert "CC-BY-4.0" not in joined

    def test_footer_still_carries_attribution_and_takedown(self):
        """Regression guard on the existing footer contract."""
        model = build_page_model(COMPANY, _uk_ogl_filings())
        footer = _footer_of(render_company_page(model, "ro"))
        assert BILANT_SOURCE_NAME in footer
        assert STRINGS["ro"]["footer_takedown"] in footer
        assert "mailto:" in footer

    def test_render_is_deterministic_with_mixed_licences(self):
        filings = _uk_ogl_filings() + [
            _filing(
                2020,
                revenue=100_000_000,
                provenance={"license_id": "CC-BY-4.0"},
            )
        ]
        model = build_page_model(COMPANY, filings)
        assert (render_company_page(model, "ro")
                == render_company_page(model, "ro"))


# ──────────────────────────────────────────────────────────────────
# DEFECT 3 — a tie against every anchor was published as p10
# ──────────────────────────────────────────────────────────────────


class TestPercentileRefusesADegenerateDistribution:
    def test_sole_filer_is_not_placed_in_the_bottom_decile(self):
        dist = {"p10": 42.0, "p25": 42.0, "p50": 42.0, "p75": 42.0,
                "p90": 42.0, "n": 1}
        assert estimate_percentile(42.0, dist) is None

    def test_tie_against_every_anchor_refuses_even_without_n(self):
        dist = {"p10": 0.0, "p25": 0.0, "p50": 0.0, "p75": 0.0, "p90": 0.0}
        assert estimate_percentile(0.0, dist) is None

    def test_single_member_distribution_refuses_whatever_its_anchors_say(self):
        dist = {"p10": 1.0, "p25": 5.0, "p50": 20.0, "p75": 100.0,
                "p90": 500.0, "n": 1}
        assert estimate_percentile(20.0, dist) is None

    def test_the_bar_does_not_render_for_the_sole_filer(self):
        filings = [_filing(2024, revenue=42, net=7, employees=3)]
        model = build_page_model(
            COMPANY,
            filings,
            percentiles={
                "revenue": {"p10": 42.0, "p25": 42.0, "p50": 42.0,
                            "p75": 42.0, "p90": 42.0, "n": 1},
            },
        )
        assert model["position"] == []
        html = render_company_page(model, "ro")
        assert not re.findall(r'<span class="pct">p(\d+)</span>', html)

    def test_a_real_distribution_still_places_the_company(self):
        """Regression guard — the refusal must be narrow."""
        dist = {"p10": 1.0, "p25": 5.0, "p50": 20.0, "p75": 100.0,
                "p90": 500.0, "n": 812}
        assert estimate_percentile(0.5, dist) == 3
        assert estimate_percentile(1000.0, dist) == 97
        assert estimate_percentile(20.0, dist) == 50
        assert estimate_percentile(1.0, dist) == 10   # ties the LOWEST only
        assert estimate_percentile(500.0, dist) == 90
        assert 50 < estimate_percentile(60.0, dist) < 75

    def test_a_tie_at_one_end_of_a_flat_tail_is_still_placeable(self):
        """Many filers reporting the same floor value is not degenerate
        as long as the distribution has spread somewhere."""
        dist = {"p10": 0.0, "p25": 0.0, "p50": 0.0, "p75": 10.0,
                "p90": 90.0, "n": 400}
        assert estimate_percentile(90.0, dist) == 90
        assert estimate_percentile(200.0, dist) == 97
