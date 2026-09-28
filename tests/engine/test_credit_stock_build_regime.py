"""THE STOCK-BUILD CREDIT REGIME — owner ruling R1 (2026-09-28), credit model
revision 5. Gate `credit-stock-build`.

THE RULING (verbatim): "DEVELOPER / STOCK-BUILD BOOKS: Scandia Română
Development went CCC → B because 29.6M of construction now flows through 711.
Accounting correct, credit signal wrong — cash went out, revenue was 162k.
When 711 stock build exceeds turnover materially, the credit model must weight
cash flow and liquidity, not EBITDA, and a finding must state: "EBITDA
pozitivă din stocuri capitalizate — numerarul a fost consumat de
construcție.""

THE DECISION (design_2026-09-28_rulings2.md R1): trigger = a MEASURED net 711
> 0 reaching net_711 / turnover >= 1.0 AND net_711 >= 10% of total operating
expense, both pack data (packs/credit/model.yaml `stock_build_regime`);
leverage, coverage, DSCR on the served cash from operations; Altman X3 on EBIT
− net 711 − net 72x, labelled; the regime's weights; an approximated or
refused CFO refuses those components (never 0, never back to EBITDA); a CFO
<= 0 grades them at the worst rung; the finding, RO verbatim + EN, severity
high, with the served figures; every surface prints the regime once.

HOW THIS FILE KNOWS (independent of the model): `check()` reads the ruling
off the SERVED statements (`assembled_pl`, `assembled_cf`) and the RAW pack
YAML — never `credit_model.stock_build_regime` — and computes the cash
components' bands by hand from CLAUDE.md Appendix A §7. The owner's sentence
is a literal here, so a paraphrase in the pack reds.

WITNESSES
  real (committed corpus, the production write path + GET /api/period):
    realestate — the developer, triggers (net 711 29,589,814.24 against
                 turnover 162,365.46); its cash flow is APPROXIMATED, so the
                 three cash components and the composite refuse;
    agras, carniprod, retail — manufacturers / a distributor, do not trigger.
  constructed (the route's own builder, serve_credit_envelope(credit_block)):
    stock_build_approximated, stock_build_cash_refused, stock_build_cash_positive,
    stock_build_cash_negative, stock_build_debt_free, manufacturer,
    at_turnover_threshold, below_turnover_threshold, below_opex_threshold,
    refused_711, zero_turnover.

SEAMS (realestate): the served `assembled_metrics.credit`, the ratio table's
`credit`, the attention document's `credit_regime`, the briefing facts'
`credit_regime` (text only — no nested money figure) — one regime.

WHAT THIS REDS ON, after the repair (TC-11): a regime on a book the raw pack
does not trigger, or none on one it does; a threshold that does not move with
the pack; an approximated / refused CFO scored (0 or any figure) or answered
with EBITDA; a measured CFO <= 0 scored anything but the declared bottom rung;
a measured CFO > 0 banded off anything but CFO; X3 carrying the stock build;
the composite on any weights but the regime's; the finding paraphrased, not
"high", or citing a figure that is not the served one (or an approximated CFO
as a figure); a seam carrying a second regime. Seven in-file plants.

CANNOT SEE (TC-13): whether the thresholds are the RIGHT ones (the owner's
ruling and the coordinator's decision); the frontend surfaces (vitest
creditRegimeSurfaces.test.tsx holds those).
"""
from __future__ import annotations

import copy
import math
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
import yaml

import _served_books as SB
from engine.api import pipeline as P
from engine.attention.now import compose_attention
from engine.ratios import credit_model as CM
from engine.ratios import credit_pack as CPK

REPO = Path(__file__).resolve().parents[2]
PACK = REPO / "packs" / "credit" / "model.yaml"

#: The owner's sentence, VERBATIM (ruling R1), and the coordinator's English.
OWNER_RO = "EBITDA pozitivă din stocuri capitalizate — numerarul a fost consumat de construcție."
OWNER_EN = "Positive EBITDA from capitalised stock — the cash was consumed by construction."

