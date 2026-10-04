"""GATE common-size-single — "% of turnover" on ONE period, and which way
time runs between two.

THE OWNER'S RULING (2026-10-04): "'% din venituri' must work for a single
year without a comparison. Engine change, with a gate." The dashboard's
share column ("% din venituri" on the P&L, "% din total active" on the
balance sheet) was painted from the two-period comparatives document, so a
company with one year on file — or its earliest year on screen — had none.
The engine now serves the shares of ONE period on the period payload
(`statements.common_size`, schema common_size/1), computed by the very
function the comparison's two sides run (`engine.comparatives.shares`).

A SECOND FINDING, measured while building this: the balance-sheet tab does
not render the registry's `bs.*` lines at all. It renders the canonical
object (bs_v2) row by row, and its share cell DIVIDED IN THE BROWSER
(`BsCmpCells`: closing / |total assets|). So the block — and the two-period
document — also carry the canonical rows (`bs.row.<id>`), section
subtotals (`bs.section.<id>`) and grand totals (`bs.total.*`), each a share
of the canonical object's own total assets.

THE SAME SURFACE'S OTHER DEFECT (review of 2026-10-04): the picker lets a
reader compare with a period that closes AFTER the one on screen. Δ is then
current − later, and "improved / deteriorated" judged on it reads history
backwards. The document now says which way time runs (`direction`) and
serves no verdict unless it runs forward.

WHAT THIS GATE HOLDS

  S1  ONE COMPUTATION. Over every corpus pair the comparatives gates build
      (every ordered pair of the corpus books, each real book beside its
      own re-aggregation in both orientations, the analytic book beside its
      condensed derivation), offline and through the real route:
      single(current).share == the document's current_share and
      single(prior).share == its prior_share, for EVERY key, to the last
      served digit — and the document's status is what the two periods'
      own statuses imply. Both documents take every share at one division
      site.
  S2  SERVED. `GET /api/period/{id}` on `engine.api.create_app()` (no fake
      store: the tenancy double, a real ES256 bearer, books carried through
      stage_map -> stage_persist) carries the block for every corpus book,
      schema exact; it is `_comparatives.common_size_block` of the body the
      route returned; the same request twice gives identical bytes; nothing
      is persisted.
  S3  ABSENT IS NOT ZERO. A refused line, an absent line and a base below
      the zero floor carry NO share and say why; a share exists only under
      the share status.
  S5  A LATER PRIOR SERVES NO VERDICT. Swap current and prior: the
      direction is `prior_is_later`, every verdict is null and both lists
      are empty, every column's delta is the exact negative, the bridges
      close as before, the ranking and every figure are what they were.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11): a second division site (the
single block computed its own way, or the two-period row no longer taking
its sides from `side_shares`); a different rounding or zero floor on one of
the two documents; the block attached before a later step changes a figure
it read; the block missing, renamed, re-keyed or persisted; a share served
under any status but `share`, or 0.0 for an absent / refused line or under
a zero base; a canonical row measured against a base other than the
canonical total; verdicts served on a later or unreadable prior; a
withheld verdict taking a figure, a delta, a bridge step or a share with it.

WHAT IT CANNOT SEE: whether the page prints the block (the frontend gate
`single-year-share`); the Ratios tab's own band movements and the command
bar's "what changed" lines under a later prior (`ratios.band_movements`,
`engine.attention` — neither reads `direction` yet; out of this lane's
scope, reported to the owner); the exported report / workbook's own share
column; whether a share is the RIGHT economic reading of a line (a
negative base is taken in absolute value, as the two-period document
always did).

WITNESSES. Every shape is a corpus book except three, constructed on a
copy of one and said so where they are built: a refused EBITDA on a book
that is otherwise clean (the committed LEGACY baseline is the real one,
through the route), a DISCLOSED zero base (the corpus's zero-turnover books
do not disclose turnover at all — their base is absent, which is the other
no-base shape), and an unreadable period close.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import ast
import copy
import importlib.util
import itertools
import json
import re
import types
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

import pytest

import _comparatives_fixtures as F
import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D
import test_comparatives_depth_parity as DP
import test_net_711_rule as N
from engine.api import _comparatives as C
from engine.comparatives import LINE_SPECS, build_comparative_columns, shares, spec_for
from engine.comparatives import analysis as A
from engine.comparatives.columns import (
    DISCLOSURE_ABSENT,
    DISCLOSURE_NOT_AT_LEVEL,
    DISCLOSURE_REFUSED,
    STATUS_ABSENT_BOTH,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    STATUS_COMPARED,
    STATUS_COMPARED_NO_BASE,
    STATUS_INCOMPARABLE,
    STATUS_NOT_DISCLOSED,
    STATUS_REFUSED,
)
from engine.comparatives.lines import ZERO_FLOOR
from engine.ratios import margin_meaning as MM

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src" / "engine"

SHARE, NO_BASE = shares.STATUS_SHARE, shares.STATUS_NO_BASE
NOT_MEANINGFUL = shares.STATUS_NOT_MEANINGFUL
ROW_KEYS = ("key", "statement", "base_key", "current", "share", "status", "note")

#: A side of a row that holds a figure.
HAS_VALUE = (SHARE, NO_BASE, NOT_MEANINGFUL)
#: The lines whose share of turnover IS a margin (a result over turnover):
#: {key: the margin's name}.
MARGIN_LINES = dict((spec.key, spec.margin) for spec in LINE_SPECS if spec.margin)
#: …and, of those, the ones the ratio table has a row for: {key: ratio key}.
TABLE_MARGIN_LINES = dict((key, margin) for key, margin in MARGIN_LINES.items()
                          if margin in MM.margin_keys())
#: The statuses under which the PAIR refuses the line: no share on either side.
PAIR_REFUSALS = (STATUS_REFUSED, STATUS_NOT_DISCLOSED, STATUS_INCOMPARABLE, STATUS_ABSENT_BOTH)


# ── the corpus, offline ───────────────────────────────────────────────

def _corpus_books() -> Dict[str, Dict[str, Any]]:
    return dict((cid, F.envelope_for(cid)) for cid in F.CANDIDATES
                if (F.CORPUS / cid / "input.xlsx").is_file())


def _offline_pairs():
    """Every pair the comparatives gates build: (label, current, prior)."""
    books = _corpus_books()
    pairs = [("%s-vs-%s" % (a, b), books[a], books[b])
             for a, b in itertools.permutations(books, 2)]
    for cid in F.REAL_BOOKS:
        if cid not in books:
            continue
        reagg, merged = F.reaggregate_to_synthetic(cid)
        assert merged > 0, cid
        pairs.append(("%s-vs-its-reaggregation" % cid, books[cid], reagg))
        pairs.append(("%s-reaggregation-vs-itself" % cid, reagg, books[cid]))
    analytic, _synthetic = F.pick_pair()
    if analytic is not None:
        condensed = F.condense(analytic[1])
        pairs.append(("%s-vs-condensed" % analytic[0], analytic[1], condensed))
        pairs.append(("condensed-vs-%s" % analytic[0], condensed, analytic[1]))
    return pairs


def _block(env: Mapping[str, Any]) -> Dict[str, Any]:
    return A.period_common_size(env, F.level_of(env))


def _rows(block: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    out = dict((r["key"], r) for r in block["rows"])
    assert len(out) == len(block["rows"]), "a key appears twice in one block"
    return out


def _table(cur, pri):
    return build_comparative_columns(cur, pri, F.level_of(cur), F.level_of(pri), "cur", "pri")


def _document_rows(cur, pri):
    """The two-period common-size rows exactly as `compare_payloads` composes
    them, and the pair's column statuses."""
    table = _table(cur, pri)
    rows = A.common_size(table) + A.canonical_common_size(cur, pri, table)
    return rows, dict((c.key, c) for c in table.columns), table


def _side_status(row: Optional[Mapping[str, Any]]) -> str:
    """A period's own status for a key; a canonical row the period's object
    does not carry is absent there."""
    return DISCLOSURE_ABSENT if row is None else row["status"]


def _pair_status(cs: str, ps: str) -> str:
    """What two periods' own statuses say about the PAIR — written here
    from the column model's rules, not read off the engine."""
    if DISCLOSURE_NOT_AT_LEVEL in (cs, ps):
        return STATUS_NOT_DISCLOSED
    if DISCLOSURE_REFUSED in (cs, ps):
        return STATUS_REFUSED
    if cs in HAS_VALUE and ps in HAS_VALUE:
        return STATUS_COMPARED
    if cs in HAS_VALUE:
        return STATUS_ABSENT_PRIOR
    if ps in HAS_VALUE:
        return STATUS_ABSENT_CURRENT
    return STATUS_ABSENT_BOTH


def _expected_row_status(cs: str, ps: str, comparable: bool = True) -> str:
    if not comparable:
        return STATUS_INCOMPARABLE
    pair = _pair_status(cs, ps)
    if pair in PAIR_REFUSALS:
        return pair
    if NO_BASE in (cs, ps):
        return "no_base"
    if NOT_MEANINGFUL in (cs, ps):
        return NOT_MEANINGFUL
    return pair


