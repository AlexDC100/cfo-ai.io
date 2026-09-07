"""G5 (engine half) — the structural industry signal, on all four books.

THE DEFECT. `organizations.industry_key` is a user setting and nothing
checked it against the book. The Agras Dec-2025 report shipped headed
"Real estate · residential rental" over a trial balance carrying 301 raw
materials, 341/345 own-produced stock, 371 merchandise and 70.5M of cost
of sales.

WHAT THIS GATE REDS ON, after the repair:
  · a family score that moves on any of the four real books without the
    per-marker expectation moving with it (TC-6 — the assertions are
    per-marker, not just "agras is manufacturing");
  · a reading that stops naming its accounts, or names a balance that
    does not reproduce the share it printed;
  · a book with too little measurable evidence being GRADED instead of
    refused, or an ambiguous mix being called;
  · a marker scored as "did not fire" when its basis was not measurable
    at all (absent read as zero);
  · the agreement verdict flipping for any (book, workspace) pair;
  · the committed `industry_signal.json` going stale, which would let
    the frontend gate pass over a payload the engine no longer serves.

WHAT IT CANNOT SEE (TC-11): whether the FAMILY is the right one for a
book nobody has classified by hand — the four books' ground truth comes
from the coordinator, not from the data. It cannot see sub-sector at all
(the module refuses to answer that), it does not run the HTTP route, and
it says nothing about what the report RENDERS — that is
`frontend/pages/cfo/__tests__/industryBlock.test.tsx`.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"

sys.path.insert(0, str(REPO / "src"))

from engine.industry import (  # noqa: E402
    build_industry_signal,
    industry_agreement,
    structural_signal,
    workspace_families,
)

BOOKS = ("agras", "carniprod", "realestate", "retail")


def _book(name: str) -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def _signal_for(name: str) -> Dict[str, Any]:
    """The same call `GET /api/period/{id}` makes — bases from the line
    items, so every printed share is reproducible from the accounts the
    evidence names, and the read stays inside the import boundary
    (E-ASSEMBLED-TOTAL)."""
    return structural_signal(_book(name)["line_items"])


@pytest.mark.parametrize("book", BOOKS)
def test_the_line_item_bases_equal_the_served_totals_to_the_cent(book: str) -> None:
    """The substitution above is only safe while these agree. It is
    asserted rather than assumed: a mapping change that moved an account
    out of the asset buckets would silently rescale every asset share."""
    fx = _book(book)
    st = fx["statements"]
    sig = structural_signal(fx["line_items"])
    assert sig["bases"]["assets"]["value"] == pytest.approx(
        (st.get("assembled_bs") or {})["total_assets"], abs=0.01
    )
    assert sig["bases"]["revenue"]["value"] == pytest.approx(
        (st.get("assembled_pl") or {})["revenue"], abs=0.01
    )


# ── What the four books read as, measured ─────────────────────────────
# Ground truth per the coordinator: agras and carniprod are food
# manufacturers, retail is trade, realestate is property. The module
# answers at FAMILY level, which is all the account codes carry.
EXPECTED = {
    "agras":      {"family": "manufacturing", "score": 1.0000, "runner_up": ("trade", 0.1250)},
    "carniprod":  {"family": "manufacturing", "score": 1.0000, "runner_up": ("real_estate", 0.1250)},
    "retail":     {"family": "trade",         "score": 1.0000, "runner_up": ("manufacturing", 0.0000)},
    "realestate": {"family": "real_estate",   "score": 0.6250, "runner_up": ("services", 0.2000)},
}

# TC-6 — the markers that must FIRE for the leading family on each book.
# A family score is only as good as the observations under it; asserting
# the score alone would let two markers swap and stay green.
EXPECTED_MARKERS = {
    "agras": {"own_production_revenue", "production_stock", "material_cost", "raw_material_stock"},
    "carniprod": {"own_production_revenue", "production_stock", "material_cost", "raw_material_stock"},
    "retail": {"merchandise_revenue", "merchandise_cost", "merchandise_stock", "no_production_stock"},
    "realestate": {"rent_revenue", "land_and_buildings_dominate", "no_cost_of_sales"},
}


@pytest.mark.parametrize("book", BOOKS)
def test_each_book_reads_as_its_family_with_the_expected_margin(book: str) -> None:
    sig = _signal_for(book)
    want = EXPECTED[book]
    assert sig["verdict"] == "decided", sig["undetermined_because"]
    assert sig["family"] == want["family"]
    assert sig["score"] == pytest.approx(want["score"], abs=5e-4)
    runner = sig["candidates"][1]
    assert (runner["family"], runner["score"]) == (
        want["runner_up"][0],
        pytest.approx(want["runner_up"][1], abs=5e-4),
    )
    assert sig["margin"] >= sig["thresholds"]["min_margin"]


@pytest.mark.parametrize("book", BOOKS)
def test_the_leading_family_fires_exactly_the_expected_markers(book: str) -> None:
    sig = _signal_for(book)
    lead = sig["candidates"][0]
    fired = {m["key"] for m in lead["markers"] if m["fired"]}
    assert fired == EXPECTED_MARKERS[book]


@pytest.mark.parametrize("book", BOOKS)
def test_every_fired_marker_names_accounts_whose_balances_reproduce_its_share(book: str) -> None:
    """A signal a reader cannot audit is not evidence.

    Each fired marker must print the accounts it summed, and the shown
    balances must add back to the amount whose share it stated.
    """
    sig = _signal_for(book)
    for cand in sig["candidates"]:
        for m in cand["markers"]:
            if not m["fired"]:
                continue
            # "Absence" markers legitimately have no accounts to name —
            # that is the observation. Everything else must name them.
            if m["amount"] != 0:
                assert m["accounts"], (book, m["key"])
                assert sum(a["amount"] for a in m["accounts"]) == pytest.approx(
                    m["amount"], abs=0.02
                ), (book, m["key"])
            assert m["basis_amount"] > 0
            assert m["share"] == pytest.approx(m["amount"] / m["basis_amount"], abs=1e-6)
            assert m["basis_source"], (book, m["key"])
            assert m["reads"], (book, m["key"])


def test_agras_names_the_accounts_the_owner_read_off_the_book() -> None:
    """The specific reading behind the Agras banner, spelled out."""
    sig = _signal_for("agras")
    lead = sig["candidates"][0]
    by_key = {m["key"]: m for m in lead["markers"]}
    codes = set()
    for m in lead["markers"]:
        if m["fired"]:
            codes.update(a["code"] for a in m["accounts"])
    # The accounts the owner cited as proof the header was wrong.
    assert {"301", "341", "345"} <= codes
    assert by_key["own_production_revenue"]["share"] == pytest.approx(0.6689, abs=5e-4)
    assert by_key["material_cost"]["share"] == pytest.approx(0.3797, abs=5e-4)


# ── "Cannot tell" is an answer this module is able to give ────────────

THIN_BOOKS = ("synthetic_negative_equity", "synthetic_thin_equity", "imbalance_03pct")


@pytest.mark.parametrize("name", THIN_BOOKS)
def test_a_book_with_too_little_evidence_is_refused_not_graded(name: str) -> None:
    fx = json.loads((FIRM / ("%s.json" % name)).read_text())
    sig = structural_signal(fx.get("line_items") or [])
    assert sig["verdict"] == "undetermined"
    assert sig["family"] is None
    assert sig["undetermined_because"], "a refusal must say what it lacked"


def test_an_empty_book_is_refused_and_says_all_three_reasons() -> None:
    sig = structural_signal([])
    assert sig["verdict"] == "undetermined"
    assert len(sig["undetermined_because"]) == 3


def test_an_ambiguous_producer_distributor_is_refused_on_margin() -> None:
    """Derived from the REAL Agras book, not invented from nothing.

    Own-production sales are moved down to 31% of revenue and
    merchandise up to 62%, with the merchandise cost following — a
    manufacturer that also distributes at scale. Manufacturing still
    scores 1.000 on its own markers, trade reaches 0.875, and the two
    are inside the 0.15 margin, so the module refuses rather than
    picking the winner by a rounding.
    """
    fx = _book("agras")
    items: List[Dict[str, Any]] = copy.deepcopy(fx["line_items"])
    revenue = (fx["statements"]["assembled_pl"] or {})["revenue"]
    other_rev = sum(
        it["amount"] for it in items
        if it["statement"] == "PL"
        and str(it["ro_account_code"]).startswith("70")
        and not str(it["ro_account_code"]).startswith(("701", "707"))
    )
    target_701 = 0.31 * revenue
    target_707 = revenue - target_701 - other_rev
    target_607 = 0.56 * revenue
    for group, target in (("701", target_701), ("707", target_707), ("607", target_607)):
        current = sum(it["amount"] for it in items if str(it["ro_account_code"]).startswith(group))
        factor = target / current
        for it in items:
            if str(it["ro_account_code"]).startswith(group):
                it["amount"] *= factor

    sig = structural_signal(items, revenue=revenue)
    scores = {c["family"]: c["score"] for c in sig["candidates"]}
    assert scores["manufacturing"] == pytest.approx(1.0, abs=5e-4)
    assert scores["trade"] == pytest.approx(0.875, abs=5e-4)
    assert sig["verdict"] == "undetermined"
    assert any("within" in r for r in sig["undetermined_because"])
    assert sig["family"] is None


def test_an_unmeasurable_basis_is_absent_not_a_failed_marker() -> None:
    """ABSENT != ZERO, applied to the denominator.

    A book with no revenue must not be graded as if every
    share-of-revenue marker had been evaluated and missed.
    """
    fx = _book("agras")
    items = [it for it in fx["line_items"] if it["statement"] != "PL"]
    sig = structural_signal(items, revenue=0)
    revenue_markers = [
        m for c in sig["candidates"] for m in c["markers"] if m["basis"] == "revenue"
    ]
    assert revenue_markers
    for m in revenue_markers:
        assert m["available"] is False
        assert m["share"] is None
        assert "Not measurable" in m["statement"]
    for c in sig["candidates"]:
        assert c["available_weight"] < c["max_weight"]


# ── The comparison with the workspace setting ─────────────────────────

def test_the_family_map_covers_every_catalog_key_the_ui_offers() -> None:
    """`ORG_INDUSTRIES` in `frontend/components/cfo/OrgIndustryPills.tsx`
    is the catalog a user picks from. A key the map does not know cannot
    be checked, and the report must say so rather than block silently."""
    catalog = (REPO / "frontend" / "components" / "cfo" / "OrgIndustryPills.tsx").read_text()
    keys = set()
    for line in catalog.splitlines():
        if line.strip().startswith("{ key: \""):
            keys.add(line.split("\"")[1])
    assert keys, "could not read the catalog"
    unknown = {k for k in keys if not _key_is_known(k)}
    assert unknown == set(), "workspace keys with no family mapping: %s" % sorted(unknown)


def _key_is_known(key: str) -> bool:
    from engine.industry.structural_signal import _KEY_FAMILIES

    return key in _KEY_FAMILIES


def test_other_names_no_sector_so_it_can_never_be_contradicted() -> None:
    assert workspace_families("other") == frozenset()
    sig = _signal_for("agras")
    verdict = industry_agreement(sig, "other", "Other")
    assert verdict["agreement"] == "unspecified"
    assert verdict["block_sector_content"] is False


def test_a_key_outside_the_catalog_is_unverifiable_not_a_disagreement() -> None:
    sig = _signal_for("agras")
    verdict = industry_agreement(sig, "shipbuilding", "Shipbuilding")
    assert verdict["agreement"] == "unverifiable"
    assert verdict["block_sector_content"] is False
    assert "not in the catalog" in verdict["reason"]


def test_an_undetermined_reading_never_blocks() -> None:
    """The setting stands when the account mix cannot second it. The
    report then shows no prompt — asserted on the frontend side too."""
    sig = structural_signal([])
    verdict = industry_agreement(sig, "real_estate_residential", "Real estate · residential rental")
    assert sig["verdict"] == "undetermined"
    assert verdict["agreement"] == "unverifiable"
    assert verdict["block_sector_content"] is False


# The pair the whole wave exists for, plus its non-vacuity twin.
AGREEMENT_MATRIX = [
    ("agras", "real_estate_residential", "disagree", True),
    ("agras", "manufacturing", "agree", False),
    ("agras", "fmcg", "agree", False),
    ("carniprod", "real_estate_residential", "disagree", True),
    ("carniprod", "manufacturing", "agree", False),
    ("retail", "real_estate_residential", "disagree", True),
    ("retail", "retail_ecom", "agree", False),
    ("retail", "manufacturing", "disagree", True),
    ("realestate", "manufacturing", "disagree", True),
    ("realestate", "real_estate_residential", "agree", False),
    ("realestate", "real_estate", "agree", False),
]


@pytest.mark.parametrize("book,key,agreement,blocks", AGREEMENT_MATRIX)
def test_the_agreement_verdict(book: str, key: str, agreement: str, blocks: bool) -> None:
    sig = _signal_for(book)
    verdict = industry_agreement(sig, key, key)
    assert verdict["agreement"] == agreement, verdict["reason"]
    assert verdict["block_sector_content"] is blocks


def test_the_disagreement_reason_names_both_sectors() -> None:
    fx = _book("agras")
    block = build_industry_signal(
        fx["line_items"],
        industry_key="real_estate_residential",
        industry_display="Real estate · residential rental",
    )
    assert block["block_sector_content"] is True
    assert "Manufacturing / production" in block["reason"]
    assert "Real estate · residential rental" in block["reason"]


def test_the_module_refuses_to_answer_sub_sector() -> None:
    """`real_estate` and `real_estate_residential` are the SAME family:
    a reader must never be asked to confirm a distinction the account
    codes cannot see."""
    assert workspace_families("real_estate") == workspace_families("real_estate_residential")
    sig = _signal_for("realestate")
    assert sig["resolves_to"] == "family"
    assert "sub-sector" in sig["cannot_resolve"].lower()


# ── The fixture the frontend gate renders over ────────────────────────

def test_the_served_signal_fixture_matches_the_live_module() -> None:
    """A stale capture would let G5 pass over a payload production never
    serves — the same failure mode `served_metrics.json` has a check for."""
    out = subprocess.run(
        [sys.executable, str(FIRM / "capture_industry_signal.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )
    assert out.returncode == 0, out.stdout + out.stderr
