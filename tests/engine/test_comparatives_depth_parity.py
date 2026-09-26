"""THE DEPTH-PARITY GATE — two books of one company, kept at different
chart depths, compared without a code string ever deciding a figure.

THE INCIDENT (owner screenshot, 2026-09-23; diagnosed 2026-09-26). On
`/dashboard?period=<Dec 2024>&tab=pl`, "Compare with Dec 2025" printed
operating revenue 2,727,103.68 and EBITDA -36,676.13 in the compare
column while `GET /api/period/<Dec 2025>` served 413,727,560.16 and
54,443,833.33. The two books differ in depth — the Dec 2024 file is the
external condensed balanță (220 rows, four-digit codes), the Dec 2025
file the full ledger (653 rows, six-digit codes) — so the first reading
was that the column model paired rows by code depth and dropped the
701 family. It does not, and it never did: `engine.comparatives.lines`
reads each period's ASSEMBLED statement fields, which are bucket sums
over that period's own leaves, and the two served payloads replayed
offline through `compare_payloads` give 413,727,560.16 to the cent.

The printed figures are real. 2,727,103.68 / -36,676.13 are, to the
cent, the revenue and EBITDA of the committed `eei_dec_2025` baseline —
a different company's book. `pipeline.stage_persist`'s "duplicate-month
= REPLACE" rule re-points a month's period at ANY file uploaded into the
workspace for that month, and on 09-22 another company's balanță had
taken over the Dec 2025 period; the route then compared Scandia's Dec
2024 with what the period held, faithfully, under Scandia's label. The
month-replace is the workspace lane's to close (CUI routing); this gate
owns the other half of the promise: that a compare figure is ALWAYS the
period's own served figure, so the only way to see another book's
revenue in the column is for the period to hold another book.

WHAT THIS GATE HOLDS, over every ordered pair of the five real corpus
books and over each book paired with its own four-digit re-aggregation
(`_comparatives_fixtures.reaggregate_to_synthetic`: rows folded to the
synthetic boundary and run through the SAME post-parse assembler):

  1. every headline column's `current` and `prior` equal THAT period's
     served `assembled_pl` / `assembled_bs` figure to the cent — the
     balance-sheet totals through the same envelope-truth override
     `/api/period` applies, so the authority is the canonical sheet;
  2. Δ is the difference of those two figures and Δ % is the engine's
     own ratio against the prior — or the stated no-base refusal;
  3. across the depth difference the P&L headline MOVES NOTHING: the
     roll-up is lossless on every real book (measured here, not
     asserted), so a figure that moved would be a figure a code string
     decided;
  4. the three bridges close to the cent on every pair;
  5. a headline the prior cannot build is an honest refusal (`absent_
     prior`, prior None, no Δ) and the bridge refuses with the field
     named — never a partial sum standing in for the line;
  6. no served column label lists account codes: a label that names a
     subset of codes as "combined" is a lie on the book whose bucket
     holds more (the incident's label read "706/704/707 combined" on a
     row that was 99% account 701).

WHAT IT FAILS ON AFTER THE REPAIR (TC-11): a column read that sums
leaves by code depth, exact code or modal depth instead of reading the
assembled bucket figure (the plant in docs/engine_book/gates.md); a
served BS total that is not the canonical sheet's; a bridge plugged to
close; a percentage divided by the FE-style `(cur - pri) / pri` without
the base floor; a registry label carrying an account-code list.

THE BALANCE SHEET IS NOT CLAIMED LOSSLESS ACROSS DEPTH, on purpose: a
grade-II synthetic account whose analytic sub-accounts close on both
sides nets when the rows merge, exactly as the real condensed balanță
prints it. Measured on the retail book the merge moves total assets by
11,247.93. That is a property of the two BOOKS, and each side's column
still equals its own served figure to the cent — which is the claim.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import copy
import itertools
import json
import re
from pathlib import Path
from typing import Any, Dict, Mapping, Tuple

import pytest

import _comparatives_fixtures as F
from engine.api import pipeline as _pipeline
from engine.api._comparatives import compare_payloads
from engine.comparatives import (
    LINE_SPECS,
    PCT_BASE_FLOOR,
    STATUS_ABSENT_BOTH,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    STATUS_COMPARED,
    STATUS_COMPARED_NO_BASE,
    SYNTHETIC,
    spec_for,
)
from engine.comparatives.analysis import canonical_totals
from engine.comparatives.lines import ZERO_FLOOR
from engine.country_packs.ro_romania.detail_level import SYNTHETIC_MAX_DIGITS, account_code_depth

REPO = Path(__file__).resolve().parents[2]
BASELINES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
             / "fixtures" / "regression_baselines")

#: The rows a reader calls the statement: every one is a sum the assembler
#: serves, and every one is what the P&L / balance-sheet tabs print with
#: a compare column beside it.
PL_HEADLINES = (
    "pl.revenue", "pl.cogs", "pl.opex_total", "pl.depreciation",
    "pl.ebitda", "pl.ebit", "pl.pretax", "pl.tax",
    "pl.net_income_operational", "pl.net_income",
)
BS_HEADLINES = (
    "bs.total_assets", "bs.total_equity", "bs.total_liabilities",
    "bs.cash", "bs.inventory", "bs.trade_receivables_net",
    "bs.trade_payables", "bs.total_current_assets",
    "bs.total_non_current_assets", "bs.total_debt",
)
HEADLINES = PL_HEADLINES + BS_HEADLINES

_ABSENT_STATUSES = (STATUS_ABSENT_PRIOR, STATUS_ABSENT_CURRENT, STATUS_ABSENT_BOTH)

#: A label that lists account codes: three digits, a slash, three digits
#: ("706/704/707"), or the word the incident's label used.
_CODE_LIST = re.compile(r"\b\d{3}\s*/\s*\d{3}\b")


def _served_like(env: Dict[str, Any]) -> Dict[str, Any]:
    """The offline envelope with the ONE override `/api/period` applies
    before serving: the persisted canonical balance sheet sources the
    `assembled_bs` totals (`_apply_envelope_truth_to_statements`, shared
    by the served path and the briefing rebuild). Read through the same
    code object, so the gate's BS authority is the served one."""
    st = env["statements"]
    _pipeline._apply_envelope_truth_to_statements(
        st, {"assembled_canonical_v1": st.get("assembled_canonical_v1") or {}})
    return env