def _hold_identity(label, doc_rows, cur_block, pri_block, comparable=True) -> int:
    """S1 on one pair: every key, both sides, shares and statuses."""
    cur, pri = _rows(cur_block), _rows(pri_block)
    seen = set()
    for row in doc_rows:
        key = row["key"] if isinstance(row, Mapping) else row.key
        get = (lambda f: row[f]) if isinstance(row, Mapping) else (lambda f: getattr(row, f))
        seen.add(key)
        c, p = cur.get(key), pri.get(key)
        want = _expected_row_status(_side_status(c), _side_status(p), comparable)
        assert get("status") == want, (label, key, get("status"), want, c and c["status"], p and p["status"])
        if want in PAIR_REFUSALS:
            # The PAIR refuses the line (one period refused it, the two books
            # are not comparable, …): no share on EITHER side, whatever each
            # period's own block carries.
            assert (get("current_share"), get("prior_share"), get("delta_pts")) == (None, None, None), (
                label, key, want, get("current_share"), get("prior_share"))
            continue
        assert get("current_share") == (None if c is None else c["share"]), (
            "%s %s: the document's current share %r is not the period's own %r"
            % (label, key, get("current_share"), c and c["share"]))
        assert get("prior_share") == (None if p is None else p["share"]), (
            "%s %s: the document's prior share %r is not the period's own %r"
            % (label, key, get("prior_share"), p and p["share"]))
        if get("current_share") is not None and get("prior_share") is not None:
            assert get("delta_pts") is not None, (label, key)
        else:
            assert get("delta_pts") is None, (label, key)
    # Nothing a period says is missing from the document, and nothing is
    # in the document that neither period says.
    assert seen == set(cur) | set(pri), (label, sorted(seen ^ (set(cur) | set(pri)))[:6])
    return 2 * len(doc_rows)


def test_one_computation_every_share_of_every_corpus_pair_is_the_periods_own():
    """S1, offline: 67+ pairs, every key, both sides, to the last digit."""
    pairs = _offline_pairs()
    assert len(pairs) >= 60, len(pairs)
    held = with_share = 0
    statuses = set()
    for label, cur, pri in pairs:
        doc_rows, cols, table = _document_rows(cur, pri)
        assert table.comparability.comparable, label
        cur_block, pri_block = _block(cur), _block(pri)
        held += _hold_identity(label, doc_rows, cur_block, pri_block)
        cur_rows = _rows(cur_block)
        for key, col in cols.items():
            # The registry side IS the column model's side: same figure, and
            # the pair's status is what the two sides imply.
            assert cur_rows[key]["current"] == col.current, (label, key)
            want = _pair_status(cur_rows[key]["status"], _rows(pri_block)[key]["status"])
            got = STATUS_COMPARED if col.status == STATUS_COMPARED_NO_BASE else col.status
            assert got == want, (label, key, col.status, want)
        with_share += sum(1 for r in doc_rows if r.current_share is not None)
        statuses |= set(r.status for r in doc_rows)
    # Non-vacuity: the pairs exercise the share, the two one-sided
    # absences, the absent base, the depth refusal and the margin rule.
    assert {"compared", "no_base", STATUS_ABSENT_PRIOR, STATUS_ABSENT_CURRENT,
            STATUS_ABSENT_BOTH, STATUS_NOT_DISCLOSED, NOT_MEANINGFUL} <= statuses, sorted(statuses)
    assert with_share >= 3000, with_share
    print("GATE-WORK common-size-single rows=%d pairs=%d" % (held, len(pairs)))


def _divisions(path: Path) -> Dict[str, int]:
    """{enclosing function: number of `/` operations} in one source file."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = {}  # type: Dict[str, int]
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        n = sum(1 for node in ast.walk(fn)
                if isinstance(node, (ast.BinOp, ast.AugAssign)) and isinstance(node.op, ast.Div))
        if n:
            out[fn.name] = out.get(fn.name, 0) + n
    return out


def test_both_documents_take_every_share_at_one_division_site(monkeypatch):
    """The structure S1's equality rests on. In source: `shares.take_share`
    holds the package's only share division, and no function that composes
    a common-size row divides. In behaviour: replace that one function and
    BOTH documents serve the replacement — on every key."""
    assert _divisions(SRC / "comparatives" / "shares.py") == {"take_share": 1}
    composing = ("_table_side", "_pair_row", "common_size", "canonical_side_lines",
                 "_canonical_line", "canonical_common_size", "period_common_size", "_absent_side")
    in_analysis = _divisions(SRC / "comparatives" / "analysis.py")
    assert not set(composing) & set(in_analysis), in_analysis
    assert "common_size_block" not in _divisions(SRC / "api" / "_comparatives.py")

    books = _corpus_books()
    cur, pri = books["saga_10_col_agras"], books["saga_10_col_carniprod"]
    monkeypatch.setattr(shares, "take_share",
                        lambda value, base: None if value is None or base is None else 0.123456)
    doc_rows, _cols, _table_ = _document_rows(cur, pri)
    single = _block(cur)["rows"]
    valued = [r for r in single if r["current"] is not None]
    assert len(valued) >= 80
    assert all(r["share"] == 0.123456 for r in valued), [r for r in valued if r["share"] != 0.123456][:3]
    shared = [r for r in doc_rows if r.current_share is not None]
    assert len(shared) >= 80
    assert all(r.current_share == 0.123456 for r in shared)
    assert all(r.prior_share in (None, 0.123456) for r in doc_rows)


def test_a_share_exists_only_under_the_share_status_and_is_the_line_over_its_base():
    """S3's shape law over every block this file can build offline: the
    corpus books and each real book's re-aggregation."""
    envs = list(_corpus_books().items())
    envs += [(cid + "@4", F.reaggregate_to_synthetic(cid)[0]) for cid in F.REAL_BOOKS
             if (F.CORPUS / cid / "input.xlsx").is_file()]
    checked = empty_sections = 0
    for label, env in envs:
        block = _block(env)
        assert set(block) == {"schema", "bases", "rows"}, (label, sorted(block))
        assert block["schema"] == A.COMMON_SIZE_SCHEMA == "common_size/1"
        rows = _rows(block)
        assert [r["key"] for r in block["rows"]][:len(LINE_SPECS)] == [s.key for s in LINE_SPECS], label
        for statement, base_key in shares.COMMON_SIZE_BASE.items():
            assert block["bases"][statement] == {"key": base_key, "value": rows[base_key]["current"]}, label
        for row in block["rows"]:
            assert set(row) == set(ROW_KEYS), (label, sorted(row))
            assert row["status"] in shares.SIDE_STATUSES, (label, row)
            base = rows.get(row["base_key"])
            if row["status"] == SHARE:
                assert row["current"] is not None and base is not None and base["current"] is not None
                assert abs(base["current"]) >= ZERO_FLOOR, (label, row)
                want = round(row["current"] / abs(base["current"]), shares.SHARE_DP)
                assert row["share"] == (0.0 if want == 0 else want), (label, row, want)
            else:
                assert row["share"] is None, (label, row)
                assert row["note"], (label, row)
                if row["status"] == NO_BASE:
                    assert row["current"] is not None, (label, row)
                    assert base is None or base["current"] is None or abs(base["current"]) < ZERO_FLOOR
                elif row["status"] == NOT_MEANINGFUL:
                    # The line is reported and its base is there: what is
                    # refused is the MARGIN, and only on a margin line.
                    assert row["current"] is not None and row["key"] in MARGIN_LINES, (label, row)
                    assert base is not None and abs(base["current"]) >= ZERO_FLOOR, (label, row)
                else:
                    assert row["current"] is None, (label, row)
            checked += 1
        # A section the object lists with no row in it and no balance is
        # ABSENT — never "0.0 % of total assets" for a section the book
        # does not have.
        cbs = env["statements"]["canonical_bs"]
        populated = set(r["section"] for r in cbs["rows"])
        for sec in cbs["sections"]:
            row = rows[A.CANONICAL_SECTION_PREFIX + sec["id"]]
            if sec["id"] not in populated and abs(sec["subtotal"]) < ZERO_FLOOR:
                empty_sections += 1
                assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_ABSENT, None, None), (label, row)
            else:
                assert row["current"] == round(float(sec["subtotal"]), 2), (label, row)
        # the same envelope, the same bytes
        again = A.period_common_size(copy.deepcopy(env), F.level_of(env))
        assert json.dumps(block, sort_keys=True) == json.dumps(again, sort_keys=True), label
    assert checked >= 1000 and empty_sections >= 10, (checked, empty_sections)


# ── S3: refused, absent, no base ──────────────────────────────────────

REFUSED_FIELDS = ("ebitda", "ebit", "gross_profit", "pretax")
REFUSED_KEYS = ("pl.ebitda", "pl.ebit", "pl.gross_profit", "pl.pretax", "pl.inventory_variation")


def _with_refused_ebitda(env: Dict[str, Any]) -> Dict[str, Any]:
    """CONSTRUCTED (no corpus book refuses its EBITDA through the offline
    path): the assembler's refusal shape on a copy of a clean book — the
    refused fields null, the typed reason beside them."""
    out = copy.deepcopy(env)
    pl = out["statements"]["assembled_pl"]
    for field in REFUSED_FIELDS:
        pl[field] = None
    pl["inventory_variation"] = dict(pl["inventory_variation"], value=None)
    pl["ebitda_refusal"] = {"code": "stock_variation_not_measurable",
                            "text_en": "the stock variation cannot be measured on this book",
                            "text_ro": "variația stocurilor nu poate fi măsurată pe această balanță",
                            "fields": list(REFUSED_FIELDS)}
    return out


