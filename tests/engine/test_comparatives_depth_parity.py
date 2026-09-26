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
     row that was 99% account 701);
  7. the nine bucket-backed SUB-AGGREGATE lines (interest income, third-
     party services, doubtful receivables, receivable provisions,
     related-party receivables, FX cash, assets under construction,
     fixed-asset advances, dividends payable) obey 1–5 like every other
     headline, ON THE SERVED SHAPE — see below — and a fine bucket a
     book feeds at zero is a disclosed 0.00, never an absence;
  8. the top movers are the served columns' own ranking, recomputed here
     from the columns alone, with the sub-aggregates in it: measured on
     2026-09-26, a sub-aggregate line sits in the top eight on 15 of the
     20 real pairs, so a ranking that could not see them was wrong on
     most pairs, not a corner.

THE PAYLOADS ARE SERVED-SHAPED (2026-09-26). The assembler emits
`canonical_bucket` beside every line item; `stage_persist` strips it (not
a `statement_line_items` column) and `GET /api/period` serves the
persisted legacy `bucket` alone — `interest_income` as `financialIncome`,
`ar_intercompany` as `otherCurrentAssets`, `cash_fx` as `cash`, and so on.
This gate's first version read fixtures straight off the assembler, WITH
the field, and stayed green (63 passed) while the real client pair served
all nine sub-aggregate lines "neither period reported" beside non-zero
served fields and ranked its movers without a related-party movement
above the floor: the gate's coverage was fed by a key production never
carries. Every payload here now drops the field exactly as the persist
step does (`_comparatives_fixtures.served_line_item`), `_fed` reads the
pack's rule for the account code — not the persisted name — and a test
holds the shape itself so it cannot silently grow the field back.

WHAT IT FAILS ON AFTER THE REPAIR (TC-11): a column read that sums
leaves by code depth, exact code or modal depth instead of reading the
assembled bucket figure (the plant in docs/engine_book/gates.md); a
served BS total that is not the canonical sheet's; a bridge plugged to
close; a percentage divided by the FE-style `(cur - pri) / pri` without
the base floor; a registry label carrying an account-code list; coverage
matched on the persisted bucket names again (any sub-aggregate line a
book holds reading absent — `envelope_from_payload` no longer resolving
the canonical bucket from the code, or `read_value` refusing a non-zero
served field on a coverage miss); a fed zero reading absent; a fixture
that carries `canonical_bucket`; a mover ranking that is not the columns'
own.

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
import hashlib
import itertools
import json
import re
import types
from pathlib import Path
from typing import Any, Dict, Mapping, Tuple

import pytest

import _comparatives_fixtures as F
import _real_app_comparatives as RA
import firm_postgrest_double as D
import test_rebuild_net_income_anchor as ANCHOR
from engine.api import pipeline as _pipeline
from engine.api._comparatives import compare_payloads
from engine.comparatives import (
    LINE_SPECS,
    build_comparative_columns,
    PCT_BASE_FLOOR,
    STATUS_ABSENT_BOTH,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    STATUS_COMPARED,
    STATUS_COMPARED_NO_BASE,
    SYNTHETIC,
    spec_for,
)
from engine.comparatives.analysis import TOP_MOVERS_DEFAULT, canonical_totals
from engine.comparatives.lines import ZERO_FLOOR
from engine.country_packs.ro_romania.chart_of_accounts import (
    _CANONICAL_TO_LEGACY_BUCKET,
    bucket_for,
)
from engine.country_packs.ro_romania.detail_level import SYNTHETIC_MAX_DIGITS, account_code_depth

REPO = Path(__file__).resolve().parents[2]
BASELINES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
             / "fixtures" / "regression_baselines")

