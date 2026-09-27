"""ONE PERIOD'S RATIO TABLE, computed at serve time from the served payload.

The engine is the one authority for ratio values, bands and band status
(critic authority_decision). This module is the per-period half: given the
payload ``GET /api/period/{id}`` serves, it returns the block that will be
served as ``assembled_metrics.ratio_table`` (``get_period`` builds it with
``serve_time_metrics=True``). Its ``credit`` block is the serve-time
credit model (``engine.ratios.credit_model.credit_block`` over
``compute_period_metrics`` of the served statements), with the payload's
persisted ``metrics`` rows as the as-filed evidence.

── WHERE EACH VALUE COMES FROM ───────────────────────────────────────────

Exactly where ``frontend/lib/financialReport.ts computeRatios`` takes it
today, operand for operand and precedence for precedence, so the engine's
quantized value equals the printed FE value on every shared key
(``tests/engine/test_ratio_table.py`` holds that on four committed books):

  · balance-sheet TOTALS (current assets / liabilities, total assets,
    equity) through ``engine.serving.facts.FactsGateway`` over the served
    ``statements.canonical_bs`` — the same served totals ``servedFacts.ts
    factsFrom`` reads;
  · bucket lines (cash, receivables, inventory, payables, short/long-term
    debt) from ``statements.balanceSheet``, P&L lines from
    ``statements.incomeStatement`` — canonical_bs carries no debt split;
  · the served engine metric row (``payload.metrics``) where the FE's
    ``mOr`` lets the engine row win (P&L ratios), and only as the fallback
    where the FE's ``bsOr`` makes the division of the printed balance
    sheet win (balance-sheet ratios) — the split is recorded per key in
    ``_PRECEDENCE`` below;
  · the account-121 anchored net income (``assembled_pl.
    net_income_statutory``, then the metric, then the reconstruction) for
    ROA, ROE and — on the no-metric path — net margin.

── WHERE THE ENGINE DEPARTS FROM computeRatios, AND WHY ──────────────────

Each departure is invisible on the metric-present payloads the parity gate
reads, and each is gated on its own:

  · ONE KEY, ONE FORMULA. When a period serves no metric row for a
    ``mOr`` key (a prior period, or any ``GET /api/period`` body whose
    ``calculated_metrics`` are absent), the FE fallback computes a
    DIFFERENT formula under the same key: ``net_margin`` over the class-6/7
    reconstruction while ROA/ROE beside it read account 121, and
    ``interest_coverage`` on EBIT while the metric divided EBITDA (until
    2026-09-19; the metric is now EBIT ÷ interest, the methodology's
    definition, and ``ebitda_to_interest`` is the EBITDA row), and
    ``dscr`` / ``dscr_with_lt_principal`` on cash EBITDA while the
    metric is statutory EBITDA. The engine's fallback is the metric's own
    definition (``pipeline.stage_compute``): ``net_margin`` =
    anchored net income ÷ revenue; ``interest_coverage`` = EBIT ÷
    interest; the two DSCRs = EBITDA ÷ their debt service.
    ``test_ratio_table.py`` holds the no-metric route body to the
    metric-present value on every ``mOr`` key.
  · THE ONE EBITDA (owner ruling 2026-09-26). EBITDA, EBIT and gross
    profit are READ from the assembled P&L's one definition
    (``credit_model.operating_figures``: net 711 "Variația stocurilor de
    produse" and net 72x inside, 767 financial) — never rebuilt here
    from the ``incomeStatement`` mirror, which carries no net 711. A
    refused one-EBITDA refuses every row that divides it
    (``ebitda_refused``, the stock-variation cause and its sentence
    beside the code) — never a fallback to the definition without 711.
    Every margin divides TURNOVER (``incomeStatement.revenue`` = class 70
    − 709), never total operating revenue.
  · SECTOR WITHHOLDING reaches the three metric-only keys whose FE
    sibling is sector-calibrated (``SECTOR_SIBLING_OF``): a margin over
    revenue is withheld with ``ebitda_margin``, inventory turnover with
    ``dio``. One document must not grade ``core_ebitda_margin`` on the
    ladder it withholds for ``ebitda_margin``.
  · A LEGACY PERIOD (no served ``canonical_bs``) reads the balance-sheet
    totals from the served ``assembled_bs`` grand totals — the persisted
    truth ``servedFacts.ts centsFromLegacy`` reads — and refuses them
    (``operand_absent``) when that coherent triple is absent, where the FE
    would fall back to bucket sums. It never reads the re-assembled
    ``assembled_canonical_v1.methodology`` totals.

Floats are combined in the SAME ORDER the FE's ``absentAware`` folds do
(``add`` from 0, ``mul`` from 1, left to right), so both runtimes produce
the same IEEE double, not merely a close one.

── BANDS ─────────────────────────────────────────────────────────────────

From the pack: the served ``statements.assembled_bands`` block (which is
``country_packs.ro_romania.chart_of_accounts._band_definitions`` output),
or ``_band_definitions()`` itself when a payload carries none. Rungs are
served in the row's DISPLAY unit as strings (pct rows: the pack fraction
× 100). Grading walks strong → healthy → watch with ``>=`` for
higher-is-better and ``<=`` otherwise, on the full-precision value — the
``verdictFromBands`` semantics. A value past the last rung takes the
floor: the definition's declared ``floor`` when it carries one (DPO
floors at ``watch``, owner ruling 2026-09-14), else ``critical``.
Four FE ladders diverge from the pack
(dpo, ccc, asset_turnover, ltv vs debt_to_assets); the gate declares the
verdicts that divergence changes rather than hiding them.

── WHAT A ROW CAN SAY ────────────────────────────────────────────────────

``band_status`` is one of ``BAND_STATUSES``. ``ladder`` is served ONLY on a
``graded`` row: a withheld or refused row carries ``ladder: null``, so no
reader can print a cutoff beside a badge that was not decided by it
(TC-10).
  graded           value present, a pack ladder applied;
  ungraded_sector  sector-calibrated key and the payload's industry signal
                   blocks sector content;
  withheld_sign    the denominator the ladder assumes positive is negative;
  withheld_basis   the ladder measures a base this book does not have
                   (gross margin with no cost of sales);
  not_banded       value present, the pack bands no such key;
  refused          no value; ``reason`` names why.
A MARGIN THAT IS NOT MEANINGFUL (``margin_not_meaningful``) is refused, not
withheld: every key ``packs/ratios/margin_meaning.yaml`` lists (the margins
over turnover) carries no value and no percent when turnover is negligible
against operating activity — the ONE rule ``engine.ratios.margin_meaning``
decides for this table, the served period and the forecast cockpit alike.
Its ``reason`` carries the share, the threshold and the refusal text beside
the code (TC-10: the threshold is the pack's, never prose).
Every ``reason.code`` is one of ``REASON_CODES``. ``higher_is_better`` is
present on EVERY row, refused and ungraded rows included.

── QUANTIZATION ──────────────────────────────────────────────────────────

``Decimal(float)`` — the EXACT binary value, never its repr — quantized
``ROUND_HALF_UP`` at display precision (x 2dp, pct 1dp, days 0dp, z 2dp,
score 1dp) and serialised as a string. On the exact binary value that is
what JavaScript's ``toFixed`` prints (it rounds the magnitude half up), so
``2.675`` (binary 2.67499…) prints ``2.67`` on both sides.

── CENSUS (TC-13) ────────────────────────────────────────────────────────

``CENSUS`` is the 22 rows ``computeRatios`` emits — with the FE's ``ltv``
row served under the pack key ``debt_to_assets``, because the engine never
receives a property market value (served ``supplementary`` is
``periodDays`` only) and without one the FE row IS total debt ÷ total
assets — plus the six pack-banded keys no FE row carries
(``net_debt_to_ebitda``, ``lt_debt_to_equity``, ``ebitda_to_interest``,
``operating_margin``, ``core_ebitda_margin``, ``inventory_turnover``).
Those six have no FE formula to mirror, so their value is the served
engine metric row verbatim (the only authority that defines them) and a
period with no such row refuses them with ``engine_metric_absent``. The
union therefore covers every FE row and every pack-banded key; a key the
pack adds later reds the census gate instead of going unserved.

── SCOPE ─────────────────────────────────────────────────────────────────

Private (RO trial-balance) served payloads. A statements block that
declares its own absences (``absentInputs`` / ``reportedTotals``, the
FE-only public-company adapter shape) is not computed here: every row
refuses with ``source_declares_absence`` rather than reading a declared
absence as a value. A period whose served payload carries no canonical
balance sheet and no coherent ``assembled_bs`` grand-total triple refuses
the balance-sheet totals (``operand_absent``) where the FE would fall back
to legacy bucket sums.

PURITY: the output is a function of the payload alone — no clock, no
randomness. ``FactsGateway.from_envelope`` may append to the access log when
access logging is enabled (a side effect with a timestamp); nothing it
writes reaches the table.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

TABLE_VERSION = "ratio_table.v1"

#: Display precision per display unit — the digits ``formatRatio`` prints.
DISPLAY_DIGITS: Dict[str, int] = {"x": 2, "pct": 1, "days": 0, "z": 2, "score": 1}

BAND_STATUSES: Tuple[str, ...] = (
    "graded",
    "ungraded_sector",
    "withheld_sign",
    "withheld_basis",
    "not_banded",
    "refused",
)

#: The closed enum every ``reason.code`` is drawn from.
REASON_CODES: Tuple[str, ...] = (
    # refused (no value)
    "operand_absent",
    "zero_denominator",
    "nonpositive_denominator",
    "non_finite",
    "engine_metric_absent",
    "user_input_absent",
    "source_declares_absence",
    # the one EBITDA / operating result is refused on this period (the
    # stock variation, account 711, could not be measured)
    "ebitda_refused",
    # a margin over a turnover negligible against operating activity
    # (engine.ratios.margin_meaning, packs/ratios/margin_meaning.yaml)
    "margin_not_meaningful",
    # band withheld (value kept)
    "sector_unconfirmed",
    "negative_denominator",
    "no_cost_of_sales",
    "not_in_pack_bands",
)

#: `financialReport.ts SECTOR_CALIBRATED_RATIOS` — the six keys whose
#: ladder moves with the industry, withheld when the served industry
#: signal blocks sector content. The parity gate reds if the FE set and
#: this one grade differently on the disputed books.
SECTOR_CALIBRATED_RATIOS = frozenset(
    {"gross_margin", "ebitda_margin", "net_margin", "dio", "dso", "asset_turnover"}
)

#: The six metric-only census keys have no FE row, so no FE set says
#: whether their ladder is sector-calibrated. Each inherits the status of
#: the FE row that measures the same thing on the same base — declared
#: here as data and asserted by the sector gate, never inferred:
#: operating and core-EBITDA margins are margins over revenue (the
#: ``ebitda_margin`` ladder, rung for rung for core EBITDA), inventory
#: turnover is DIO inverted, and the three leverage/coverage keys follow
#: their sector-neutral FE siblings.
SECTOR_SIBLING_OF: Mapping[str, str] = {
    "operating_margin": "ebitda_margin",
    "core_ebitda_margin": "ebitda_margin",
    "inventory_turnover": "dio",
    "net_debt_to_ebitda": "debt_to_ebitda",
    "lt_debt_to_equity": "debt_to_equity",
    "ebitda_to_interest": "interest_coverage",
}

#: Every census key withheld under a disputed sector: the FE set plus the
#: metric-only keys whose sibling is in it.
SECTOR_WITHHELD_KEYS = frozenset(
    SECTOR_CALIBRATED_RATIOS
    | {k for k, sib in SECTOR_SIBLING_OF.items() if sib in SECTOR_CALIBRATED_RATIOS}
)

BAND_RANK = {"critical": 0, "watch": 1, "healthy": 2, "strong": 3}

_LADDER_ORDER = ("strong", "healthy", "watch")


# ── the census ──────────────────────────────────────────────────────────────


class _Spec(object):
    __slots__ = ("key", "group", "display_unit", "higher_is_better", "fe_key", "band_key")

    def __init__(self, key: str, group: str, display_unit: str, higher_is_better: bool,
                 fe_key: Optional[str], band_key: Optional[str]) -> None:
        self.key = key
        self.group = group
        self.display_unit = display_unit
        self.higher_is_better = higher_is_better
        self.fe_key = fe_key
        self.band_key = band_key


_SPECS: Tuple[_Spec, ...] = (
    # computeRatios rows, in its order
    _Spec("current_ratio", "liquidity", "x", True, "current_ratio", "current_ratio"),
    _Spec("quick_ratio", "liquidity", "x", True, "quick_ratio", "quick_ratio"),
    _Spec("cash_ratio", "liquidity", "x", True, "cash_ratio", "cash_ratio"),
    _Spec("gross_margin", "profitability", "pct", True, "gross_margin", "gross_margin"),
    _Spec("ebitda_margin", "profitability", "pct", True, "ebitda_margin", "ebitda_margin"),
    _Spec("net_margin", "profitability", "pct", True, "net_margin", "net_margin"),
    _Spec("roa", "profitability", "pct", True, "roa", "roa"),
    _Spec("roe", "profitability", "pct", True, "roe", "roe"),
    _Spec("roic", "profitability", "pct", True, "roic", "roic"),
    _Spec("debt_to_ebitda", "leverage", "x", False, "debt_to_ebitda", "debt_to_ebitda"),
    _Spec("debt_to_equity", "leverage", "x", False, "debt_to_equity", "debt_to_equity"),
    _Spec("equity_ratio", "leverage", "pct", True, "equity_ratio", "equity_ratio"),
    _Spec("debt_to_assets", "leverage", "pct", False, "ltv", "debt_to_assets"),
    _Spec("interest_coverage", "coverage", "x", True, "interest_coverage", "interest_coverage"),
    _Spec("dscr", "coverage", "x", True, "dscr", "dscr"),
    _Spec("adjusted_dscr", "coverage", "x", True, "adjusted_dscr", None),
    _Spec("dscr_with_lt_principal", "coverage", "x", True, "dscr_with_lt_principal",
          "dscr_with_lt_principal"),
    _Spec("dso", "efficiency", "days", False, "dso", "dso"),
    _Spec("dio", "efficiency", "days", False, "dio", "dio"),
    _Spec("dpo", "efficiency", "days", True, "dpo", "dpo"),
    _Spec("ccc", "efficiency", "days", False, "ccc", "ccc"),
    _Spec("asset_turnover", "efficiency", "x", True, "asset_turnover", "asset_turnover"),
    # pack-banded keys with no computeRatios row — served engine metric only
    _Spec("net_debt_to_ebitda", "leverage", "x", False, None, "net_debt_to_ebitda"),
    _Spec("lt_debt_to_equity", "leverage", "x", False, None, "lt_debt_to_equity"),
    _Spec("ebitda_to_interest", "coverage", "x", True, None, "ebitda_to_interest"),
    _Spec("operating_margin", "profitability", "pct", True, None, "operating_margin"),
    _Spec("core_ebitda_margin", "profitability", "pct", True, None, "core_ebitda_margin"),
    _Spec("inventory_turnover", "efficiency", "x", True, None, "inventory_turnover"),
)

#: THE declared TC-13 list, in serve order.
CENSUS: Tuple[str, ...] = tuple(s.key for s in _SPECS)
_SPEC_BY_KEY = {s.key: s for s in _SPECS}

#: engine key -> computeRatios key, for the keys computeRatios emits.
FE_KEY_OF: Dict[str, str] = {s.key: s.fe_key for s in _SPECS if s.fe_key is not None}

#: Keys whose value the FE takes from the served metric FIRST (`mOr`) or
#: from the division of the printed balance sheet first (`bsOr`), or that
#: exist only as an engine metric (`metric_only`) or only on a user input
#: (`user_input`). Read by the precedence gate, not by the arithmetic.
_PRECEDENCE: Dict[str, str] = {
    "current_ratio": "bsOr", "quick_ratio": "bsOr", "cash_ratio": "bsOr",
    "roa": "bsOr", "roe": "bsOr", "equity_ratio": "bsOr", "debt_to_ebitda": "bsOr",
    "debt_to_equity": "bsOr", "debt_to_assets": "bsOr", "dso": "bsOr",
    "asset_turnover": "bsOr",
    "gross_margin": "mOr", "ebitda_margin": "mOr", "net_margin": "mOr", "roic": "mOr",
    "interest_coverage": "mOr", "dscr": "mOr", "dscr_with_lt_principal": "mOr",
    "dio": "mOr", "dpo": "mOr", "ccc": "mOr",
    "adjusted_dscr": "user_input",
    "net_debt_to_ebitda": "metric_only", "lt_debt_to_equity": "metric_only",
    "ebitda_to_interest": "metric_only", "operating_margin": "metric_only",
    "core_ebitda_margin": "metric_only", "inventory_turnover": "metric_only",
}
PRECEDENCE: Mapping[str, str] = dict(_PRECEDENCE)


# ── absent-aware figures (a port of frontend/lib/absentAware.ts) ────────────


class _Fig(object):
    """A number, or an absence that knows why, plus the leaves it read.

    ``absence`` is None, ``("missing", (input, ...))`` or
    ``("undefined", denominator)`` — the FE's two ``FigureAbsence`` kinds —
    or ``("non_finite", what)``."""

    __slots__ = ("value", "absence", "ops")

    def __init__(self, value: Optional[float], absence: Optional[Tuple[Any, ...]],
                 ops: Tuple[Tuple[str, Any, str], ...] = ()) -> None:
        self.value = value
        self.absence = absence
        self.ops = ops


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _leaf(name: str, source: str, raw: Any) -> _Fig:
    if not _is_num(raw):
        return _Fig(None, ("missing", (source,)), ((name, None, source),))
    return _Fig(float(raw), None, ((name, float(raw), source),))


def _known(v: float) -> _Fig:
    return _Fig(v, None) if math.isfinite(v) else _Fig(None, ("non_finite", "constant"))


def _merge_ops(figs: Sequence[_Fig]) -> Tuple[Tuple[str, Any, str], ...]:
    seen = set()
    out: List[Tuple[str, Any, str]] = []
    for f in figs:
        for op in f.ops:
            if op[2] in seen:
                continue
            seen.add(op[2])
            out.append(op)
    return tuple(out)


def _combine(figs: Sequence[_Fig]) -> Optional[Tuple[Any, ...]]:
    inputs: List[str] = []
    other: Optional[Tuple[Any, ...]] = None
    for f in figs:
        a = f.absence
        if a is None:
            continue
        if a[0] == "missing":
            for i in a[1]:
                if i not in inputs:
                    inputs.append(i)
        elif other is None:
            other = a
    if inputs:
        return ("missing", tuple(inputs))
    return other


def _fold(figs: Sequence[_Fig], op: str) -> _Fig:
    ops = _merge_ops(figs)
    absence = _combine(figs)
    if absence is not None:
        return _Fig(None, absence, ops)
    acc = 0.0 if op == "add" else 1.0
    for f in figs:
        acc = acc + f.value if op == "add" else acc * f.value  # type: ignore[operator]
    if not math.isfinite(acc):
        return _Fig(None, ("non_finite", "result"), ops)
    return _Fig(acc, None, ops)


def _add(*figs: _Fig) -> _Fig:
    return _fold(figs, "add")


def _mul(*figs: _Fig) -> _Fig:
    return _fold(figs, "mul")


def _sub(a: _Fig, b: _Fig) -> _Fig:
    ops = _merge_ops((a, b))
    absence = _combine((a, b))
    if absence is not None:
        return _Fig(None, absence, ops)
    out = a.value - b.value  # type: ignore[operator]
    return _Fig(out, None, ops) if math.isfinite(out) else _Fig(None, ("non_finite", "result"), ops)


def _div(a: _Fig, b: _Fig, denominator: str) -> _Fig:
    ops = _merge_ops((a, b))
    absence = _combine((a, b))
    if absence is not None:
        return _Fig(None, absence, ops)
    if b.value == 0:
        return _Fig(None, ("undefined", denominator), ops)
    out = a.value / b.value  # type: ignore[operator]
    return _Fig(out, None, ops) if math.isfinite(out) else _Fig(None, ("undefined", denominator), ops)


def _pct_of(a: _Fig, b: _Fig, denominator: str) -> _Fig:
    return _mul(_div(a, b, denominator), _known(100.0))


def _positive(f: _Fig, denominator: str) -> _Fig:
    """A denominator that must be positive: a negative value is an absence
    (`nonpositive_denominator`), never a floor. Zero is left to `_div`, which
    names it `zero_denominator`."""
    if f.value is None or f.value >= 0:
        return f
    return _Fig(None, ("nonpositive", denominator), f.ops)


# ── quantization and rungs ──────────────────────────────────────────────────


def quantize_display(value: Optional[float], display_unit: str) -> Optional[str]:
    """The printed digits of ``value`` at the unit's display precision.

    ``Decimal(value)`` is the exact binary value; the quantization is
    ROUND_HALF_UP on it. ``-0.0`` prints as ``0`` to the precision, as
    ``toFixed`` does."""
    if value is None:
        return None
    digits = DISPLAY_DIGITS[display_unit]
    exp = Decimal(1).scaleb(-digits)
    exact = Decimal(0) if value == 0 else Decimal(value)
    # Enough precision for every integer digit plus the places: the default
    # 28-digit context raises InvalidOperation on a quantize wider than it.
    context = Context(prec=max(28, exact.adjusted() + digits + 2))
    return str(exact.quantize(exp, rounding=ROUND_HALF_UP, context=context))


def _rung_display(rung: Any, display_unit: str) -> str:
    """A pack rung in the row's display unit, never rounded away."""
    d = Decimal(repr(float(rung)))
    if display_unit == "pct":
        d = d * 100
    text = format(d.normalize(), "f")
    return text