def test_a_refused_line_has_no_share_and_says_why_and_takes_nothing_else_with_it():
    books = _corpus_books()
    clean = books["saga_10_col_agras"]
    refused = _with_refused_ebitda(clean)
    before, after = _rows(_block(clean)), _rows(_block(refused))
    for key in REFUSED_KEYS:
        assert before[key]["status"] == SHARE and before[key]["share"] is not None, key
        row = after[key]
        assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_REFUSED, None, None), row
        assert "the stock variation cannot be measured on this book" in row["note"], row["note"]
    # Every other line is what it was — a refusal is not contagious.
    for key, row in after.items():
        if key not in REFUSED_KEYS:
            assert row == before[key], key

    # In a PAIR the refusal is the pair's: no share on EITHER side of the
    # refused keys (the existing two-period law), while the clean period
    # read alone still carries its own. The one place the two documents
    # differ, and it is a refusal, not a second figure.
    other = books["saga_10_col_carniprod"]
    doc_rows, cols, _t = _document_rows(refused, other)
    by_key = dict((r.key, r) for r in doc_rows)
    alone = _rows(_block(other))
    for key in REFUSED_KEYS:
        assert cols[key].status == STATUS_REFUSED
        assert (by_key[key].status, by_key[key].current_share, by_key[key].prior_share) == (
            STATUS_REFUSED, None, None), by_key[key]
        assert alone[key]["status"] == SHARE and alone[key]["share"] is not None, key
    for key, row in by_key.items():
        if key not in REFUSED_KEYS:
            assert row.current_share == after[key]["share"] if key in after else row.current_share is None
            assert row.prior_share == (alone[key]["share"] if key in alone else None), key


def test_a_refusal_beside_a_figure_still_in_its_field_refuses_the_line():
    """CONSTRUCTED on a clean corpus book (the real ones are through the
    route, below): each refusal's own shape with the FIGURE LEFT IN ITS
    FIELD — the refusal is read before the value, and names its reason."""
    books = _corpus_books()
    clean, other = books["saga_10_col_agras"], books["saga_10_col_carniprod"]
    before = _rows(_block(clean))

    # (a) total equity short by a refused year's result: the figure stays in
    # `total_equity`, the completeness refusal rides beside it.
    env = copy.deepcopy(clean)
    assert env["statements"]["assembled_bs"]["total_equity"] > 1000
    env["statements"]["assembled_bs"]["total_equity_refusal"] = {
        "code": "account_121_anchor_absent", "kind": "incomplete", "missing": "current_year_result",
        "text_en": "total equity excludes the year's result, which is refused: planted reason",
        "text_ro": "capitalurile proprii nu includ rezultatul exercițiului, refuzat: motiv plantat"}
    after = _rows(_block(env))
    built_on_equity = ("bs.total_equity",) + A.CANONICAL_EQUITY_KEYS
    assert A.CANONICAL_EQUITY_KEYS == ("bs.section.equity", "bs.total.equity_plus_liabilities")
    for key in built_on_equity:
        assert before[key]["status"] == SHARE and before[key]["share"] is not None, key
        row = after[key]
        assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_REFUSED, None, None), row
        assert "planted reason" in row["note"], row["note"]
    # Nothing else moves: the equity ROWS are posted balances and keep their
    # shares, and so does every other line.
    for key, row in after.items():
        if key not in built_on_equity:
            assert row == before[key], key
    equity_rows = [r["id"] for r in clean["statements"]["canonical_bs"]["rows"] if r["section"] == "equity"]
    assert equity_rows and all(after[A.CANONICAL_ROW_PREFIX + rid]["status"] == SHARE for rid in equity_rows)
    # In a PAIR the column refuses it too — no movement on a refused equity —
    # and the canonical lines refuse on both sides, whichever period refused.
    for cur, pri in ((env, other), (other, env)):
        doc_rows, cols, _t = _document_rows(cur, pri)
        col = cols["bs.total_equity"]
        assert (col.status, col.delta, col.delta_pct) == (STATUS_REFUSED, None, None), col
        assert "planted reason" in col.note
        by_key = dict((r.key, r) for r in doc_rows)
        for key in built_on_equity:
            r = by_key[key]
            assert (r.status, r.current_share, r.prior_share, r.delta_pts) == (
                STATUS_REFUSED, None, None, None), r
            assert "planted reason" in r.note, r.note
        _hold_identity("refused-equity", doc_rows, _block(cur), _block(pri))

    # (b) a refused net result, by the refusal's own `fields` — with the
    # number still in the field, and with the field null.
    for left_in_field in (True, False):
        env = copy.deepcopy(clean)
        pl = env["statements"]["assembled_pl"]
        if not left_in_field:
            pl["net_income_statutory"] = None
        pl["net_income_refusal"] = {"code": "account_121_anchor_absent",
                                    "text_en": "the net result cannot be stated: planted reason",
                                    "fields": ["net_income_statutory", "net_margin"]}
        after = _rows(_block(env))
        row = after["pl.net_income"]
        assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_REFUSED, None, None), row
        assert "planted reason" in row["note"] and "did not report" not in row["note"], row["note"]
        for key, r in after.items():
            if key != "pl.net_income":
                assert r == before[key], key

    # (c) an EBITDA refusal whose refused fields still hold their numbers.
    env = copy.deepcopy(clean)
    env["statements"]["assembled_pl"]["ebitda_refusal"] = {
        "code": "stock_variation_not_measurable", "text_en": "planted reason", "fields": list(REFUSED_FIELDS)}
    after = _rows(_block(env))
    for key in REFUSED_KEYS:
        assert (after[key]["status"], after[key]["current"], after[key]["share"]) == (
            DISCLOSURE_REFUSED, None, None), after[key]


def test_a_margin_the_rule_refuses_is_not_served_as_a_share_offline():
    """THE ONE MARGIN RULE (packs/ratios/margin_meaning.yaml: "every surface
    that prints a margin over turnover asks that module first"). A result
    line's share of turnover IS a margin; where the rule refuses the
    period's margins, those lines carry no share — in the period's own block
    and on that period's side of any comparison — and every other line, and
    the other period, keep theirs. Corpus witness: the developer."""
    assert shares.STATUS_NOT_MEANINGFUL == MM.MARGIN_NOT_MEANINGFUL == "margin_not_meaningful"
    # Every result line of the registry, and no other: the four the ratio
    # table has a row for, by that row's key, and the two it has none for.
    assert TABLE_MARGIN_LINES == {"pl.gross_profit": "gross_margin", "pl.ebitda": "ebitda_margin",
                                  "pl.ebit": "operating_margin", "pl.net_income": "net_margin"}
    assert sorted(set(MARGIN_LINES) - set(TABLE_MARGIN_LINES)) == ["pl.net_income_operational", "pl.pretax"]
    books = _corpus_books()
    refusing = 0
    for cid, env in books.items():
        verdict, _inputs = MM.period_verdict(env["statements"])
        rows = _rows(_block(env))
        withheld = set(k for k, r in rows.items() if r["status"] == NOT_MEANINGFUL)
        if not verdict.refused:
            assert withheld == set(), (cid, withheld)
            continue
        refusing += 1
        assert withheld == set(k for k in MARGIN_LINES if rows[k]["current"] is not None) and withheld, cid
        display = MM.refusal_display(verdict, env["statements"].get("currency"))["en"]
        for key in withheld:
            row = rows[key]
            assert row["share"] is None and row["current"] is not None, row
            assert display in row["note"] and MARGIN_LINES[key] in row["note"], row["note"]
        # every other P&L line is the line over the base, as on any book
        base = rows["pl.revenue"]["current"]
        others = [r for r in rows.values() if r["statement"] == "PL" and r["status"] == SHARE]
        assert len(others) >= 7, cid
        for r in others:
            assert r["share"] == round(r["current"] / abs(base), shares.SHARE_DP) + 0.0, (cid, r)
    assert refusing >= 1, "no corpus book has its margins refused — the law is vacuous"

    developer, normal = books["saga_10_col_realestate"], books["saga_10_col_agras"]
    alone = _rows(_block(normal))
    for cur, pri, refused_side in ((developer, normal, "current"), (normal, developer, "prior")):
        doc_rows, cols, _t = _document_rows(cur, pri)
        by_key = dict((r.key, r) for r in doc_rows)
        for key in MARGIN_LINES:
            r = by_key[key]
            mine, theirs = (r.current_share, r.prior_share) if refused_side == "current" else (
                r.prior_share, r.current_share)
            assert r.status == NOT_MEANINGFUL and mine is None and r.delta_pts is None, r
            assert theirs == alone[key]["share"] and theirs is not None, (key, theirs)
            assert ("%s period" % refused_side) in r.note, r.note
            # The COLUMN is not a margin: the amount and its movement stand.
            assert cols[key].status == STATUS_COMPARED and cols[key].delta is not None, cols[key]


def test_the_zero_floor_is_half_a_cent_on_both_sides_of_it():
    """`take_share`'s floor, witnessed at the boundary (CONSTRUCTED: the
    smallest corpus base is in the hundreds): a base under half a cent is
    no base; a cent is one."""
    assert ZERO_FLOOR == 0.005
    assert shares.take_share(1.0, 0.004) is None and shares.take_share(1.0, -0.004) is None
    assert shares.take_share(1.0, 0.0) is None and shares.take_share(None, 5.0) is None
    assert shares.take_share(1.0, 0.005) == 200.0  # AT the floor is a base
    assert shares.take_share(1.0, 0.01) == 100.0 and shares.take_share(1.0, -0.01) == 100.0
    assert shares.take_share(0.0, 0.01) == 0.0
    clean = _corpus_books()["saga_10_col_agras"]
    for base, want in ((0.004, NO_BASE), (0.01, SHARE)):
        env = copy.deepcopy(clean)
        env["statements"]["assembled_bs"]["total_assets"] = base
        rows = _rows(_block(env))
        registry = [r for r in rows.values() if r["base_key"] == "bs.total_assets" and r["current"] is not None]
        assert len(registry) >= 15
        for r in registry:
            assert r["status"] == want, (base, r)
            if want == SHARE:
                assert r["share"] == round(r["current"] / base, shares.SHARE_DP) + 0.0, r
            else:
                assert r["share"] is None and ("%.3f zero floor" % ZERO_FLOOR) in r["note"], r