#: The rows a reader calls the statement: every one is a sum the assembler
#: serves, and every one is what the P&L / balance-sheet tabs print with
#: a compare column beside it.
#: The bucket-backed sub-aggregates a book may carry. Their buckets are
#: the CANONICAL names the persisted `bucket` folds away, which is why the
#: served shape hid them (the P&L ones join the lossless claim: every one
#: of the nine has a pack rule of at most four digits, so the four-digit
#: fold cannot move them — measured below, not asserted).
PL_SUB_AGGREGATES = ("pl.interest_income", "pl.opex_third_party")
BS_SUB_AGGREGATES = (
    "bs.ar_doubtful_gross", "bs.ar_provisions", "bs.ar_intercompany",
    "bs.cash_fx_component", "bs.ppe_under_construction", "bs.ppe_advances",
    "bs.ap_dividends",
)
SUB_AGGREGATES = PL_SUB_AGGREGATES + BS_SUB_AGGREGATES

PL_HEADLINES = (
    "pl.revenue", "pl.cogs", "pl.opex_total", "pl.depreciation",
    "pl.ebitda", "pl.ebit", "pl.pretax", "pl.tax",
    "pl.net_income_operational", "pl.net_income",
) + PL_SUB_AGGREGATES
BS_HEADLINES = (
    "bs.total_assets", "bs.total_equity", "bs.total_liabilities",
    "bs.cash", "bs.inventory", "bs.trade_receivables_net",
    "bs.trade_payables", "bs.total_current_assets",
    "bs.total_non_current_assets", "bs.total_debt",
) + BS_SUB_AGGREGATES
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
    """Did this period's book feed any of the line's buckets?

    Read off the PACK'S RULE for each leaf's account code — the
    classification the assembler summed — and the persisted name beside
    it; never off `canonical_bucket`, which the served shape does not
    carry (and which the route core, the thing under test, is what puts
    back). A leaf whose rule lands in the line's buckets means the book
    disclosed the line, whatever name persistence gave the row."""
    spec = spec_for(key)
    buckets = set(spec.source_buckets)
    if not buckets:
        return True
    for li in payload.get("line_items") or []:
        if li.get("bucket") in buckets:
            return True
        rule = bucket_for(str(li.get("ro_account_code") or ""))
        if rule is not None and rule.bucket in buckets:
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
        # The baselines were captured off the assembler and carry
        # `canonical_bucket`; the served shape does not.
        "line_items": [F.served_line_item(li) for li in env.get("lineItems") or []],
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


# ── 7. The column model itself never calls a non-zero served field absent ──

def test_the_column_model_never_calls_a_non_zero_served_field_absent_even_on_the_raw_served_shape(books):
    """Below the route core, on the RAW served shape — line items exactly
    as `GET /api/period` serves them, no canonical bucket resolved onto
    them — the column model still reads every headline a book holds. An
    assembled field above the floor is a sum over leaves the book holds,
    so coverage (a reading of the same leaves) cannot contradict it; when
    the vocabulary does, the served figure is the fact. The pre-repair
    order ran the coverage check first and read all nine sub-aggregate
    lines absent here; the zero case stays coverage-decided and is held
    by the fed-zero plant below."""
    ids = [cid for cid in F.REAL_BOOKS if cid in books]
    cur, pri = books[ids[0]], books[ids[1]]
    raw_cur = {"statements": cur["statements"], "lineItems": list(cur["line_items"])}
    raw_pri = {"statements": pri["statements"], "lineItems": list(pri["line_items"])}
    assert all("canonical_bucket" not in li for li in raw_cur["lineItems"] + raw_pri["lineItems"])
    table = build_comparative_columns(raw_cur, raw_pri, SYNTHETIC, SYNTHETIC)
    held = 0
    for key in HEADLINES:
        col = table.by_key(key)
        for side, payload in (("current", cur), ("prior", pri)):
            want = _served_figure(payload, key)
            if abs(want) >= ZERO_FLOOR:
                held += 1
                got = getattr(col, side)
                assert got is not None and _cents(got, want), (key, side, got, want)
    assert held >= len(HEADLINES), held


# ── 8. The payloads are the served shape ──────────────────────────────

