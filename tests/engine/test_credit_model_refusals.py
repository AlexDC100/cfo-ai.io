"""Absent is never zero in the credit model (revision 2, ruling Q2).

THE DEFECT (revision 1, measured 2026-09-14): a book with no current
liabilities scored the liquidity sub-score 0.0 (`if current_liab > 0 else 0`
on all three ratios), and Altman X4 divided equity by
`max(total_liabilities, 1)`. `corpus/saga_compact_6_col`, whose liabilities
are all zero, served X4 1500.0, Z'' 1584.89, liquidity 0.0 and composite
88.5 AA. Six more corpus books with no liabilities served Z'' between
1,056.56 and 1,049,796.56 and composite 53.5 BB.

THE REPAIR: current liabilities not positive -> the liquidity sub-score
refuses (`current_liabilities_not_positive`); total liabilities not
positive -> X4, Z'' and the Altman sub-score refuse
(`total_liabilities_not_positive`). The composite is the weighted sum over
the sub-scores that computed, their weights renormalised to sum to one; the
served credit block lists the refused sub-scores with their reasons and the
weights the composite used.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
  · saga_compact_6_col, through the REAL GET /api/period route, serving a
    number for X4, Z'' or the Altman or liquidity sub-score; a refused
    sub-score missing from `refused_subscores` or carrying another code;
    served `weights` that are not the computed sub-scores' model weights
    divided by their sum; a composite that is not those weights times the
    served sub-scores (to the 1dp rounding of the rows); the letter not read
    off that composite; the credit envelope's composite_weights differing
    from the ratio table's; `CREDIT_MODEL_REVISION` still 1;
  · on every deterministic corpus book (write-time statements) and the five
    served books: a refused set other than exactly {liquidity when current
    liabilities are not positive, altman when total liabilities are not
    positive}; a book with nothing refused serving weights other than the
    model table verbatim; fewer than one book of each kind (non-vacuity,
    census printed);
  · the planted book with current liabilities zeroed but long-term debt
    kept refusing anything but liquidity;
  · the two-period block giving a refused Altman or liquidity row any
    reason but the model's own (`credit_inputs_absent` beside a computed
    composite is the defect), or the composer's COMPOSITE_REASON_CODES not
    declaring the model's refusal codes.

WHAT IT CANNOT SEE: the other placeholders that read an absent operand as a
value (ROE 0 on non-positive equity, net margin 0 on zero revenue, coverage
999 with no interest) — not in the ruling, recorded as held.
"""
from __future__ import annotations

import copy
import importlib.util
import sys
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

_CL = ("accountsPayable", "shortTermDebt", "otherCurrentLiabilities")
_NCL = ("longTermDebt", "otherNonCurrentLiabilities")


def _expected_weights(computed: List[str]) -> Dict[str, float]:
    total = sum(CM.CREDIT_COMPOSITE_WEIGHTS[k] for k in computed)
    return {k: CM.CREDIT_COMPOSITE_WEIGHTS[k] / total for k in CM.CREDIT_COMPOSITE_WEIGHTS if k in computed}


def _expected_refusals(bs: Dict[str, float]) -> Dict[str, str]:
    cl = sum(float(bs.get(k) or 0) for k in _CL)
    tl = cl + sum(float(bs.get(k) or 0) for k in _NCL)
    out = {}
    if cl <= 0:
        out["liquidity"] = CM.CURRENT_LIABILITIES_NOT_POSITIVE
    if tl <= 0:
        out["altman"] = CM.TOTAL_LIABILITIES_NOT_POSITIVE
    return out


def _check_block(where: str, credit: Dict[str, Any], bs: Dict[str, float]) -> Dict[str, str]:
    want = _expected_refusals(bs)
    got = {k: v["code"] for k, v in credit["refused_subscores"].items()}
    assert got == want, "%s: refused sub-scores %s, expected %s from the liabilities" % (where, got, want)
    subs = credit["subscores"]
    for key in want:
        assert subs[key] is None, "%s: refused %s still serves %r" % (where, key, subs[key])
    computed = [k for k, v in subs.items() if v is not None]
    if not want:
        assert credit["weights"] == CM.CREDIT_COMPOSITE_WEIGHTS, (where, credit["weights"])
    else:
        assert credit["weights"] == pytest.approx(_expected_weights(computed), abs=1e-15), (
            where, credit["weights"])
        assert set(credit["weights"]) == set(computed), (where, sorted(credit["weights"]))
    assert credit["model_weights"] == CM.CREDIT_COMPOSITE_WEIGHTS
    recomposed = sum(credit["weights"][k] * subs[k] for k in computed)
    assert abs(recomposed - credit["composite"]) <= 0.1, (
        "%s: composite %s is not the applied weights x served sub-scores (%s)"
        % (where, credit["composite"], recomposed))
    assert credit["letter"] == CM.composite_to_letter_grade(credit["composite"]), where
    if "altman" in want:
        assert credit["altman"]["x4"] is None and credit["altman"]["z"] is None, (where, credit["altman"])
        assert credit["altman"]["zone"] is None
    return got


