"""THE RUNG, RANGE AND WITHDRAWAL GATES of the credit model (revision 2;
rulings R-D1 / R-D2 / R-D3 / R-D4 / R-RANGE; owner 2026-09-18: a labelled
top rung only where reality is genuinely best-case, exploded values refuse,
absent inputs refuse, the range gate is absolute). Battery gate
`ratio-credit-model`.

THE DEFECTS THIS FILE EXISTS FOR (B8 verifier, 2026-09-19):

  · A declared rung fired on UNMEASURED operands: `credit_block(rows)` and
    `_refused_subscores(rows)` took a rows-only fallback whenever
    `statements` was omitted (the default of both signatures), and that
    fallback read an absent `total_debt` row as 0.0, an absent
    `ebitda_to_interest` row as "interest is zero" and an absent `ebit`
    row as 0.0 — so agras (debt 3,640,202, interest 277,930) with three
    rows removed was declared "no interest-bearing debt" at coverage 95
    / DSCR 90. `statements` is now REQUIRED and the fallback is deleted:
    a rung is declared only over operands read from the statements.
  · The as-filed WITHDRAWAL (a persisted revision-1 Z'' / composite
    outside its range served null and named in `as_filed.withdrawn`) had
    no gate: with it removed, the Ratios tab printed "as filed: composite
    88.5, letter AA, Z'' 1584.89 (revision 1)" — a fabricated Altman value
    labelled as filed.
  · The served block's independent re-check (`_served_out_of_range`) and
    the liquidity negative-term refusal were entered by no book, so
    nothing held them.

WHAT THIS REDS ON, after the repair (TC-11): a `credit_block` or
`_refused_subscores` that accepts rows alone; an `operands_from_rows`
coming back; a rung declared on a book whose statements carry debt,
whatever rows are missing; a rung declared with no operands at all; a
filed Z'' or composite outside its range reprinted under `as_filed`, or
withdrawn without being named; a served X4 above 1 / share, a composite
above 100 or a sub-score above 100 reaching the block; negative cash
scoring liquidity; a letter minted from None, NaN or an out-of-range
composite; a Z'' bound that is not the derivation the pack prints; a
malformed pack defaulting instead of raising.

WHAT IT CANNOT SEE (TC-13): the real route (test_served_range.py reads
the same law over nine served bodies); the FE reader (vitest
creditRefusedSubscores + ratioCompareTab).
"""
from __future__ import annotations

import copy
import inspect
import json
import math
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.ratios import credit_model as CM
from engine.ratios import credit_pack as CP

REPO = Path(__file__).resolve().parents[2]
AGRAS = REPO / "tests" / "engine" / "fixtures" / "firm" / "saga_10_col_agras.json"
FE_FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "served_credit_refusals.json"


def _agras_statements() -> Dict[str, Any]:
    return copy.deepcopy(json.loads(AGRAS.read_text("utf-8"))["statements"])


def _compact_statements() -> Dict[str, Any]:
    """`corpus/saga_compact_6_col` as the route serves it — the committed FE
    fixture carries the statements block (no liabilities; revenue 800)."""
    return copy.deepcopy(json.loads(FE_FIXTURE.read_text("utf-8"))["statements"])


