"""COMMON SIZE, THE VARIANCE BRIDGE, AND TOP MOVERS — over a ComparativeTable.

Three readings of the same two envelopes, each with its own refusal.

  COMMON SIZE   every line as a share of its statement's base (net turnover
                for the P&L, total assets for the balance sheet), for each
                period, and the change in PERCENTAGE POINTS — never a
                percentage of a percentage. A line the column model refused
                stays refused here; a base below the zero floor refuses the
                whole statement's shares.

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
                does not know the business.

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

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .columns import (
    MOVEMENT_STATUSES,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    ComparativeColumn,
    ComparativeTable,
)
from .lines import ZERO_FLOOR, spec_for, unwrap_envelope

__all__ = [
    "COMMON_SIZE_BASE",
    "FAVORABLE_DIRECTION",
    "MATERIALITY_FLOOR",
    "TOP_MOVERS_DEFAULT",
    "CommonSizeRow",
    "BridgeStep",
    "Bridge",
    "Mover",
    "Movers",
    "common_size",
    "pl_bridge",
    "bs_bridge",
    "movers",
]

#: The line each statement's shares are taken against.
COMMON_SIZE_BASE = {"PL": "pl.revenue", "BS": "bs.total_assets"}

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


def _base_values(table: ComparativeTable, statement: str) -> Tuple[Optional[float], Optional[float], str]:
    base_key = COMMON_SIZE_BASE.get(statement)
    if base_key is None:
        return None, None, ""
    col = table.by_key(base_key)
    if col is None:
        return None, None, base_key
    return col.current, col.prior, base_key


def _share(value: Optional[float], base: Optional[float]) -> Optional[float]:
    if value is None or base is None or abs(base) < ZERO_FLOOR:
        return None
    return value / abs(base)


def common_size(table: ComparativeTable) -> Tuple[CommonSizeRow, ...]:
    """One row per column, each as a share of its statement's base."""
    rows = []
    for col in table.columns:
        if col.statement not in COMMON_SIZE_BASE:
            # analytic-only figures live under "BS" in the registry but
            # carry no base of their own; a refused column stays refused.
            pass
        cur_base, pri_base, base_key = _base_values(table, col.statement)
        if col.status not in MOVEMENT_STATUSES and col.status not in (
                STATUS_ABSENT_PRIOR, STATUS_ABSENT_CURRENT):
            rows.append(CommonSizeRow(col.key, col.statement, base_key, None, None,
                                      None, col.status, col.note))
            continue
        cur_share = _share(col.current, cur_base)
        pri_share = _share(col.prior, pri_base)
        if cur_share is None and col.current is not None:
            status, note = "no_base", (
                "%s is below the %.3f zero floor in the current period; no "
                "share can be taken" % (base_key, ZERO_FLOOR))
        elif pri_share is None and col.prior is not None:
            status, note = "no_base", (
                "%s is below the %.3f zero floor in the prior period; no "
                "share can be taken" % (base_key, ZERO_FLOOR))
        elif cur_share is not None and pri_share is not None:
            status, note = "compared", "share of %s in both periods" % base_key
        else:
            status, note = col.status, col.note
        delta = (
            _r((cur_share - pri_share) * 100.0, PTS_DP)
            if cur_share is not None and pri_share is not None else None
        )
        rows.append(CommonSizeRow(
            key=col.key, statement=col.statement, base_key=base_key,
            current_share=None if cur_share is None else _r(cur_share, 6),
            prior_share=None if pri_share is None else _r(pri_share, 6),
            delta_pts=delta, status=status, note=note,
        ))
    return tuple(rows)


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


def _verdict(favorable: Optional[str], delta: Optional[float]) -> Optional[str]:
    if favorable is None or delta is None or abs(delta) < ZERO_FLOOR:
        return None
    up = delta > 0
    if favorable == "up":
        return "improved" if up else "deteriorated"
    return "deteriorated" if up else "improved"


def movers(table, top_n=TOP_MOVERS_DEFAULT, floor=MATERIALITY_FLOOR):
    # type: (ComparativeTable, int, float) -> Movers
    """Rank the bucket-backed lines that moved. Subtotals and derived lines
    (EBITDA, total assets, …) are excluded from the ranking so a move is
    never counted twice; they still carry a verdict in `common_size`."""
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
                  verdict=_verdict(fav, col.delta), status=col.status)
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
                  improved=improved, deteriorated=deteriorated, below_floor=below)