def test_a_pair_that_is_not_comparable_serves_no_share_on_any_row_offline():
    """A comparison the column model refuses (a book whose detail level
    cannot be established) carries no share on either side of ANY row —
    registry and canonical — while each period read alone keeps its own."""
    books = _corpus_books()
    cur, pri = books["saga_10_col_agras"], books["saga_10_col_carniprod"]
    table = build_comparative_columns(cur, pri, F.level_of(cur), "indeterminate", "cur", "pri")
    assert table.comparability.comparable is False
    registry = A.common_size(table)
    canonical = A.canonical_common_size(cur, pri, table)
    assert len(registry) == len(LINE_SPECS) and len(canonical) >= 40
    for row in registry + canonical:
        assert (row.status, row.current_share, row.prior_share, row.delta_pts) == (
            STATUS_INCOMPARABLE, None, None, None), row
        assert row.note == table.comparability.reason
    assert sum(1 for r in _block(cur)["rows"] if r["share"] is not None) >= 80


def test_an_absent_line_is_absent_never_zero_percent():
    """Corpus witness: the retail and the real-estate books carry no
    income-tax row at all."""
    books = _corpus_books()
    for cid in ("saga_10_col_retail", "saga_10_col_realestate"):
        env = books[cid]
        assert env["statements"]["assembled_pl"]["tax"] == 0.0, cid  # the dense field
        row = _rows(_block(env))["pl.tax"]
        assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_ABSENT, None, None), (cid, row)
        assert "absent, which is not zero" in row["note"]


def test_a_base_that_is_not_there_gives_no_share_to_any_line_of_its_statement():
    books = _corpus_books()
    # (a) Corpus witness: a book with no turnover row — the base is ABSENT.
    env = books["exact_zero"]
    rows = _rows(_block(env))
    assert rows["pl.revenue"]["status"] == DISCLOSURE_ABSENT and rows["pl.revenue"]["current"] is None
    pl = [r for r in rows.values() if r["statement"] == "PL"]
    assert all(r["share"] is None for r in pl)
    valued = [r for r in pl if r["current"] is not None]
    assert valued and all(r["status"] == NO_BASE for r in valued), valued
    assert all("pl.revenue is absent in this period" in r["note"] for r in valued)
    # …and the balance sheet, whose base IS there, is untouched by it.
    assert rows["bs.total_assets"]["share"] == 1.0 and rows["bs.total.assets"]["share"] == 1.0

    # (b) CONSTRUCTED: a DISCLOSED zero turnover (the revenue rows are in the
    # book; the figure is 0.00) — a base below the floor, the base line
    # itself included.
    zero = copy.deepcopy(books["saga_10_col_agras"])
    zero["statements"]["assembled_pl"]["revenue"] = 0.0
    rows = _rows(_block(zero))
    assert rows["pl.revenue"]["current"] == 0.0 and rows["pl.revenue"]["status"] == NO_BASE
    pl = [r for r in rows.values() if r["statement"] == "PL"]
    assert sum(1 for r in pl if r["current"] is not None) >= 15
    for r in pl:
        assert r["share"] is None, r
        if r["current"] is not None:
            assert r["status"] == NO_BASE and ("%.3f zero floor" % ZERO_FLOOR) in r["note"], r

    # (c) CONSTRUCTED: the two balance-sheet bases, each its own family's.
    nobs = copy.deepcopy(books["saga_10_col_agras"])
    nobs["statements"]["assembled_bs"]["total_assets"] = 0.0
    rows = _rows(_block(nobs))
    registry_bs = [r for r in rows.values() if r["base_key"] == "bs.total_assets" and r["current"] is not None]
    assert registry_bs and all(r["status"] == NO_BASE and r["share"] is None for r in registry_bs)
    canonical = [r for r in rows.values() if r["base_key"] == A.CANONICAL_BASE_KEY]
    assert sum(1 for r in canonical if r["status"] == SHARE) >= 30  # one object, one base
    for total in ("assets",):
        gone = copy.deepcopy(books["saga_10_col_agras"])
        gone["statements"]["canonical_bs"]["totals"][total] = 0.0
        rows = _rows(_block(gone))
        canonical = [r for r in rows.values() if r["base_key"] == A.CANONICAL_BASE_KEY and r["current"] is not None]
        assert canonical and all(r["status"] == NO_BASE and r["share"] is None for r in canonical), canonical[:2]


def test_a_period_with_no_canonical_object_serves_the_registry_lines_alone():
    env = copy.deepcopy(_corpus_books()["saga_10_col_agras"])
    del env["statements"]["canonical_bs"]
    rows = _block(env)["rows"]
    assert [r["key"] for r in rows] == [s.key for s in LINE_SPECS]
    other = _corpus_books()["saga_10_col_carniprod"]
    doc_rows, _cols, _t = _document_rows(env, other)
    canon = [r for r in doc_rows if r.key.startswith(A.CANONICAL_ROW_PREFIX)]
    assert canon and all(r.status == STATUS_ABSENT_CURRENT and r.current_share is None for r in canon)
    assert all("carries no canonical balance sheet" in r.note for r in canon)
    _hold_identity("legacy-current", doc_rows, _block(env), _block(other))


# ── S5: which way time runs ───────────────────────────────────────────

def test_the_order_of_two_closes():
    earlier = A.time_direction("2025-12-31", "2024-12-31")
    assert (earlier.order, earlier.verdicts_served, earlier.reason) == ("prior_is_earlier", True, None)
    later = A.time_direction("2024-12-31", "2025-12-31")
    assert (later.order, later.verdicts_served, later.reason) == ("prior_is_later", False, "prior_is_later")
    assert "2025-12-31" in later.note and "2024-12-31" in later.note
    same = A.time_direction("2025-12-31", "2025-12-31T00:00:00+00:00")
    assert (same.order, same.verdicts_served, same.reason) == ("same_close", True, None)
    import datetime as dt
    assert A.time_direction(dt.date(2025, 6, 30), dt.datetime(2025, 3, 31, 12)).order == "prior_is_earlier"
    # THE ORDER IS THE DATES', NEVER THE YEARS'. A monthly workspace's later
    # prior closes inside the same year; one day apart is still an order.
    for cur, pri, want in (
            ("2025-06-30", "2025-12-31", "prior_is_later"),
            ("2025-12-31", "2025-06-30", "prior_is_earlier"),
            ("2025-01-31", "2025-02-28", "prior_is_later"),
            ("2025-12-30", "2025-12-31", "prior_is_later"),
            ("2025-12-31", "2025-12-30", "prior_is_earlier"),
            ("2024-12-31", "2025-01-01", "prior_is_later"),
            ("2025-01-01", "2024-12-31", "prior_is_earlier")):
        d = A.time_direction(cur, pri)
        assert d.order == want, (cur, pri, d.order)
        assert d.verdicts_served is (want == "prior_is_earlier"), (cur, pri)
        assert d.reason == (None if want == "prior_is_earlier" else "prior_is_later")
    for cur, pri in ((None, "2024-12-31"), ("2025-12-31", None), ("", ""), ("FY2025", "2024-12-31"),
                     ("2025-12-31", 20241231)):
        d = A.time_direction(cur, pri)
        assert (d.order, d.verdicts_served, d.reason) == ("unknown", False, "period_order_unknown"), (cur, pri, d)
    assert set(A.VERDICT_ORDERS) == {"prior_is_earlier", "same_close"}


def _mover_figures(m) -> Tuple[Any, ...]:
    return (m.key, m.current, m.prior, m.delta, m.delta_pct, m.materiality, m.base_key, m.favorable, m.status)


def test_withholding_the_verdicts_changes_no_figure_and_no_rank():
    pairs = _offline_pairs()
    verdicts = 0
    for label, cur, pri in pairs:
        table = _table(cur, pri)
        served = A.movers(table)
        withheld = A.movers(table, verdicts_withheld="prior_is_later")
        assert served.verdicts_withheld is None and withheld.verdicts_withheld == "prior_is_later"
        assert [_mover_figures(m) for m in withheld.top] == [_mover_figures(m) for m in served.top], label
        assert (withheld.bases, withheld.below_floor, withheld.materiality_floor) == (
            served.bases, served.below_floor, served.materiality_floor), label
        assert all(m.verdict is None for m in withheld.top), label
        assert withheld.improved == () and withheld.deteriorated == (), label
        verdicts += len(served.improved) + len(served.deteriorated)
    assert verdicts >= 100, verdicts  # the pairs do carry verdicts to withhold


# ── through the real app ──────────────────────────────────────────────

USER = "7b0c0f3e-0000-4000-8000-00000000e0a1"
ORG = DP.SERVED_ORG
LEGACY = "scandia-legacy"
#: The first real book again, as a period that closes at MID-YEAR of the
#: second book's year: a pair whose two closes share a year (a monthly
#: workspace's ordinary later prior).
HALF_YEAR = "half-year"
#: The first real book's persisted period with NO line items: its detail
#: level cannot be read ("indeterminate"), so no pair with it is comparable.
NO_LINE_ITEMS = "no-line-items"

#: One close per real book, a year apart, so every ordered pair of them
#: runs one way or the other; each condensed counterpart closes WITH its
#: book (same_close); the legacy baseline closes with the last one.
_CLOSES = dict((cid, "%d-12-31" % (2021 + i)) for i, cid in enumerate(F.REAL_BOOKS))


def _pid(label: str) -> str:
    return "p-" + label.replace(DP.CONDENSED, "-4d")


