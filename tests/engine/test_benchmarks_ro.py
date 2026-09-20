"""Gates for the Romanian sourced sector benchmark (engine.benchmarks_ro).

THE LAW: no figure without SOURCE, YEAR and N; n < MIN_PEERS says
"insufficient peers" and carries no median; absent is never zero; a
ratio the filed summary cannot support is refused with the reason.

The fixture under fixtures/benchmarks_ro/ is a REAL slice of the
Ministry of Finance mass files (data.gov.ro, CC-BY-4.0): every FY2024
row filed under CAEN 1011 / 1013, plus the FY2023 rows of the same CUIs,
cut byte-for-byte by ``build_ro_sector_benchmarks.py --slice-out``.
Plants (TC-2) and what each gate reds on after repair (TC-11) are in
docs/engine_book/gates.md.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from decimal import Decimal
from pathlib import Path

import pytest

from engine.benchmarks_ro import build as B
from engine.benchmarks_ro import definitions as D
from engine.benchmarks_ro import dataset as L

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "tests" / "engine" / "fixtures" / "benchmarks_ro"
SLICE_MANIFEST = FIX / "slice_manifest.json"


def _builder():
    spec = importlib.util.spec_from_file_location(
        "build_ro_sector_benchmarks",
        REPO / "scripts" / "build_ro_sector_benchmarks.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _slice_build():
    mod = _builder()
    manifest = json.loads(SLICE_MANIFEST.read_text("utf-8"))
    return mod, mod.build_from_manifest(manifest, FIX, "slice_manifest.json")


@pytest.fixture(scope="module")
def committed():
    return json.loads(L.DATASET_PATH.read_text("utf-8"))


def _figures(dataset):
    for sector, entry in dataset["sectors"].items():
        for band, cell in entry["cells"].items():
            for ratio, fig in cell["figures"].items():
                yield "%s/%s/%s" % (sector, band, ratio), fig


# ── the law ──────────────────────────────────────────────────────────


def test_every_committed_figure_carries_source_year_and_n(committed):
    assert L.check_law(committed) == []
    seen = 0
    for where, fig in _figures(committed):
        seen += 1
        assert isinstance(fig["n"], int), where
        assert fig["year"] == committed["year"], where
        assert fig["source"].startswith(
            "Ministerul Finantelor - situatii financiare anuale, "
            "published on data.gov.ro, FY"), where
        assert fig["source"].endswith("CC-BY-4.0"), where
        assert fig["filed_lines"], where
    assert seen >= 100  # TC-12: the walk really covered the dataset


@pytest.mark.parametrize("missing", ["n", "year", "source"])
def test_a_figure_without_source_year_or_n_does_not_load(committed, missing):
    planted = copy.deepcopy(committed)
    fig = planted["sectors"]["1013"]["cells"]["gte_250m"]["figures"][
        "net_margin"]
    assert "median" in fig
    del fig[missing]
    with pytest.raises(L.DatasetLawError, match="figure without " + missing):
        L.validate(planted)


def test_lookup_rows_carry_source_year_n_and_level(committed):
    out = L.lookup("1013", 413_727_560, committed)
    assert out["status"] == "ok" and out["size_band"]["key"] == "gte_250m"
    assert set(out["rows"]) == set(D.RATIOS)
    for ratio, row in out["rows"].items():
        assert row["source"] and row["year"] and isinstance(row["n"], int)
        assert row["level"] in ("caen4", "caen2") and row["sector_caen"]
        assert ("median" in row) != bool(row.get("insufficient_peers"))


# ── n < MIN_PEERS ────────────────────────────────────────────────────


def test_fewer_than_min_peers_has_no_median():
    vals = [Decimal(i) / 10 for i in range(D.MIN_PEERS - 1)]
    fig = B.figure("net_margin", vals, {}, (2024,))
    assert fig["insufficient_peers"] is True and fig["n"] == D.MIN_PEERS - 1
    assert not {"median", "p25", "p75"} & set(fig)
    ok = B.figure("net_margin", vals + [Decimal(1)], {}, (2024,))
    assert "median" in ok and "insufficient_peers" not in ok


def test_a_median_on_too_few_peers_does_not_load(committed):
    planted = copy.deepcopy(committed)
    fig = planted["sectors"]["1013"]["cells"]["gte_250m"]["figures"]["roa"]
    fig["n"] = D.MIN_PEERS - 1
    with pytest.raises(L.DatasetLawError, match="median published on n=4"):
        L.validate(planted)


def test_committed_cells_below_min_peers_are_refusals(committed):
    thin = [(w, f) for w, f in _figures(committed)
            if f["n"] < committed["min_peers"]]
    for where, fig in thin:
        assert fig.get("insufficient_peers") is True, where
        assert "median" not in fig, where


def test_fallback_to_division_is_stated_never_silent(committed):
    planted = copy.deepcopy(committed)
    cell = planted["sectors"]["1013"]["cells"]["gte_250m"]["figures"]
    n_before = cell["roa"]["n"]
    cell["roa"] = {k: v for k, v in cell["roa"].items()
                   if k not in ("median", "p25", "p75")}
    cell["roa"].update(n=3, insufficient_peers=True)
    row = L.lookup("1013", 300_000_000, L.validate(planted))["rows"]["roa"]
    assert n_before >= D.MIN_PEERS
    assert row["level"] == "caen2" and row["sector_caen"] == "10"
    assert row["fallback_from"] == {"caen": "1013",
                                    "reason": "insufficient_peers",
                                    "n_at_class": 3}
    other = L.lookup("1013", 300_000_000, planted)["rows"]["net_margin"]
    assert other["level"] == "caen4" and "fallback_from" not in other
    unknown = L.lookup("1089", 300_000_000, committed)["rows"]["net_margin"]
    assert unknown["level"] == "caen2"
    assert unknown["fallback_from"]["reason"] == "class_not_in_dataset"


def test_lookup_refuses_rather_than_guessing(committed):
    assert L.lookup(None, 1e6, committed)["reason"] == "caen_absent"
    assert L.lookup("1013", None, committed)["reason"] == "turnover_absent"
    assert L.lookup("1013", 0, committed)["reason"] == "turnover_absent"
    assert L.lookup("6201", 5e6, committed)["reason"] == (
        "sector_not_in_dataset")


# ── absent is not zero ───────────────────────────────────────────────


def _row(**ind):
    from engine.public_ro.ingest import derive_fields
    full = {"i%d" % n: None for n in range(1, 21)}
    full.update(ind)
    d = derive_fields(full)
    return {"cui": 1, "caen": "1013", "ind": full,
            "total_assets": d["total_assets"], "net_result": d["net_result"]}


def test_an_empty_field_is_absent_not_zero():
    # I6 (prepayments) empty: total assets is UNKNOWN, so every
    # asset-based ratio drops this row — it is not computed on I1 + I2.
    row = _row(i1=100, i2=100, i3=None, i4=50, i10=80, i13=1000, i18=10)
    r = B.row_ratios(row, None, True)
    assert r["net_margin"] == Decimal(10) / Decimal(1000)
    for key in ("roa", "equity_ratio", "liabilities_to_assets",
                "current_asset_share"):
        assert r[key] == "absent_operand", key
    # Inventory empty: dropped, NOT zero inventory days.
    assert r["inventory_days_on_turnover"] == "absent_operand"
    assert r["revenue_growth"] == "absent_operand"
    # A filed zero is a fact and stays in the distribution.
    zero = B.row_ratios(_row(i3=0, i13=1000), None, False)
    assert zero["inventory_days_on_turnover"] == Decimal(0)
    # Negative or zero equity: ROE is refused for the row, not signed.
    assert B.row_ratios(_row(i10=-5, i13=1, i19=3), None, False)["roe"] == (
        "nonpositive_denominator")


def test_dropped_rows_are_counted_per_ratio(committed):
    cell = committed["sectors"]["1013"]["cells"]["all_sizes"]
    nm, roa = cell["figures"]["net_margin"], cell["figures"]["roa"]
    assert nm["n"] + sum(nm["dropped"].values()) == cell["n_companies"]
    assert roa["n"] + sum(roa["dropped"].values()) == cell["n_companies"]
    assert roa["dropped"]["absent_operand"] > 0  # the real I6 hole
    assert roa["n"] < nm["n"]


def test_unsupported_ratios_are_refused_with_the_reason(committed):
    for key in ("gross_margin", "ebitda_margin", "dpo", "current_ratio",
                "interest_coverage"):
        assert committed["refused_ratios"][key]["reason"].startswith(
            "the summary-level filing does not publish"), key
        assert key not in committed["ratios"]
    for _, fig in _figures(committed):
        assert fig["unit"] in ("fraction", "days")


# ── determinism + the real slice ─────────────────────────────────────


def test_slice_files_are_the_committed_real_bytes():
    manifest = json.loads(SLICE_MANIFEST.read_text("utf-8"))
    for spec in manifest["files"]:
        digest = hashlib.sha256((FIX / spec["file"]).read_bytes()).hexdigest()
        assert digest == spec["sha256"], spec["file"]


def test_two_builds_are_byte_identical():
    mod, first = _slice_build()
    _, second = _slice_build()
    a, b = mod._dump(first), mod._dump(second)
    assert a == b
    assert hashlib.sha256(a).hexdigest() == (
        FIX / "slice_build.sha256").read_text("ascii").strip()


def test_committed_class_cells_equal_a_build_from_the_real_slice(committed):
    """The committed aggregate IS what the real rows produce: the CAEN
    class cells rebuilt from the slice equal the committed ones."""
    _, built = _slice_build()
    for caen in ("1011", "1013"):
        assert built["sectors"][caen]["cells"] == (
            committed["sectors"][caen]["cells"]), caen


def test_a_tampered_file_aborts_the_build(tmp_path):
    manifest = json.loads(SLICE_MANIFEST.read_text("utf-8"))
    for spec in manifest["files"]:
        for name in (spec["file"], spec["spec"]):
            (tmp_path / name).write_bytes((FIX / name).read_bytes())
    victim = tmp_path / manifest["files"][0]["file"]
    victim.write_bytes(victim.read_bytes().replace(b"1013", b"1014", 1))
    with pytest.raises(B.BuildError, match="does not match the manifest"):
        _builder().build_from_manifest(manifest, tmp_path, "x")


def test_size_band_cutoffs_are_data_and_contiguous(committed):
    bands = committed["size_bands"]
    assert bands == D.SIZE_BANDS
    for lo, hi in zip(bands, bands[1:]):
        assert lo["max_ron"] == hi["min_ron"]
    assert bands[-1]["max_ron"] is None
    assert D.size_band_key(249_999_999) == "50m_250m"
    assert D.size_band_key(250_000_000) == "gte_250m"
    assert D.normalize_caen("111") == "0111"


def test_provenance_header(committed):
    prov = committed["provenance"]
    assert prov["license"] == "CC-BY-4.0" and prov["build_command"]
    assert {(d["year"], d["family"]) for d in prov["datasets"]} == {
        (2024, "UU"), (2024, "BL"), (2023, "UU"), (2023, "BL")}
    for d in prov["datasets"]:
        assert len(d["file_sha256"]) == 64 and d["row_count"] > 0
        assert d["resource_url"].startswith("https://data.gov.ro/dataset/")
        assert d["license_id"] == "CC-BY-4.0"
