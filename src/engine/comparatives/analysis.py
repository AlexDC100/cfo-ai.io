"""COMMON SIZE, THE VARIANCE BRIDGE, AND TOP MOVERS — over a ComparativeTable.

Three readings of the same two envelopes, each with its own refusal.

  COMMON SIZE   every line as a share of its statement's base (net turnover
                for the P&L, total assets for the balance sheet), for each
                period, and the change in PERCENTAGE POINTS — never a
                percentage of a percentage. A line the column model refused
                stays refused here; a base below the zero floor refuses the
                whole statement's shares. A share is a statement about ONE
                period, so each side's is taken by `shares.side_shares` —
                the same function `period_common_size` runs over a period
                read on its own (`statements.common_size` on every period
                payload): one computation, two documents. A result line's
                share of turnover is a MARGIN, so it asks the one margin
                rule first (`lines.share_withheld_of`): where the rule
                refuses a period's margins that side carries no share, the
                other side keeps its own, and no change in points is struck
                between a margin and a refusal.

  THE BRIDGE    prior total → named steps → current total, closing to the
                cent. Every step is the change in one engine field that the
                assembler's own identities sum; nothing is plugged. If the
                identity does not close on these two envelopes the bridge is
                REFUSED with the residual named — it is never served with a
                balancing line pretending to be a step.

  MOVERS        the bucket-backed lines that moved most, ranked by
                materiality against the current period's base, and the
                subset with a declared favourable direction sorted into
                "improved" and "deteriorated". A line with no declared
                direction (inventory, receivables, capital) is listed as a
                mover and is never given an adjective — whether more
                inventory is good depends on the business, and this module
                does not know the business. An adjective also needs TIME
                TO RUN FORWARD from the prior to the current period: a
                comparison with a period that closes LATER (or whose order
                cannot be read) is served with every figure and no verdict
                (`time_direction`).

The identities the bridge relies on were MEASURED on the committed real
baselines (scandia_fy2025, eei_dec_2025) before being written down here,
and re-measured on the ONE EBITDA (owner ruling 2026-09-26) over every
corpus pair the gates run:

    ebitda   = revenue + other_operating_income + capitalized_own_work
               - cogs + inventory_variation - opex_total
               (other_operating_income is the assembler's own term; on
               the condensed real book it is NOT 758 + 781; net 72x and
               the MEASURED net 711 — "Variația stocurilor de produse",
               beside cost of sales — are inside it since the ruling)
    ebit     = ebitda - depreciation
    pretax   = ebit + net_financial_result
    ni_stat  = pretax - tax + (not explained by the accounts)
               # the statutory adjustment is what account 121 holds beyond
               # every line above: 0.00 where 711 came off the 121 bridge,
               # the visible remainder on a book with no 711 postings

A period whose assembly REFUSED the one EBITDA (the stock variation could
not be measured) has no EBITDA to walk through: the P&L bridge refuses with
that reason, on either side.
    canonical_bs.totals.assets                  = Σ rows in the asset sections
    canonical_bs.totals.equity_plus_liabilities = Σ rows in the other sections
    (the bs_v2 object the balance-sheet tab renders; rows are paired
     across periods by their stable ids — see `bs_bridge`)

Jurisdiction-blind: nothing here names a country or a chart. The sign
conventions below are statement-line facts (revenue up is favourable in
any chart), not chart facts.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .columns import (
    DISCLOSURE_ABSENT,
    DISCLOSURE_REFUSED,
    DISCLOSURE_REPORTED,
    MOVEMENT_STATUSES,
    STATUS_ABSENT_BOTH,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    STATUS_COMPARED,
    STATUS_INCOMPARABLE,
    STATUS_REFUSED,
    ComparativeColumn,
    ComparativeTable,
    round_money,
)
from .lines import ZERO_FLOOR, equity_refusal_of, spec_for, unwrap_envelope
from .shares import (
    COMMON_SIZE_BASE,
    STATUS_NO_BASE,
    STATUS_NOT_MEANINGFUL,
    SideLine,
    SideShare,
    side_lines,
    side_shares,
)

__all__ = [
    "COMMON_SIZE_BASE",
    "COMMON_SIZE_SCHEMA",
    "CANONICAL_ROW_PREFIX",
    "CANONICAL_SECTION_PREFIX",
    "CANONICAL_TOTAL_PREFIX",
    "CANONICAL_BASE_KEY",
    "CANONICAL_EQUITY_KEYS",
    "FAVORABLE_DIRECTION",
    "MATERIALITY_FLOOR",
    "TOP_MOVERS_DEFAULT",
    "ORDER_PRIOR_EARLIER",
    "ORDER_PRIOR_LATER",
    "ORDER_SAME_CLOSE",
    "ORDER_UNKNOWN",
    "VERDICT_ORDERS",
    "CommonSizeRow",
    "BridgeStep",
    "Bridge",
    "Mover",
    "Movers",
    "Direction",
    "common_size",
    "canonical_side_lines",
    "canonical_common_size",
    "period_common_size",
    "pl_bridge",
    "bs_bridge",
    "movers",
    "line_verdict",
    "time_direction",
]

#: Which way is good news, per line. Absent from this table means NO
#: verdict — the line can be a mover but never "improved" or
#: "deteriorated". Deliberately short: a direction is only declared where
#: it holds for every business the product serves.
FAVORABLE_DIRECTION = {
    "pl.revenue": "up",
    "pl.gross_profit": "up",
    "pl.other_operating_income": "up",
    "pl.ebitda": "up",
    "pl.ebit": "up",
    "pl.pretax": "up",
    "pl.net_income": "up",
    "pl.interest_income": "up",
    "pl.financial_income": "up",
    "pl.cogs": "down",
    "pl.opex_total": "down",
    "pl.opex_third_party": "down",
    "pl.interest_expense": "down",
    "pl.financial_expense": "down",
    "bs.cash": "up",
    "bs.total_equity": "up",
    "bs.retained_earnings": "up",
    "bs.short_term_debt": "down",
    "bs.long_term_debt": "down",
    "bs.total_debt": "down",
    "bs.total_liabilities": "down",
    "bs.ar_doubtful_gross": "down",
    "bs.ar_provisions": "down",
}

#: A mover must be at least this share of the statement base to be listed.
#: Half a percent of net turnover on a 400M book is 2M — below it the list
#: is noise. Rendered into every `Movers` so the cutoff is never prose.
MATERIALITY_FLOOR = 0.005
TOP_MOVERS_DEFAULT = 8

MONEY_DP = 2
PTS_DP = 4


def _r(value: float, dp: int = MONEY_DP) -> float:
    out = round(value, dp)
    return 0.0 if out == 0 else out


# ── common size ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class CommonSizeRow:
    key: str
    statement: str
    base_key: str
    #: share of the base, as a fraction; None when refused.
    current_share: Optional[float]
    prior_share: Optional[float]
    #: change in PERCENTAGE POINTS (current_share - prior_share) * 100.
    delta_pts: Optional[float]
    status: str
    note: str


def _table_side(table: ComparativeTable, which: str) -> Tuple[SideLine, ...]:
    """One side of a comparison as the lines of ONE period — exactly what
    the column model read for that side (value to the cent, disclosure)."""
    current = which == "current"
    withheld = dict(table.current_share_withheld if current else table.prior_share_withheld)
    return tuple(
        SideLine(key=col.key, statement=col.statement, label=col.label,
                 base_key=COMMON_SIZE_BASE.get(col.statement, ""),
                 value=col.current if current else col.prior,
                 disclosure=col.current_disclosure if current else col.prior_disclosure,
                 share_withheld=withheld.get(col.key, ""))
        for col in table.columns)


def _pair_row(pair_status: str, pair_note: str, cur: SideShare, pri: SideShare) -> CommonSizeRow:
    """One two-period row from the two periods' own shares. The shares are
    `side_shares`' and nothing else; this only says what the PAIR permits."""
    line = cur.line
    if pair_status not in MOVEMENT_STATUSES and pair_status not in (
            STATUS_ABSENT_PRIOR, STATUS_ABSENT_CURRENT):
        # The pair refuses the line (refused or not disclosed on either
        # side, incomparable, absent on both): no share on either side.
        return CommonSizeRow(line.key, line.statement, line.base_key, None, None,
                             None, pair_status, pair_note)
    if cur.status == STATUS_NO_BASE:
        status, note = "no_base", (
            "%s is below the %.3f zero floor in the current period; no "
            "share can be taken" % (line.base_key, ZERO_FLOOR))
    elif pri.status == STATUS_NO_BASE:
        status, note = "no_base", (
            "%s is below the %.3f zero floor in the prior period; no "
            "share can be taken" % (line.base_key, ZERO_FLOOR))
    elif STATUS_NOT_MEANINGFUL in (cur.status, pri.status):
        # The margin rule refused this line's share in one period or both:
        # that side carries none, the other keeps its own, and there is no
        # change in points between a margin and a refusal.
        status, note = STATUS_NOT_MEANINGFUL, "; ".join(
            "%s period: %s" % (name, side.note)
            for name, side in (("current", cur), ("prior", pri))
            if side.status == STATUS_NOT_MEANINGFUL)
    elif cur.raw is not None and pri.raw is not None:
        status, note = "compared", "share of %s in both periods" % line.base_key
    else:
        status, note = pair_status, pair_note
    # The change in points is struck from the UNROUNDED sides, as it
    # always was; each side is then served rounded.
    delta = (
        _r((cur.raw - pri.raw) * 100.0, PTS_DP)
        if cur.raw is not None and pri.raw is not None else None
    )
    return CommonSizeRow(
        key=line.key, statement=line.statement, base_key=line.base_key,
        current_share=cur.share, prior_share=pri.share,
        delta_pts=delta, status=status, note=note,
    )