MODEL_WEIGHTS = {"altman": 0.30, "profitability": 0.20, "leverage": 0.15, "coverage": 0.10,
                 "dscr": 0.10, "liquidity": 0.10, "equity": 0.05}

WORK: Dict[str, Any] = {"books": [], "seams": [], "plants": [], "units": 0}


def _raw_regime(path: Path = PACK) -> Dict[str, Any]:
    return yaml.safe_load(path.read_text("utf-8"))["stock_build_regime"]


# ── this file's own reading of the ruling ───────────────────────────────────


def _f(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def expected_regime(statements: Dict[str, Any], pack: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The ruling on these statements, from the served P&L / cash flow and
    the raw pack: None, or {net_711, turnover, toe, ebit, cap, cash_status,
    cash}."""
    apl = statements.get("assembled_pl") or {}
    if "ebitda_definition" not in apl or apl.get("ebitda_refusal"):
        return None
    net = _f((apl.get("inventory_variation") or {}).get("value"))
    if net is None or not net > 0:
        return None
    turnover, toe = _f(apl.get("turnover")), _f(apl.get("total_operating_expense"))
    t1 = Decimal(str(pack["trigger"]["net_711_to_turnover"]["at_least"]))
    t2 = Decimal(str(pack["trigger"]["net_711_to_operating_expense"]["at_least"]))
    n = Decimal(repr(net))
    if not (n >= t1 * Decimal(repr(turnover)) and n >= t2 * Decimal(repr(toe))):
        return None
    cf = statements.get("assembled_cf") or {}
    cash = _f(cf.get("cash_from_operating"))
    status = "refused" if cash is None else ("measured" if cf.get("is_approximated") is False else "approximated")
    return {"net_711": net, "turnover": turnover, "toe": toe, "ebit": _f(apl.get("operating_result")),
            "cap": _f((apl.get("capitalized_own_work") or {}).get("value")) or 0.0,
            "ebitda": _f(apl.get("ebitda")), "before": _f(apl.get("ebitda_before_stock_variation")),
            "cash_status": status, "cash": cash}


def _lev(nd: float, cash: float) -> float:
    v = nd / cash
    return 90 if v <= 1.5 else 70 if v <= 3.0 else 50 if v <= 5.0 else max(0, 50 - (v - 5) * 10)


def _cov(cash: float, interest: float) -> float:
    v = cash / interest
    return 95 if v >= 8 else 80 if v >= 4 else 60 if v >= 2 else 40 if v >= 1 else max(0, v * 30)


def _dscr(cash: float, interest: float, ltd: float) -> float:
    v = cash / (interest + ltd / 8)
    return 90 if v >= 2 else 70 if v >= 1.25 else max(0, v * 50)


def check(name: str, statements: Dict[str, Any], block: Dict[str, Any], rows: Dict[str, Any],
          pack: Optional[Dict[str, Any]] = None) -> List[str]:
    """Every way `block` (a served CreditBlock) and `rows` (the model's rows)
    depart from the ruling on `statements`."""
    pack = pack or _raw_regime()
    out: List[str] = []
    want = expected_regime(statements, pack)
    reg = block.get("regime")
    bs, pl = statements["balanceSheet"], statements["incomeStatement"]
    ta = sum(float(bs[k]) for k in ("cash", "accountsReceivable", "inventory", "otherCurrentAssets",
                                    "propertyPlantEquipment", "intangibles", "otherNonCurrentAssets"))
    if want is None:
        if reg is not None:
            out.append("%s: a regime is served on a book the pack does not trigger: %r" % (name, reg.get("code")))
        if block.get("weights") != MODEL_WEIGHTS:
            out.append("%s: weights %r are not the model table" % (name, block.get("weights")))
        return out
    if not isinstance(reg, dict) or reg.get("code") != pack["code"]:
        return out + ["%s: the pack triggers the regime and the block serves %r" % (name, reg)]
    # the trigger, as served, against the raw pack
    tests = {t["key"]: t for t in reg["trigger"]["tests"]}
    for key, base in (("net_711_to_turnover", want["turnover"]), ("net_711_to_operating_expense", want["toe"])):
        t = tests.get(key) or {}
        if t.get("at_least") != format(Decimal(str(pack["trigger"][key]["at_least"])), "f") or t.get("met") is not True:
            out.append("%s: trigger test %s served %r" % (name, key, t))
        share = None if base <= 0 else round(want["net_711"] / base, 4)
        if t.get("share") != share:
            out.append("%s: trigger %s share %r, the served figures give %r" % (name, key, t.get("share"), share))
    # weights: the regime's table, never renormalised
    rw = {k: float(v) for k, v in pack["weights"].items()}
    if block.get("weights") != rw:
        out.append("%s: weights %r are not the regime's %r" % (name, block.get("weights"), rw))
    # X3 on the operating result before the stock variation and own work
    if want["ebit"] is not None and ta > 0:
        x3 = round((want["ebit"] - want["net_711"] - want["cap"]) / ta, 4)
        if rows.get("altman_x3") is not None and rows.get("altman_x3") != x3:
            out.append("%s: X3 %r, (EBIT − net 711 − net 72x) / TA = %r" % (name, rows.get("altman_x3"), x3))
        if (block["altman"].get("x3_basis") or {}).get("ro") != pack["altman_x3"]["label"]["ro"]:
            out.append("%s: X3 served without the pack's label" % name)
    # the cash components
    subs, refused = block["subscores"], block.get("refused_subscores") or {}
    rungs = block.get("declared_rungs") or {}
    nd = float(bs["shortTermDebt"]) + float(bs["longTermDebt"]) - float(bs["cash"])
    interest, ltd = float(pl["interestExpense"]), float(bs["longTermDebt"])
    comps = ["coverage", "dscr"] + (["leverage"] if nd > 0 else [])
    if want["cash_status"] != "measured":
        code = "cash_from_operations_%s" % want["cash_status"]
        for k in comps:
            if subs.get(k) is not None:
                out.append("%s: %s scored %r on a cash figure that is %s" % (name, k, subs.get(k), want["cash_status"]))
            if (refused.get(k) or {}).get("code") != code:
                out.append("%s: %s refused as %r, the ruling says %s" % (name, k, (refused.get(k) or {}).get("code"), code))
            elif not ((refused[k].get("text_ro") or "") and (refused[k].get("text_en") or "")):
                out.append("%s: %s refusal carries no RO / EN sentence" % (name, k))
        if block.get("composite") is not None or block.get("letter") is not None:
            out.append("%s: a composite %r / letter %r beside refused cash components"
                       % (name, block.get("composite"), block.get("letter")))
    elif want["cash"] <= 0:
        for k in comps:
            if subs.get(k) != 0 or (rungs.get(k) or {}).get("rung") != "cash_from_operations_not_positive":
                out.append("%s: %s on cash %r is %r (rung %r), the declared bottom rung is 0"
                           % (name, k, want["cash"], subs.get(k), (rungs.get(k) or {}).get("rung")))
    else:
        cash = want["cash"]
        exp = {}
        if nd > 0:
            exp["leverage"] = _lev(nd, cash)
        if interest > 0:
            exp["coverage"] = _cov(cash, interest)
            exp["dscr"] = _dscr(cash, interest, ltd)
        elif float(bs["shortTermDebt"]) + ltd == 0:
            exp["coverage"] = pack["declared_rungs"]["no_interest_bearing_debt"]["coverage_score"]
            exp["dscr"] = pack["declared_rungs"]["no_interest_bearing_debt"]["dscr_score"]
        for k, v in exp.items():
            if subs.get(k) != round(v, 1):
                out.append("%s: %s %r, banded on cash from operations gives %r" % (name, k, subs.get(k), round(v, 1)))
        if all(subs.get(k) is not None for k in rw):
            comp = sum(rw[k] * subs[k] for k in rw)
            if block.get("composite") is None or abs(block["composite"] - comp) > 0.15:
                out.append("%s: composite %r, the regime's weights x the sub-scores give %.2f"
                           % (name, block.get("composite"), comp))
    # the finding
    f = reg.get("finding") or {}
    if (f.get("text") or {}).get("ro") != OWNER_RO or (f.get("text") or {}).get("en") != OWNER_EN:
        out.append("%s: the finding is not the owner's sentence: %r" % (name, f.get("text")))
    if f.get("severity") != "high":
        out.append("%s: the finding is %r, not high" % (name, f.get("severity")))
    figs = {x["key"]: x for x in f.get("figures") or []}
    for key, v in (("net_711", want["net_711"]), ("net_turnover", want["turnover"]),
                   ("ebitda", want["ebitda"]), ("ebitda_before_stock_variation", want["before"]),
                   ("cash_from_operations", want["cash"] if want["cash_status"] == "measured" else None)):
        got = (figs.get(key) or {}).get("value", "absent")
        if got != (None if v is None else round(v, 2)):
            out.append("%s: finding figure %s %r, served %r" % (name, key, got, v))
    return out


# ── witnesses ────────────────────────────────────────────────────────────────


def _block(*, net711: float, turnover: float, toe: float, ebit: float, cap: float = 0.0,
           cfo: Optional[float] = -3_000_000.0, approximated: bool = True,
           st_debt: float = 4_000_000.0, lt_debt: float = 12_000_000.0, interest: float = 900_000.0,
           cash: float = 1_000_000.0, ebitda_refused: bool = False) -> Dict[str, Any]:
    """A constructed statements block in the shape `assemble_statements`
    serves (only the fields the credit model and the regime read)."""
    dep = 150_000.0
    ebitda = ebit + dep
    before = ebitda - net711 - cap
    cogs, opex = round(toe * 0.55, 2), round(toe * 0.45 - dep, 2)
    ni = ebit - interest
    bs = {"cash": cash, "accountsReceivable": 2_000_000.0, "inventory": 40_000_000.0,
          "otherCurrentAssets": 500_000.0, "propertyPlantEquipment": 6_000_000.0, "intangibles": 0.0,
          "otherNonCurrentAssets": 0.0, "accountsPayable": 5_000_000.0, "shortTermDebt": st_debt,
          "otherCurrentLiabilities": 1_000_000.0, "longTermDebt": lt_debt, "otherNonCurrentLiabilities": 0.0,
          "shareCapital": 20_000_000.0, "retainedEarnings": 5_000_000.0, "otherEquity": 1_500_000.0}
    apl: Dict[str, Any] = {
        "ebitda_definition": "constructed", "ebitda": None if ebitda_refused else ebitda,
        "operating_result": None if ebitda_refused else ebit, "gross_profit": turnover - cogs + net711,
        "ebitda_before_stock_variation": before,
        "inventory_variation": {"value": None if ebitda_refused else net711},
        "capitalized_own_work": {"value": cap}, "turnover": turnover, "total_operating_expense": toe,
        "net_income_statutory": ni,
    }
    if ebitda_refused:
        apl["ebitda_refusal"] = {"code": "stock_variation_unmeasured", "text_ro": "refuzat", "text_en": "refused"}
    cf: Dict[str, Any] = {"cash_from_operating": cfo, "is_approximated": approximated}
    if cfo is None:
        cf["net_income_refusal"] = {"code": "constructed", "text_ro": "refuzat", "text_en": "refused"}
    return {
        "currency": "RON", "balanceSheet": bs,
        "incomeStatement": {"revenue": turnover, "costOfGoodsSold": cogs, "operatingExpenses": opex,
                            "depreciationAmortization": dep, "interestExpense": interest, "otherIncome": 0.0,
                            "financialIncome": 0.0, "financialExpense": 0.0, "taxExpense": 0.0,
                            "capitalizedOwnWork": cap},
        "assembled_pl": apl, "assembled_cf": cf,
    }


_DEV = dict(net711=29_000_000.0, turnover=160_000.0, toe=29_000_000.0, ebit=450_000.0)

CONSTRUCTED: Dict[str, Dict[str, Any]] = {
    "stock_build_approximated": _block(**_DEV),
    "stock_build_cash_refused": _block(**_DEV, cfo=None),
    "stock_build_cash_positive": _block(**_DEV, cfo=5_000_000.0, approximated=False),
    "stock_build_cash_negative": _block(**_DEV, cfo=-2_000_000.0, approximated=False),
    "stock_build_debt_free": _block(**_DEV, cfo=3_000_000.0, approximated=False, st_debt=0.0, lt_debt=0.0,
                                    interest=0.0),
    "manufacturer": _block(net711=1_000_000.0, turnover=110_000_000.0, toe=103_000_000.0, ebit=8_900_000.0,
                           cfo=10_000_000.0, approximated=False),
    "at_turnover_threshold": _block(net711=3_000_000.0, turnover=3_000_000.0, toe=20_000_000.0, ebit=300_000.0),
    "below_turnover_threshold": _block(net711=2_999_999.99, turnover=3_000_000.0, toe=20_000_000.0,
                                       ebit=300_000.0),
    "below_opex_threshold": _block(net711=900_000.0, turnover=500_000.0, toe=10_000_000.0, ebit=100_000.0),
    "refused_711": _block(**_DEV, ebitda_refused=True),
    "zero_turnover": _block(net711=5_000_000.0, turnover=0.0, toe=5_200_000.0, ebit=-100_000.0),
}
#: What the ruling says of each constructed book, stated by hand.
TRIGGERS = {"stock_build_approximated": True, "stock_build_cash_refused": True,
            "stock_build_cash_positive": True, "stock_build_cash_negative": True,
            "stock_build_debt_free": True, "manufacturer": False, "at_turnover_threshold": True,
            "below_turnover_threshold": False, "below_opex_threshold": False, "refused_711": False,
            "zero_turnover": True}

REAL_BOOKS = ("realestate", "agras", "carniprod", "retail")


def _built(statements: Dict[str, Any]):
    rows_list = CM.compute_period_metrics(copy.deepcopy(statements))
    block = CM.credit_block(rows_list, statements=statements)
    return block, {r["name"]: r["value"] for r in rows_list}


@pytest.mark.parametrize("name", sorted(CONSTRUCTED))
def test_the_ruling_on_each_constructed_book(name):
    st = CONSTRUCTED[name]
    assert (expected_regime(st, _raw_regime()) is not None) == TRIGGERS[name], (
        "%s: this file's reading of the trigger disagrees with the hand statement" % name)
    block, rows = _built(st)
    problems = check(name, st, block, rows)
    assert not problems, "\n  ".join(problems)
    # the route's own envelope builder carries the same regime and weights
    env = CM.serve_credit_envelope(block)
    assert env["regime"] == block["regime"] and env["composite_weights"] == block["weights"], name
    WORK["books"].append(name)
    WORK["units"] += 1 + len(block["subscores"])


@pytest.mark.parametrize("name", REAL_BOOKS)
def test_the_ruling_on_the_real_books_through_the_route(name):
    body = SB.served_body(name)
    st = body["statements"]
    table = body["assembled_metrics"]["ratio_table"]["credit"]
    rows = {r["name"]: r["value"] for r in body["metrics"]}
    problems = check(name, st, table, rows)
    assert not problems, "\n  ".join(problems)
    assert (table.get("regime") is not None) == (name == "realestate"), (name, table.get("regime"))
    env = body["assembled_metrics"]["credit"]
    assert env["regime"] == table["regime"], "%s: the envelope and the ratio table carry two regimes" % name
    assert env["composite_weights"] == table["weights"], name
    WORK["books"].append(name)
    WORK["units"] += 1 + len(table["subscores"])


def test_every_seam_carries_one_regime():
    """realestate: the served envelope, the ratio table, the attention
    document and the briefing facts carry ONE regime — the attention document
    verbatim, the briefing facts as text with no nested money figure."""
    body = SB.served_body("realestate")
    reg = body["assembled_metrics"]["credit"]["regime"]
    assert reg is not None and reg["code"] == _raw_regime()["code"]
    doc = compose_attention(body, prior={"rule": "same_length", "status": "absent", "period_id": None})
    assert doc["credit_regime"] == reg, "the attention document carries a second regime"
    WORK["seams"].append("attention")
    st = body["statements"]
    facts = P._briefing_facts_raw(st["assembled_pl"], st["assembled_bs"],
                                  {"total_assets": 1.0, "total_equity": 1.0, "total_liabilities": 1.0,
                                   "bs_balance_delta": 0.0}, statements=st)
    cr = facts.get("credit_regime")
    assert cr is not None and cr["code"] == reg["code"], cr
    assert cr["finding"]["text"] == reg["finding"]["text"] and cr["finding"]["severity"] == "high"
    assert cr["cash_status"] == reg["cash"]["status"] == "approximated"

    def _numbers(v: Any) -> List[Any]:
        if isinstance(v, dict):
            return [n for x in v.values() for n in _numbers(x)]
        if isinstance(v, list):
            return [n for x in v for n in _numbers(x)]
        return [v] if isinstance(v, (int, float)) and not isinstance(v, bool) else []

    assert _numbers(cr) == [], "the briefing's regime carries a nested number the FX conversion never sees"
    # a manufacturer's facts carry no regime
    ag = SB.served_body("agras")["statements"]
    assert "credit_regime" not in P._briefing_facts_raw(
        ag["assembled_pl"], ag["assembled_bs"], {"total_assets": 1.0, "total_equity": 1.0,
                                                  "total_liabilities": 1.0, "bs_balance_delta": 0.0},
        statements=ag)
    WORK["seams"].append("briefing_facts")
    WORK["units"] += 4


def test_the_thresholds_and_the_weights_are_read_from_the_pack(tmp_path, monkeypatch):
    """TC-10: plant the pack's turnover share above the developer's 182x —
    the regime is gone; plant a weight table — the composite follows it."""
    real = PACK.read_text("utf-8")
    old = '    net_711_to_turnover:\n      at_least: "1.0"\n'
    assert real.count(old) == 1, "the pack's trigger line moved; re-aim the plant"
    (tmp_path / "model.yaml").write_text(real.replace(old, old.replace('"1.0"', '"200"')), "utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(tmp_path))
    st = SB.served_body("realestate")["statements"]
    block, rows = _built(st)
    assert block["regime"] is None, "the planted threshold was not read"
    assert not check("realestate@200", st, block, rows, pack=_raw_regime(tmp_path / "model.yaml"))
    wold = "    profitability: 0.10\n    leverage: 0.15\n    coverage: 0.10\n    dscr: 0.10\n    liquidity: 0.20\n"
    assert real.count(wold) == 1, "the regime weight table moved; re-aim the plant"
    wnew = "    profitability: 0.05\n    leverage: 0.15\n    coverage: 0.10\n    dscr: 0.10\n    liquidity: 0.25\n"
    # a second directory: the pack loader caches by path
    wdir = tmp_path / "weights"
    wdir.mkdir()
    (wdir / "model.yaml").write_text(real.replace(wold, wnew), "utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(wdir))
    st2 = CONSTRUCTED["stock_build_cash_positive"]
    block2, rows2 = _built(st2)
    assert block2["weights"]["liquidity"] == 0.25, block2["weights"]
    assert not check("cash_positive@planted_weights", st2, block2, rows2,
                     pack=_raw_regime(wdir / "model.yaml"))
    WORK["units"] += 2


def test_a_pack_without_the_regime_is_refused_not_defaulted(tmp_path, monkeypatch):
    real = PACK.read_text("utf-8")
    head = real.split("\nstock_build_regime:")[0]
    (tmp_path / "model.yaml").write_text(head + "\n", "utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(tmp_path))
    with pytest.raises(CPK.CreditPackError):
        CPK.credit_pack()
    WORK["units"] += 1


# ── in-file plants: each checker must see the defect it exists for ───────────


def _plant(plant: str, monkeypatch) -> None:
    if plant == "approximated-cash-read-as-measured":
        orig = CM.cash_from_operations

        def measured(statements):
            out = orig(statements)
            if out["status"] == "approximated":
                out.update(status="measured", refusal_code=None)
            return out
        monkeypatch.setattr(CM, "cash_from_operations", measured)
    elif plant == "refusal-falls-back-to-ebitda":
        orig = CM._regime_cash

        def ebitda_instead(ops):
            regime, code, cash = orig(ops)
            if regime is not None and code is not None:
                return regime, None, ops.get("ebitda")
            return regime, code, cash
        monkeypatch.setattr(CM, "_regime_cash", ebitda_instead)
    elif plant == "x3-keeps-the-stock-build":
        orig = CM.stock_build_regime

        def keeps(statements):
            out = orig(statements)
            if out is not None:
                out["altman_x3"]["numerator"] = out["altman_x3"]["operating_result"]
            return out
        monkeypatch.setattr(CM, "stock_build_regime", keeps)
    elif plant == "cash-components-on-ebit":
        orig = CM._regime_cash

        def on_ebit(ops):
            regime, code, cash = orig(ops)
            if regime is not None and cash is not None:
                return regime, code, ops.get("ebit")
            return regime, code, cash
        monkeypatch.setattr(CM, "_regime_cash", on_ebit)
    elif plant == "model-weights-under-the-regime":
        monkeypatch.setattr(CM, "composite_weights_for", lambda regime: dict(CM.CREDIT_COMPOSITE_WEIGHTS))
    elif plant == "finding-paraphrased":
        orig = CM.stock_build_regime

        def para(statements):
            out = orig(statements)
            if out is not None:
                out["finding"]["text"]["ro"] = "EBITDA pozitivă din stocuri — numerarul a scăzut."
            return out
        monkeypatch.setattr(CM, "stock_build_regime", para)
    elif plant == "trigger-threshold-in-code":
        orig = CM.stock_build_regime

        def fixed(statements):
            # a regime decided on a constant the pack does not hold (net 711
            # > turnover alone, the operating-cost share ignored)
            out = orig(statements)
            if out is None:
                apl = statements.get("assembled_pl") or {}
                net = _f((apl.get("inventory_variation") or {}).get("value"))
                if net is not None and net > (_f(apl.get("turnover")) or 0) and not apl.get("ebitda_refusal"):
                    donor = orig(CONSTRUCTED["stock_build_approximated"])
                    return donor
            return out
        monkeypatch.setattr(CM, "stock_build_regime", fixed)
    else:  # pragma: no cover
        raise AssertionError(plant)


PLANTS = {
    "approximated-cash-read-as-measured": "stock_build_approximated",
    "refusal-falls-back-to-ebitda": "stock_build_approximated",
    "x3-keeps-the-stock-build": "stock_build_cash_positive",
    "cash-components-on-ebit": "stock_build_cash_positive",
    "model-weights-under-the-regime": "stock_build_cash_positive",
    "finding-paraphrased": "stock_build_approximated",
    "trigger-threshold-in-code": "below_opex_threshold",
}


@pytest.mark.parametrize("plant", sorted(PLANTS))
def test_plant_is_caught(plant, monkeypatch):
    book = PLANTS[plant]
    _plant(plant, monkeypatch)
    st = CONSTRUCTED[book]
    block, rows = _built(st)
    assert check(book, st, block, rows), "PLANT %s on %s went unnoticed — the checker is blind" % (plant, book)
    WORK["plants"].append(plant)
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE credit-stock-build (owner ruling R1 2026-09-28, packs/credit/model.yaml "
              "stock_build_regime): %d constructed books, %d real books through GET /api/period, "
              "%d seams, %d plants" % (len([b for b in WORK["books"] if b in CONSTRUCTED]),
                                       len([b for b in WORK["books"] if b in REAL_BOOKS]),
                                       len(WORK["seams"]), len(WORK["plants"])))
        print("STOCK-BUILD-BOOKS: %s" % ", ".join(sorted(WORK["books"])))
        print("STOCK-BUILD-PLANTS: %s" % ", ".join(sorted(WORK["plants"])))
        print("GATE-WORK credit-stock-build units=%d" % WORK["units"])
    assert len(WORK["books"]) == len(CONSTRUCTED) + len(REAL_BOOKS)
    assert len(WORK["plants"]) == len(PLANTS)
    assert sorted(WORK["seams"]) == ["attention", "briefing_facts"]