def test_every_payload_the_gate_compares_is_served_shaped(books, condensed):
    """Non-vacuity of the shape claim: not one line item carries the
    assembler's `canonical_bucket`, every persisted `bucket` is a
    persistence name (never a canonical-only one), and every book holds
    at least one leaf whose pack rule is a fine bucket the persisted name
    folds away — so the served shape really does hide what the nine
    lines need, on every book this gate compares."""
    payloads = list(books.items()) + [(cid + "@4", p) for cid, (p, _m) in condensed.items()]
    assert len(payloads) >= 4
    for label, payload in payloads:
        items = payload["line_items"]
        assert items, label
        hidden = 0
        for li in items:
            assert "canonical_bucket" not in li, (label, li)
            assert li["bucket"] not in _CANONICAL_TO_LEGACY_BUCKET, (label, li)
            rule = bucket_for(str(li.get("ro_account_code") or ""))
            if rule is not None and rule.bucket in _CANONICAL_TO_LEGACY_BUCKET:
                assert li["bucket"] == _CANONICAL_TO_LEGACY_BUCKET[rule.bucket] or li["bucket"] != rule.bucket, (label, li)
                hidden += 1
        assert hidden >= 1, "%s persists no fine bucket under a legacy name" % label


# ── 9. The movers are the columns' own ranking, sub-aggregates in it ──

def _ranking_from_columns(doc: Mapping[str, Any], floor: float, top_n: int):
    """The mover ranking recomputed from the served columns alone: every
    bucket-backed line that moved, |Δ| over the current period's base,
    at or above the floor, materiality descending then key."""
    cols = _columns(doc)
    bases = {"PL": cols["pl.revenue"]["current"], "BS": cols["bs.total_assets"]["current"]}
    ranked = []
    below = 0
    for col in doc["columns"]:
        spec = spec_for(col["key"])
        if not spec.source_buckets or col["status"] not in (STATUS_COMPARED, STATUS_COMPARED_NO_BASE):
            continue
        base = bases.get(col["statement"])
        if base is None or abs(base) < ZERO_FLOOR or col["delta"] is None:
            continue
        materiality = abs(col["delta"]) / abs(base)
        if materiality < floor:
            below += 1
            continue
        ranked.append((-round(materiality, 6), col["key"], round(materiality, 6)))
    ranked.sort()
    return [(k, m) for _neg, k, m in ranked[:top_n]], below


@pytest.mark.parametrize("cur_id,pri_id", PAIRS, ids=["%s-vs-%s" % p for p in PAIRS])
def test_the_top_movers_are_the_served_columns_own_ranking_on_every_real_pair(books, cur_id, pri_id):
    if cur_id not in books or pri_id not in books:
        pytest.skip("corpus book missing")
    doc = _compare(books[cur_id], books[pri_id])
    mv = doc["movers"]
    want, below = _ranking_from_columns(doc, mv["materiality_floor"], TOP_MOVERS_DEFAULT)
    assert [(m["key"], m["materiality"]) for m in mv["top"]] == want
    assert mv["below_floor"] == below
    cols = _columns(doc)
    for m in mv["top"]:
        col = cols[m["key"]]
        assert (m["current"], m["prior"], m["delta"], m["delta_pct"]) == (
            col["current"], col["prior"], col["delta"], col["delta_pct"]), m["key"]


def test_a_sub_aggregate_ranks_among_the_top_movers_on_the_real_pairs(books):
    """Census, so the ranking test above cannot pass over a document in
    which the nine lines are never candidates: measured 2026-09-26, a
    sub-aggregate line is in the top eight on 15 of the 20 real pairs.
    The floor here is deliberately low — the claim is that they CAN rank,
    and that when a sub-aggregate column is compared and material it is
    ranked exactly where the columns put it."""
    hits = []
    ranked = 0
    for cur_id, pri_id in PAIRS:
        if cur_id not in books or pri_id not in books:
            continue
        doc = _compare(books[cur_id], books[pri_id])
        top = [m["key"] for m in doc["movers"]["top"]]
        if any(k in SUB_AGGREGATES for k in top):
            hits.append((cur_id, pri_id))
        want, _below = _ranking_from_columns(doc, doc["movers"]["materiality_floor"], TOP_MOVERS_DEFAULT)
        for key, _m in want:
            if key in SUB_AGGREGATES:
                ranked += 1
                assert key in top, (cur_id, pri_id, key)
    assert hits, "no real pair ranks a sub-aggregate line among its top movers"
    assert ranked >= len(hits)