@pytest.fixture(scope="module")
def world():
    """The corpus books (and their condensed counterparts, and the committed
    legacy baseline) as periods of one workspace on `create_app()`, read
    back through GET /api/period — twice — and through GET
    /api/period/{id}/comparatives for every pair below."""
    present = [cid for cid in F.REAL_BOOKS if (F.CORPUS / cid / "input.xlsx").is_file()]
    assert len(present) >= 4, present
    persisted, closes = {}, {}
    for cid in present:
        persisted[cid] = DP._persisted_real(cid)
        persisted[cid + DP.CONDENSED] = DP._persisted_condensed(cid)
        closes[cid] = closes[cid + DP.CONDENSED] = _CLOSES[cid]
    persisted[LEGACY] = SB.scandia_baseline_book("p-legacy-src")
    closes[LEGACY] = max(_CLOSES.values())
    first, second = present[0], present[1]
    persisted[HALF_YEAR] = persisted[first]
    closes[HALF_YEAR] = closes[second][:4] + "-06-30"
    assert closes[HALF_YEAR][:4] == closes[second][:4] and closes[HALF_YEAR] < closes[second]
    persisted[NO_LINE_ITEMS] = types.SimpleNamespace(
        period=persisted[first].period, line_items=[], doc=persisted[first].doc)
    closes[NO_LINE_ITEMS] = closes[first]
    app = RA.build_app()
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus Entity", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(bk, _pid(label), ORG, closes[label][:4] + "-01-01", closes[label])
                 for label, bk in persisted.items()])
    pairs = [(a, b) for a, b in itertools.permutations(present, 2)]
    pairs += [(cid, cid + DP.CONDENSED) for cid in present]
    pairs += [(cid + DP.CONDENSED, cid) for cid in present]
    pairs += [(LEGACY, present[0]), (present[0], LEGACY)]
    pairs += [(HALF_YEAR, second), (second, HALF_YEAR)]
    pairs += [(second, NO_LINE_ITEMS), (NO_LINE_ITEMS, second)]
    bearer = D.mint_jwt(USER)
    bodies, raw, raw_again, docs = {}, {}, {}, {}
    with RA.installed(double):
        RA.seed_metrics(app, double, [_pid(l) for l in persisted], ORG, bearer)
        for label in persisted:
            for store in (raw, raw_again):
                resp = RA.get(app, "/api/period/%s" % _pid(label), bearer, ORG)
                assert resp.status_code == 200, (label, resp.status_code, resp.text[:400])
                store[label] = resp.text
            bodies[label] = json.loads(raw[label])
        for cur, pri in pairs:
            resp = RA.get(app, "/api/period/%s/comparatives?prior=%s" % (_pid(cur), _pid(pri)), bearer, ORG)
            assert resp.status_code == 200, (cur, pri, resp.status_code, resp.text[:400])
            docs[(cur, pri)] = resp.json()
        stored = [dict(r) for r in double.rows("financial_periods")]
    # `bodies` holds the periods that ARE a whole book; the one without line
    # items is served too (`every`) and has laws of its own.
    every = dict(bodies)
    del bodies[NO_LINE_ITEMS]
    return types.SimpleNamespace(bodies=bodies, every=every, raw=raw, raw_again=raw_again, docs=docs,
                                 stored=stored, closes=closes, present=present)


def test_get_period_serves_the_block_on_every_corpus_book_schema_exact(world):
    """S2 through the real app. Exactly `schema`, `bases`, `rows`; exactly
    seven fields a row (key sets: a JSON object carries no order); every
    figure a number or null."""
    assert len(world.bodies) >= 9
    for label, body in world.bodies.items():
        block = body["statements"].get("common_size")
        assert isinstance(block, dict), "%s: GET /api/period serves no statements.common_size" % label
        assert set(block) == {"schema", "bases", "rows"}, (label, sorted(block))
        assert block["schema"] == "common_size/1"
        assert set(block["bases"]) == {"PL", "BS"}
        assert block["bases"]["PL"]["key"] == "pl.revenue" and block["bases"]["BS"]["key"] == "bs.total_assets"
        rows = _rows(block)
        for stmt in ("PL", "BS"):
            assert set(block["bases"][stmt]) == {"key", "value"}
            assert block["bases"][stmt]["value"] == rows[block["bases"][stmt]["key"]]["current"], label
        for row in block["rows"]:
            assert set(row) == set(ROW_KEYS), (label, sorted(row))
            assert row["statement"] in ("PL", "BS") and row["status"] in shares.SIDE_STATUSES, row
            for f in ("current", "share"):
                assert row[f] is None or (isinstance(row[f], (int, float)) and not isinstance(row[f], bool)), row
            assert (row["share"] is not None) == (row["status"] == SHARE), (label, row)
            assert isinstance(row["note"], str) and row["note"], (label, row)
        assert sum(1 for r in block["rows"] if r["status"] == SHARE) >= 60, label


def test_the_served_block_is_the_block_of_the_body_the_route_returned(world):
    """No drift between the attach point and the response: recomputed from
    the SERVED body (statements and line items as the browser receives
    them), it is the same block. And every `current` is the figure the page
    prints — the assembled field for a registry line, the canonical
    object's own amount for a balance-sheet row, subtotal or total."""
    for label, body in world.bodies.items():
        served = body["statements"]["common_size"]
        again = C.common_size_block(body)
        assert json.dumps(served, sort_keys=True) == json.dumps(again, sort_keys=True), label
        rows = _rows(served)
        st = body["statements"]
        for spec in LINE_SPECS:
            row = rows[spec.key]
            if row["current"] is None:
                continue
            node = st
            for part in spec.path:
                node = node[part]
            assert abs(float(node) - row["current"]) < ZERO_FLOOR, (label, spec.key, node, row["current"])
        cbs = st["canonical_bs"]
        for r in cbs["rows"]:
            assert rows[A.CANONICAL_ROW_PREFIX + r["id"]]["current"] == round(float(r["amount"]), 2), (label, r["id"])
        sections = dict((s["id"], s["subtotal"]) for s in cbs["sections"])
        for sid, subtotal in sections.items():
            row = rows[A.CANONICAL_SECTION_PREFIX + sid]
            assert row["current"] in (None, round(float(subtotal), 2)), (label, sid, row)
        totals = A.canonical_totals(cbs, st.get("currency"))
        assert rows["bs.total.assets"]["current"] == round(totals["assets"], 2), label
        assert rows["bs.total.equity_plus_liabilities"]["current"] == round(totals["equity_plus_liabilities"], 2)
        # ONE BASE ON THE PAGE: on a served period the registry's total
        # assets IS the canonical total (the envelope-truth override), so
        # "% of total assets" means one thing on both families of rows.
        assert served["bases"]["BS"]["value"] == rows["bs.total.assets"]["current"], label
        assert sum(1 for k, r in rows.items() if k.startswith(A.CANONICAL_ROW_PREFIX) and r["status"] == SHARE) >= 20, label


def test_the_same_request_twice_serves_the_same_bytes_and_persists_nothing(world):
    for label in world.every:
        a = json.loads(world.raw[label])["statements"]["common_size"]
        b = json.loads(world.raw_again[label])["statements"]["common_size"]
        assert json.dumps(a) == json.dumps(b), label
    # NOT PERSISTED, and not on the envelope other lanes read: a pure
    # function of the served statements needs no stored copy to drift.
    for row in world.stored:
        assert "common_size" not in json.dumps(row.get("assembled_canonical_v1") or {}), row["id"]
    for label, body in world.bodies.items():
        assert "common_size" not in (body["statements"].get("assembled_canonical_v1") or {}), label
        assert "common_size" not in body, label


def test_one_computation_through_the_real_routes(world):
    """S1 through the app: the comparatives document's two share columns are
    the two periods' own served blocks, for every key of every pair. Where
    the prior's block rides the document's `prior_statements` (it passes
    through the same serving function today; NOTHING may require it there —
    the document's `prior_share` is the contract), it is that block."""
    held = 0
    refused_pairs = 0
    for (cur, pri), doc in sorted(world.docs.items()):
        cb, pb = world.every[cur]["statements"]["common_size"], world.every[pri]["statements"]["common_size"]
        # The prior's shares are the document's `prior_share` column; its
        # block does not ride along a second time (about 19 KB a document).
        assert "common_size" not in doc["prior_statements"], (cur, pri)
        assert "common_size" in world.every[pri]["statements"], pri  # …and the body is not touched
        if LEGACY in (cur, pri):
            # The legacy baseline REFUSES its EBITDA: on those keys the pair
            # refuses both sides (held below); every other key is identical.
            refused_pairs += 1
            cols = dict((c["key"], c) for c in doc["columns"])
            mine, theirs = _rows(cb), _rows(pb)
            for row in doc["common_size"]:
                if cols.get(row["key"], {}).get("status") == STATUS_REFUSED:
                    assert (row["status"], row["current_share"], row["prior_share"]) == (STATUS_REFUSED, None, None)
                    continue
                assert row["current_share"] == (mine[row["key"]]["share"] if row["key"] in mine else None), row
                assert row["prior_share"] == (theirs[row["key"]]["share"] if row["key"] in theirs else None), row
            continue
        held += _hold_identity("%s-vs-%s" % (cur, pri), doc["common_size"], cb, pb,
                               comparable=doc["comparability"]["comparable"])
    assert refused_pairs == 2 and held >= 5000, (refused_pairs, held)
    print("GATE-WORK common-size-single served_periods=%d served_pairs=%d served_rows=%d"
          % (len(world.bodies), len(world.docs), held))


