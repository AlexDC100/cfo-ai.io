"""forecast-sector-rung (forecast-scenarios-live): revenue growth reads the
book, then the SECTOR, then the macro anchor — never a silent 0%.

The ladder (contract 3.4): [book] the company's own two turnovers when a
comparable prior year is loaded in the workspace; else [sector] the median
net-turnover growth of the company's CAEN class and size band from the ONE
committed sector dataset (engine.benchmarks_ro: Ministry of Finance filings on
data.gov.ro, CC-BY-4.0, with source, year and n); else [macro] the ro_macro
inflation anchor with its source and date; else the convention rung.

Through the REAL create_app over the tenancy double; the workspace CAEN is
the organizations.caen_code the one authority (_org.caen_for_org) reads.

RED ON (TC-11): a one-year book with a CAEN the dataset carries not standing
on tier sector; its value not the dataset's own median for the company's
class and size band; the sector evidence missing a contract 3.3 field, its n
below levers.yaml#sector.min_n, or pins.sector_snapshot_id not the dataset's
content digest; a CAEN the dataset does not carry, or no CAEN, not falling to
macro with the sector rung's reason stated; a median below the lane's floor
being used; a book WITH a comparable prior leaving the book rung, or not
being OFFERED the sector median as alternatives.sector; a sector pedigree
whose served value is not its evidence median.

CANNOT SEE: whether the sector median is a good forecast (it is the filings'
arithmetic, stated as such); sectors outside the dataset (CAEN 10, 1011,
1013 today).
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000f5c1"
ORG = "0c0f0000-0000-4000-8000-00000000f5c1"
CONTRACT_SECTOR_FIELDS = ("source_id", "source_url", "statistic", "p25", "p50", "p75",
                          "n", "period_year", "caen_level_used", "size_band_used",
                          "method", "computed_at")
WORK = {"units": 0}


def _dataset_median(caen: str, revenue_cents: int) -> Tuple[int, int]:
    """(median micros, n) straight from the committed dataset, by its own
    lookup — the figure the rung must serve, read independently of it."""
    from decimal import Decimal
    from engine.benchmarks_ro import dataset
    row = dataset.lookup(caen, revenue_cents // 100)["rows"]["revenue_growth"]
    return int(Decimal(str(row["median"])) * 1000000), row["n"]


def _forecast(caen: Optional[str], prior: bool = False) -> Dict[str, Any]:
    from engine.api import _forecast_history
    org = {"id": ORG, "name": "Sector Co", "default_currency": "RON"}
    if caen:
        org["caen_code"] = caen
    periods = [(SB.book("agras"), "s-cur", ORG, "2025-01-01", "2025-12-31")]
    if prior:
        # The carniprod corpus book, dated one year back IN THE SAME
        # workspace: a comparable prior (same year end, one year back). A
        # SYNTHETIC pairing, labelled: two different companies' books.
        periods.append((SB.book("carniprod"), "s-pri", ORG, "2024-01-01", "2024-12-31"))
    double = RA.seed_double(
        orgs=[org], memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                                  "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=periods)
    _forecast_history.clear_cache()
    try:
        with RA.installed(double):
            client = TestClient(RA.build_app(), raise_server_exceptions=False)
            r = client.get("/api/forecast/s-cur?horizon=5",
                           headers={"Authorization": "Bearer " + D.mint_jwt(USER),
                                    "X-Org-Id": ORG})
    finally:
        _forecast_history.clear_cache()
    assert r.status_code == 200, r.text[:400]
    return r.json()


def _growth(body: Dict[str, Any]) -> Dict[str, Any]:
    return body["drivers"]["revenue_growth"]


def _revenue(body: Dict[str, Any], label: str = "FY2026") -> int:
    return [f for f in body["figures"] if f["line"] == "pl.revenue" and f["period"] == label][0][
        "amount_minor"]


def test_a_one_year_book_with_a_known_sector_grows_at_the_sector_median():
    from engine.forecast.levers_pack import sector_pack
    from engine.forecast.sector import dataset_snapshot_id
    body = _forecast("1011")
    growth = _growth(body)
    basis = growth["basis"]
    revenue = SB.book("agras").persist_assembled["statements"]["assembled_pl"]["revenue"]
    median, n = _dataset_median("1011", int(round(revenue * 100)))
    assert basis["tier"] == "sector", (basis["tier"], basis["sentence"])
    assert growth["values"] == [median] * 5, (growth["values"], median)
    evidence = basis["sector"]
    missing = [f for f in CONTRACT_SECTOR_FIELDS if f not in evidence]
    assert not missing, missing
    assert evidence["p50"] == median and evidence["n"] == n >= sector_pack().min_n
    assert evidence["caen"] == "1011" and evidence["source"], evidence
    assert [(s["tier"], s["outcome"]) for s in basis["fallback_steps"]] == [("book", "absent")]
    assert body["pins"]["sector_snapshot_id"] == dataset_snapshot_id()
    assert growth["alternatives"]["sector"]["values"] == [median] * 5
    assert "%d filers" % n in basis["sentence"]["text"], basis["sentence"]["text"]
    macro = _forecast(None)
    assert _growth(macro)["basis"]["tier"] == "macro"
    assert (_revenue(body) > _revenue(macro)) == (median > _growth(macro)["values"][0]), (
        "the sector growth did not reach the revenue line")
    print("sector rung: agras CAEN 1011 %s -> %d micros over n=%d; FY2026 revenue %d (macro %d)"
          % (evidence["size_band_used"], median, n, _revenue(body), _revenue(macro)))
    WORK["units"] += len(CONTRACT_SECTOR_FIELDS) + 6


@pytest.mark.parametrize("caen,reason", (
    (None, "no CAEN code"),
    ("4711", "not in the sourced sector dataset"),
))
def test_no_sector_figure_falls_to_macro_and_says_why(caen, reason):
    body = _forecast(caen)
    basis = _growth(body)["basis"]
    assert basis["tier"] == "macro", basis["tier"]
    steps = dict((s["tier"], s["reason"]["text"]) for s in basis["fallback_steps"])
    assert reason in steps.get("sector", ""), steps
    assert basis["sector"] is None and _growth(body)["alternatives"]["sector"] is None
    assert body["pins"]["sector_snapshot_id"] is None
    WORK["units"] += 4


def test_a_median_below_the_lanes_floor_is_not_used(monkeypatch):
    from engine.forecast import levers_pack
    pack = levers_pack.sector_pack()
    revenue = SB.book("agras").persist_assembled["statements"]["assembled_pl"]["revenue"]
    _median, n = _dataset_median("1011", int(round(revenue * 100)))
    monkeypatch.setattr(pack, "min_n", n + 1)
    body = _forecast("1011")
    basis = _growth(body)["basis"]
    assert basis["tier"] == "macro", basis["tier"]
    steps = dict((s["tier"], s["reason"]["text"]) for s in basis["fallback_steps"])
    assert "fewer filers than this lane's floor" in steps["sector"], steps
    WORK["units"] += 2


def test_a_comparable_prior_keeps_the_book_rung_and_offers_the_sector():
    body = _forecast("1011", prior=True)
    growth = _growth(body)
    assert growth["basis"]["tier"] == "book", growth["basis"]["tier"]
    offer = growth["alternatives"]["sector"]
    assert offer is not None, "the sector median is not offered beside the book rung"
    assert offer["basis"]["tier"] == "sector" and offer["basis"]["sector"]["n"] >= 5
    assert body["pins"]["sector_snapshot_id"], body["pins"]
    WORK["units"] += 3


def test_a_sector_pedigree_serves_its_own_evidence_median():
    from engine.forecast.assumptions import _check_pedigree
    from engine.forecast.errors import AssumptionError
    good = dict((f, 1) for f in CONTRACT_SECTOR_FIELDS)
    good.update(p50=51528, n=11)
    _check_pedigree("revenue_growth", 51528, "sector", good, ())
    for bad, why in ((dict(good, p50=51529), "evidence median"),
                     (dict(good, n=2), "below"),
                     (dict((k, v) for k, v in good.items() if k != "source_url"), "lacks")):
        with pytest.raises(AssumptionError) as refused:
            _check_pedigree("revenue_growth", 51528, "sector", bad, ())
        assert why in str(refused.value), str(refused.value)
    WORK["units"] += 4


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-sector-rung: agras corpus (one year) with CAEN 1011, 4711 "
              "and none; agras + carniprod dated one year back (SYNTHETIC pairing, labelled) "
              "for the book rung; dataset engine/data/ro_sector_benchmarks.json")
        print("GATE-WORK forecast-sector-rung units=%d" % WORK["units"])
    assert WORK["units"] > 0