#: The bands a declared ``floor`` may name (the band a value below the last
#: rung takes). Anything else in a pack band definition is refused loudly.
LADDER_FLOORS = ("watch", "critical")


def ladder_floor(band_def: Optional[Mapping[str, Any]], ladder: Mapping[str, str]) -> str:
    """The band a value past the last rung takes: the pack definition's
    declared ``floor`` when it carries one (DPO: ``watch``), else
    ``critical`` when the ladder has a watch rung and ``watch`` when it
    does not. A floor outside ``LADDER_FLOORS`` raises — a pack table
    error, never a silent default."""
    declared = (band_def or {}).get("floor")
    if declared is None:
        return "critical" if "watch" in ladder else "watch"
    if declared not in LADDER_FLOORS:
        raise ValueError("pack band floor %r is not one of %r" % (declared, LADDER_FLOORS))
    return str(declared)


def _grade(value: float, ladder: Mapping[str, str], higher_is_better: bool,
           floor: Optional[str] = None) -> str:
    rungs = {k: float(v) for k, v in ladder.items()}
    if floor is None:
        floor = "critical" if "watch" in rungs else "watch"
    for name in _LADDER_ORDER:
        if name not in rungs:
            continue
        if (value >= rungs[name]) if higher_is_better else (value <= rungs[name]):
            return name
    return floor