def test_the_legacy_period_refuses_its_ebitda_lines_through_the_route(world):
    """The REAL refused witness: a period persisted before the stock
    variation was measured serves its EBITDA refused, and its block says so
    on each line built on it — with every other share intact."""
    body = world.bodies[LEGACY]
    refusal = body["statements"]["assembled_pl"]["ebitda_refusal"]
    rows = _rows(body["statements"]["common_size"])
    for key in REFUSED_KEYS:
        assert (rows[key]["status"], rows[key]["current"], rows[key]["share"]) == (DISCLOSURE_REFUSED, None, None)
        assert refusal["text_en"] in rows[key]["note"], rows[key]["note"]
    assert rows["pl.revenue"]["share"] == 1.0 and rows["pl.cogs"]["status"] == SHARE


CONSTRUCTED = ("unanchored_unbalanced", "unanchored", "closed_bridge")


@pytest.fixture(scope="module")
def constructed():
    """Three CONSTRUCTED books of the net-711 gate (synthetic figures, no
    client data) through the real write seam and the real GET /api/period —
    the bytes committed for the frontend under fixtures/oneEbitda/: a book
    with no account 121 whose sheet does NOT balance without the year's
    result (equity refused as incomplete), the same book balancing without
    it (equity complete, the net result still refused), and a clean one."""
    bodies = {}
    for name in CONSTRUCTED:
        bk = N._persisted(name)
        mp = pytest.MonkeyPatch()
        try:
            with DP.ANCHOR._routed(bk, mp) as (client, _db):
                resp = client.get("/api/period/%s" % bk.period_id, headers={"Authorization": "Bearer test"})
        finally:
            mp.undo()
        assert resp.status_code == 200, (name, resp.status_code, resp.text[:300])
        bodies[name] = resp.json()
    return bodies


def _table_rows(body):
    return dict((r["key"], r) for r in body["assembled_metrics"]["ratio_table"]["rows"])


def test_a_refused_equity_and_a_refused_net_result_take_no_share_through_the_route(constructed):
    """THE REVIEW'S WITNESS (2026-10-04). On `unanchored_unbalanced` the
    block served total equity at 0.47619 of total assets — the equity ratio
    the same body's ratio table refuses — and called the refused net income
    "not reported". Each is refused, with the period's own reason."""
    body = constructed["unanchored_unbalanced"]
    st = body["statements"]
    eq_refusal, ni_refusal = st["assembled_bs"]["total_equity_refusal"], st["assembled_pl"]["net_income_refusal"]
    assert st["assembled_bs"]["total_equity"] == 200000.0  # THE FIGURE IS STILL IN THE FIELD
    assert st["assembled_pl"]["net_income_statutory"] is None
    rows = _rows(st["common_size"])
    for key in ("bs.total_equity",) + A.CANONICAL_EQUITY_KEYS:
        row = rows[key]
        assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_REFUSED, None, None), row
        assert eq_refusal["text_en"] in row["note"], row["note"]
    row = rows["pl.net_income"]
    assert (row["status"], row["current"], row["share"]) == (DISCLOSURE_REFUSED, None, None), row
    assert ni_refusal["text_en"] in row["note"] and "did not report" not in row["note"], row["note"]
    # ONE ANSWER PER BODY: the ratio the share would be is refused beside it.
    table = _table_rows(body)
    assert table["equity_ratio"]["value"] is None and table["debt_to_equity"]["value"] is None
    assert table["net_margin"]["value"] is None
    # What is NOT refused stands: total assets, and the equity rows the book posted.
    assert rows["bs.total.assets"]["share"] == 1.0 and rows["bs.total_assets"]["share"] == 1.0
    equity_rows = [r["id"] for r in st["canonical_bs"]["rows"] if r["section"] == "equity"]
    assert len(equity_rows) >= 2
    for rid in equity_rows:
        assert rows[A.CANONICAL_ROW_PREFIX + rid]["status"] == SHARE, rid
    assert C.common_size_block(body) == st["common_size"]

    # The same book BALANCING without the result: equity is complete and
    # takes its share; the net result is refused all the same.
    whole = constructed["unanchored"]
    wst = whole["statements"]
    assert "total_equity_refusal" not in wst["assembled_bs"] and wst["assembled_pl"].get("net_income_refusal")
    wrows = _rows(wst["common_size"])
    assert (wrows["bs.total_equity"]["status"], wrows["bs.total_equity"]["share"]) == (SHARE, 0.8)
    assert wrows["bs.section.equity"]["share"] == 0.8 and wrows["bs.total.equity_plus_liabilities"]["share"] == 1.0
    assert wrows["pl.net_income"]["status"] == DISCLOSURE_REFUSED
    assert _table_rows(whole)["equity_ratio"]["value"] is not None

    # IN A PAIR, either way round: the column refuses (no movement on a
    # refused equity or net result), and no share is served on either side.
    clean = constructed["closed_bridge"]
    crows = _rows(clean["statements"]["common_size"])
    assert crows["bs.total_equity"]["status"] == SHARE and crows["pl.net_income"]["status"] == SHARE
    for cur, pri in ((body, clean), (clean, body)):
        doc = json.loads(json.dumps(C.compare_payloads(
            cur, pri, current_row={"id": "p-cur", "period_end": "2025-12-31"},
            prior_row={"id": "p-pri", "period_end": "2024-12-31"})))
        cols = dict((c["key"], c) for c in doc["columns"])
        for key in ("bs.total_equity", "pl.net_income"):
            col = cols[key]
            assert (col["status"], col["delta"], col["delta_pct"]) == (STATUS_REFUSED, None, None), col
        cs = dict((r["key"], r) for r in doc["common_size"])
        for key in ("bs.total_equity", "pl.net_income") + A.CANONICAL_EQUITY_KEYS:
            r = cs[key]
            assert (r["status"], r["current_share"], r["prior_share"], r["delta_pts"]) == (
                STATUS_REFUSED, None, None, None), r
        _hold_identity("constructed", doc["common_size"],
                       cur["statements"]["common_size"], pri["statements"]["common_size"])


def test_a_margin_the_rule_refuses_is_not_served_as_a_share_through_the_route(world):
    """The served block and the served verdict agree on EVERY body: the
    lines withheld are exactly the margin lines of a period whose
    `statements.margin_meaning` refuses — and the ratio table on that body
    refuses the same margins with the same code."""
    refusing = 0
    for label, body in world.bodies.items():
        st = body["statements"]
        rows = _rows(st["common_size"])
        served = st.get("margin_meaning")
        withheld = set(k for k, r in rows.items() if r["status"] == NOT_MEANINGFUL)
        if not (isinstance(served, dict) and served.get("status") == MM.NOT_MEANINGFUL):
            assert withheld == set(), (label, withheld)
            continue
        refusing += 1
        assert withheld == set(MARGIN_LINES), (label, withheld)
        # ONE VERDICT PER BODY: every margin the served block names is a
        # line withheld here, and the ratio table refuses it with the code.
        assert set(TABLE_MARGIN_LINES.values()) <= set(served["margins"]), served["margins"]
        table = _table_rows(body)
        for key in withheld:
            row = rows[key]
            assert row["share"] is None and row["current"] is not None, (label, row)
            assert served["display"]["en"] in row["note"], row["note"]
            if key in TABLE_MARGIN_LINES:
                ratio = table[TABLE_MARGIN_LINES[key]]
                assert ratio["value"] is None and ratio["reason"]["code"] == MM.MARGIN_NOT_MEANINGFUL, ratio
    assert refusing >= 2, refusing  # the developer and its condensed counterpart
    # …and in a served pair the refused side is blank, the other keeps its own.
    developer = [l for l in world.present
                 if (world.bodies[l]["statements"].get("margin_meaning") or {}).get("status") == MM.NOT_MEANINGFUL]
    assert developer, world.present
    normal = [l for l in world.present if l not in developer][0]
    doc = world.docs[(developer[0], normal)]
    alone = _rows(world.bodies[normal]["statements"]["common_size"])
    for row in doc["common_size"]:
        if row["key"] in MARGIN_LINES:
            assert (row["status"], row["current_share"], row["delta_pts"]) == (NOT_MEANINGFUL, None, None), row
            assert row["prior_share"] == alone[row["key"]]["share"] and row["prior_share"] is not None


def _steps(bridge):
    return dict((s["key"], s) for s in bridge["steps"])


CROSSINGS = ("crossed_up", "crossed_down")
ADJECTIVES = ("improved", "deteriorated")


def _ratio_rows(doc):
    block = doc["ratios"]
    return dict((r["key"], r) for r in block["rows"] + block["composites"] + block["subscores"])


def _negated(text):
    """A served signed decimal, negated ("+0.89" <-> "-0.89"; a zero is a zero)."""
    if text is None:
        return None
    if text.startswith("+"):
        return "-" + text[1:]
    if text.startswith("-"):
        return "+" + text[1:]
    return text


def _no_ratio_verdict(doc, reason):
    """THE RATIO BLOCK OF A DOCUMENT THAT SERVES NO VERDICT: no ratio is
    listed improved or deteriorated, no delta carries the adjective, no band
    crossing and no band finding is served — and every movable entry is still
    in the partition. Returns the keys withheld under `reason`."""
    bm = doc["ratios"]["band_movements"]
    assert bm["verdicts_withheld"] == reason, bm["verdicts_withheld"]
    assert bm["improved"] == [] and bm["deteriorated"] == [] and bm["findings"] == [], (
        bm["improved"], bm["deteriorated"], len(bm["findings"]))
    for key, row in _ratio_rows(doc).items():
        assert row["delta"]["favourable"] not in ADJECTIVES, (key, row["delta"])
        assert row["movement"]["status"] not in CROSSINGS, (key, row["movement"])
        assert row["finding_id"] is None, key
    assert (len(bm["improved"]) + len(bm["deteriorated"]) + len(bm["unchanged"])
            + len(bm["not_comparable"])) == doc["ratios"]["coverage"]["both_sides"]
    return set(e["key"] for e in bm["not_comparable"] if e["reason_code"] == reason)


