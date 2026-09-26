"""Absent is never zero, and never a floor, in the credit model (revision 2;
rulings Q2 corrected 2026-09-15, R-COMPOSITE, R-D4).

THE FIRST DEFECT (revision 1, measured 2026-09-14): a book with no current
liabilities scored the liquidity sub-score 0.0 (`if current_liab > 0 else 0`
on all three ratios), and Altman X4 divided equity by
`max(total_liabilities, 1)`. `corpus/saga_compact_6_col`, whose liabilities
are all zero, served X4 1500.0, Z'' 1584.89, liquidity 0.0 and composite
88.5 AA.

THE SECOND DEFECT (the first repair, measured 2026-09-15): the refused
sub-scores dropped out and the composite was RENORMALISED over the ones that
computed, so a composite and a letter were still served over part of the
model. Through the real GET /api/period route, `corpus/imbalance_03pct`
(cash 1,000,000, share capital 997,000, no liabilities, empty P&L) served
composite 39.2 CCC over 60% of the model; `synthetic_thin_equity` served
the same 39.2 CCC; and with 1 RON of liabilities planted the `> 0` guard
defined X4 10,000.0, Z'' 10,416.74 "safe", liquidity 100 and 63.5 BBB. And
this file PINNED it: `assert credit["composite"] is not None` for every book
and `rows["credit_composite"]["current"]["value_q"] is not None` on a
zero-liability book. Those assertions are flipped here, deliberately.

THE REPAIR: current liabilities not positive -> liquidity refuses
(`current_liabilities_not_positive`); total liabilities below the pack's
materiality share of total assets (`packs/credit/model.yaml`) -> X4, Z'',
the zone and the Altman sub-score refuse
(`total_liabilities_below_materiality`, carrying the pack share it was read
against); ANY refusal -> composite and letter null, `reason`
`credit_component_undefined` listing every refused component with
`{code, component, inputs, text}`. The weights are the model table, always.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
  · a composite or letter served beside any refused sub-score, on the real
    route (saga_compact_6_col, imbalance_03pct), through the builder
    (synthetic_thin_equity, the census, agras with current liabilities
    zeroed), in the two-period block, or in the as-filed envelope — i.e. the
    renormalisation restored;
  · served weights other than the model table verbatim, or a `model_weights`
    field (the renormalisation's second vector) coming back;
  · a refusal missing from `reason.components`, a component without its
    code / component / inputs / text, or an Altman component whose text does
    not print the pack's share (TC-10: rendered from data);
  · X4, Z'' or the Altman sub-score defined on a book whose total
    liabilities are 1 RON (below 1% of total assets); X4 refused AT the
    threshold; the threshold not moving when the pack moves (planted pack);
  · on every deterministic corpus book and the five served books: a refused
    set other than exactly {liquidity when current liabilities are not
    positive, altman when total liabilities are below the pack share of
    total assets}; a book with nothing refused whose composite is not the
    model weights times its sub-scores (to the rows' 1dp); fewer than one
    book of each kind (non-vacuity, census printed).

WAVE 3 (2026-09-18, R-D1 / R-D2 / R-D3 / R-RANGE): the remaining placeholders
went the same way — profitability refuses on revenue not positive, coverage
and DSCR refuse on interest not positive unless the R-D1 rung applies, and
the leverage / equity rungs are declared, labelled pack data. This file's
`_expected_refusals` reads those rulings from the LEAVES; the rung, range
and out-of-range gates live in `test_credit_model_rungs_and_ranges.py` and
`test_served_range.py`.

REVISION 3 (2026-09-26, the ONE EBITDA). EBIT and EBITDA are the assembled
P&L's one definition (net 711 and net 72x inside). Where the assembly
REFUSES them (the stock variation could not be measured — e.g. the Scandia
regression baseline, whose persisted envelope predates the measurement),
altman (X3), coverage, DSCR and — with net debt — leverage refuse as
`ebitda_refused`, each naming the stock-variation cause, and the composite
refuses with them. `_expected_refusals` reads that from the served
`assembled_pl` itself, not from the model.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import _served_books as SB
import test_rebuild_net_income_anchor as ANCHOR
from engine.api import _comparatives as C
from engine.comparatives import ratio_compare as RC
from engine.ratios import credit_model as CM

REPO = Path(__file__).resolve().parents[2]
COMPACT = REPO / "corpus" / "saga_compact_6_col"
IMBALANCE = REPO / "corpus" / "imbalance_03pct"
THIN = REPO / "tests" / "engine" / "fixtures" / "firm" / "synthetic_thin_equity.json"

_CL = ("accountsPayable", "shortTermDebt", "otherCurrentLiabilities")
_NCL = ("longTermDebt", "otherNonCurrentLiabilities")
_TA = ("cash", "accountsReceivable", "inventory", "otherCurrentAssets",
       "propertyPlantEquipment", "intangibles", "otherNonCurrentAssets")


def _expected_refusals(statements: Dict[str, Any]) -> Dict[str, str]:
    """THIS FILE'S OWN reading of the rulings, from the leaves — never the
    model's predicate — so the two agree by measurement, not by construction.
    liquidity: current liabilities not positive (Q2); altman: total
    liabilities below the pack share of total assets (R-D4); profitability:
    revenue not positive (R-D2); coverage + dscr: interest not positive and
    not the R-D1 rung (debt == 0, interest == 0, EBIT > 0)."""
    bs = statements["balanceSheet"]
    pl = statements["incomeStatement"]
    cl = sum(float(bs.get(k) or 0) for k in _CL)
    tl = cl + sum(float(bs.get(k) or 0) for k in _NCL)
    ta = sum(float(bs.get(k) or 0) for k in _TA)
    out = {}
    if ta <= 0:
        return out
    if cl <= 0:
        out["liquidity"] = CM.CURRENT_LIABILITIES_NOT_POSITIVE
    if Decimal(repr(tl)) < CM.x4_materiality_share() * Decimal(repr(ta)) or tl <= 0:
        out["altman"] = CM.TOTAL_LIABILITIES_BELOW_MATERIALITY
    if not float(pl["revenue"]) > 0:
        out["profitability"] = CM.REVENUE_NOT_POSITIVE
    interest = float(pl["interestExpense"])
    debt = float(bs["shortTermDebt"]) + float(bs["longTermDebt"])
    ebit, ebitda = _one_ebit_ebitda(statements)
    if ebit is None or ebitda is None:
        # the one EBITDA / operating result refused (revision 3)
        if "altman" not in out:
            out["altman"] = CM.EBITDA_REFUSED
        out["coverage"] = CM.EBITDA_REFUSED
        out["dscr"] = CM.EBITDA_REFUSED
        if debt - float(bs["cash"]) > 0:
            out["leverage"] = CM.EBITDA_REFUSED
        return out
    d1_rung = debt == 0 and interest == 0 and ebit > 0
    if not interest > 0 and not d1_rung:
        out["coverage"] = CM.INTEREST_EXPENSE_NOT_POSITIVE
        out["dscr"] = CM.INTEREST_EXPENSE_NOT_POSITIVE
    return out


def _one_ebit_ebitda(statements: Dict[str, Any]) -> Tuple[Any, Any]:
    """(EBIT, EBITDA) as the served statements state them — the assembled
    P&L's one definition (None when it carries `ebitda_refusal`); on a
    block assembled before the ruling, the build-up plus net 72x, and None
    where the book posts to 711 (only its gross turnover was kept)."""
    apl = statements.get("assembled_pl") or {}
    if "ebitda_definition" in apl:
        if apl.get("ebitda_refusal"):
            return None, None
        return apl.get("operating_result"), apl.get("ebitda")
    pl = statements["incomeStatement"]
    if abs(float(pl.get("inventoryVariationMemo") or 0)) >= 0.005:
        return None, None
    ebitda = (float(pl["revenue"]) - float(pl["costOfGoodsSold"]) - float(pl["operatingExpenses"])
              + float(pl["otherIncome"]) + float(pl.get("capitalizedOwnWork") or 0))
    return ebitda - float(pl["depreciationAmortization"]), ebitda


def _check_component(where: str, comp: Dict[str, Any]) -> None:
    for field in ("code", "component", "inputs", "text"):
        assert comp.get(field), "%s: refused component %r carries no %s" % (where, comp, field)
    if CM.EBITDA_REFUSED in (comp.get("code"), comp.get("cause")):
        # the stock-variation cause travels with the code, in both languages
        cause = comp.get("ebitda_refusal") or {}
        assert cause.get("code") and cause.get("text_ro") and cause.get("text_en"), (where, comp)
        assert cause["text_en"] in comp["text"], (where, comp)
    if comp["component"] == "altman" and CM.TOTAL_LIABILITIES_BELOW_MATERIALITY in (
            comp.get("code"), comp.get("cause")):
        share = CM.credit_pack()["share"]
        pct = "%s%%" % format((share * 100).normalize(), "f")
        assert pct in comp["text"], "%s: the Altman refusal does not print the pack's %s: %r" % (
            where, pct, comp["text"])
        assert comp["materiality"]["share"] == format(share, "f"), (where, comp["materiality"])
        assert comp["materiality"]["file"] == "packs/credit/model.yaml"


def _check_block(where: str, credit: Dict[str, Any], statements: Dict[str, Any]) -> Dict[str, str]:
    want = _expected_refusals(statements)
    got = {k: v["code"] for k, v in credit["refused_subscores"].items()}
    assert got == want, "%s: refused sub-scores %s, expected %s from the leaves" % (where, got, want)
    subs = credit["subscores"]
    for key in want:
        assert subs[key] is None, "%s: refused %s still serves %r" % (where, key, subs[key])
        _check_component(where, credit["refused_subscores"][key])
    assert credit["weights"] == CM.CREDIT_COMPOSITE_WEIGHTS, (
        "%s: served weights %s are not the model table — renormalised?" % (where, credit["weights"]))
    assert "model_weights" not in credit, "%s: a second weight vector is served again" % where
    if want:
        assert credit["composite"] is None and credit["letter"] is None, (
            "%s: composite %r / letter %r served beside refused %s — the weights were redistributed"
            % (where, credit["composite"], credit["letter"], sorted(want)))
        reason = credit["reason"] or {}
        assert reason.get("code") == CM.CREDIT_COMPONENT_UNDEFINED, (where, reason)
        listed = [c["component"] for c in reason.get("components") or []]
        assert listed == [k for k in CM.CREDIT_COMPOSITE_WEIGHTS if k in want], (where, listed)
        for comp in reason["components"]:
            _check_component(where, comp)
            assert comp["cause"] == want[comp["component"]], (where, comp)
    else:
        recomposed = sum(CM.CREDIT_COMPOSITE_WEIGHTS[k] * subs[k] for k in CM.CREDIT_COMPOSITE_WEIGHTS)
        assert abs(recomposed - credit["composite"]) <= 0.1, (
            "%s: composite %s is not the model weights x served sub-scores (%s)"
            % (where, credit["composite"], recomposed))
        assert credit["letter"] == CM.composite_to_letter_grade(credit["composite"]), where
        assert credit["reason"] is None, (where, credit["reason"])
    if "altman" in want:
        assert credit["altman"]["x4"] is None and credit["altman"]["z"] is None, (where, credit["altman"])
        assert credit["altman"]["zone"] is None
    return got


# ── 1. the real zero-liability books, through the real route ────────────────


_BODIES: Dict[str, Any] = {}


def _routed(case_dir: Path):
    key = case_dir.name
    if key not in _BODIES:
        bk = ANCHOR._Book(case_dir)
        _BODIES[key] = (bk, SB.routed_body(bk))
    bk, body = _BODIES[key]
    return bk, copy.deepcopy(body)


def _compact():
    return _routed(COMPACT)


#: What each zero-liability corpus book refuses. `saga_compact_6_col` has a
#: P&L (revenue 800, EBIT 500) and no debt: profitability scores and
#: coverage / DSCR take the R-D1 declared rung. `imbalance_03pct` has an
#: EMPTY P&L: five of the seven components refuse.
_TWO = {"liquidity": "current_liabilities_not_positive",
        "altman": "total_liabilities_below_materiality"}
_FIVE = dict(_TWO, profitability="revenue_not_positive",
             coverage="interest_expense_not_positive", dscr="interest_expense_not_positive")
_EXPECTED_REFUSALS = {COMPACT.name: _TWO, IMBALANCE.name: _FIVE}


@pytest.mark.parametrize("case_dir", [COMPACT, IMBALANCE], ids=lambda p: p.name)
def test_a_book_with_no_liabilities_refuses_the_composite_and_the_letter_through_the_real_route(case_dir):
    assert CM.CREDIT_MODEL_REVISION >= 2, "the arithmetic changed and the revision did not move"
    _bk, body = _routed(case_dir)
    bs = body["statements"]["balanceSheet"]
    assert sum(bs[k] for k in _CL + _NCL) == 0, "the corpus book is expected to carry no liabilities: %s" % bs
    credit = body["assembled_metrics"]["ratio_table"]["credit"]
    got = _check_block(case_dir.name, credit, body["statements"])
    assert got == _EXPECTED_REFUSALS[case_dir.name], (case_dir.name, got)
    if case_dir is COMPACT:
        # revenue 800, EBIT 500, no debt, no interest: the R-D1 declared rung
        # on coverage and DSCR, labelled, never a measurement
        rungs = credit["declared_rungs"]
        assert set(rungs) == {"coverage", "dscr"}, rungs
        for k in ("coverage", "dscr"):
            assert rungs[k]["score"] == credit["subscores"][k], (k, rungs[k], credit["subscores"][k])
            assert rungs[k]["label"] and rungs[k]["file"] == CM.CREDIT_PACK_FILE, rungs[k]
    else:
        assert credit["declared_rungs"] == {}, credit["declared_rungs"]
    env = body["assembled_metrics"]["credit"]
    assert env["basis"] == "serve"
    assert env["composite_weights"] == CM.CREDIT_COMPOSITE_WEIGHTS
    assert "model_weights" not in env
    assert env["altman_z_score"] is None and env["altman_components"]["x4"] is None
    assert env["subscores"]["liquidity"] is None and env["subscores"]["altman"] is None
    assert env["composite_score"] is None and env["letter_grade"] is None, (
        case_dir.name, env["composite_score"], env["letter_grade"])
    assert env["reason"] == credit["reason"]
    rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(copy.deepcopy(body["statements"]))}
    for name in ("altman_x4", "altman_z_score", "credit_subscore_altman", "credit_subscore_liquidity",
                 "credit_composite"):
        assert rows[name] is None, "%s serves %r on a book with no liabilities" % (name, rows[name])
    served = {r["name"]: r["value"] for r in body["metrics"]}
    assert served.get("credit_composite") is None


def _thin_statements() -> Dict[str, Any]:
    return copy.deepcopy(json.loads(THIN.read_text(encoding="utf-8"))["statements"])


def test_the_thin_equity_book_refuses_the_composite_and_the_letter():
    statements = _thin_statements()
    credit = CM.credit_block(CM.compute_period_metrics(statements), statements=statements)
    got = _check_block("synthetic_thin_equity", credit, statements)
    assert got == _FIVE, got


# ── 2. R-D4: X4 is defined only from the pack's materiality share ────────────


def test_one_ron_of_liabilities_does_not_define_x4_z_or_the_altman_component():
    statements = _thin_statements()
    statements["balanceSheet"]["accountsPayable"] = 1.0
    rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(copy.deepcopy(statements))}
    for name in ("altman_x4", "altman_z_score", "credit_subscore_altman", "credit_composite"):
        assert rows[name] is None, "%s = %r on a book with 1 RON of liabilities" % (name, rows[name])
    credit = CM.credit_block(CM.compute_period_metrics(statements), statements=statements)
    got = _check_block("thin equity + 1 RON payable", credit, statements)
    assert got["altman"] == "total_liabilities_below_materiality", got
    assert "liquidity" not in got and credit["subscores"]["liquidity"] is not None


def _at_share(share: Decimal) -> Dict[str, Any]:
    statements = _thin_statements()
    bs = statements["balanceSheet"]
    ta = sum(float(bs.get(k) or 0) for k in _TA)
    bs["accountsPayable"] = float(share * Decimal(repr(ta)))
    return statements


def test_x4_is_defined_at_the_threshold_and_refused_just_below_it():
    share = CM.x4_materiality_share()
    at_statements = _at_share(share)
    at = CM.credit_block(CM.compute_period_metrics(at_statements), statements=at_statements)
    assert at["altman"]["x4"] is not None and "altman" not in at["refused_subscores"], at["altman"]
    below = _at_share(share)
    below["balanceSheet"]["accountsPayable"] -= 0.01
    got = CM.credit_block(CM.compute_period_metrics(below), statements=below)
    assert got["altman"]["x4"] is None and got["composite"] is None, got["altman"]


def test_the_threshold_is_read_from_the_pack(tmp_path, monkeypatch):
    """Plant: a pack declaring a share ten thousand times smaller defines X4
    on the 1 RON book, and the refusal text on a book below it prints the
    planted share — the threshold is data, not a constant in the module."""
    real = (REPO / "packs" / "credit" / "model.yaml").read_text(encoding="utf-8")
    assert real.count('share: "0.01"') == 1, "the real pack's share line moved; re-aim the plant"
    (tmp_path / "model.yaml").write_text(real.replace('share: "0.01"', 'share: "0.000001"'), encoding="utf-8")
    monkeypatch.setenv("CREDIT_PACKS_DIR", str(tmp_path))
    statements = _thin_statements()
    statements["balanceSheet"]["accountsPayable"] = 1.0
    credit = CM.credit_block(CM.compute_period_metrics(statements), statements=statements)
    assert credit["altman"]["x4"] is not None, "the planted pack share was not read"
    assert CM.subscore_refusal("altman", CM.TOTAL_LIABILITIES_BELOW_MATERIALITY)["text"].count("0.0001%") == 1


# ── 3. the census: every book refuses exactly where its liabilities say ──────


def _corpus_statements() -> List[Tuple[str, Dict[str, Any]]]:
    spec = importlib.util.spec_from_file_location("corpus_replay", str(REPO / "scripts" / "corpus_replay.py"))
    cr = sys.modules.get("corpus_replay")
    if cr is None:
        cr = importlib.util.module_from_spec(spec)
        sys.modules["corpus_replay"] = cr
        spec.loader.exec_module(cr)
    pack = cr.get_pack("RO")
    out = []
    for case_dir in cr.discover_cases(REPO / "corpus"):
        meta = cr._load_meta(case_dir)
        parser = str(meta.get("expected_parser") or "")
        if parser not in ("csv", "saga_10_col", "saga_compact_6_col", "generic_4_col", "pdf_positional"):
            continue
        ip = cr._input_path(case_dir)
        content = ip.read_bytes()
        tb = (pack.parse_trial_balance_csv(content, ip.name) if parser == "csv"
              else pack.parse_trial_balance(content, ip.name))
        _tb, _shaped, assembled = pack.assemble_parsed_tb(tb, company_name=ip.stem, period_label="Imported period")
        out.append(("corpus/%s" % case_dir.name, assembled["statements"]))
    return out


def test_every_book_refuses_exactly_where_its_liabilities_are_below_the_model():
    books = _corpus_statements() + [("served %s" % n, SB.served_body(n)["statements"]) for n in SB.ALL_BOOKS]
    refused, clean = [], []
    for where, statements in books:
        credit = CM.credit_block(CM.compute_period_metrics(copy.deepcopy(statements)), statements=statements)
        got = _check_block(where, credit, statements)
        (refused if got else clean).append(where)
    census = "%d books: %d with a refusal %s, %d without" % (len(books), len(refused), refused, len(clean))
    print(census)
    assert len(books) >= 15, census
    assert refused and len(clean) >= 5, census
    assert "corpus/saga_compact_6_col" in refused and "corpus/imbalance_03pct" in refused, census


def test_current_liabilities_zeroed_with_long_term_debt_kept_refuses_liquidity_and_the_composite():
    statements = copy.deepcopy(SB.served_body("agras")["statements"])
    bs = statements["balanceSheet"]
    for k in _CL:
        bs[k] = 0.0
    assert bs["longTermDebt"] > 0, bs
    credit = CM.credit_block(CM.compute_period_metrics(statements), statements=statements)
    got = _check_block("agras, current liabilities zeroed", credit, statements)
    assert got == {"liquidity": "current_liabilities_not_positive"}, got
    assert credit["altman"]["x4"] is not None and credit["altman"]["z"] is not None


# ── 4. the two-period block carries the model's own reasons ────────────────


def test_the_two_period_block_refuses_the_composite_and_the_letter_with_every_component():
    assert set(CM.CREDIT_SUBSCORE_REFUSAL_CODES) <= set(RC.COMPOSITE_REASON_CODES), RC.COMPOSITE_REASON_CODES
    assert CM.CREDIT_COMPONENT_UNDEFINED in RC.COMPOSITE_REASON_CODES
    bk, body = _compact()
    out = C.compare_payloads(body, SB.served_body("agras"),
                             current_row=dict(bk.period, id="p-compact"),
                             prior_row=dict(SB.book("agras").period, id="p-agras"))["ratios"]
    rows = {r["key"]: r for r in out["composites"] + out["subscores"]}
    want = {"altman_z": "total_liabilities_below_materiality",
            "credit_subscore_altman": "total_liabilities_below_materiality",
            "credit_subscore_liquidity": "current_liabilities_not_positive",
            "credit_composite": "credit_component_undefined",
            "letter_grade": "credit_component_undefined"}
    for key, code in want.items():
        side = rows[key]["current"]
        assert side["value_q"] is None and side["band_status"] == "refused", (key, side)
        assert (side["reason"] or {}).get("code") == code, (key, side["reason"])
        assert rows[key]["prior"]["value_q"] is not None, key
    listed_all = ["altman", "liquidity"]  # the model's order over _TWO
    for key in ("credit_composite", "letter_grade"):
        listed = [c["component"] for c in rows[key]["current"]["reason"]["components"]]
        assert listed == listed_all, (key, listed)
    assert out["credit"]["current"]["refused_subscores"].keys() == set(listed_all)
    # the R-D1 rung travels with the two-period block, labelled
    assert set(out["credit"]["current"]["declared_rungs"]) == {"coverage", "dscr"}


# ── 5. the GET /api/period credit envelope, on both branches ────────────────


def test_the_serve_envelope_passes_the_refusals_and_the_reason_through():
    _bk, body = _compact()
    credit = body["assembled_metrics"]["ratio_table"]["credit"]
    env = body["assembled_metrics"]["credit"]
    assert env["basis"] == "serve"
    assert env.get("refused_subscores") == credit["refused_subscores"], env.get("refused_subscores")
    assert env["refused_subscores"].keys() == _TWO.keys()
    assert env["reason"]["code"] == CM.CREDIT_COMPONENT_UNDEFINED
    assert env["declared_rungs"] == credit["declared_rungs"] and set(env["declared_rungs"]) == {"coverage", "dscr"}
    assert env["ranges"] == credit["ranges"]
    assert "model_weights" not in env


def _as_filed_body(monkeypatch, rows):
    """The route with the serve-time model unable to run, so the persisted
    rows are what the envelope reads (`basis: as_filed`)."""
    import engine.ratios.table as T

    def _cannot_run(_statements):
        raise RuntimeError("planted: the serve-time model cannot run on these statements")

    monkeypatch.setattr(T, "serve_time_metric_rows", _cannot_run)
    bk, _body = _compact()
    return SB.routed_body(bk, metrics=rows)


def test_the_as_filed_envelope_refuses_the_composite_with_every_component(monkeypatch):
    _bk, body = _compact()
    rows = CM.compute_period_metrics(copy.deepcopy(body["statements"]))
    env = _as_filed_body(monkeypatch, rows)["assembled_metrics"]["credit"]
    assert env["basis"] == "as_filed", env["basis"]
    assert env["composite_weights"] == CM.CREDIT_COMPOSITE_WEIGHTS, env["composite_weights"]
    assert "model_weights" not in env
    assert {k: v["code"] for k, v in env["refused_subscores"].items()} == _TWO
    assert env["composite_score"] is None and env["letter_grade"] is None
    assert [c["component"] for c in env["reason"]["components"]] == ["altman", "liquidity"]


def test_a_complete_book_serves_the_model_table_and_no_reason(monkeypatch):
    body = SB.served_body("agras")
    env = body["assembled_metrics"]["credit"]
    assert env["composite_score"] is not None and env["letter_grade"] is not None
    assert env["composite_weights"] == CM.CREDIT_COMPOSITE_WEIGHTS
    assert env["refused_subscores"] == {} and env["reason"] is None