def common_size(table: ComparativeTable) -> Tuple[CommonSizeRow, ...]:
    """One row per column, each as a share of its statement's base."""
    cur = side_shares(_table_side(table, "current"))
    pri = side_shares(_table_side(table, "prior"))
    return tuple(_pair_row(col.status, col.note, c, p)
                 for col, c, p in zip(table.columns, cur, pri))


# ── common size of the canonical balance sheet ───────────────────────
#
# THE BALANCE-SHEET TAB RENDERS THE CANONICAL OBJECT (bs_v2), row by row —
# not the registry's `bs.*` lines. Its "% of total assets" column was
# therefore never an engine figure: the page divided each row's closing
# balance by the total it printed (BsCmpCells, measured 2026-10-04). The
# rows are served here instead, under the keys the variance bridge already
# gives them (`bs.row.<id>`), each section's subtotal and the two grand
# totals beside them, every one a share of the canonical object's OWN total
# assets — read through the serving gateway, the figure the tab prints as
# TOTAL ASSETS. One object, one base: a canonical row is never a share of a
# total another authority computed. (On a served period the registry's
# `bs.total_assets` IS that total — `_apply_envelope_truth_to_statements` —
# and the gate holds the two equal through the real route.)
CANONICAL_ROW_PREFIX = "bs.row."
CANONICAL_SECTION_PREFIX = "bs.section."
CANONICAL_TOTAL_PREFIX = "bs.total."
CANONICAL_BASE_KEY = CANONICAL_TOTAL_PREFIX + "assets"