def _ratio_figures_are_the_forward_ones_swapped(fwd, back, reason):
    """Withholding the direction takes NO figure with it: the two sides are
    the forward document's, swapped; each delta is the exact negative; the
    bands and ladders are untouched; a band that held still held."""
    f, b = _ratio_rows(fwd), _ratio_rows(back)
    assert set(f) == set(b)
    judged = 0
    for key, row in b.items():
        other = f[key]
        for side, mirror in (("current", "prior"), ("prior", "current")):
            for field in ("value", "value_q", "band", "band_status", "ladder"):
                assert row[side][field] == other[mirror][field], (key, side, field)
        assert row["delta"]["value"] == _negated(other["delta"]["value"]), (key, row["delta"], other["delta"])
        if other["delta"]["favourable"] in ADJECTIVES:
            judged += 1
            assert row["delta"]["value"] is not None, key
            assert (row["delta"]["favourable"], row["delta"]["reason_code"]) == (None, reason), row["delta"]
        else:
            assert row["delta"]["favourable"] == other["delta"]["favourable"], key
        if other["movement"]["status"] == "same_band":
            assert row["movement"] == other["movement"], key
        elif other["movement"]["status"] in CROSSINGS:
            assert (row["movement"]["status"], row["movement"]["reason_code"]) == ("not_comparable", reason)
    return judged


def test_a_later_prior_serves_every_figure_and_no_verdict(world):
    """S5 through the real route, on every ordered pair of the real books:
    one orientation runs forward, its swap backwards."""
    swaps = forward_verdicts = band_verdicts = band_findings = ratio_adjectives = 0
    for a, b in itertools.combinations(world.present, 2):
        earlier, later = sorted((a, b), key=lambda cid: world.closes[cid])
        fwd, back = world.docs[(later, earlier)], world.docs[(earlier, later)]
        # which way time runs
        assert fwd["direction"] == {
            "order": "prior_is_earlier", "current_period_end": world.closes[later],
            "prior_period_end": world.closes[earlier], "verdicts_served": True,
            "reason": None, "note": ""}, fwd["direction"]
        assert back["direction"]["order"] == "prior_is_later" and back["direction"]["verdicts_served"] is False
        assert back["direction"]["reason"] == "prior_is_later" and back["direction"]["note"]
        assert (back["direction"]["current_period_end"], back["direction"]["prior_period_end"]) == (
            world.closes[earlier], world.closes[later])
        # no verdict backwards; verdicts forwards
        mv = back["movers"]
        assert mv["verdicts_withheld"] == "prior_is_later" and fwd["movers"]["verdicts_withheld"] is None
        assert mv["top"] and all(m["verdict"] is None for m in mv["top"]), (earlier, later)
        assert mv["improved"] == [] and mv["deteriorated"] == []
        forward_verdicts += len(fwd["movers"]["improved"]) + len(fwd["movers"]["deteriorated"])
        # …and nothing else moved: the ranking and its figures are the
        # columns' own, as before (the depth-parity gate's ranking).
        want, below = DP._ranking_from_columns(back, mv["materiality_floor"], A.TOP_MOVERS_DEFAULT)
        assert [(m["key"], m["materiality"]) for m in mv["top"]] == want and mv["below_floor"] == below
        bcols = dict((c["key"], c) for c in back["columns"])
        for m in mv["top"]:
            col = bcols[m["key"]]
            assert (m["current"], m["prior"], m["delta"], m["delta_pct"]) == (
                col["current"], col["prior"], col["delta"], col["delta_pct"]), m["key"]
        # every column's delta is the exact negative
        fcols = dict((c["key"], c) for c in fwd["columns"])
        moved = 0
        for col in back["columns"]:
            other = fcols[col["key"]]
            assert (col["current"], col["prior"]) == (other["prior"], other["current"]), col["key"]
            if other["delta"] is None:
                assert col["delta"] is None, col["key"]
            else:
                assert col["delta"] == (0.0 if other["delta"] == 0 else -other["delta"]), (col["key"], col["delta"])
                moved += 1
        assert moved >= 30, moved
        # the bridges close as before, every step the exact negative
        for name in ("pl", "bs_assets", "bs_liabilities_equity"):
            fb, bb = fwd["bridges"][name], back["bridges"][name]
            assert fb["closes"] and bb["closes"], (earlier, later, name, fb["reason"], bb["reason"])
            assert (bb["prior_total"], bb["current_total"]) == (fb["current_total"], fb["prior_total"])
            fsteps, bsteps = _steps(fb), _steps(bb)
            assert set(fsteps) == set(bsteps), name
            for key, step in bsteps.items():
                assert abs(step["amount"] + fsteps[key]["amount"]) < ZERO_FLOOR, (name, key)
        # the shares swap sides; the change in points is the exact negative
        frows = dict((r["key"], r) for r in fwd["common_size"])
        for row in back["common_size"]:
            other = frows[row["key"]]
            assert (row["current_share"], row["prior_share"]) == (other["prior_share"], other["current_share"])
            if other["delta_pts"] is None:
                assert row["delta_pts"] is None
            else:
                assert row["delta_pts"] == (0.0 if other["delta_pts"] == 0 else -other["delta_pts"]), row["key"]
        # THE RATIO BLOCK reads the same direction: a document that says no
        # verdict is served serves none in ANY of its blocks. Forwards, the
        # ratios that crossed a band are listed; backwards, exactly those are
        # withheld under the reason, and every figure is the forward one.
        fbm = fwd["ratios"]["band_movements"]
        assert fbm["verdicts_withheld"] is None
        crossed = set(fbm["improved"]) | set(fbm["deteriorated"])
        assert _no_ratio_verdict(back, "prior_is_later") == crossed, (earlier, later)
        band_verdicts += len(crossed)
        band_findings += len(fbm["findings"])
        ratio_adjectives += _ratio_figures_are_the_forward_ones_swapped(fwd, back, "prior_is_later")
        swaps += 1
    assert swaps >= 6 and forward_verdicts >= 20, (swaps, forward_verdicts)
    # …and the forward documents DO carry what the backward ones withhold.
    assert band_verdicts >= 20 and band_findings >= 20 and ratio_adjectives >= 60, (
        band_verdicts, band_findings, ratio_adjectives)
    # two periods that close the same day: time does not run backwards
    for cid in world.present:
        doc = world.docs[(cid, cid + DP.CONDENSED)]
        assert doc["direction"]["order"] == "same_close" and doc["direction"]["verdicts_served"] is True
        assert doc["movers"]["verdicts_withheld"] is None
    print("GATE-WORK common-size-single swaps=%d forward_verdicts=%d band_verdicts=%d"
          % (swaps, forward_verdicts, band_verdicts))


def test_a_later_prior_inside_the_same_year_serves_no_verdict(world):
    """The ordinary later prior of a monthly workspace: both periods close
    in ONE year. The order is read off the dates, through the real route."""
    second = world.present[1]
    back, fwd = world.docs[(HALF_YEAR, second)], world.docs[(second, HALF_YEAR)]
    d = back["direction"]
    assert d["current_period_end"][:4] == d["prior_period_end"][:4], d  # one year
    assert (d["order"], d["verdicts_served"], d["reason"]) == ("prior_is_later", False, "prior_is_later"), d
    assert (fwd["direction"]["order"], fwd["direction"]["verdicts_served"]) == ("prior_is_earlier", True)
    mv = back["movers"]
    assert mv["verdicts_withheld"] == "prior_is_later" and mv["improved"] == [] and mv["deteriorated"] == []
    assert mv["top"] and all(m["verdict"] is None for m in mv["top"])
    assert fwd["movers"]["improved"] or fwd["movers"]["deteriorated"]
    fbm = fwd["ratios"]["band_movements"]
    crossed = set(fbm["improved"]) | set(fbm["deteriorated"])
    assert crossed and _no_ratio_verdict(back, "prior_is_later") == crossed
    assert _ratio_figures_are_the_forward_ones_swapped(fwd, back, "prior_is_later") >= 5


def test_a_pair_the_engine_will_not_compare_serves_no_share_through_the_route(world):
    """A period with no line items has a detail level that cannot be read:
    the pair is not comparable, and the document carries no share on either
    side of ANY row, registry or canonical — in both orientations — while
    each period's own block keeps its shares."""
    second = world.present[1]
    own = sum(1 for r in world.every[second]["statements"]["common_size"]["rows"] if r["share"] is not None)
    assert own >= 80
    for pair in ((second, NO_LINE_ITEMS), (NO_LINE_ITEMS, second)):
        doc = world.docs[pair]
        assert doc["comparability"]["comparable"] is False, doc["comparability"]
        rows = doc["common_size"]
        assert len(rows) >= 100
        assert sum(1 for r in rows if r["key"].startswith(A.CANONICAL_ROW_PREFIX)) >= 30
        for r in rows:
            assert (r["status"], r["current_share"], r["prior_share"], r["delta_pts"]) == (
                STATUS_INCOMPARABLE, None, None, None), r
            assert r["note"] == doc["comparability"]["reason"]