# ── 10. A fine bucket fed at zero is a disclosed zero, not an absence ──

def test_a_fine_bucket_the_book_feeds_at_zero_is_a_disclosed_zero_not_an_absence(books):
    """The one case the corpus does not carry (measured 2026-09-26: every
    fed sub-aggregate is non-zero on all five books): a book holding FX-
    cash rows that sum to nothing. Planted on a served-shaped copy — the
    rows' amounts and the field they sum to set to 0.00 together, so the
    plant is consistent — the line reads 0.00 `reported` on that side; the
    book disclosed the account. The other side is the same book with
    every FX-cash row removed and the field at 0.00: the absence, honest.
    A model that lets coverage decide a non-zero (the pre-repair order)
    or one that cannot see the fine bucket on the served shape both read
    the planted side absent and turn this red."""
    ids = [cid for cid in F.REAL_BOOKS if cid in books]
    cur = copy.deepcopy(books[ids[0]])
    pri = copy.deepcopy(books[ids[1]])

    def _is_fx(li):
        rule = bucket_for(str(li.get("ro_account_code") or ""))
        return rule is not None and rule.bucket == "cash_fx"

    fed_rows = [li for li in cur["line_items"] if _is_fx(li)]
    assert fed_rows, "%s carries no FX-cash row" % ids[0]
    assert all("canonical_bucket" not in li for li in fed_rows)
    for li in fed_rows:
        li["amount"] = 0.0
    cur["statements"]["assembled_bs"]["cash_fx_component"] = 0.0
    pri["line_items"] = [li for li in pri["line_items"] if not _is_fx(li)]
    pri["statements"]["assembled_bs"]["cash_fx_component"] = 0.0
    doc = _compare(cur, pri)
    col = _columns(doc)["bs.cash_fx_component"]
    assert col["current"] == 0.0 and col["current_disclosure"] == "reported", col
    assert col["prior"] is None and col["prior_disclosure"] == "absent", col
    assert col["status"] == STATUS_ABSENT_PRIOR and col["delta"] is None and col["delta_pct"] is None, col
    assert "absent, which is not zero" in col["note"], col["note"]


# ── 11. THE SERVED PATH: the real persist seam and the real routes ────
#
# Sections 1–10 compare envelopes the fixtures module SHAPES like the
# served body. This section removes the shaping. Every real corpus book
# AND its condensed counterpart is carried through the production write
# seam — parse -> `stage_map` -> `stage_persist` over the persist double
# (`corpus_replay.fake_persist_seam`, the seam `run_pipeline` writes
# through) — what `stage_persist` INSERTED is seeded into the projection-
# faithful tenancy double (`firm_postgrest_double`: it refuses a column no
# migration declares) beside a `documents` row naming each file, and the
# periods are read back through `engine.api.create_app()` itself with a
# real ES256 bearer: GET /api/period/{id} for each period (the served
# shape — persisted columns only, legacy buckets only) and GET
# /api/period/{cur}/comparatives?prior={pri} for every ordered pair of the
# real books and for every book beside its own condensed counterpart, both
# orientations. Nothing between the persisted rows and the served document
# is stubbed but the network.
#
# The gate's first version could not see the nine-line defect because no
# fixture of its had passed through `stage_persist`; these all have, so a
# coverage read that matches the persisted names again — or a `read_value`
# that lets coverage veto a non-zero served field — reds here on every
# pair, through the app, not only over a shaped envelope.

SERVED_USER = "7b0c0f3e-0000-4000-8000-00000000d0a1"
SERVED_ORG = "0c0f0000-0000-4000-8000-0000000000d1"
#: Label suffix of a book's condensed counterpart.
CONDENSED = "@4"