def _payload(env: Dict[str, Any], period_id: str, period_end: str) -> Dict[str, Any]:
    return F.served_payload(_served_like(env), period_id, period_end)


def _row(period_id: str, period_end: str) -> Dict[str, Any]:
    return {"id": period_id, "period_end": period_end, "currency": "RON"}


def _compare(cur_payload, pri_payload):
    return compare_payloads(
        cur_payload, pri_payload,
        current_row=_row(cur_payload["period"]["id"], cur_payload["period"]["period_end"]),
        prior_row=_row(pri_payload["period"]["id"], pri_payload["period"]["period_end"]),
        caen=None,
    )


def _served_figure(payload: Mapping[str, Any], key: str) -> float:
    """THE authority for one headline: the payload's own assembled field
    at the registry's path — what `/api/period` serves for that line."""
    spec = spec_for(key)
    assert spec is not None, key
    node = payload["statements"]
    for part in spec.path:
        assert part in node, "%s: served payload has no %s" % (key, "/".join(spec.path))
        node = node[part]
    assert isinstance(node, (int, float)) and not isinstance(node, bool), (key, node)
    return float(node)


def _columns(doc) -> Dict[str, Dict[str, Any]]:
    return dict((c["key"], c) for c in doc["columns"])


def _fed(payload: Mapping[str, Any], key: str) -> bool:
    """Did this period's book feed any of the line's buckets?"""
    spec = spec_for(key)
    buckets = set(spec.source_buckets)
    if not buckets:
        return True
    for li in payload.get("line_items") or []:
        if (li.get("canonical_bucket") or li.get("bucket")) in buckets:
            return True
    return False