def _rows_by_name(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {r["name"]: r["value"] for r in rows}


def _set(rows: List[Dict[str, Any]], **values: Any) -> List[Dict[str, Any]]:
    out = [dict(r) for r in rows]
    for r in out:
        if r["name"] in values:
            r["value"] = values[r["name"]]
    return out


def _without(rows: List[Dict[str, Any]], *names: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in rows if r["name"] not in names]


# ── 1. a rung is declared only over MEASURED operands (R-D1) ─────────────────


def test_the_block_and_the_refusals_take_no_rows_only_fallback():
    for fn in (CM.credit_block, CM._refused_subscores):
        p = inspect.signature(fn).parameters["statements"]
        assert p.default is inspect.Parameter.empty, "%s: statements must be required, got default %r" % (
            fn.__name__, p.default)
    assert not hasattr(CM, "operands_from_rows"), "the rows-only operands fallback is back"
    rows = CM.compute_period_metrics(_agras_statements())
    with pytest.raises(TypeError):
        CM.credit_block(rows)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        CM._refused_subscores(_rows_by_name(rows))  # type: ignore[call-arg]


def test_a_book_with_debt_is_never_declared_debt_free_because_rows_are_missing():
    statements = _agras_statements()
    bs, pl = statements["balanceSheet"], statements["incomeStatement"]
    assert bs["shortTermDebt"] + bs["longTermDebt"] > 0 and pl["interestExpense"] > 0
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    trimmed = _without(rows, "total_debt", "ebitda_to_interest", "net_debt", "operating_profit")
    block = CM.credit_block(trimmed, statements)
    assert block["declared_rungs"] == {}, block["declared_rungs"]
    assert block["subscores"]["coverage"] == _rows_by_name(rows)["credit_subscore_coverage"]
    assert block["refused_subscores"] == {}
    assert block["composite"] is not None and block["letter"] is not None


def test_with_no_operands_nothing_is_declared_and_every_withheld_row_refuses_as_inputs_absent():
    rows = CM.compute_period_metrics(_agras_statements())
    nulled = _set(rows, credit_subscore_coverage=None, credit_subscore_dscr=None, credit_composite=None)
    for statements in ({}, {"balanceSheet": {}, "incomeStatement": {}}, None):
        block = CM.credit_block(nulled, statements)  # type: ignore[arg-type]
        assert block["declared_rungs"] == {}, statements
        assert block["profitability_disclosure"] is None
        assert set(block["refused_subscores"]) == {"coverage", "dscr"}
        for comp in block["refused_subscores"].values():
            assert comp["code"] == CM.CREDIT_INPUTS_ABSENT, comp
        assert block["composite"] is None and block["letter"] is None
        assert block["reason"]["code"] == CM.CREDIT_COMPONENT_UNDEFINED


@pytest.mark.parametrize("absent", [
    ("balanceSheet", "shortTermDebt"), ("balanceSheet", "longTermDebt"),
    ("incomeStatement", "interestExpense"),
    ("balanceSheet", "shortTermDebt", "longTermDebt", "incomeStatement", "interestExpense"),
])
def test_an_absent_debt_or_interest_leaf_declares_nothing(absent):
    """R-D1: debt == 0, interest == 0 and EBIT > 0, ALL MEASURED. A leaf the
    statements do not carry is absent, never 0.0: read as zero, agras (debt
    3.64M, interest 278k) was declared "no interest-bearing debt" and served
    the labelled top rung beside composite 80.7 AA (repair-round verifier's
    plant: `bs.get(k) or 0.0` in statement_operands — every suite green).
    REDS ON, after the repair: any declared rung, or a refusal other than
    `credit_inputs_absent`, over statements missing one of the three leaves."""
    statements = _agras_statements()
    assert statements["balanceSheet"]["shortTermDebt"] + statements["balanceSheet"]["longTermDebt"] > 0
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    if len(absent) == 2:
        statements[absent[0]].pop(absent[1])
    else:
        for k in ("shortTermDebt", "longTermDebt"):
            statements["balanceSheet"].pop(k)
        statements["incomeStatement"].pop("interestExpense")
    assert CM.statement_operands(statements) is None
    # a legacy period's rows, coverage withheld, over the thinned statements
    nulled = _set(rows, credit_subscore_coverage=None, credit_subscore_dscr=None, credit_composite=None)
    block = CM.credit_block(nulled, statements)
    assert block["declared_rungs"] == {}, block["declared_rungs"]
    refused = CM._refused_subscores(_rows_by_name(nulled), statements)
    assert set(refused) == {"coverage", "dscr"}
    for comp in list(refused.values()) + list(block["refused_subscores"].values()):
        assert comp["code"] == CM.CREDIT_INPUTS_ABSENT, comp
    assert block["composite"] is None and block["letter"] is None
    # ... and with the full rows nothing is declared either
    assert CM.credit_block(rows, statements)["declared_rungs"] == {}


def test_the_d1_rung_needs_all_three_operands_measured_and_the_others_their_own():
    pack = CP.credit_pack()["declared_rungs"]
    base = {"total_assets": 100.0, "current_liab_positive": True, "total_liab": 50.0, "tl_material": True,
            "total_debt": 0.0, "interest_positive": False, "interest_zero": True, "ebit": 10.0,
            "ebitda": 12.0, "net_debt": -5.0, "total_equity": 50.0, "equity_ratio": 0.5, "revenue": 100.0}
    assert set(CM.declared_rungs(base)) == {"coverage", "dscr"}
    assert CM.declared_rungs(base)["coverage"] == dict(pack["coverage"])
    assert CM.declared_rungs(base)["coverage"]["score"] == 95 and CM.declared_rungs(base)["dscr"]["score"] == 90
    assert "coverage" not in CM.declared_rungs(dict(base, total_debt=1.0))
    assert "coverage" not in CM.declared_rungs(dict(base, interest_zero=False, interest_positive=True))
    assert "coverage" not in CM.declared_rungs(dict(base, ebit=0.0))
    # R-D3: net debt > 0 with EBITDA <= 0 takes the bottom rung, labelled
    lev = CM.declared_rungs(dict(base, net_debt=5.0, ebitda=0.0))
    assert lev["leverage"]["score"] == 0 and lev["leverage"]["label"] == pack["leverage"]["label"]
    assert "leverage" not in CM.declared_rungs(dict(base, net_debt=5.0, ebitda=1.0))
    assert "leverage" not in CM.declared_rungs(dict(base, net_debt=-5.0, ebitda=0.0))
    # R-D2: equity ratio <= 0 takes the bottom rung, labelled with its law
    eq = CM.declared_rungs(dict(base, equity_ratio=0.0))
    assert eq["equity"]["score"] == 0 and "153^24" in eq["equity"]["label"]
    assert "equity" not in CM.declared_rungs(dict(base, equity_ratio=None))
    for rung in pack.values():
        assert rung["file"] == CP.CREDIT_PACK_FILE and rung["when"] and rung["source"]


def test_profitability_discloses_the_net_margin_only_variant_exactly_when_equity_is_not_positive():
    ops = {"revenue": 100.0, "total_equity": -1.0}
    disclosed = CM.profitability_disclosure(ops)
    assert disclosed == dict(CP.credit_pack()["profitability_roe_undefined"])
    assert "net margin" in disclosed["label"] and disclosed["file"] == CP.CREDIT_PACK_FILE
    assert CM.profitability_disclosure({"revenue": 100.0, "total_equity": 1.0}) is None
    assert CM.profitability_disclosure({"revenue": 0.0, "total_equity": -1.0}) is None


# ── 2. the as-filed withdrawal (R-RANGE on persisted revision-1 rows) ────────


def _revision_1_rows(statements: Dict[str, Any]) -> List[Dict[str, Any]]:
    """What revision 1 persisted for `saga_compact_6_col` (measured
    2026-09-14): X4 = equity / max(TL, 1) = 1500.0, Z'' 1584.89, liquidity
    0.0 on `if current_liab > 0 else 0`, composite 88.5 AA."""
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    rows = _set(rows, altman_x4=1500.0, altman_z_score=1584.89, credit_subscore_altman=100.0,
                credit_subscore_liquidity=0.0, credit_composite=88.5)
    for r in rows:
        if r["name"] == CM.CREDIT_MODEL_REVISION_METRIC:
            r["value"] = 1
    return rows


def test_a_filed_altman_and_composite_outside_the_range_are_withdrawn_never_reprinted():
    statements = _compact_statements()
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    filed = _revision_1_rows(statements)
    block = CM.credit_block(rows, statements, as_filed_rows=filed)
    assert block["as_filed_differs"] is True
    af = block["as_filed"]
    assert af is not None and af["credit_model_revision"] == 1
    assert af["altman_z"] is None and af["composite"] is None and af["letter"] is None, af
    withdrawn = {w["figure"]: w for w in af["withdrawn"]}
    assert set(withdrawn) == {"altman_z_score", "credit_composite"}, af["withdrawn"]
    assert withdrawn["altman_z_score"]["value"] == 1584.89 and withdrawn["credit_composite"]["value"] == 88.5
    for w in withdrawn.values():
        assert w["text"].startswith("withdrawn: computed under revision 1")
        assert "altman_x4" in w["text"]
    # the served side is the refusing model, untouched by what was filed
    assert block["altman"]["z"] is None and block["composite"] is None
    assert {"altman", "liquidity"} <= set(block["refused_subscores"])


def test_a_filed_in_range_composite_that_differs_is_disclosed_with_its_value():
    statements = _agras_statements()
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    filed = _set(rows, credit_composite=round(_rows_by_name(rows)["credit_composite"] - 12.0, 1))
    block = CM.credit_block(rows, statements, as_filed_rows=filed)
    assert block["as_filed_differs"] is True
    assert block["as_filed"]["composite"] == _rows_by_name(filed)["credit_composite"]
    assert block["as_filed"]["withdrawn"] == []


# ── 3. the served block's independent re-check (R-RANGE) ─────────────────────


def test_the_as_filed_basis_withdraws_a_filed_altman_outside_its_range_on_the_route(monkeypatch):
    """GET /api/period's `basis: as_filed` envelope (served when the
    serve-time model cannot run) printed persisted revision-1 rows raw:
    Z'' 1584.89 / X4 1500 beside composite 80.7 AA, no `ranges`, while the
    same body's `ratio_table.credit` refused (repair-round verifier's probe).
    REDS ON, after the repair: a filed Altman figure, its sub-score, the
    composite or the letter served on that branch — in the envelope OR in
    the `metrics[]` rows the FE reads first — or the envelope serving no
    `ranges`. CANNOT SEE: the serve basis (the tests below own it)."""
    import _served_books as SB
    from engine.ratios import table as T

    bk = SB.book("agras")
    legacy = []
    for r in T.serve_time_metric_rows(SB.routed_body(bk)["statements"]):
        r = dict(r)
        if r["name"] == "altman_z_score":
            r["value"] = 1584.89
        if r["name"] == "altman_x4":
            r["value"] = 1500.0
        if r["name"] == CM.CREDIT_MODEL_REVISION_METRIC:
            r["value"] = 1
        legacy.append(r)
    monkeypatch.setattr(T, "serve_time_metric_rows", lambda statements: None)
    body = SB.routed_body(bk, metrics=legacy)
    env = body["assembled_metrics"]["credit"]
    assert env["basis"] == "as_filed"
    assert env["altman_z_score"] is None and env["altman_components"]["x4"] is None
    assert env["subscores"]["altman"] is None
    assert env["composite_score"] is None and env["letter_grade"] is None
    assert env["refused_subscores"]["altman"]["code"] == CM.CREDIT_OUT_OF_RANGE
    assert env["reason"]["code"] == CM.CREDIT_COMPONENT_UNDEFINED
    assert env["ranges"]["altman_x4"]["max"] == CP.credit_pack()["ranges"]["altman_x4"]["max"]
    rows = {r["name"]: r["value"] for r in body["metrics"]}
    for name in ("altman_z_score", "altman_x4", "credit_subscore_altman", "credit_composite"):
        assert rows[name] is None, (name, rows[name])
    # an in-range filed figure on the same branch is untouched
    assert rows["altman_x2"] is not None and env["subscores"]["equity"] is not None


def test_a_served_x4_above_its_bound_is_withheld_with_z_the_zone_and_the_composite():
    statements = _agras_statements()
    rows = _set(CM.compute_period_metrics(copy.deepcopy(statements)), altman_x4=200.0)
    block = CM.credit_block(rows, statements)
    assert block["altman"]["x4"] is None and block["altman"]["z"] is None and block["altman"]["zone"] is None
    assert block["subscores"]["altman"] is None
    refusal = block["refused_subscores"]["altman"]
    assert refusal["code"] == CM.CREDIT_OUT_OF_RANGE and refusal["inputs"] == ["altman_x4"]
    assert "1 / altman_x4.liabilities_materiality.share" in refusal["range"]
    assert block["composite"] is None and block["letter"] is None
    assert [c["component"] for c in block["reason"]["components"]] == ["altman"]


def test_a_served_composite_outside_the_range_is_withheld_and_no_letter_is_minted():
    statements = _agras_statements()
    rows = _set(CM.compute_period_metrics(copy.deepcopy(statements)), credit_composite=140.0)
    block = CM.credit_block(rows, statements)
    assert block["composite"] is None and block["letter"] is None
    assert block["refused_subscores"] == {}
    assert block["reason"]["code"] == CM.CREDIT_OUT_OF_RANGE and block["reason"]["inputs"] == ["credit_composite"]
    assert block["reason"]["range"] == "[0, 100]"


def test_a_served_subscore_outside_the_range_is_withheld_naming_the_figure():
    statements = _agras_statements()
    rows = _set(CM.compute_period_metrics(copy.deepcopy(statements)), credit_subscore_leverage=120.0)
    block = CM.credit_block(rows, statements)
    assert block["subscores"]["leverage"] is None
    refusal = block["refused_subscores"]["leverage"]
    assert refusal["code"] == CM.CREDIT_OUT_OF_RANGE and refusal["inputs"] == ["credit_subscore_leverage"]
    assert refusal["range"] == "[0, 100]"
    assert block["composite"] is None and block["letter"] is None
    assert [c["component"] for c in block["reason"]["components"]] == ["leverage"]


@pytest.mark.parametrize("cash", [-1.0, -1_000_000.0])
def test_negative_cash_refuses_liquidity_naming_the_cash_ratio(cash):
    """-1 RON rounds to a -0.0 cash-ratio row: the sign is the evidence
    the refusal names, so it must read the sign, not `< 0`."""
    statements = _agras_statements()
    statements["balanceSheet"]["cash"] = cash
    rows = CM.compute_period_metrics(copy.deepcopy(statements))
    by = _rows_by_name(rows)
    assert by["credit_subscore_liquidity"] is None and by["credit_composite"] is None
    assert by["cash_ratio"] is not None and math.copysign(1.0, by["cash_ratio"]) < 0
    block = CM.credit_block(rows, statements)
    refusal = block["refused_subscores"]["liquidity"]
    assert refusal["code"] == CM.CREDIT_OUT_OF_RANGE and refusal["inputs"] == ["cash_ratio"]
    assert block["composite"] is None and block["letter"] is None


# ── 4. the ranges, the letter, the pack ──────────────────────────────────────


def test_the_z_bound_is_the_printed_derivation_over_the_books_own_x2_and_x3():
    share = CP.credit_pack()["share"]
    r = CM.credit_ranges(0.25, -0.1)
    assert r["subscore"]["min"] == 0 and r["subscore"]["max"] == 100
    assert r["composite"]["min"] == 0 and r["composite"]["max"] == 100
    assert r["altman_x1"]["max"] == 1
    assert r["altman_x4"]["max"] == float(Decimal(1) / share)
    expected = 6.56 * 1 + 3.26 * 0.25 + 6.72 * (-0.1) + 1.05 * float(Decimal(1) / share)
    assert abs(r["altman_z"]["bound"] - expected) < 1e-9, (r["altman_z"], expected)
    assert "6.56 x altman_x1.max" in r["altman_z"]["bound_is"]
    assert CM.credit_ranges(None, None)["altman_z"]["bound"] is None
    assert CM.altman_out_of_range(0.5, 0.25, -0.1, 50.0, expected + 0.01) == "altman_z_score"
    assert CM.altman_out_of_range(0.5, 0.25, -0.1, 50.0, expected - 0.01) is None
    assert CM.altman_out_of_range(1.01, 0.25, -0.1, 50.0, 1.0) == "altman_x1"
    assert CM.altman_out_of_range(0.5, math.nan, -0.1, 50.0, 1.0) == "altman_x2"
    assert CM.altman_out_of_range(0.5, 0.25, math.inf, 50.0, 1.0) == "altman_x3"
    assert CM.altman_out_of_range(0.5, 0.25, -0.1, float(Decimal(1) / share) + 1, 1.0) == "altman_x4"
    assert CM.altman_out_of_range(None, None, None, None, None) is None


@pytest.mark.parametrize("value, out", [(-0.1, True), (0.0, False), (100.0, False), (100.1, True),
                                        (math.nan, True), (math.inf, True), (None, False)])
def test_score_out_of_range_reads_the_pack_bounds(value, out):
    assert CM.score_out_of_range(value) is out
    assert CM.score_out_of_range(value, "composite") is out


@pytest.mark.parametrize("composite, letter", [(None, None), (math.nan, None), (-5.0, None), (140.0, None),
                                               (100.0, "AAA"), (95.0, "AAA"), (89.9, "AA"), (0.0, "CC"),
                                               (24.9, "CC"), (25.0, "CCC"), (True, None), ("80", None)])
def test_a_letter_is_minted_only_from_a_composite_inside_the_range(composite, letter):
    assert CM.composite_to_letter_grade(composite) == letter


def test_a_malformed_pack_raises_and_never_defaults(tmp_path, monkeypatch):
    bad = tmp_path / "packs"
    bad.mkdir()
    text = (REPO / "packs" / "credit" / "model.yaml").read_text("utf-8")
    (bad / CP.CREDIT_PACK_NAME).write_text(text.replace('share: "0.01"', 'share: "1.5"'), encoding="utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(bad))
    CP._load.cache_clear()
    try:
        with pytest.raises(CP.CreditPackError, match="share must be in"):
            CP.credit_pack()
        (bad / CP.CREDIT_PACK_NAME).unlink()
        CP._load.cache_clear()
        with pytest.raises(CP.CreditPackError, match="cannot be read"):
            CM.x4_materiality_share()
    finally:
        CP._load.cache_clear()
    monkeypatch.delenv("CREDIT_PACKS_DIR")
    CP._load.cache_clear()
    assert CP.credit_pack()["share"] == Decimal("0.01")


# ── 5. a broken pack refuses the credit block — never the period, never boot ──


def _plant_bad_pack(tmp_path, monkeypatch) -> None:
    bad = tmp_path / "packs"
    bad.mkdir(exist_ok=True)
    text = (REPO / "packs" / "credit" / "model.yaml").read_text("utf-8")
    (bad / CP.CREDIT_PACK_NAME).write_text(text.replace('share: "0.01"', 'share: "1.5"'), encoding="utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(bad))
    CP._load.cache_clear()


def test_a_broken_pack_refuses_the_credit_block_and_the_period_still_serves(tmp_path, monkeypatch):
    """B8 verifier D6: `_refused_subscores` ran outside every non-fatal try
    in get_period, so a malformed pack turned EVERY GET /api/period into a
    500. Now the credit block refuses with the pack's own error and the
    period page serves."""
    import _served_books as SB

    _plant_bad_pack(tmp_path, monkeypatch)
    try:
        body = SB.routed_body(SB.book("agras"))  # asserts 200
    finally:
        CP._load.cache_clear()
    env = body["assembled_metrics"]["credit"]
    assert env["composite_score"] is None and env["letter_grade"] is None, env
    assert env["reason"]["code"] == CM.CREDIT_INPUTS_ABSENT
    assert env["reason"]["inputs"] == [CP.CREDIT_PACK_FILE]
    assert "share must be in (0, 1)" in env["reason"]["text"], env["reason"]
    assert env["refused_subscores"] == {}
    # the ratio table could not open the pack either: absent, not invented
    assert body["assembled_metrics"]["ratio_table"] is None
    monkeypatch.delenv("CREDIT_PACKS_DIR")
    CP._load.cache_clear()
    good = SB.routed_body(SB.book("agras"))["assembled_metrics"]["credit"]
    assert good["composite_score"] is not None and good["reason"] is None


def test_boot_refuses_to_start_on_a_broken_pack(tmp_path, monkeypatch):
    from engine import boot_verify

    for k in boot_verify._CRITICAL:
        monkeypatch.setenv(k, "set-for-the-test")
    _plant_bad_pack(tmp_path, monkeypatch)
    try:
        with pytest.raises(RuntimeError, match=r"credit pack .* is unusable .* share must be in"):
            boot_verify.verify_config()
    finally:
        CP._load.cache_clear()
    monkeypatch.delenv("CREDIT_PACKS_DIR")
    CP._load.cache_clear()
    boot_verify.verify_credit_pack()  # the committed pack loads
