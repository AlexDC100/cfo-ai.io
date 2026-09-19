"""THE SERVED-RANGE GATE (ruling R-RANGE; owner 2026-09-18: range gate
absolute). Battery gate `served-range`.

Every credit score the real GET /api/period route serves is read against
the law in `served_range_law.py` — a file that imports NOTHING from the
product, so the product's own `score_out_of_range` cannot pass its own
bug. Seven books go through the real router over the projection-faithful
Supabase double (`_served_books`): the four corpus books, the Scandia
FY2025 regression baseline, `corpus/imbalance_03pct` (no liabilities,
empty P&L) and `synthetic_thin_equity` (no liabilities, revenue nil),
plus the thin book carrying exactly 1 RON of liabilities.

For each score the law names, on each book:
  · in its domain  -> the served value is a finite number inside the
                      law's bound (a composite in [0, 100], X1 <= 1,
                      X4 <= 1 / share, Z'' <= the derived bound);
  · out of domain  -> the served value is None AND the surface carries a
                      refusal whose code is in the law's vocabulary;
and a composite is served only when every component is; a letter only
beside a composite; the envelope agrees with the ratio-table block.

WHAT THIS REDS ON, after the repair (TC-11): a zero-liability book (or one
with 1 RON of liabilities) serving any Altman figure, a liquidity score or
a composite; a composite or letter served beside a refused component; a
sub-score outside [0, 100]; X1 above 1, X4 above 1 / share, Z'' above its
derived bound; a refused score with no reason or a reason outside the
law's vocabulary; ROIC served with invested capital <= 0; the composite
envelope disagreeing with the ratio-table credit block; fewer than seven
books measured (non-vacuity).

WHAT IT CANNOT SEE (TC-13): whether an in-range value is the RIGHT value
(that is ratio-credit-model's golden), the FE reader (creditRefusedSubscores
in vitest re-checks the range there), or any book outside these seven.
"""
from __future__ import annotations

import copy
import math
import types
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import _served_books as SB
import served_range_law as LAW
import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]
IMBALANCE = REPO / "corpus" / "imbalance_03pct"

#: The seven books, plus the 1-RON-of-liabilities probe (R-D4: a divisor
#: that is rounding, not a capital structure).
BOOKS: Tuple[str, ...] = SB.ALL_BOOKS + ("imbalance_03pct", "synthetic_thin_equity", "thin_plus_1_ron")

_BODIES: Dict[str, Dict[str, Any]] = {}


THIN_INPUT = REPO / "tests" / "engine" / "fixtures" / "firm" / "inputs" / "synthetic_thin_equity.xlsx"


def _thin_book(payable: float = 0.0, case_id: str = "synthetic_thin_equity") -> Any:
    """`synthetic_thin_equity` carried through the SAME production write
    seam as every corpus book (`ANCHOR._Book`: parse -> stage_map ->
    stage_persist over the fake persist seam), from its committed xlsx.
    `payable` plants ONE extra trial-balance row — account 401, a closing
    credit balance of that amount — before assembly, so the 1-RON probe is
    a book the engine assembled, not a hand-edited envelope."""
    import corpus_replay
    from engine.api import pipeline as P

    pack = corpus_replay.get_pack("RO")
    content = THIN_INPUT.read_bytes()
    tb_rows = pack.parse_trial_balance(content, THIN_INPUT.name)
    if payable:
        tb_rows.append({"cont": "401", "nume_cont": "Furnizori (planted %s RON)" % payable,
                        "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": float(payable),
                        "st_d": 0.0, "st_c": float(payable), "sf_d": 0.0, "sf_c": float(payable)})
    _tb, shaped, _assembled = pack.assemble_parsed_tb(tb_rows, company_name=case_id, period_label="Imported period")
    doc = {"id": "doc-%s" % case_id, "org_id": "org-corpus", "original_filename": THIN_INPUT.name,
           "content_hash": "sha256-planted-%s" % payable, "period_end_hint": "2025-12-31"}
    parsed = P._deterministic_tb_parsed(doc, tb_rows, shaped,
                                        pack.compute_statutory_net_profit_anchor(tb_rows),
                                        pack.compute_source_imbalance(tb_rows))
    persist_assembled = P.stage_map(doc, parsed, None)
    with corpus_replay.no_live_api_guard():
        with corpus_replay.fake_persist_seam() as fake:
            period_id = P.stage_persist(doc, parsed, persist_assembled)
            line_items = [dict(r) for r in fake.inserted_line_items]
            period = dict(fake.period_rows[0])
    return types.SimpleNamespace(period=period, line_items=line_items, period_id=period_id,
                                 org={"id": doc["org_id"], "name": case_id},
                                 persist_assembled=persist_assembled, doc=doc, parsed=parsed)