def _check_side(col: Mapping[str, Any], side: str, payload: Mapping[str, Any],
                key: str, label: str) -> bool:
    """One side of one column is either THAT period's served figure to the
    cent, or an ABSENCE the book justifies: the disclosure says absent,
    the served field holds nothing above the zero floor, and not one leaf
    of the book sits in the line's buckets. Returns True when reported.
    (The retail and real-estate books carry no income-tax row at all —
    the absent-tax-charge case — and `pl.tax` reads absent on them, not
    0.00; the column may not print a zero the book never disclosed.)"""
    want = _served_figure(payload, key)
    if col[side] is None:
        assert col[side + "_disclosure"] == "absent", (key, side, col)
        assert abs(want) < ZERO_FLOOR, (
            "%s %s reads absent while %s serves %.2f" % (key, side, label, want))
        assert not _fed(payload, key), (
            "%s %s reads absent while %s's book feeds the bucket" % (key, side, label))
        return False
    assert _cents(col[side], want), (
        "%s %s %r is not %s's served %.2f" % (key, side, col[side], label, want))
    return True


def _cents(a: float, b: float) -> bool:
    return abs(a - b) < ZERO_FLOOR


# ── Fixtures: the real books and their condensed counterparts ─────────

@pytest.fixture(scope="module")
def books() -> Dict[str, Dict[str, Any]]:
    present = [cid for cid in F.REAL_BOOKS if (F.CORPUS / cid / "input.xlsx").is_file()]
    if len(present) < 2:
        pytest.skip("fewer than two real corpus books present: %r" % (present,))
    return dict((cid, _payload(F.envelope_for(cid), cid, "2025-12-31")) for cid in present)


@pytest.fixture(scope="module")
def condensed() -> Dict[str, Tuple[Dict[str, Any], int]]:
    out = {}
    for cid in F.REAL_BOOKS:
        if not (F.CORPUS / cid / "input.xlsx").is_file():
            continue
        env, merged = F.reaggregate_to_synthetic(cid)
        out[cid] = (_payload(env, cid + "@4", "2024-12-31"), merged)
    return out


PAIRS = [(a, b) for a, b in itertools.permutations(F.REAL_BOOKS, 2)]


# ── 1 + 2 + 4. Every real pair: each side is its own served figure ────

@pytest.mark.parametrize("cur_id,pri_id", PAIRS, ids=["%s-vs-%s" % p for p in PAIRS])
def test_every_headline_column_is_each_periods_own_served_figure_on_every_real_pair(books, cur_id, pri_id):
    if cur_id not in books or pri_id not in books:
        pytest.skip("corpus book missing")
    cur, pri = books[cur_id], books[pri_id]
    doc = _compare(cur, pri)
    assert doc["comparability"]["comparable"], doc["comparability"]["reason"]
    cols = _columns(doc)
    checked = 0
    for key in HEADLINES:
        col = cols[key]
        cur_ok = _check_side(col, "current", cur, key, cur_id)
        pri_ok = _check_side(col, "prior", pri, key, pri_id)
        if not (cur_ok and pri_ok):
            # A justified absence on either side: no movement is stated.
            assert col["status"] in _ABSENT_STATUSES, (key, col)
            assert col["delta"] is None and col["delta_pct"] is None, (key, col)
            checked += 1
            continue
        want_cur = _served_figure(cur, key)
        want_pri = _served_figure(pri, key)
        assert _cents(col["delta"], round(want_cur - want_pri, 2)), (key, col["delta"])
        if abs(want_pri) < PCT_BASE_FLOOR:
            assert col["status"] == STATUS_COMPARED_NO_BASE and col["delta_pct"] is None, col
        else:
            assert col["status"] == STATUS_COMPARED, col
            assert col["delta_pct"] == round((want_cur - want_pri) / abs(want_pri), 6), col
        checked += 1
    assert checked == len(HEADLINES)


@pytest.mark.parametrize("cur_id,pri_id", PAIRS, ids=["%s-vs-%s" % p for p in PAIRS])
def test_the_three_bridges_close_to_the_cent_on_every_real_pair(books, cur_id, pri_id):
    if cur_id not in books or pri_id not in books:
        pytest.skip("corpus book missing")
    doc = _compare(books[cur_id], books[pri_id])
    for name in ("pl", "bs_assets", "bs_liabilities_equity"):
        b = doc["bridges"][name]
        assert b["closes"] is True and b["residual"] == 0.0, (name, b["reason"])
        assert len(b["steps"]) > 0, name


# ── 3. A book against its own condensed counterpart moves nothing ─────