#: Every comparison the served section makes: the 20 real ordered pairs
#: and each book beside its condensed counterpart, both orientations.
SERVED_PAIRS = (PAIRS
                + [(cid, cid + CONDENSED) for cid in F.REAL_BOOKS]
                + [(cid + CONDENSED, cid) for cid in F.REAL_BOOKS])
_SERVED_IDS = ["%s-vs-%s" % p for p in SERVED_PAIRS]


def _period_id(label: str) -> str:
    return "p-" + label.replace(CONDENSED, "-4d")


def _filename(label: str) -> str:
    """The file seeded behind each period — what the served document must
    name for the column that holds it."""
    return label.replace(CONDENSED, "_condensed") + ".xlsx"


def _persisted_real(cid: str):
    """The corpus book through the production write path — the anchor
    gate's `_Book` (parse -> stage_map -> stage_persist), shared with it."""
    for case_id, case_dir, _p121 in ANCHOR.ANCHOR_CASES:
        if case_id == cid:
            return ANCHOR._book(case_id, case_dir)
    raise AssertionError("%s is not an anchor corpus case" % cid)


def _persisted_condensed(cid: str):
    """The condensed counterpart through the SAME write path: the folded
    rows of `_comparatives_fixtures.condensed_tb_rows` in place of the
    file's, every step after the parse exactly `_Book`'s."""
    from engine.api import pipeline as P

    pack = ANCHOR.corpus_replay.get_pack("RO")
    tb_rows, merged = F.condensed_tb_rows(cid)
    assert merged > 0, "%s merged no rows — it is not a deeper book" % cid
    _tb, shaped, _assembled = pack.assemble_parsed_tb(
        tb_rows, company_name=cid + "-condensed", period_label="Imported period")
    content = (F.CORPUS / cid / "input.xlsx").read_bytes()
    doc = {
        "id": "doc-%s-4d" % cid,
        "org_id": SERVED_ORG,
        "original_filename": _filename(cid + CONDENSED),
        "content_hash": "sha256-%s" % hashlib.sha256(content + b"@4").hexdigest(),
        "period_end_hint": "2024-12-31",
    }
    parsed = P._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows))
    assembled = P.stage_map(doc, parsed, None)
    with ANCHOR.corpus_replay.fake_persist_seam() as fake:
        period_id = P.stage_persist(doc, parsed, assembled)
        line_items = [dict(r) for r in fake.inserted_line_items]
        period = dict(fake.period_rows[0])
    return types.SimpleNamespace(doc=doc, period=period, line_items=line_items,
                                 period_id=period_id, persist_assembled=assembled)