#: The canonical grand totals, in render order: (gateway name, label).
_CANONICAL_TOTALS = (
    ("assets", "Total assets"),
    ("equity_plus_liabilities", "Total equity and liabilities"),
)

#: THE CANONICAL LINES BUILT ON TOTAL EQUITY: the equity section's subtotal
#: (the bs_v2 schema's own section id) and the grand total that adds the
#: liabilities to it. When the period refuses total equity as incomplete
#: (`lines.equity_refusal_of`: short by a refused year's result) both are
#: that short figure and neither takes a share — a share of total assets on
#: the equity subtotal IS the equity ratio the ratio table refuses on the
#: same body. The equity ROWS (share capital, reserves, …) are posted
#: balances, complete in themselves, and keep theirs.
_EQUITY_SECTION = "equity"
CANONICAL_EQUITY_KEYS = (
    CANONICAL_SECTION_PREFIX + _EQUITY_SECTION,
    CANONICAL_TOTAL_PREFIX + "equity_plus_liabilities",
)


def _canonical_line(key, label, value, why_absent, refusal=None):
    # type: (str, str, Optional[float], str, Optional[Mapping[str, Any]]) -> SideLine
    if refusal is not None and key in CANONICAL_EQUITY_KEYS:
        return SideLine(
            key=key, statement="BS", label=label, base_key=CANONICAL_BASE_KEY,
            value=None, disclosure=DISCLOSURE_REFUSED,
            note="%s is refused, so no share is taken — %s"
                 % (label, refusal.get("text_en") or refusal.get("code") or "refused"))
    if value is None:
        return SideLine(key=key, statement="BS", label=label, base_key=CANONICAL_BASE_KEY,
                        value=None, disclosure=DISCLOSURE_ABSENT, note=why_absent)
    return SideLine(key=key, statement="BS", label=label, base_key=CANONICAL_BASE_KEY,
                    value=round_money(value), disclosure=DISCLOSURE_REPORTED)


def canonical_side_lines(envelope: Mapping[str, Any]) -> Optional[Tuple[SideLine, ...]]:
    """The canonical balance sheet of ONE period as lines: every row, every
    section subtotal, the two grand totals. None when the period carries no
    canonical object (a legacy envelope has no row identities).

    A section the object lists with no row in it and a subtotal below the
    zero floor is ABSENT — the book has no such section — never 0 % of
    total assets. The lines built on a REFUSED total equity
    (`CANONICAL_EQUITY_KEYS`) are refused with the period's own reason."""
    read = _canonical_rows(envelope)
    if read is None:
        return None
    rows, totals = read
    equity_refusal = equity_refusal_of(envelope)
    node = unwrap_envelope(envelope).get("statements") or {}
    cbs = node.get("canonical_bs") or {}
    out = []  # type: List[SideLine]
    populated = set()
    for rid, (amount, section, label) in rows.items():
        populated.add(section)
        out.append(_canonical_line(CANONICAL_ROW_PREFIX + rid, label, amount, ""))
    for sec in cbs.get("sections") or []:
        if not isinstance(sec, Mapping) or sec.get("id") is None:
            continue
        sid = str(sec["id"])
        subtotal = sec.get("subtotal")
        value = None  # type: Optional[float]
        if not isinstance(subtotal, bool) and isinstance(subtotal, (int, float)):
            value = float(subtotal)
            if value != value or value in (float("inf"), float("-inf")):
                value = None
        if value is not None and sid not in populated and abs(value) < ZERO_FLOOR:
            value = None
        out.append(_canonical_line(
            CANONICAL_SECTION_PREFIX + sid, "section %s" % sid, value,
            "the period's balance sheet carries no row in section %s; absent, "
            "which is not zero — no share is taken" % sid, equity_refusal))
    for name, label in _CANONICAL_TOTALS:
        out.append(_canonical_line(
            CANONICAL_TOTAL_PREFIX + name, label, totals.get(name),
            "the canonical balance sheet does not serve %s; no share is taken" % label.lower(),
            equity_refusal))
    return tuple(out)


def _absent_side(line: SideLine) -> SideShare:
    gone = SideLine(key=line.key, statement=line.statement, label=line.label,
                    base_key=line.base_key, value=None, disclosure=DISCLOSURE_ABSENT)
    return SideShare(line=gone, raw=None, share=None, status=DISCLOSURE_ABSENT, note="")


def canonical_common_size(cur_env, pri_env, table):
    # type: (Mapping[str, Any], Mapping[str, Any], ComparativeTable) -> Tuple[CommonSizeRow, ...]
    """The canonical rows of two periods, paired by their stable ids — the
    same pairing `bs_bridge` walks. A row only one period carries is
    `absent_prior` / `absent_current` with the other side's share and no
    change in points; a pair the column model will not compare gets no
    share on either side. Each side's shares are `side_shares` over that
    period's own canonical lines."""
    cur_lines = canonical_side_lines(cur_env)
    pri_lines = canonical_side_lines(pri_env)
    if cur_lines is None and pri_lines is None:
        return ()
    cur = dict((s.line.key, s) for s in side_shares(cur_lines or ()))
    pri = dict((s.line.key, s) for s in side_shares(pri_lines or ()))
    keys = list(cur) + [k for k in pri if k not in cur]
    rows = []
    for key in keys:
        c, p = cur.get(key), pri.get(key)
        line = (c or p).line  # type: ignore[union-attr]
        c = c if c is not None else _absent_side(line)
        p = p if p is not None else _absent_side(line)
        if not table.comparability.comparable:
            status, note = STATUS_INCOMPARABLE, table.comparability.reason
        elif DISCLOSURE_REFUSED in (c.line.disclosure, p.line.disclosure):
            # The pair refuses the line, as the column model refuses a
            # registry line either period refused: no share on either side.
            status, note = STATUS_REFUSED, "%s is refused, so no change is computed — %s" % (
                line.label, "; ".join(
                    "%s: %s" % (label, side.line.note)
                    for label, side in ((table.current_label, c), (table.prior_label, p))
                    if side.line.disclosure == DISCLOSURE_REFUSED))
        elif c.line.value is not None and p.line.value is not None:
            status, note = STATUS_COMPARED, "both periods reported %s" % line.label
        elif c.line.value is not None:
            status, note = STATUS_ABSENT_PRIOR, (
                "%s carries no canonical balance sheet (bs_v2); %s is not disclosed by it"
                % (table.prior_label, line.label) if pri_lines is None else
                "%s did not report %s; absent, which is not zero — no change is "
                "computed against it" % (table.prior_label, line.label))
        elif p.line.value is not None:
            status, note = STATUS_ABSENT_CURRENT, (
                "%s carries no canonical balance sheet (bs_v2); %s is not disclosed by it"
                % (table.current_label, line.label) if cur_lines is None else
                "%s did not report %s; absent, which is not zero — no change is "
                "computed against it" % (table.current_label, line.label))
        else:
            status, note = STATUS_ABSENT_BOTH, "neither period reported %s" % line.label
        rows.append(_pair_row(status, note, c, p))
    return tuple(rows)