_ORIENT = [(cid, o) for cid in F.REAL_BOOKS for o in ("ledger-current", "ledger-prior")]


@pytest.mark.parametrize("cid,orient", _ORIENT, ids=["%s/%s" % p for p in _ORIENT])
def test_a_book_against_its_own_4_digit_re_aggregation_moves_nothing_on_the_pl(books, condensed, cid, orient):
    if cid not in books:
        pytest.skip("corpus book missing")
    ledger = books[cid]
    folded, merged = condensed[cid]
    assert merged > 0, "%s merged no rows — it is not a deeper book" % cid
    # The condensed side really is condensed: not one usable code beyond
    # the boundary, by the detector's own reading of a code. (The
    # carniprod export carries three codes with a stray apostrophe —
    # "6028.10'" — which the detector rightly refuses to read as codes;
    # a real condensed export keeps such rows verbatim, and so does this.)
    depths = [account_code_depth(li.get("ro_account_code")) for li in folded["line_items"]]
    usable = [d for d in depths if d is not None]
    assert usable and max(usable) <= SYNTHETIC_MAX_DIGITS, max(usable)
    assert len(usable) >= 0.95 * len(depths), (len(usable), len(depths))
    cur, pri = (ledger, folded) if orient == "ledger-current" else (folded, ledger)
    doc = _compare(cur, pri)
    assert doc["comparability"]["comparable"] is True
    assert doc["comparability"]["level"] == SYNTHETIC
    cols = _columns(doc)
    for key in HEADLINES:
        col = cols[key]
        cur_ok = _check_side(col, "current", cur, key, "ledger" if cur is ledger else "condensed")
        pri_ok = _check_side(col, "prior", pri, key, "ledger" if pri is ledger else "condensed")
        # Folding rows cannot create or destroy a bucket: what one side
        # discloses, the other discloses.
        assert cur_ok == pri_ok, (key, col)
    # The P&L roll-up is lossless: the same twelve months, folded, is the
    # same P&L to the cent. A movement here is a figure a code decided.
    for key in PL_HEADLINES:
        col = cols[key]
        if col["status"] in _ABSENT_STATUSES:
            assert col["delta"] is None, (key, col)
            continue
        assert col["status"] in (STATUS_COMPARED, STATUS_COMPARED_NO_BASE), (key, col)
        assert col["delta"] == 0.0, "%s moved %r across a depth difference" % (key, col["delta"])
        if col["status"] == STATUS_COMPARED:
            assert col["delta_pct"] == 0.0, (key, col)
    for name in ("pl", "bs_assets", "bs_liabilities_equity"):
        b = doc["bridges"][name]
        assert b["closes"] is True and b["residual"] == 0.0, (name, b["reason"])


def test_the_pl_roll_up_is_measured_lossless_on_every_real_book(books, condensed):
    """Not an assertion inherited from `levels.py`'s docstring: measured
    here, on every book, through the assembler, so the day a book breaks
    it the claim above it goes red rather than stale."""
    measured = 0
    for cid, ledger in books.items():
        folded, merged = condensed[cid]
        for key in PL_HEADLINES:
            assert _cents(_served_figure(ledger, key), _served_figure(folded, key)), (cid, key)
            measured += 1
    assert measured == len(books) * len(PL_HEADLINES)


# ── 4. The balance-sheet totals are the canonical sheet's ────────────

@pytest.mark.parametrize("cid", F.REAL_BOOKS)
def test_the_served_bs_totals_the_column_reads_are_the_canonical_sheets(books, cid):
    if cid not in books:
        pytest.skip("corpus book missing")
    payload = books[cid]
    cbs = payload["statements"].get("canonical_bs")
    assert isinstance(cbs, dict) and cbs.get("rows"), "%s serves no canonical_bs" % cid
    facts = canonical_totals(cbs, "RON")
    assert _cents(_served_figure(payload, "bs.total_assets"), facts["assets"]), (
        cid, _served_figure(payload, "bs.total_assets"), facts)
    equity = [s.get("subtotal") for s in cbs.get("sections") or [] if s.get("id") == "equity"]
    assert equity and _cents(_served_figure(payload, "bs.total_equity"), float(equity[0])), (
        cid, equity)