def test_an_unreadable_close_serves_no_verdict(world):
    """CONSTRUCTED (every stored period has a close): the same two served
    bodies with the closes unreadable — no verdict, the same figures."""
    cur, pri = world.present[1], world.present[0]
    served = world.docs[(cur, pri)]
    assert served["direction"]["order"] == "prior_is_earlier" and (
        served["movers"]["improved"] or served["movers"]["deteriorated"])
    cb, pb = copy.deepcopy(world.bodies[cur]), copy.deepcopy(world.bodies[pri])
    for body in (cb, pb):
        body["period"]["period_end"] = None
    # (through JSON, as the route serves it)
    doc = json.loads(json.dumps(C.compare_payloads(
        cb, pb, current_row={"id": _pid(cur)}, prior_row={"id": _pid(pri)})))
    assert doc["direction"] == {
        "order": "unknown", "current_period_end": None, "prior_period_end": None,
        "verdicts_served": False, "reason": "period_order_unknown",
        "note": doc["direction"]["note"]} and doc["direction"]["note"]
    assert doc["movers"]["verdicts_withheld"] == "period_order_unknown"
    assert all(m["verdict"] is None for m in doc["movers"]["top"])
    assert doc["movers"]["improved"] == [] and doc["movers"]["deteriorated"] == []
    for block in ("columns", "bridges", "common_size"):
        assert json.dumps(doc[block], sort_keys=True) == json.dumps(served[block], sort_keys=True), block
    # The ratio block withholds under the same reason; its figures are the
    # served document's own (the same two periods, the same way round).
    sbm = served["ratios"]["band_movements"]
    crossed = set(sbm["improved"]) | set(sbm["deteriorated"])
    assert crossed and _no_ratio_verdict(doc, "period_order_unknown") == crossed
    for key, row in _ratio_rows(doc).items():
        other = _ratio_rows(served)[key]
        assert (row["current"], row["prior"]) == (other["current"], other["prior"]), key
        assert row["delta"]["value"] == other["delta"]["value"], key
    # A reason this module does not declare is a caller bug, not a verdict.
    from engine.comparatives import ratio_compare as RC
    assert RC.VERDICT_WITHHELD_CODES == ("prior_is_later", "period_order_unknown")
    assert set(RC.VERDICT_WITHHELD_CODES) <= set(RC.DELTA_REASON_CODES) & set(RC.MOVEMENT_REASON_CODES)
    with pytest.raises(ValueError):
        RC.compare_ratio_tables(cb, pb, current_label="a", prior_label="b",
                                band_findings=lambda *a, **k: [], verdicts_withheld="because")
    # the workspace row's close wins; the served body's is the fallback
    doc = C.compare_payloads(world.bodies[cur], world.bodies[pri],
                             current_row={"id": _pid(cur)}, prior_row={"id": _pid(pri)})
    assert doc["direction"]["order"] == "prior_is_earlier"


def test_no_block_is_attached_to_a_payload_whose_assembly_did_not_run(world, monkeypatch):
    """ABSENT != ZERO on the wire. A payload with no assembled P&L or
    balance sheet (the re-assembly failed, non-fatally) gets NO block —
    not a block that calls every line "not reported" — and a stale one is
    removed. A failure inside the builder costs the reader nothing else."""
    from engine.api import pipeline as P

    body = copy.deepcopy(world.bodies[world.present[0]])
    statements, items = body["statements"], body["line_items"]
    served = statements.pop("common_size")
    P._attach_common_size_block(statements, items)
    assert statements["common_size"] == served  # the same helper the route ran
    for missing in ("assembled_pl", "assembled_bs"):
        st = copy.deepcopy(statements)
        st[missing] = None
        P._attach_common_size_block(st, items)
        assert "common_size" not in st, missing
    P._attach_common_size_block(None, items)  # a body with no statements: nothing to do

    def explode(payload):
        raise RuntimeError("planted: the builder failed")

    monkeypatch.setattr(C, "common_size_block", explode)
    st = copy.deepcopy(statements)
    st["common_size"] = {"schema": "common_size/1", "stale": True}
    P._attach_common_size_block(st, items)  # must not raise
    assert "common_size" not in st  # and never a half-written or stale block


# ── the deploy pre-flight ─────────────────────────────────────────────

def _preflight():
    spec = importlib.util.spec_from_file_location(
        "check_served_periods", REPO / "scripts" / "check_served_periods.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_the_deploy_preflight_reads_the_block_and_prints_no_figure(world):
    """`scripts/check_served_periods.py --require-common-size`: every
    stored period's body carries a lawful common_size/1 block — and a
    problem it reports names keys and statuses, never an amount."""
    gate = _preflight()
    for label, body in world.bodies.items():
        assert gate.common_size_problem(body) is None, (label, gate.common_size_problem(body))
    body = copy.deepcopy(world.bodies[world.present[0]])

    def broken(mutate) -> str:
        b = copy.deepcopy(body)
        mutate(b["statements"])
        problem = gate.common_size_problem(b)
        assert isinstance(problem, str) and problem, "the pre-flight passed a broken block"
        return problem

    assert "no statements.common_size" in broken(lambda st: st.pop("common_size"))
    assert "schema" in broken(lambda st: st["common_size"].update(schema="common_size/0"))
    assert "rows" in broken(lambda st: st["common_size"].update(rows=[]))
    assert "bases" in broken(lambda st: st["common_size"]["bases"].pop("BS"))

    def share_on_absent(st):
        row = next(r for r in st["common_size"]["rows"] if r["status"] == DISCLOSURE_ABSENT)
        row["share"] = 0.0

    problem = broken(share_on_absent)
    assert "share" in problem and "absent" in problem

    def share_under_another_status(st):
        row = next(r for r in st["common_size"]["rows"] if r["key"] == "pl.cogs")
        assert row["status"] == SHARE and row["current"] > 1000
        row["status"] = DISCLOSURE_ABSENT

    # …and it says so WITHOUT the line's amount: keys and statuses only.
    problem = broken(share_under_another_status)
    assert "pl.cogs" in problem and "absent" in problem
    cogs = next(r for r in body["statements"]["common_size"]["rows"] if r["key"] == "pl.cogs")
    assert ("%.2f" % cogs["current"]) not in problem and str(cogs["share"]) not in problem, problem
    assert not re.search(r"\d{3,}", problem), problem
    # the judge only asks for the block when told to
    pid = body["period"]["id"]
    stripped = copy.deepcopy(body)
    stripped["statements"].pop("common_size")
    assert gate._judge(pid, 200, stripped) is None
    assert "common_size" in gate._judge(pid, 200, stripped, require_common_size=True)
    assert gate._judge(pid, 200, body, require_common_size=True) is None
    # …and the run: every period counted, the one without a block the one failure.
    rows = [{"id": b["period"]["id"], "org_id": ORG, "period_end": None} for b in world.bodies.values()]
    served = dict((b["period"]["id"], b) for b in world.bodies.values())
    served[pid] = stripped
    for required, failed in ((False, 0), (True, 1)):
        report = gate.check_periods(rows, lambda p: (200, served[p]), require_common_size=required)
        assert (report["checked"], report["failed"]) == (len(rows), failed), report
        assert (report["common_size"]["lawful"], report["common_size"]["required"]) == (len(rows) - 1, required)
        assert report["common_size"]["withheld"]["periods"] == []
        assert report["common_size"]["no_canonical_rows"]["periods"] == []
        assert gate.exit_code(report) == (1 if failed else 0)
    assert report["failures"][0]["period_id"] == pid and "common_size" in report["failures"][0]["problem"]

    # The script states the status vocabulary itself (it runs before the
    # engine is trusted) — and it is the engine's.
    assert set(gate.COMMON_SIZE_STATUSES) == set(shares.SIDE_STATUSES)

    def unknown_status(st):
        st["common_size"]["rows"][3]["status"] = "shared"

    assert "not one of" in broken(unknown_status)

    def a_key_twice(st):
        st["common_size"]["rows"].append(dict(st["common_size"]["rows"][0]))

    assert "appears twice" in broken(a_key_twice)

    # TWO NAMED OUTCOMES THAT ARE NOT FAILURES. (1) The engine withholds the
    # block from a body with no assembled statements, on purpose: required
    # or not, that period is listed and the run stays green.
    unassembled = copy.deepcopy(stripped)
    unassembled["statements"]["assembled_pl"] = None
    assert gate.common_size_withheld(unassembled) and not gate.common_size_withheld(stripped)
    assert not gate.common_size_withheld(body)
    assert gate._judge(pid, 200, unassembled, require_common_size=True) is None
    # (2) A period with no canonical balance sheet gets the registry lines
    # only: lawful, and its balance-sheet tab has no share to print.
    legacy = copy.deepcopy(body)
    legacy["statements"]["common_size"]["rows"] = [
        r for r in legacy["statements"]["common_size"]["rows"]
        if not r["key"].startswith(("bs.row.", "bs.section.", "bs.total."))]
    assert gate.common_size_problem(legacy) is None and gate.common_size_lacks_canonical_rows(legacy)
    assert not gate.common_size_lacks_canonical_rows(body)
    other = next(b["period"]["id"] for b in world.bodies.values() if b["period"]["id"] != pid)
    legacy["period"] = dict(legacy["period"], id=other)
    served = dict((b["period"]["id"], b) for b in world.bodies.values())
    served[pid], served[other] = unassembled, legacy
    report = gate.check_periods(rows, lambda p: (200, served[p]), require_common_size=True)
    assert report["failed"] == 0 and gate.exit_code(report) == 0, report["failures"]
    assert report["common_size"]["withheld"] == {"outcome": gate.WITHHELD_NO_ASSEMBLED, "periods": [pid]}
    assert report["common_size"]["no_canonical_rows"] == {"outcome": gate.NO_CANONICAL_ROWS, "periods": [other]}
    assert report["common_size"]["lawful"] == len(rows) - 1