# ── common size of ONE period ────────────────────────────────────────

#: The served block's schema stamp (`statements.common_size.schema`).
COMMON_SIZE_SCHEMA = "common_size/1"


def period_common_size(envelope: Mapping[str, Any], level: str) -> Dict[str, Any]:
    """The single-period common size, JSON-ready: every registry line and
    every canonical balance-sheet line of ONE assembled envelope as a share
    of its base. No second period is read and none is needed.

        {"schema": "common_size/1",
         "bases": {"PL": {"key": "pl.revenue", "value": …|null},
                   "BS": {"key": "bs.total_assets", "value": …|null}},
         "rows": [{"key", "statement", "base_key", "current", "share",
                   "status", "note"}, …]}

    `status` is one of `shares.SIDE_STATUSES`; a row carries a `share`
    only under `share`, and a `current` under `share`, `no_base` and
    `margin_not_meaningful` (the line is reported; it is the share that is
    not taken). Pure: same envelope in, same bytes out."""
    lines = side_lines(envelope, level)
    by_key = dict((line.key, line) for line in lines)
    rows = []
    for s in side_shares(lines + (canonical_side_lines(envelope) or ())):
        rows.append({
            "key": s.line.key, "statement": s.line.statement, "base_key": s.line.base_key,
            "current": s.line.value, "share": s.share, "status": s.status, "note": s.note,
        })
    bases = {}
    for statement, base_key in COMMON_SIZE_BASE.items():
        base = by_key.get(base_key)
        bases[statement] = {"key": base_key, "value": None if base is None else base.value}
    return {"schema": COMMON_SIZE_SCHEMA, "bases": bases, "rows": rows}


# ── the bridge ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class BridgeStep:
    key: str
    label: str
    #: Signed contribution to the walk from prior to current total.
    amount: float
    #: The underlying line, both periods, for the reader who wants to
    #: check the step by hand.
    current: Optional[float]
    prior: Optional[float]
    #: "delta" when both periods report the line, "new" when only the
    #: current does, "gone" when only the prior does, "none" when neither.
    status: str


@dataclass(frozen=True)
class Bridge:
    statement: str
    from_label: str
    to_label: str
    prior_total: Optional[float]
    current_total: Optional[float]
    steps: Tuple[BridgeStep, ...]
    #: current - (prior + sum(steps)). Zero to the cent when `closes`.
    residual: Optional[float]
    closes: bool
    reason: str


def _raw(envelope: Mapping[str, Any], statement_key: str, field: str) -> Optional[float]:
    """The assembler's own number, dense — this is the walk's arithmetic,
    so it reads what the totals were built from. None only when the
    field is not there or not a finite number. A dotted `field` reads a
    nested block (`inventory_variation.value`)."""
    node = unwrap_envelope(envelope).get("statements") or {}
    block = node.get(statement_key) or {}
    parts = field.split(".")
    for part in parts[:-1]:
        block = block.get(part) if isinstance(block, Mapping) else None
        if not isinstance(block, Mapping):
            return None
    val = block.get(parts[-1])
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None
    f = float(val)
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _step(key, label, cur, pri, sign, cur_disclosed, pri_disclosed):
    # type: (str, str, Optional[float], Optional[float], int, bool, bool) -> BridgeStep
    c = 0.0 if cur is None else cur
    p = 0.0 if pri is None else pri
    if cur_disclosed and pri_disclosed:
        status = "delta"
    elif cur_disclosed:
        status = "new"
    elif pri_disclosed:
        status = "gone"
    else:
        status = "none"
    return BridgeStep(key=key, label=label, amount=_r(sign * (c - p)),
                      current=None if cur is None else _r(c),
                      prior=None if pri is None else _r(p), status=status)


def _disclosed(table: Optional[ComparativeTable], key: str, side: str) -> bool:
    """Whether the column model says the period reported this line. With
    no table, the raw number decides (a bridge can be struck alone)."""
    if table is None:
        return True
    col = table.by_key(key)
    if col is None:
        return True
    disc = col.current_disclosure if side == "current" else col.prior_disclosure
    return disc == "reported"