# ── 1. the real zero-liability book, through the real route ────────────────


_COMPACT_BODY: Dict[str, Any] = {}


def _compact():
    if "book" not in _COMPACT_BODY:
        bk = ANCHOR._Book(COMPACT)
        _COMPACT_BODY["book"] = bk
        _COMPACT_BODY["body"] = SB.routed_body(bk)
    return _COMPACT_BODY["book"], copy.deepcopy(_COMPACT_BODY["body"])


def test_a_book_with_no_liabilities_refuses_x4_altman_and_liquidity_through_the_real_route():
    assert CM.CREDIT_MODEL_REVISION >= 2, "the arithmetic changed and the revision did not move"
    _bk, body = _compact()
    bs = body["statements"]["balanceSheet"]
    assert sum(bs[k] for k in _CL + _NCL) == 0, "the corpus book is expected to carry no liabilities: %s" % bs
    credit = body["assembled_metrics"]["ratio_table"]["credit"]
    got = _check_block("saga_compact_6_col", credit, bs)
    assert got == {"liquidity": "current_liabilities_not_positive", "altman": "total_liabilities_not_positive"}
    assert credit["refused_subscores"]["altman"]["inputs"][-2:] == [
        "balanceSheet.longTermDebt", "balanceSheet.otherNonCurrentLiabilities"]
    env = body["assembled_metrics"]["credit"]
    assert env["basis"] == "serve"
    assert env["composite_weights"] == credit["weights"]
    assert env["altman_z_score"] is None and env["altman_components"]["x4"] is None
    assert env["subscores"]["liquidity"] is None and env["subscores"]["altman"] is None
    assert (env["composite_score"], env["letter_grade"]) == (credit["composite"], credit["letter"])
    rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(copy.deepcopy(body["statements"]))}
    for name in ("altman_x4", "altman_z_score", "credit_subscore_altman", "credit_subscore_liquidity"):
        assert rows[name] is None, "%s serves %r on a book with no liabilities" % (name, rows[name])


# ── 2. the census: every book refuses exactly where its liabilities are not positive ──


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


def test_every_book_refuses_exactly_where_its_liabilities_are_not_positive():
    books = _corpus_statements() + [("served %s" % n, SB.served_body(n)["statements"]) for n in SB.ALL_BOOKS]
    refused, clean = [], []
    for where, statements in books:
        credit = CM.credit_block(CM.compute_period_metrics(copy.deepcopy(statements)))
        assert credit["composite"] is not None, where
        got = _check_block(where, credit, statements["balanceSheet"])
        (refused if got else clean).append(where)
    census = "%d books: %d with a refusal %s, %d without" % (len(books), len(refused), refused, len(clean))
    assert len(books) >= 15, census
    assert refused and len(clean) >= 5, census
    assert "corpus/saga_compact_6_col" in refused, census


def test_current_liabilities_zeroed_with_long_term_debt_kept_refuses_only_liquidity():
    statements = copy.deepcopy(SB.served_body("agras")["statements"])
    bs = statements["balanceSheet"]
    for k in _CL:
        bs[k] = 0.0
    assert bs["longTermDebt"] > 0, bs
    credit = CM.credit_block(CM.compute_period_metrics(statements))
    got = _check_block("agras, current liabilities zeroed", credit, bs)
    assert got == {"liquidity": "current_liabilities_not_positive"}, got
    assert credit["altman"]["x4"] is not None and credit["altman"]["z"] is not None


# ── 3. the two-period block carries the model's own reasons ────────────────


def test_a_refused_subscore_row_in_the_two_period_block_states_its_own_reason():
    assert set(CM.CREDIT_SUBSCORE_REFUSAL_CODES) <= set(RC.COMPOSITE_REASON_CODES), RC.COMPOSITE_REASON_CODES
    bk, body = _compact()
    out = C.compare_payloads(body, SB.served_body("agras"),
                             current_row=dict(bk.period, id="p-compact"),
                             prior_row=dict(SB.book("agras").period, id="p-agras"))["ratios"]
    rows = {r["key"]: r for r in out["composites"] + out["subscores"]}
    want = {"altman_z": "total_liabilities_not_positive",
            "credit_subscore_altman": "total_liabilities_not_positive",
            "credit_subscore_liquidity": "current_liabilities_not_positive"}
    for key, code in want.items():
        side = rows[key]["current"]
        assert side["value_q"] is None and side["band_status"] == "refused", (key, side)
        assert (side["reason"] or {}).get("code") == code, (key, side["reason"])
        assert rows[key]["prior"]["value_q"] is not None, key
    assert rows["credit_composite"]["current"]["value_q"] is not None
    assert out["credit"]["current"]["refused_subscores"].keys() == {"altman", "liquidity"}