@pytest.fixture(scope="module")
def served(books):
    """Every period served by the real app over the tenancy double, and
    every SERVED_PAIRS comparison the real route produced — captured once
    inside the installed double, so the tests below are pure reads of
    what the app served."""
    present = [cid for cid in F.REAL_BOOKS if cid in books]
    persisted = {}
    for cid in present:
        persisted[cid] = _persisted_real(cid)
        persisted[cid + CONDENSED] = _persisted_condensed(cid)
    app = RA.build_app()
    periods = []
    for label, bk in persisted.items():
        end = "2024-12-31" if label.endswith(CONDENSED) else "2025-12-31"
        periods.append((bk, _period_id(label), SERVED_ORG, end[:4] + "-01-01", end))
    double = RA.seed_double(
        orgs=[{"id": SERVED_ORG, "name": "Corpus Entity", "default_currency": "RON"}],
        memberships=[{"user_id": SERVED_USER, "org_id": SERVED_ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=periods)
    # The file behind each period, so the served document can name it.
    dcols = set(double.columns["documents"])
    for label, bk in persisted.items():
        row = {"id": bk.doc["id"], "org_id": SERVED_ORG, "original_filename": _filename(label),
               "status": "analyzed", "detected_type": "trial_balance"}
        double.add("documents", dict((k, v) for k, v in row.items() if k in dcols))
    bearer = D.mint_jwt(SERVED_USER)
    bodies, docs = {}, {}
    with RA.installed(double):
        RA.seed_metrics(app, double, [_period_id(l) for l in persisted], SERVED_ORG, bearer)
        for label in persisted:
            resp = RA.get(app, "/api/period/%s" % _period_id(label), bearer, SERVED_ORG)
            assert resp.status_code == 200, (label, resp.status_code, resp.text[:400])
            bodies[label] = resp.json()
        for cur, pri in SERVED_PAIRS:
            if cur not in persisted or pri not in persisted:
                continue
            resp = RA.get(app, "/api/period/%s/comparatives?prior=%s"
                          % (_period_id(cur), _period_id(pri)), bearer, SERVED_ORG)
            assert resp.status_code == 200, (cur, pri, resp.status_code, resp.text[:400])
            docs[(cur, pri)] = resp.json()
        rows = dict((r["id"], dict(r)) for r in double.rows("financial_periods"))
    return types.SimpleNamespace(
        bodies=bodies, docs=docs, rows=rows,
        inserted=dict((label, bk.line_items) for label, bk in persisted.items()))


def _served_doc(served, cur, pri):
    if (cur, pri) not in served.docs:
        pytest.skip("corpus book missing")
    return served.docs[(cur, pri)]


def test_the_route_serves_the_rows_stage_persist_inserted_and_nothing_the_persist_step_dropped(served):
    """Non-vacuity of the served shape, on every period the app served —
    the ledgers and the condensed counterparts alike: the line items are
    exactly the rows `stage_persist` inserted, projected to the persisted
    columns (no `canonical_bucket`, every `bucket` a persistence name),
    and every period holds a leaf whose pack rule is a fine bucket the
    persisted name folds away. The served shape really does hide what the
    nine lines need, on every book this section compares."""
    assert len(served.bodies) >= 4
    for label, body in served.bodies.items():
        items = body["line_items"]
        assert items, label

        def _row(li):
            return (li["statement"], li["bucket"], li["ro_account_code"],
                    round(float(li["amount"] or 0), 2))

        assert sorted(_row(li) for li in items) == sorted(_row(li) for li in served.inserted[label]), label
        hidden = 0
        for li in items:
            assert set(li) == set(F.PERSISTED_LINE_ITEM_KEYS), (label, sorted(li))
            assert li["bucket"] not in _CANONICAL_TO_LEGACY_BUCKET, (label, li)
            rule = bucket_for(str(li.get("ro_account_code") or ""))
            if rule is not None and rule.bucket in _CANONICAL_TO_LEGACY_BUCKET:
                hidden += 1
        assert hidden >= 1, "%s persists no fine bucket under a legacy name" % label


@pytest.mark.parametrize("cur,pri", SERVED_PAIRS, ids=_SERVED_IDS)
def test_every_headline_a_period_holds_is_its_served_figure_through_the_real_routes(served, cur, pri):
    """Through the real app, on every served pair: each side of every
    headline column — the P&L spine, the balance-sheet spine and the nine
    sub-aggregates — is THAT period's served figure to the cent, or an
    absence its book justifies (disclosure absent, served field below the
    floor, no leaf in the bucket by the pack's rule for its code). Δ and
    Δ % are the engine's. The pre-repair app read all nine sub-aggregate
    lines absent here whatever the bodies served."""
    doc = _served_doc(served, cur, pri)
    cb, pb = served.bodies[cur], served.bodies[pri]
    assert doc["comparability"]["comparable"], doc["comparability"]["reason"]
    cols = _columns(doc)
    checked = 0
    for key in HEADLINES:
        col = cols[key]
        cur_ok = _check_side(col, "current", cb, key, cur)
        pri_ok = _check_side(col, "prior", pb, key, pri)
        if not (cur_ok and pri_ok):
            assert col["status"] in _ABSENT_STATUSES, (key, col)
            assert col["delta"] is None and col["delta_pct"] is None, (key, col)
            checked += 1
            continue
        want_cur = _served_figure(cb, key)
        want_pri = _served_figure(pb, key)
        assert _cents(col["delta"], round(want_cur - want_pri, 2)), (key, col["delta"])
        if abs(want_pri) < PCT_BASE_FLOOR:
            assert col["status"] == STATUS_COMPARED_NO_BASE and col["delta_pct"] is None, col
        else:
            assert col["status"] == STATUS_COMPARED, col
            assert col["delta_pct"] == round((want_cur - want_pri) / abs(want_pri), 6), col
        checked += 1
    assert checked == len(HEADLINES)


def test_the_nine_sub_aggregate_lines_are_reported_through_the_real_route_wherever_a_period_holds_them(served):
    """Census over every served pair, so the pair test above cannot pass
    over documents in which the nine lines are never held: each of the
    nine is `reported` on every side whose served field is above the
    floor, to the cent, with no note saying "neither period reported"
    beside it. Non-vacuity: at least seven of the nine are held above the
    floor by some served period, and the reported sides number in the
    hundreds (measured 2026-09-26 through the app: seven of nine and 360
    sides — every line but dividends payable, which no corpus book
    carries above the floor though the real client pair does, and
    receivable provisions, which the RO pack emits as contra `ar` and
    never feeds). Before the repair every one read absent."""
    held = set()
    reported = 0
    for (cur, pri), doc in served.docs.items():
        cols = _columns(doc)
        for key in SUB_AGGREGATES:
            for side, label in (("current", cur), ("prior", pri)):
                want = _served_figure(served.bodies[label], key)
                if abs(want) < ZERO_FLOOR:
                    continue
                held.add(key)
                col = cols[key]
                assert col[side + "_disclosure"] == "reported", (cur, pri, key, side, col)
                assert _cents(col[side], want), (cur, pri, key, side, col[side], want)
                assert "neither period reported" not in col["note"], (cur, pri, key, col["note"])
                reported += 1
    assert len(held) >= 7, sorted(held)
    assert reported >= 100, reported


@pytest.mark.parametrize("cur,pri", SERVED_PAIRS, ids=_SERVED_IDS)
def test_the_served_document_is_compare_payloads_over_the_two_bodies_the_same_app_served(served, cur, pri):
    """No second composition on the route: the columns, movers, bridges,
    common-size rows, coverage sources, comparability verdict and both
    period blocks the route served are `compare_payloads` over the two
    GET /api/period bodies the same app served — so sections 1–10
    (offline, over `compare_payloads`) and this section (through the app)
    gate ONE document, not two that may drift."""
    doc = _served_doc(served, cur, pri)
    again = compare_payloads(
        served.bodies[cur], served.bodies[pri],
        current_row=served.rows[_period_id(cur)], prior_row=served.rows[_period_id(pri)],
        caen=None)
    for block in ("columns", "movers", "bridges", "common_size", "coverage_source",
                  "comparability", "current", "prior"):
        assert json.dumps(doc[block], sort_keys=True) == json.dumps(again[block], sort_keys=True), block


@pytest.mark.parametrize("cur,pri", SERVED_PAIRS, ids=_SERVED_IDS)
def test_the_served_document_names_the_file_each_column_holds(served, cur, pri):
    """The document's two period blocks name the `documents` row behind
    each period — the file a reader can check a column against — and it
    is the same file the served period body names."""
    doc = _served_doc(served, cur, pri)
    assert doc["current"]["source_document"]["filename"] == _filename(cur), doc["current"]
    assert doc["prior"]["source_document"]["filename"] == _filename(pri), doc["prior"]
    for label in (cur, pri):
        assert served.bodies[label]["period"]["source_document"]["filename"] == _filename(label)


@pytest.mark.parametrize("cur,pri", SERVED_PAIRS, ids=_SERVED_IDS)
def test_the_top_movers_are_the_served_columns_own_ranking_through_the_real_route(served, cur, pri):
    """The movers the route served are the served columns' own ranking —
    every bucket-backed compared line, |Δ| over the current period's own
    base, at or above the floor, materiality descending then key — with
    the sub-aggregates in it; and each mover's four figures are the
    column's, which are the two bodies' served figures."""
    doc = _served_doc(served, cur, pri)
    mv = doc["movers"]
    want, below = _ranking_from_columns(doc, mv["materiality_floor"], TOP_MOVERS_DEFAULT)
    assert [(m["key"], m["materiality"]) for m in mv["top"]] == want
    assert mv["below_floor"] == below
    cols = _columns(doc)
    for m in mv["top"]:
        col = cols[m["key"]]
        assert (m["current"], m["prior"], m["delta"], m["delta_pct"]) == (
            col["current"], col["prior"], col["delta"], col["delta_pct"]), m["key"]
        assert _cents(m["current"], _served_figure(served.bodies[cur], m["key"])), m["key"]
        assert _cents(m["prior"], _served_figure(served.bodies[pri], m["key"])), m["key"]


def test_a_sub_aggregate_ranks_among_the_top_movers_through_the_real_route(served):
    """Census, so the ranking test cannot pass over documents in which the
    nine lines are never candidates: on the served pairs a sub-aggregate
    line ranks among the top movers on at least ten (measured 2026-09-26
    through the app: 15 of the 30 served pairs, all real-vs-real — a
    book beside its own counterpart moves nothing), and every
    sub-aggregate the columns rank is in the served top."""
    hits = []
    for (cur, pri), doc in served.docs.items():
        top = [m["key"] for m in doc["movers"]["top"]]
        want, _below = _ranking_from_columns(doc, doc["movers"]["materiality_floor"], TOP_MOVERS_DEFAULT)
        for key, _m in want:
            if key in SUB_AGGREGATES:
                assert key in top, (cur, pri, key)
        if any(k in SUB_AGGREGATES for k in top):
            hits.append((cur, pri))
    assert len(hits) >= 10, hits


_SERVED_ORIENT = [(cid, o) for cid in F.REAL_BOOKS for o in ("ledger-current", "ledger-prior")]


@pytest.mark.parametrize("cid,orient", _SERVED_ORIENT, ids=["%s/%s" % p for p in _SERVED_ORIENT])
def test_a_book_against_its_own_condensed_counterpart_moves_nothing_on_the_pl_through_the_real_route(served, cid, orient):
    """Section 3 through the app: the ledger beside its own condensed
    counterpart, both persisted and served, compares at the synthetic
    level, moves nothing on any P&L headline — the sub-aggregates
    included — and closes its three bridges."""
    pair = (cid, cid + CONDENSED) if orient == "ledger-current" else (cid + CONDENSED, cid)
    doc = _served_doc(served, *pair)
    assert doc["comparability"]["comparable"] is True
    assert doc["comparability"]["level"] == SYNTHETIC
    cols = _columns(doc)
    for key in PL_HEADLINES:
        col = cols[key]
        if col["status"] in _ABSENT_STATUSES:
            assert col["delta"] is None, (key, col)
            continue
        assert col["status"] in (STATUS_COMPARED, STATUS_COMPARED_NO_BASE), (key, col)
        assert col["delta"] == 0.0, "%s moved %r across a depth difference" % (key, col["delta"])
    for name in ("pl", "bs_assets", "bs_liabilities_equity"):
        b = doc["bridges"][name]
        assert b["closes"] is True and b["residual"] == 0.0, (name, b["reason"])


@pytest.mark.parametrize("cid", F.REAL_BOOKS)
def test_the_offline_envelope_and_the_served_body_carry_the_same_headline_figures(books, condensed, served, cid):
    """The two halves of this gate read one book the same way: every
    headline the offline fixture serves (the offline assembler) equals
    what the app served for the same rows through stage_map ->
    stage_persist -> GET /api/period, to the cent — on the ledger and on
    its condensed counterpart. A field the two paths disagree on is a
    second assembly, and the gate would be green over a product that does
    not exist."""
    if cid not in books:
        pytest.skip("corpus book missing")
    for label, offline in ((cid, books[cid]), (cid + CONDENSED, condensed[cid][0])):
        body = served.bodies[label]
        for key in HEADLINES:
            assert _cents(_served_figure(offline, key), _served_figure(body, key)), (
                label, key, _served_figure(offline, key), _served_figure(body, key))