def _walk(statement, from_label, to_label, cur_env, pri_env, total_field_key,
          spec_rows, table):
    # type: (str, str, str, Mapping[str, Any], Mapping[str, Any], Tuple[str, str], Sequence[Tuple[str, str, str, str, int]], Optional[ComparativeTable]) -> Bridge
    """spec_rows: (key, label, statement_block, field, sign)."""
    block, total_field = total_field_key
    cur_total = _raw(cur_env, block, total_field)
    pri_total = _raw(pri_env, block, total_field)
    steps = []
    missing = []
    for key, label, blk, field, sign in spec_rows:
        cur = _raw(cur_env, blk, field)
        pri = _raw(pri_env, blk, field)
        if cur is None:
            missing.append("current.%s.%s" % (blk, field))
        if pri is None:
            missing.append("prior.%s.%s" % (blk, field))
        steps.append(_step(key, label, cur, pri, sign,
                           _disclosed(table, key, "current"),
                           _disclosed(table, key, "prior")))
    if cur_total is None or pri_total is None or missing:
        gaps = missing + (["current.%s.%s" % (block, total_field)] if cur_total is None else []) \
            + (["prior.%s.%s" % (block, total_field)] if pri_total is None else [])
        return Bridge(statement=statement, from_label=from_label, to_label=to_label,
                      prior_total=None if pri_total is None else _r(pri_total),
                      current_total=None if cur_total is None else _r(cur_total),
                      steps=tuple(steps), residual=None, closes=False,
                      reason="bridge refused: envelope field(s) missing — %s"
                             % ", ".join(sorted(set(gaps))))
    walked = pri_total + sum(s.amount for s in steps)
    residual = _r(cur_total - walked)
    closes = abs(residual) < ZERO_FLOOR
    reason = (
        "prior %s + %d steps == current %s to the cent"
        % (from_label, len(steps), to_label) if closes else
        "bridge refused: prior + steps misses current by %.2f — the "
        "assembler's identity does not hold on these envelopes, so no "
        "step is plugged to make it" % residual
    )
    return Bridge(statement=statement, from_label=from_label, to_label=to_label,
                  prior_total=_r(pri_total), current_total=_r(cur_total),
                  steps=tuple(steps), residual=residual, closes=closes, reason=reason)


#: The P&L walk, net income (statutory) to net income (statutory).
#:
#: `other_operating_income` is the assembler's OWN EBITDA term
#: (chart_of_accounts.py: `ebitda = revenue - cogs - opex + other_inc`).
#: The first version of this walk spelled it as 758 + 781, which happened
#: to equal it on the analytic Scandia book and MISSED it by 326,903.15 on
#: the condensed one — an identity assumed, not read. The walk now carries
#: the assembler's term itself, so it closes wherever the assembler does.
#:
#: THE ONE EBITDA (owner ruling 2026-09-26): own work capitalised (net 72x)
#: and the MEASURED stock variation (net 711, "Variația stocurilor de
#: produse", beside cost of sales, signed) are steps of their own — inside
#: EBITDA, outside turnover — read from the blocks the assembler serves.
#:
#: PROVISIONS SYMMETRIC (owner ruling R2, 2026-09-28): the ruled charges
#: (6812, 6814) and reversals (7812, 7814) are outside EBITDA — out of
#: `other_operating_income` and out of `depreciation` — and walk as ONE
#: step of their own, their net (`net_provisions.value`, signed as a
#: charge). The accounts are the served block's (this package is
#: jurisdiction-blind, E8: it names no account list).
_PL_STEPS = (
    ("pl.revenue", "Net turnover", "assembled_pl", "revenue", +1),
    ("pl.other_operating_income_total", "Other operating income (EBITDA basis)",
     "assembled_pl", "other_operating_income", +1),
    ("pl.capitalized_own_work", "Own work capitalised (72x)",
     "assembled_pl", "capitalized_own_work.value", +1),
    ("pl.cogs", "Cost of goods sold", "assembled_pl", "cogs", -1),
    ("pl.inventory_variation", "Variația stocurilor de produse (711)",
     "assembled_pl", "inventory_variation.value", +1),
    ("pl.opex_total", "Operating expenses", "assembled_pl", "opex_total", -1),
    ("pl.depreciation", "Depreciation & amortisation", "assembled_pl", "depreciation", -1),
    ("pl.net_provisions", "Net provisions (outside EBITDA)",
     "assembled_pl", "net_provisions.value", -1),
    ("pl.net_financial_result", "Net financial result", "assembled_pl", "net_financial_result", +1),
    ("pl.tax", "Income tax", "assembled_pl", "tax", -1),
)