def body_of(name: str) -> Dict[str, Any]:
    if name not in _BODIES:
        if name in SB.ALL_BOOKS:
            _BODIES[name] = SB.served_body(name)
        elif name == "imbalance_03pct":
            _BODIES[name] = SB.routed_body(ANCHOR._Book(IMBALANCE))
        elif name == "synthetic_thin_equity":
            _BODIES[name] = SB.routed_body(_thin_book())
        elif name == "thin_plus_1_ron":
            _BODIES[name] = SB.routed_body(_thin_book(payable=1.0, case_id="synthetic_thin_equity_1ron"))
        else:
            raise AssertionError(name)
    return copy.deepcopy(_BODIES[name])


def _credit(body: Dict[str, Any]) -> Dict[str, Any]:
    return body["assembled_metrics"]["ratio_table"]["credit"]


def _ratio_rows(body: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    table = body["assembled_metrics"]["ratio_table"]
    rows = {}
    for group in table.get("groups") or []:
        for r in group.get("rows") or []:
            rows[r["key"]] = r
    for r in table.get("rows") or []:
        rows[r["key"]] = r
    return rows


def _refusal_of(credit: Dict[str, Any], key: str) -> Dict[str, Any] | None:
    comp = LAW.component_of(key)
    if comp is not None:
        own = (credit.get("refused_subscores") or {}).get(comp)
        if own:
            return own
    return credit.get("reason")


# ── the census ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason(name):
    body = body_of(name)
    credit = _credit(body)
    ops = LAW.operands(body["statements"])
    measured = 0
    for row in LAW.LAW:
        v = LAW.read_path(credit, row.path)
        in_domain = row.domain(ops)
        where = "%s %s (%s)" % (name, row.key, row.path)
        if in_domain:
            assert row.in_range(v, ops), "%s: served %r outside %s [%s]" % (where, v, row.bound_text(ops), row.source)
        else:
            assert v is None, "%s: served %r outside its domain (absent is never a value)" % (where, v)
            reason = _refusal_of(credit, row.key)
            assert reason and reason.get("code") in row.refusal_codes, (
                "%s: refused with no reason in the law's vocabulary: %r" % (where, reason))
        measured += 1
    assert measured == len(LAW.LAW)
    # the letter exists only beside a composite, and the composite only
    # beside every component
    subs = credit["subscores"]
    if credit["composite"] is None:
        assert credit["letter"] is None, name
        assert credit["reason"] is not None and credit["reason"]["code"] in LAW.COMPOSITE_CODES, (name, credit["reason"])
    else:
        assert all(subs[k] is not None for k in subs), (name, subs)
        assert credit["letter"] in LAW.LETTERS, (name, credit["letter"])
        assert credit["reason"] is None, name
    # a refused component names itself in the composite's reason
    refused = set(credit.get("refused_subscores") or {})
    if refused:
        listed = {c["component"] for c in (credit["reason"] or {}).get("components") or []}
        assert listed == refused, (name, listed, refused)
    # Piotroski, when served, is an integer in 0..9
    p = (body["assembled_metrics"].get("piotroski") or {}).get("score")
    if p is not None:
        assert float(p) == int(p) and LAW.PIOTROSKI_RANGE[0] <= p <= LAW.PIOTROSKI_RANGE[1], (name, p)


@pytest.mark.parametrize("name", BOOKS)
def test_the_credit_envelope_agrees_with_the_ratio_table_block(name):
    body = body_of(name)
    credit = _credit(body)
    env = body["assembled_metrics"]["credit"]
    assert env["composite_score"] == credit["composite"], name
    assert env["letter_grade"] == credit["letter"], name
    assert env["altman_z_score"] == credit["altman"]["z"], name
    assert env["subscores"] == credit["subscores"], name
    assert env.get("reason") == credit["reason"], name
    assert env.get("refused_subscores") == credit["refused_subscores"], name
    assert "model_weights" not in env and env["composite_weights"] == credit["weights"], name
    assert abs(sum(env["composite_weights"].values()) - 1.0) < 1e-9, name


@pytest.mark.parametrize("name", BOOKS)
def test_the_ratio_table_serves_roic_only_for_positive_invested_capital(name):
    body = body_of(name)
    ops = LAW.operands(body["statements"])
    rows = _ratio_rows(body)
    for key, domain, source, codes in LAW.RATIO_LAW:
        row = rows.get(key)
        assert row is not None, (name, key, sorted(rows)[:10])
        v = row.get("value")
        if domain(ops):
            assert isinstance(v, (int, float)) and math.isfinite(v), (name, key, v, source)
        else:
            assert v is None and (row.get("reason") or {}).get("code") in codes, (name, key, row.get("reason"))


# ── the books this gate exists for (non-vacuity, named) ──────────────────


def test_the_zero_liability_books_refuse_altman_liquidity_the_composite_and_the_letter():
    for name in ("imbalance_03pct", "synthetic_thin_equity"):
        credit = _credit(body_of(name))
        assert credit["altman"]["z"] is None and credit["altman"]["x4"] is None and credit["altman"]["zone"] is None, name
        assert credit["subscores"]["altman"] is None and credit["subscores"]["liquidity"] is None, name
        assert credit["composite"] is None and credit["letter"] is None, name
        assert credit["reason"]["code"] == "credit_component_undefined", name
        assert {"altman", "liquidity"} <= set(credit["refused_subscores"]), name


def test_one_ron_of_liabilities_is_not_a_capital_structure():
    credit = _credit(body_of("thin_plus_1_ron"))
    ops = LAW.operands(body_of("thin_plus_1_ron")["statements"])
    assert 0 < ops["total_liabilities"] < LAW.X4_MATERIALITY_SHARE * ops["total_assets"]
    assert credit["altman"]["x4"] is None and credit["altman"]["z"] is None, credit["altman"]
    assert credit["subscores"]["altman"] is None and credit["composite"] is None and credit["letter"] is None
    assert credit["refused_subscores"]["altman"]["code"] == "total_liabilities_below_materiality"
    # liquidity now has a base (1 RON of payables) and scores; the range holds
    assert credit["subscores"]["liquidity"] is not None and 0 <= credit["subscores"]["liquidity"] <= 100


def test_the_scoring_books_serve_a_composite_inside_the_range_with_every_component():
    scored = 0
    for name in SB.ALL_BOOKS:
        credit = _credit(body_of(name))
        assert credit["composite"] is not None and 0 <= credit["composite"] <= 100, (name, credit["composite"])
        assert credit["letter"] in LAW.LETTERS, name
        assert credit["refused_subscores"] == {}, name
        scored += 1
    assert scored == 5


def test_the_law_is_independent_of_the_product():
    src = Path(LAW.__file__).read_text(encoding="utf-8")
    assert "from engine" not in src and "import engine" not in src and "credit_pack" not in src.split('"""', 2)[2]