# ── 5. What cannot be built is refused, never partially summed ────────

_REFUSABLE = ("pl.revenue", "pl.ebitda", "pl.net_income", "bs.total_assets", "bs.total_equity")


@pytest.mark.parametrize("key", _REFUSABLE)
def test_a_headline_the_prior_cannot_build_is_an_honest_refusal_never_a_partial_sum(books, key):
    ids = [cid for cid in F.REAL_BOOKS if cid in books]
    cur, pri = books[ids[0]], copy.deepcopy(books[ids[1]])
    spec = spec_for(key)
    node = pri["statements"]
    for part in spec.path[:-1]:
        node = node[part]
    del node[spec.path[-1]]
    doc = _compare(cur, pri)
    col = _columns(doc)[key]
    assert col["status"] == STATUS_ABSENT_PRIOR, col
    assert col["prior"] is None and col["delta"] is None and col["delta_pct"] is None, col
    assert _cents(col["current"], _served_figure(cur, key)), col
    assert "absent, which is not zero" in col["note"], col["note"]
    # The prior's leaves still hold the family; a partial sum over them
    # would be a number here. There is none.
    assert col["prior"] != 0.0
    if key in ("pl.net_income",):
        b = doc["bridges"]["pl"]
        assert b["closes"] is False and b["residual"] is None, b
        assert spec.path[-1] in b["reason"], b["reason"]


# ── 6. No served label lists account codes ────────────────────────────

def test_no_served_column_label_lists_account_codes(books):
    ids = [cid for cid in F.REAL_BOOKS if cid in books]
    doc = _compare(books[ids[0]], books[ids[1]])
    labels = [c["label"] for c in doc["columns"]] + [s.label for s in LINE_SPECS]
    assert len(labels) >= 2 * len(HEADLINES)
    offenders = [l for l in labels if _CODE_LIST.search(l) or "combined" in l.lower()]
    assert offenders == [], offenders


# ── 7. The incident pair, from committed baselines ───────────────────

def _baseline_payload(name: str, period_id: str, period_end: str) -> Dict[str, Any]:
    with open(str(BASELINES / (name + ".json")), encoding="utf-8") as fh:
        env = json.load(fh)["assembled"]
    payload = {
        "statements": env["statements"],
        "line_items": list(env.get("lineItems") or []),
        "metrics": [],
        "period": {"id": period_id, "period_end": period_end, "currency": "RON"},
        "industry_signal": None,
    }
    return payload


def test_the_incident_pair_serves_each_books_own_revenue_so_only_the_period_content_can_print_another_books_figure():
    """`eei_dec_2025` (62 rows, three- and four-digit codes) beside
    `scandia_fy2025` (653 rows, six-digit codes): the depth pair of the
    incident, from committed baselines. With the EEI book in the prior
    slot the compare column prints EEI's 2,727,103.68 — the screenshot's
    figure — and with the Scandia book there it prints 413,727,560.16.
    The column is the period's own figure in both orientations; nothing
    about the depth difference can move it."""
    scandia = _baseline_payload("scandia_fy2025", "scandia", "2025-12-31")
    eei = _baseline_payload("eei_dec_2025", "eei", "2025-12-31")
    if not scandia["line_items"] or not eei["line_items"]:
        pytest.skip("baselines carry no line items")
    doc = _compare(scandia, eei)
    cols = _columns(doc)
    assert doc["current"]["detail_level"]["modal_depth"] > SYNTHETIC_MAX_DIGITS
    assert doc["prior"]["detail_level"]["modal_depth"] <= SYNTHETIC_MAX_DIGITS
    assert cols["pl.revenue"]["current"] == _served_figure(scandia, "pl.revenue")
    assert cols["pl.revenue"]["prior"] == _served_figure(eei, "pl.revenue")
    assert cols["pl.ebitda"]["prior"] == _served_figure(eei, "pl.ebitda")
    flipped = _columns(_compare(eei, scandia))
    assert flipped["pl.revenue"]["prior"] == _served_figure(scandia, "pl.revenue")
    assert flipped["pl.ebitda"]["prior"] == _served_figure(scandia, "pl.ebitda")
    assert flipped["pl.revenue"]["current"] == _served_figure(eei, "pl.revenue")