def _ebitda_refusal(envelope: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    node = unwrap_envelope(envelope).get("statements") or {}
    apl = node.get("assembled_pl") if isinstance(node, Mapping) else None
    refusal = apl.get("ebitda_refusal") if isinstance(apl, Mapping) else None
    return refusal if isinstance(refusal, Mapping) else None


def pl_bridge(cur_env, pri_env, table=None):
    # type: (Mapping[str, Any], Mapping[str, Any], Optional[ComparativeTable]) -> Bridge
    """Prior statutory net income → current statutory net income.

    The last step is the statutory adjustment — `net_income_statutory -
    (net_income_operational + net 72x + net 711)` in each period — what
    account 121 holds beyond every line the walk names (0.00 where net 711
    came off the 121 bridge). It is a named step because it is a real
    difference between two numbers the assembler serves, not a plug.

    A period whose assembly refused the one EBITDA refuses the bridge, by
    name and with the reason: its stock variation cannot be stated, so
    neither can the walk through its EBITDA."""
    refused = [(side, r) for side, r in (("current", _ebitda_refusal(cur_env)),
                                        ("prior", _ebitda_refusal(pri_env))) if r is not None]
    if refused:
        return Bridge(statement="PL", from_label="net income (statutory)",
                      to_label="net income (statutory)",
                      prior_total=_raw(pri_env, "assembled_pl", "net_income_statutory"),
                      current_total=_raw(cur_env, "assembled_pl", "net_income_statutory"),
                      steps=(), residual=None, closes=False,
                      reason="bridge refused: the one EBITDA is refused for %s" % "; ".join(
                          "the %s period (%s: %s)" % (side, r.get("code"), r.get("text_en") or "")
                          for side, r in refused))
    bridge = _walk("PL", "net income (statutory)", "net income (statutory)",
                   cur_env, pri_env, ("assembled_pl", "net_income_statutory"),
                   _PL_STEPS, table)
    if bridge.residual is None:
        # The walk refused on a missing field; its reason names the field.
        # Re-walking here would turn "cannot be verified" into a number.
        return bridge
    cur_adj = None
    pri_adj = None

    def _named(env):  # type: (Mapping[str, Any]) -> Optional[float]
        """net income built from the named lines: the operational build-up
        plus net 72x plus net 711."""
        parts = (_raw(env, "assembled_pl", "net_income_operational"),
                 _raw(env, "assembled_pl", "capitalized_own_work.value"),
                 _raw(env, "assembled_pl", "inventory_variation.value"))
        return None if any(v is None for v in parts) else sum(parts)  # type: ignore[arg-type]

    cs, co = _raw(cur_env, "assembled_pl", "net_income_statutory"), _named(cur_env)
    ps, po = _raw(pri_env, "assembled_pl", "net_income_statutory"), _named(pri_env)
    if cs is not None and co is not None:
        cur_adj = cs - co
    if ps is not None and po is not None:
        pri_adj = ps - po
    if cur_adj is None or pri_adj is None:
        gaps = []
        if cur_adj is None:
            gaps.append("current.assembled_pl.net_income_operational")
        if pri_adj is None:
            gaps.append("prior.assembled_pl.net_income_operational")
        return Bridge(statement="PL", from_label=bridge.from_label, to_label=bridge.to_label,
                      prior_total=bridge.prior_total, current_total=bridge.current_total,
                      steps=bridge.steps, residual=None, closes=False,
                      reason="bridge refused: envelope field(s) missing — %s" % ", ".join(gaps))
    adj = _step("pl.statutory_adjustment",
                "Statutory adjustment (account 121 beyond the named lines)",
                cur_adj, pri_adj, +1, True, True)
    steps = tuple(bridge.steps) + (adj,)
    if bridge.prior_total is None or bridge.current_total is None:
        return Bridge(statement="PL", from_label=bridge.from_label, to_label=bridge.to_label,
                      prior_total=bridge.prior_total, current_total=bridge.current_total,
                      steps=steps, residual=None, closes=False, reason=bridge.reason)
    walked = bridge.prior_total + sum(s.amount for s in steps)
    residual = _r(bridge.current_total - walked)
    closes = abs(residual) < ZERO_FLOOR
    reason = (
        "prior net income + %d steps == current net income to the cent" % len(steps)
        if closes else
        "bridge refused: prior + steps misses current by %.2f — the "
        "assembler's identity does not hold on these envelopes, so no "
        "step is plugged to make it" % residual
    )
    return Bridge(statement="PL", from_label=bridge.from_label, to_label=bridge.to_label,
                  prior_total=bridge.prior_total, current_total=bridge.current_total,
                  steps=steps, residual=residual, closes=closes, reason=reason)


#: THE BALANCE-SHEET WALKS READ THE CANONICAL OBJECT (bs_v2), row by row.
#:
#: MEASURED on four real books (saga_10_col, saga_compact_6_col and the
#: two client years): `statements.canonical_bs` sums its rows to its
#: section subtotals and its sections to its totals EXACTLY, and it is
#: what the balance-sheet tab renders. The `assembled_bs` bucket chain
#: does not — its `total_equity` is served from the canonical object
#: while its components are the persistence buckets, so `share_capital +
#: retained_earnings + other_equity` missed `total_equity` by 402,869.16
#: on saga_10_col and by 64.7M on the analytic client year. One
#: authority: the walk is over the canonical rows, paired across periods
#: by their stable ids; a row only one period carries is a `new` / `gone`
#: step for its whole amount. The section→side split is the bs_v2
#: schema's own.
_BS_ASSET_SECTIONS = frozenset({"non_current_assets", "current_assets", "prepaid_expenses"})


def _canonical_rows(envelope):
    # type: (Mapping[str, Any]) -> Optional[Tuple[Dict[str, Tuple[float, str, str]], Dict[str, float]]]
    """({row_id: (amount, section, label)}, totals) or None without bs_v2."""
    node = unwrap_envelope(envelope).get("statements") or {}
    cbs = node.get("canonical_bs")
    if not isinstance(cbs, Mapping):
        return None
    rows = {}  # type: Dict[str, Tuple[float, str, str]]
    for row in cbs.get("rows") or []:
        if not isinstance(row, Mapping) or not row.get("id"):
            continue
        amt = row.get("amount")
        if isinstance(amt, bool) or not isinstance(amt, (int, float)):
            continue
        rows[str(row["id"])] = (float(amt), str(row.get("section") or ""), str(row.get("label") or row["id"]))
    return rows, canonical_totals(cbs, node.get("currency"))


def canonical_totals(cbs, currency):
    # type: (Mapping[str, Any], Any) -> Dict[str, float]
    """The two balance-sheet totals the bridges close against, read through
    the serving gateway (the one sanctioned reader of canonical_bs facts,
    docs/CANONICAL_BS_V2_CONTRACT.md) — never off the raw snapshot. A total
    the gateway cannot serve is omitted, so the bridge refuses by name."""
    from engine.serving.facts import FactsGateway, MissingFactError

    gateway = FactsGateway.from_envelope({"canonical_bs": dict(cbs)}, currency=currency)
    out = {}  # type: Dict[str, float]
    if gateway is None or gateway.tier != FactsGateway.TIER_CANONICAL:
        return out
    for key, accessor in (("assets", gateway.total_assets),
                          ("equity_plus_liabilities", gateway.equity_plus_liabilities)):
        try:
            out[key] = accessor().to_float()
        except MissingFactError:
            continue
    return out


def _row_walk(side_label, cur_rows, pri_rows, cur_total, pri_total, on_side):
    # type: (str, Dict[str, Tuple[float, str, str]], Dict[str, Tuple[float, str, str]], Optional[float], Optional[float], Any) -> Bridge
    # Current rows in the object's own order, then rows only the prior had.
    ids = [rid for rid, (_a, sec, _l) in cur_rows.items() if on_side(sec)]
    ids += [rid for rid, (_a, sec, _l) in pri_rows.items() if on_side(sec) and rid not in cur_rows]
    steps = []
    for rid in ids:
        cur = cur_rows.get(rid)
        pri = pri_rows.get(rid)
        label = (cur or pri)[2]
        steps.append(_step("bs.row." + rid, label,
                           None if cur is None else cur[0],
                           None if pri is None else pri[0],
                           +1, cur is not None, pri is not None))
    if cur_total is None or pri_total is None:
        gaps = []
        if cur_total is None:
            gaps.append("current.canonical_bs.totals")
        if pri_total is None:
            gaps.append("prior.canonical_bs.totals")
        return Bridge(statement="BS", from_label=side_label, to_label=side_label,
                      prior_total=None if pri_total is None else _r(pri_total),
                      current_total=None if cur_total is None else _r(cur_total),
                      steps=tuple(steps), residual=None, closes=False,
                      reason="bridge refused: envelope field(s) missing — %s" % ", ".join(gaps))
    walked = pri_total + sum(s.amount for s in steps)
    residual = _r(cur_total - walked)
    closes = abs(residual) < ZERO_FLOOR
    reason = (
        "prior %s + %d rows == current %s to the cent" % (side_label, len(steps), side_label)
        if closes else
        "bridge refused: prior + rows misses current by %.2f — the canonical "
        "object's rows do not sum to its totals on these envelopes, so no "
        "step is plugged to make it" % residual
    )
    return Bridge(statement="BS", from_label=side_label, to_label=side_label,
                  prior_total=_r(pri_total), current_total=_r(cur_total),
                  steps=tuple(steps), residual=residual, closes=closes, reason=reason)


def _no_canonical(side_label, which):
    # type: (str, str) -> Bridge
    return Bridge(statement="BS", from_label=side_label, to_label=side_label,
                  prior_total=None, current_total=None, steps=(), residual=None,
                  closes=False,
                  reason="bridge refused: the %s period carries no canonical "
                         "balance sheet (bs_v2); a legacy envelope has no row "
                         "identities to walk" % which)


def bs_bridge(cur_env, pri_env, table=None):
    # type: (Mapping[str, Any], Mapping[str, Any], Optional[ComparativeTable]) -> Tuple[Bridge, Bridge]
    """Two walks over the canonical rows: total assets, and liabilities +
    equity. Each closes on its own side; a book whose two sides disagree
    still gets two honest bridges rather than one that hides the gap.
    `table` is accepted for signature symmetry with `pl_bridge`; the
    canonical object carries its own presence (a row id is there or it
    is not)."""
    cur = _canonical_rows(cur_env)
    pri = _canonical_rows(pri_env)
    if cur is None or pri is None:
        which = "current" if cur is None else "prior"
        return _no_canonical("total assets", which), _no_canonical("liabilities + equity", which)
    cur_rows, cur_tot = cur
    pri_rows, pri_tot = pri
    assets = _row_walk("total assets", cur_rows, pri_rows,
                       cur_tot.get("assets"), pri_tot.get("assets"),
                       lambda sec: sec in _BS_ASSET_SECTIONS)
    le = _row_walk("liabilities + equity", cur_rows, pri_rows,
                   cur_tot.get("equity_plus_liabilities"), pri_tot.get("equity_plus_liabilities"),
                   lambda sec: sec not in _BS_ASSET_SECTIONS)
    return assets, le


# ── which way time runs ──────────────────────────────────────────────
#
# "Improved" and "deteriorated" are words about time: the line moved the
# good way FROM the prior period TO the current one. The picker lets a
# reader compare with a period that closes AFTER the one on screen
# (review of 2026-10-04): Δ is then current − later, and a verdict judged
# on it reads history backwards — turnover that GREW from 2024 to 2025 was
# listed "deteriorated" on the 2024 screen. The figures of such a
# comparison are all true and all served; the adjectives are not.

ORDER_PRIOR_EARLIER = "prior_is_earlier"
ORDER_PRIOR_LATER = "prior_is_later"
ORDER_SAME_CLOSE = "same_close"
ORDER_UNKNOWN = "unknown"

#: The orders under which a verdict is served. A later prior reads time
#: backwards; an order that cannot be read is not assumed forward.
VERDICT_ORDERS: Tuple[str, ...] = (ORDER_PRIOR_EARLIER, ORDER_SAME_CLOSE)


@dataclass(frozen=True)
class Direction:
    #: One of the four ORDER_* tokens.
    order: str
    #: The two closes the order was read from, as ISO dates (None: unreadable).
    current_period_end: Optional[str]
    prior_period_end: Optional[str]
    #: False when no improved / deteriorated verdict is served.
    verdicts_served: bool
    #: Why not — `prior_is_later` | `period_order_unknown`; None when served.
    reason: Optional[str]
    note: str


def _close_date(value: Any) -> Optional[datetime.date]:
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def time_direction(current_period_end: Any, prior_period_end: Any) -> Direction:
    """Which way time runs between the two periods, from their closes.

    Pure: the two dates in, the order out — no clock is read."""
    cur = _close_date(current_period_end)
    pri = _close_date(prior_period_end)
    cur_iso = None if cur is None else cur.isoformat()
    pri_iso = None if pri is None else pri.isoformat()
    if cur is None or pri is None:
        unread = [name for name, d in (("current", cur), ("prior", pri)) if d is None]
        return Direction(
            order=ORDER_UNKNOWN, current_period_end=cur_iso, prior_period_end=pri_iso,
            verdicts_served=False, reason="period_order_unknown",
            note="the close of the %s period cannot be read, so which period is the "
                 "earlier one is unknown: no line is called improved or deteriorated"
                 % " and the ".join(unread))
    if pri > cur:
        return Direction(
            order=ORDER_PRIOR_LATER, current_period_end=cur_iso, prior_period_end=pri_iso,
            verdicts_served=False, reason=ORDER_PRIOR_LATER,
            note="the comparison period closes on %s, after the current period (%s): "
                 "every change reads backwards in time, so no line is called "
                 "improved or deteriorated" % (pri_iso, cur_iso))
    order = ORDER_SAME_CLOSE if pri == cur else ORDER_PRIOR_EARLIER
    return Direction(order=order, current_period_end=cur_iso, prior_period_end=pri_iso,
                     verdicts_served=True, reason=None, note="")


# ── movers ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Mover:
    key: str
    statement: str
    label: str
    current: Optional[float]
    prior: Optional[float]
    delta: Optional[float]
    delta_pct: Optional[float]
    #: |delta| as a share of the current period's statement base.
    materiality: float
    base_key: str
    #: "up" | "down" | None — the declared favourable direction.
    favorable: Optional[str]
    #: "improved" | "deteriorated" | None (no declared direction, or no move).
    verdict: Optional[str]
    status: str


@dataclass(frozen=True)
class Movers:
    #: The floor and the base the ranking used, rendered from the data.
    materiality_floor: float
    bases: Dict[str, Tuple[str, Optional[float]]]
    top: Tuple[Mover, ...]
    improved: Tuple[Mover, ...]
    deteriorated: Tuple[Mover, ...]
    #: Lines that moved but fell under the floor — counted, not hidden.
    below_floor: int
    #: None when verdicts are served. Otherwise WHY every `verdict` is None
    #: and both lists are empty (`Direction.reason`): the ranking, the
    #: figures and the declared directions are served all the same.
    verdicts_withheld: Optional[str] = None


def _verdict(favorable: Optional[str], delta: Optional[float]) -> Optional[str]:
    if favorable is None or delta is None or abs(delta) < ZERO_FLOOR:
        return None
    up = delta > 0
    if favorable == "up":
        return "improved" if up else "deteriorated"
    return "deteriorated" if up else "improved"


def line_verdict(key, delta):
    # type: (str, Optional[float]) -> Optional[str]
    """The verdict this module gives one comparatives line's movement:
    "improved" | "deteriorated" | None (no declared direction, or no move).
    The same rule `movers` applies, exposed so a composer that ranks a
    DERIVED line (EBITDA, net income, total debt — lines `movers` leaves
    out so no move is counted twice) never restates the direction table."""
    return _verdict(FAVORABLE_DIRECTION.get(key), delta)


def movers(table, top_n=TOP_MOVERS_DEFAULT, floor=MATERIALITY_FLOOR, verdicts_withheld=None):
    # type: (ComparativeTable, int, float, Optional[str]) -> Movers
    """Rank the bucket-backed lines that moved. Subtotals and derived lines
    (EBITDA, total assets, …) are excluded from the ranking so a move is
    never counted twice; they still carry a verdict in `common_size`.

    `verdicts_withheld` is the reason no verdict may be served — the
    document's `Direction.reason` when time does not run forward from the
    prior to the current period. The ranking is unchanged; every verdict
    is None and neither list holds a line."""
    bases = {}  # type: Dict[str, Tuple[str, Optional[float]]]
    for stmt, base_key in COMMON_SIZE_BASE.items():
        col = table.by_key(base_key)
        bases[stmt] = (base_key, None if col is None else col.current)

    candidates = []  # type: List[Mover]
    below = 0
    for col in table.columns:
        spec = spec_for(col.key)
        if spec is None or not spec.source_buckets:
            continue
        if col.status not in MOVEMENT_STATUSES:
            continue
        base_key, base = bases.get(col.statement, ("", None))
        if base is None or abs(base) < ZERO_FLOOR or col.delta is None:
            continue
        materiality = abs(col.delta) / abs(base)
        fav = FAVORABLE_DIRECTION.get(col.key)
        m = Mover(key=col.key, statement=col.statement, label=col.label,
                  current=col.current, prior=col.prior, delta=col.delta,
                  delta_pct=col.delta_pct, materiality=_r(materiality, 6),
                  base_key=base_key, favorable=fav,
                  verdict=None if verdicts_withheld else _verdict(fav, col.delta),
                  status=col.status)
        if materiality < floor:
            below += 1
            continue
        candidates.append(m)

    # Deterministic: materiality desc, then key — two hosts, one order.
    candidates.sort(key=lambda m: (-m.materiality, m.key))
    top = tuple(candidates[:top_n])
    improved = tuple(m for m in candidates if m.verdict == "improved")
    deteriorated = tuple(m for m in candidates if m.verdict == "deteriorated")
    return Movers(materiality_floor=floor, bases=bases, top=top,
                  improved=improved, deteriorated=deteriorated, below_floor=below,
                  verdicts_withheld=verdicts_withheld or None)