# ── the served inputs ────────────────────────────────────────────────────────


def _dict(v: Any) -> Dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _metrics_by_name(payload: Mapping[str, Any]) -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {}
    rows = payload.get("metrics")
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            continue
        v = row.get("value")
        out[row["name"]] = float(v) if _is_num(v) else None
    return out


def _industry_signal(payload: Mapping[str, Any], statements: Mapping[str, Any]) -> Dict[str, Any]:
    """The served signal: payload level (where get_period serves it), else
    a statements-level copy. `readIndustrySignal` shape check applies."""
    for candidate in (payload.get("industry_signal"), statements.get("industry_signal")):
        if isinstance(candidate, dict) and isinstance(candidate.get("agreement"), str) \
                and isinstance(candidate.get("verdict"), str):
            return candidate
    return {}


def _served_bands(statements: Mapping[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    block = statements.get("assembled_bands")
    origin = "served"
    if not (isinstance(block, dict) and isinstance(block.get("bands"), dict)):
        from engine.country_packs.ro_romania.chart_of_accounts import _band_definitions
        block = _band_definitions(None)
        origin = "pack_default"
    bands = {str(k): dict(v) for k, v in block["bands"].items() if isinstance(v, dict)}
    digest = hashlib.sha256(
        json.dumps(bands, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    stamp = {
        "source": block.get("source"),
        "industry_resolved": block.get("industry_resolved"),
        "table_sha256": digest,
        "origin": origin,
    }
    return bands, stamp


#: Served BS totals, per tier: the concept, and the ``assembled_bs`` key the
#: legacy tier reads for it.
_TOTAL_CONCEPTS: Tuple[Tuple[str, str], ...] = (
    ("current_assets", "total_current_assets"),
    ("current_liabilities", "total_current_liabilities"),
    ("total_assets", "total_assets"),
    ("equity", "total_equity"),
)


def _gateway_totals(statements: Mapping[str, Any]) -> Dict[str, Tuple[Optional[float], str]]:
    """The served BS totals, each with the source it was read from.

    Tier 1 — a served ``canonical_bs``: through ``FactsGateway`` (the one
    sanctioned reader) over that block ALONE, labelled ``canonical_bs.*``.
    The methodology block is deliberately not offered to the gateway: in
    ``get_period`` it is the serve-time RE-ASSEMBLED envelope, whose totals
    drift from persisted truth.

    Tier 2 — no ``canonical_bs``: the served ``assembled_bs`` grand totals
    (the persisted truth ``centsFromLegacy`` reads), consumed only when the
    assets / equity / liabilities triple is present together, labelled
    ``assembled_bs.*``. Otherwise every total is absent (``operand_absent``).
    """
    from engine.serving.facts import FactsGateway, MissingFactError

    served_cbs = statements.get("canonical_bs")
    out: Dict[str, Tuple[Optional[float], str]] = {}
    if isinstance(served_cbs, dict):
        # The currency is the served statements' own; an absent one stays
        # absent (no RON default) — the table reads amounts, never labels.
        raw_currency = statements.get("currency")
        gateway = FactsGateway.from_envelope(
            {"canonical_bs": served_cbs},
            currency=raw_currency if isinstance(raw_currency, str) and raw_currency else None)
        for concept, _legacy in _TOTAL_CONCEPTS:
            value: Optional[float] = None
            if gateway is not None and gateway.tier == FactsGateway.TIER_CANONICAL:
                try:
                    value = getattr(gateway, concept)().to_float()
                except MissingFactError:
                    value = None
            out[concept] = (value, "canonical_bs." + concept)
        return out
    ab = _dict(statements.get("assembled_bs"))
    coherent = all(_is_num(ab.get(k)) for k in ("total_assets", "total_equity", "total_liabilities"))
    for concept, legacy in _TOTAL_CONCEPTS:
        raw = ab.get(legacy) if coherent else None
        out[concept] = (float(raw) if _is_num(raw) else None, "assembled_bs." + legacy)
    return out


# ── the table ────────────────────────────────────────────────────────────────


def _reason_of(absence: Tuple[Any, ...]) -> Dict[str, Any]:
    kind = absence[0]
    if kind == "missing":
        inputs = list(absence[1])
        if inputs == ["supplementary.annualLeaseExpense"]:
            return {"code": "user_input_absent", "inputs": inputs}
        return {"code": "operand_absent", "inputs": inputs}
    if kind == "undefined":
        return {"code": "zero_denominator", "inputs": [absence[1]]}
    if kind == "nonpositive":
        return {"code": "nonpositive_denominator", "inputs": [absence[1]]}
    if kind == "metric":
        return {"code": "engine_metric_absent", "inputs": [absence[1]]}
    if kind == "ebitda_refused":
        refusal = dict(absence[1] or {})
        return {"code": "ebitda_refused", "inputs": list(refusal.get("inputs") or []),
                "cause": refusal.get("cause"), "text_ro": refusal.get("text_ro"),
                "text_en": refusal.get("text_en")}
    return {"code": "non_finite", "inputs": [str(absence[1])]}


#: The metric-only rows whose metric is built on the one EBITDA or EBIT: a
#: refused one-EBITDA refuses them with its own reason.
_BUILT_ON_ONE_EBITDA = frozenset(("net_debt_to_ebitda", "ebitda_to_interest",
                                  "operating_margin", "core_ebitda_margin"))

#: The core P&L leaves a legacy statements block builds the one EBITDA from.
_LEGACY_EBITDA_LEAVES = ("revenue", "costOfGoodsSold", "operatingExpenses", "otherIncome",
                         "depreciationAmortization")


def _one_ebitda_figs(statements: Mapping[str, Any]) -> Tuple[_Fig, _Fig, _Fig]:
    """(gross profit, EBITDA, EBIT) — THE one definition, as
    ``credit_model.operating_figures`` reads it (the assembled P&L; on a
    legacy block the same definition from the incomeStatement leaves, and
    refused where the book posts to 711). A refusal is an absence of kind
    ``ebitda_refused`` carrying the typed reason; the row that divides it
    serves that reason, never a figure from another definition."""
    from engine.ratios.credit_model import operating_figures

    try:
        f = operating_figures(statements)
    except (KeyError, TypeError, ValueError):
        inc = _dict(statements.get("incomeStatement"))
        missing = tuple("incomeStatement." + k for k in _LEGACY_EBITDA_LEAVES if not _is_num(inc.get(k)))
        absence = ("missing", missing or ("incomeStatement",))
        return (_Fig(None, absence), _Fig(None, absence), _Fig(None, absence))
    if f["source"] == "assembled_pl":
        where = {"gross_profit": "assembled_pl.gross_profit", "ebitda": "assembled_pl.ebitda",
                 "ebit": "assembled_pl.operating_result"}
    else:
        # A block assembled before the ruling: the same definition built
        # from the incomeStatement leaves (credit_model.operating_figures).
        where = {"gross_profit": "incomeStatement.gross_profit", "ebitda": "incomeStatement.ebitda",
                 "ebit": "incomeStatement.ebit"}
    if f["refusal"] is not None:
        absence = ("ebitda_refused", f["refusal"])
        return tuple(_Fig(None, absence, ((k, None, where[k]),))  # type: ignore[return-value]
                     for k in ("gross_profit", "ebitda", "ebit"))

    def fig(key: str) -> _Fig:
        value = f[key]
        if value is None:
            return _Fig(None, ("missing", (where[key],)), ((key, None, where[key]),))
        return _Fig(float(value), None, ((key, float(value), where[key]),))

    return fig("gross_profit"), fig("ebitda"), fig("ebit")


def _compute_figs(payload: Mapping[str, Any], statements: Mapping[str, Any]
                  ) -> Tuple[Dict[str, _Fig], Dict[str, _Fig], bool, Dict[str, _Fig]]:
    """(value figure per census key, sign-denominator figure per key,
    gross-margin-has-cost-base, money denominator per key)."""
    bs = _dict(statements.get("balanceSheet"))
    inc = _dict(statements.get("incomeStatement"))
    sup = _dict(statements.get("supplementary"))
    apl = _dict(statements.get("assembled_pl"))
    metrics = _metrics_by_name(payload)
    totals = _gateway_totals(statements)

    def B(k: str) -> _Fig:
        return _leaf(k, "balanceSheet." + k, bs.get(k))

    def I(k: str) -> _Fig:  # noqa: E743 — mirrors the FE's `I`
        return _leaf(k, "incomeStatement." + k, inc.get(k))

    def G(concept: str) -> _Fig:
        value, source = totals[concept]
        return _leaf(concept, source, value)

    def m(name: str) -> Optional[float]:
        return metrics.get(name)

    def mOr(name: str, fallback: _Fig) -> _Fig:
        v = m(name)
        if v is None:
            return fallback
        return _Fig(v, None, ((name, v, "metrics." + name),))

    def mPctOr(name: str, fallback: _Fig) -> _Fig:
        v = m(name)
        if v is None:
            return fallback
        return _Fig(v * 100, None, ((name, v, "metrics." + name),))

    def bsOr(name: str, computed: _Fig) -> _Fig:
        return computed if computed.value is not None else mOr(name, computed)

    def bsPctOr(name: str, computed: _Fig) -> _Fig:
        return computed if computed.value is not None else mPctOr(name, computed)

    raw_days = sup.get("periodDays")
    days = float(raw_days) if _is_num(raw_days) else 365.0
    day_count = _Fig(days, None, (("period_days", days,
                                   "supplementary.periodDays" if _is_num(raw_days)
                                   else "constant.period_days_default"),))

    current_assets = G("current_assets")
    current_liabilities = G("current_liabilities")
    total_assets = G("total_assets")
    total_equity = G("equity")
    total_debt = _add(B("shortTermDebt"), B("longTermDebt"))

    revenue = I("revenue")
    # THE ONE EBITDA, EBIT and gross profit — read, never rebuilt from the
    # incomeStatement mirror (which carries no net 711).
    gross_profit, ebitda, ebit = _one_ebitda_figs(statements)

    def optional_line(k: str, default_source: str) -> _Fig:
        """The FE's ``?? 0`` for an optional P&L line — the value mirrors
        it, the provenance says a default was used, not a read."""
        raw = inc.get(k)
        if _is_num(raw):
            return _Fig(float(raw), None, ((k, float(raw), "incomeStatement." + k),))
        return _Fig(0.0, None, ((k, 0.0, default_source),))

    fin_in = optional_line("financialIncome", "constant.financial_income_default")
    fin_ex = optional_line("financialExpense", "constant.financial_expense_default")
    interest = I("interestExpense")
    pbt = _sub(_add(ebit, fin_in), _add(interest, fin_ex))
    net_income = _sub(pbt, I("taxExpense"))

    apl_ni = apl.get("net_income_statutory")
    ni_refusal = apl.get("net_income_refusal")
    if isinstance(ni_refusal, Mapping):
        # The NET RESULT is refused with 711 (no account 121; the build-up
        # lacks the unmeasured variation): net margin, ROA and ROE refuse
        # with the same typed reason — never the metric row or this
        # table's own reconstruction standing in for it.
        from engine.ratios.credit_model import operating_figures

        try:
            ni_cause = operating_figures(statements).get("net_income_refusal")
        except (KeyError, TypeError, ValueError):
            ni_cause = None
        anchored_net_income = _Fig(None, ("ebitda_refused", ni_cause or {
            "code": "ebitda_refused", "cause": ni_refusal.get("code"),
            "text_ro": ni_refusal.get("text_ro"), "text_en": ni_refusal.get("text_en"),
            "inputs": ["assembled_pl.net_income_statutory"]}),
            (("net_income_statutory", None, "assembled_pl.net_income_statutory"),))
    elif _is_num(apl_ni):
        anchored_net_income = _Fig(float(apl_ni), None, (("net_income_statutory", float(apl_ni),
                                                          "assembled_pl.net_income_statutory"),))
    else:
        anchored_net_income = mOr("net_income_statutory", net_income)

    # The DSCRs and net debt / EBITDA divide THE one EBITDA too. Until the
    # ruling this was a second, "statutory" EBITDA (the cash view + 722)
    # read through a fallback chain — assembled figure, then the served
    # metric, then its own arithmetic — so a refused EBITDA fell through
    # to a different definition under the same row.
    ebitda_statutory = ebitda

    cost_of_sales = I("costOfGoodsSold")
    has_cost_base = cost_of_sales.value is not None and cost_of_sales.value != 0

    figs: Dict[str, _Fig] = {}
    figs["current_ratio"] = bsOr("current_ratio",
                                 _div(current_assets, current_liabilities, "current liabilities"))
    figs["quick_ratio"] = bsOr("quick_ratio", _div(_add(B("cash"), B("accountsReceivable")),
                                                   current_liabilities, "current liabilities"))
    figs["cash_ratio"] = bsOr("cash_ratio", _div(B("cash"), current_liabilities, "current liabilities"))

    figs["gross_margin"] = mPctOr("gross_margin", _pct_of(gross_profit, revenue, "revenue"))
    figs["ebitda_margin"] = mPctOr("ebitda_margin", _pct_of(ebitda, revenue, "revenue"))
    # Fallback = the metric's definition: ANCHORED net income ÷ revenue —
    # the same net income ROA and ROE below divide (never the class-6/7
    # reconstruction the FE fallback reads).
    if isinstance(ni_refusal, Mapping):
        # Refused outright: a stored metric row (written before the
        # refusal existed) must not stand in for the refused net result.
        for key in ("net_margin", "roa", "roe"):
            figs[key] = _Fig(None, anchored_net_income.absence, anchored_net_income.ops)
    else:
        figs["net_margin"] = mPctOr("net_margin", _pct_of(anchored_net_income, revenue, "revenue"))
        figs["roa"] = bsPctOr("roa", _pct_of(anchored_net_income, total_assets, "total assets"))
        figs["roe"] = bsPctOr("roe", _pct_of(anchored_net_income, total_equity, "total equity"))
    # ROIC is DEFINED only for positive invested capital (ruling R-OTHER,
    # C2.1): zero refuses as `zero_denominator`, negative (negative equity
    # exceeding debt) as `nonpositive_denominator` — the value is never
    # served with its band merely withheld. The 1-RON floor this replaced
    # served 25,200,000.0% "strong" on a book with no debt and no equity.
    invested_capital = _add(total_debt, total_equity)
    figs["roic"] = mPctOr("roic", _pct_of(_mul(ebit, _known(1 - 0.16)),
                                          _positive(invested_capital, "invested capital"), "invested capital"))

    figs["debt_to_ebitda"] = bsOr("debt_to_ebitda", _div(total_debt, ebitda, "EBITDA"))
    figs["debt_to_equity"] = bsOr("debt_to_equity", _div(total_debt, total_equity, "total equity"))
    figs["equity_ratio"] = bsPctOr("equity_ratio", _pct_of(total_equity, total_assets, "total assets"))
    figs["debt_to_assets"] = bsPctOr("debt_to_assets", _pct_of(total_debt, total_assets, "total assets"))

    # Fallback = the metric's definition: EBIT ÷ interest (the methodology's
    # interest coverage, CLAUDE.md Appendix A section 5). EBITDA ÷ interest
    # is the separate `ebitda_to_interest` row below.
    figs["interest_coverage"] = mOr("interest_coverage", _div(ebit, interest, "interest expense"))
    debt_service = _add(interest, B("shortTermDebt"))
    figs["dscr"] = mOr("dscr", _div(ebitda_statutory, debt_service, "interest + short-term debt"))
    lease = sup.get("annualLeaseExpense")
    if _is_num(lease) and lease != 0:
        lease_fig = _leaf("annualLeaseExpense", "supplementary.annualLeaseExpense", lease)
        figs["adjusted_dscr"] = _div(_add(ebitda, lease_fig), _add(debt_service, lease_fig),
                                     "interest + short-term debt + lease")
    else:
        figs["adjusted_dscr"] = _Fig(None, ("missing", ("supplementary.annualLeaseExpense",)),
                                     (("annualLeaseExpense", None, "supplementary.annualLeaseExpense"),))
    figs["dscr_with_lt_principal"] = mOr("dscr_with_lt_principal", _div(
        ebitda_statutory, _add(interest, _div(B("longTermDebt"), _known(8.0), "8")),
        "interest + LT principal proxy"))

    total_operating_expense = _add(I("costOfGoodsSold"), I("operatingExpenses"),
                                   I("depreciationAmortization"))
    figs["dso"] = bsOr("dso", _mul(_div(B("accountsReceivable"), revenue, "revenue"), day_count))
    figs["dio"] = mOr("dio", _mul(_div(B("inventory"), total_operating_expense,
                                       "total operating expense"), day_count))
    figs["dpo"] = mOr("dpo", _mul(_div(B("accountsPayable"), total_operating_expense,
                                       "total operating expense"), day_count))
    figs["ccc"] = mOr("ccc", _sub(_add(figs["dso"], figs["dio"]), figs["dpo"]))
    figs["asset_turnover"] = bsOr("asset_turnover", _div(revenue, total_assets, "total assets"))

    # The metric-only rows built ON the one EBITDA / EBIT: when it is
    # REFUSED their metric is absent for THAT reason, and the row serves
    # it (`ebitda_refused`, the stock-variation cause) — not the generic
    # `engine_metric_absent`, which told the reader nothing about why
    # (found by the refusal-carries-engine gate, 2026-09-27).
    one_ebitda_refusal = (ebitda.absence if ebitda.absence is not None
                          and ebitda.absence[0] == "ebitda_refused" else None)
    for key in ("net_debt_to_ebitda", "lt_debt_to_equity", "ebitda_to_interest",
                "operating_margin", "core_ebitda_margin", "inventory_turnover"):
        v = m(key)
        pct = _SPEC_BY_KEY[key].display_unit == "pct"
        if v is None and one_ebitda_refusal is not None and key in _BUILT_ON_ONE_EBITDA:
            figs[key] = _Fig(None, one_ebitda_refusal, ((key, None, "metrics." + key),))
        elif v is None:
            figs[key] = _Fig(None, ("metric", "metrics." + key), ((key, None, "metrics." + key),))
        else:
            figs[key] = _Fig(v * 100 if pct else v, None, ((key, v, "metrics." + key),))

    apl_revenue = _leaf("revenue", "assembled_pl.revenue", apl.get("revenue"))
    # The denominator each ladder ASSUMES is positive — `positiveDenominator`
    # in computeRatios for its rows; the six metric-only rows join on the
    # same argument, reading the denominator the engine metric divides by.
    sign: Dict[str, _Fig] = {}
    for keys, fig in (
        (("current_ratio", "quick_ratio", "cash_ratio"), current_liabilities),
        (("gross_margin", "ebitda_margin", "net_margin", "dso"), revenue),
        (("roa", "debt_to_assets", "equity_ratio", "asset_turnover"), total_assets),
        (("roe", "debt_to_equity", "lt_debt_to_equity"), total_equity),
        (("roic",), invested_capital),
        (("debt_to_ebitda",), ebitda),
        (("dio", "dpo"), total_operating_expense),
        (("net_debt_to_ebitda",), ebitda_statutory),
        (("operating_margin", "core_ebitda_margin"), apl_revenue),
        (("inventory_turnover",), B("inventory")),
    ):
        for k in keys:
            sign[k] = fig
    # The MONEY denominator of each ratio (materiality reads it): the sign
    # denominators, plus the coverage denominators no ladder sign-guards.
    # ccc is a sum of three day counts with no single denominator of its
    # own; its WORKING-CAPITAL money basis is revenue (ruling Q3,
    # 2026-09-15): days past the rung x revenue / period days is the
    # working capital those days tie up. adjusted_dscr (user input) has none.
    denominators: Dict[str, _Fig] = dict(sign)
    denominators["ccc"] = revenue
    denominators["interest_coverage"] = interest
    denominators["ebitda_to_interest"] = interest
    denominators["dscr"] = debt_service
    denominators["dscr_with_lt_principal"] = _add(
        interest, _div(B("longTermDebt"), _known(8.0), "8"))
    return figs, sign, has_cost_base, denominators


def _operands(fig: _Fig) -> List[Dict[str, Any]]:
    return [{"name": n, "value": v, "source": s} for (n, v, s) in fig.ops]


#: Which metric rows a table's metric-backed keys read.
METRICS_BASES = ("payload", "serve")


def serve_time_metric_rows(statements: Mapping[str, Any]) -> Optional[List[Dict[str, Any]]]:
    """`compute_period_metrics` over the served statements block — the
    credit model and every metric row, recomputed from what is served.
    None when the block carries no legacy view to compute from (the model
    names the missing operand; nothing is approximated)."""
    from engine.ratios.credit_model import compute_period_metrics

    bs, inc = statements.get("balanceSheet"), statements.get("incomeStatement")
    if not isinstance(bs, dict) or not isinstance(inc, dict):
        return None
    if bool(statements.get("absentInputs")) or "reportedTotals" in statements:
        return None
    try:
        return compute_period_metrics(dict(statements))
    except (KeyError, TypeError):
        return None


def ratio_denominators(served_payload: Mapping[str, Any], *,
                       serve_time_metrics: bool = False) -> Dict[str, Dict[str, Any]]:
    """The money denominator each census ratio divides, as the table
    computes it: `{key: {"value": float | None, "source": str}}`. Keys with
    no single money denominator (adjusted_dscr, and every row of a
    source that declares its absences) are absent. Read by the two-period
    composer's materiality; never by the table's own grading."""
    payload = dict(served_payload) if isinstance(served_payload, Mapping) else {}
    statements = _dict(payload.get("statements"))
    if bool(statements.get("absentInputs")) or "reportedTotals" in statements:
        return {}
    if serve_time_metrics:
        payload["metrics"] = serve_time_metric_rows(statements) or []
    _figs, _sign, _cost, denominators = _compute_figs(payload, statements)
    return {k: {"value": f.value, "source": "+".join(op[2] for op in f.ops)}
            for k, f in denominators.items()}


def build_ratio_table(served_payload: Mapping[str, Any], *,
                      serve_time_metrics: bool = False) -> Dict[str, Any]:
    """The per-period ratio block for one served payload (see PURITY).

    `serve_time_metrics=False` (the parity basis): metric-backed keys read
    the payload's `metrics` rows as served — what `computeRatios` reads.
    `serve_time_metrics=True` (what `get_period` and the comparatives
    composer serve): they read `compute_period_metrics` over the served
    statements, so a period whose persisted rows are absent (a prior) or
    stale (a reanalyze never recomputes metrics) is still computed from
    what is served. Either way `credit` is the serve-time model, with the
    payload's persisted rows as its as-filed evidence."""
    from engine.ratios import credit_model as _cm

    payload = served_payload if isinstance(served_payload, Mapping) else {}
    statements = _dict(payload.get("statements"))
    serve_rows = serve_time_metric_rows(statements)
    # The as-filed evidence: a get_period body whose credit rows were
    # served from the serve-time model carries the persisted ones under
    # `credit_metrics_as_filed`; any other payload's rows ARE persisted.
    if isinstance(payload.get("credit_metrics_as_filed"), list):
        # A filed figure the serving boundary withheld from these rows
        # (credit_boundary: value None, `withheld: {code, inputs, value}`)
        # is still EVIDENCE of what was filed: `credit_block` reads it back
        # to withdraw it by name and value, never to serve it.
        persisted_rows = [
            dict(r, value=r["withheld"].get("value"))
            if isinstance(r, Mapping) and r.get("value") is None and isinstance(r.get("withheld"), Mapping)
            else r
            for r in payload.get("credit_metrics_as_filed")]
    else:
        persisted_rows = payload.get("metrics") if isinstance(payload.get("metrics"), list) else []
    if serve_time_metrics:
        payload = dict(payload)
        payload["metrics"] = list(serve_rows or [])
    credit = _cm.credit_block(serve_rows or [], as_filed_rows=persisted_rows, statements=statements)
    if serve_rows is None:
        credit["reason"] = {"code": _cm.CREDIT_INPUTS_ABSENT,
                            "inputs": ["statements.balanceSheet", "statements.incomeStatement"]}
    bands, band_stamp = _served_bands(statements)
    signal = _industry_signal(payload, statements)
    sector_disputed = signal.get("block_sector_content") is True

    declares_absence = bool(statements.get("absentInputs")) or "reportedTotals" in statements
    if declares_absence:
        figs: Dict[str, _Fig] = {}
        sign: Dict[str, _Fig] = {}
        has_cost_base = True
    else:
        figs, sign, has_cost_base, _denoms = _compute_figs(payload, statements)

    # ONE rule for every margin over turnover (engine.ratios.margin_meaning):
    # decided once per period, over the same served operands the dashboard's
    # verdict reads, and applied to every margin key the pack lists.
    from engine.ratios import margin_meaning as _mm

    margin_refusal: Optional[Dict[str, Any]] = None
    if not declares_absence:
        verdict, verdict_inputs = _mm.period_verdict(statements)
        if verdict.refused:
            raw_ccy = statements.get("currency")
            margin_refusal = _mm.reason_block(
                verdict, verdict_inputs, raw_ccy if isinstance(raw_ccy, str) and raw_ccy else None)
    refused_margins = frozenset(_mm.margin_keys()) if margin_refusal is not None else frozenset()

    rows: List[Dict[str, Any]] = []
    refused: Dict[str, str] = {}
    withheld: Dict[str, str] = {}
    served = 0
    for spec in _SPECS:
        band_def = bands.get(spec.band_key) if spec.band_key else None
        ladder: Optional[Dict[str, str]] = None
        if band_def is not None:
            ladder = {name: _rung_display(band_def[name], spec.display_unit)
                      for name in _LADDER_ORDER if _is_num(band_def.get(name))}
        row: Dict[str, Any] = {
            "key": spec.key,
            "group": spec.group,
            "label_key": "ratioTable.%s.label" % spec.key,
            "formula_key": "ratioTable.%s.formula" % spec.key,
            "display_unit": spec.display_unit,
            "higher_is_better": spec.higher_is_better,
            "value": None,
            "value_q": None,
            "band": None,
            "band_status": "refused",
            "ladder": None,  # served only on the graded branch below (TC-10)
            # The band a value past the last rung takes, served beside the
            # ladder it completes: the rungs alone do not say that a DPO
            # below watch 30 stays watch (TC-10 — the verdict's own data).
            "ladder_floor": None,
            "operands": [],
            "reason": None,
        }
        if declares_absence:
            row["reason"] = {"code": "source_declares_absence", "inputs": []}
            refused[spec.key] = "source_declares_absence"
            rows.append(row)
            continue
        fig = figs[spec.key]
        row["operands"] = _operands(fig)
        if spec.key in refused_margins:
            reason = copy.deepcopy(margin_refusal)
            row["reason"] = reason
            refused[spec.key] = reason["code"]
            rows.append(row)
            continue
        if fig.value is None:
            reason = _reason_of(fig.absence or ("missing", ()))
            row["reason"] = reason
            refused[spec.key] = reason["code"]
            rows.append(row)
            continue
        served += 1
        row["value"] = fig.value
        row["value_q"] = quantize_display(fig.value, spec.display_unit)
        denominator = sign.get(spec.key)
        if spec.key in SECTOR_WITHHELD_KEYS and sector_disputed:
            row["band_status"] = "ungraded_sector"
            row["reason"] = {"code": "sector_unconfirmed", "inputs": ["industry_signal.block_sector_content"]}
        elif denominator is not None and denominator.value is not None and denominator.value < 0:
            row["band_status"] = "withheld_sign"
            row["reason"] = {"code": "negative_denominator",
                             "inputs": [denominator.ops[0][2] if len(denominator.ops) == 1
                                        else "+".join(op[2] for op in denominator.ops)]}
        elif spec.key == "gross_margin" and not has_cost_base:
            row["band_status"] = "withheld_basis"
            row["reason"] = {"code": "no_cost_of_sales", "inputs": ["incomeStatement.costOfGoodsSold"]}
        elif ladder is None:
            row["band_status"] = "not_banded"
            row["reason"] = {"code": "not_in_pack_bands", "inputs": [spec.band_key or spec.key]}
        else:
            row["band_status"] = "graded"
            row["ladder"] = ladder
            row["ladder_floor"] = ladder_floor(band_def, ladder)
            row["band"] = _grade(fig.value, ladder, spec.higher_is_better, row["ladder_floor"])
        if row["band_status"] != "graded":
            withheld[spec.key] = row["reason"]["code"]
        rows.append(row)

    cv1 = _dict(statements.get("assembled_canonical_v1"))
    if "pack_provenance" in payload:
        # The payload SAYS what the persisted envelope carries — including
        # that it carries none (a period persisted before the stamp). Never
        # fall through to the serve-time re-assembly's provenance then.
        pack_provenance = payload.get("pack_provenance") if isinstance(payload.get("pack_provenance"), dict) else None
        pack_source = "payload" if pack_provenance is not None else None
    elif isinstance(cv1.get("pack_provenance"), dict):
        pack_provenance, pack_source = cv1.get("pack_provenance"), "statements.assembled_canonical_v1"
    else:
        pack_provenance, pack_source = None, None
    period = _dict(payload.get("period"))

    raw_currency = statements.get("currency")
    return {
        "table_version": TABLE_VERSION,
        "stamps": {
            "ratio_table_version": TABLE_VERSION,
            "credit_model_revision": _cm.CREDIT_MODEL_REVISION,
            "metrics_basis": "serve" if serve_time_metrics else "payload",
            "currency": raw_currency if isinstance(raw_currency, str) and raw_currency else None,
            "bands": band_stamp,
            "pack_provenance": pack_provenance,
            "pack_provenance_source": pack_source,
            "methodology_version": period.get("methodology_version"),
            "assembled_at": "serve",
        },
        "census": list(CENSUS),
        "coverage": {
            "census_count": len(CENSUS),
            "served": served,
            "refused": refused,
            "band_withheld": withheld,
        },
        "rows": rows,
        "credit": credit,
    }


def ratio_table_json(table: Mapping[str, Any]) -> str:
    """Deterministic serialisation: sorted keys, no NaN, no whitespace drift."""
    return json.dumps(table, sort_keys=True, separators=(",", ":"), allow_nan=False)
