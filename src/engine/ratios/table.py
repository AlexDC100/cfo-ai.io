"""ONE PERIOD'S RATIO TABLE, computed at serve time from the served payload.

The engine is the one authority for ratio values, bands and band status
(critic authority_decision). This module is the per-period half: given the
payload ``GET /api/period/{id}`` serves, it returns the block that will be
served as ``assembled_metrics.ratio_table``. It is NOT wired into
``get_period`` yet (batch B4 does that), and its ``credit`` block is
``None`` until B4 joins the serve-time credit model (B1).

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
    ``interest_coverage`` on EBIT while the metric is EBITDA ÷ interest,
    and ``dscr`` / ``dscr_with_lt_principal`` on cash EBITDA while the
    metric is statutory EBITDA. The engine's fallback is the metric's own
    definition (``pipeline.stage_compute``): ``net_margin`` =
    anchored net income ÷ revenue; ``interest_coverage`` = cash EBITDA ÷
    interest; the two DSCRs = ``assembled_pl.ebitda_statutory`` (else the
    metric, else cash EBITDA + ``incomeStatement.capitalizedOwnWork``) ÷
    their debt service. ``test_ratio_table.py`` holds the no-metric route
    body to the metric-present value on every ``mOr`` key.
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
``verdictFromBands`` semantics. Four FE ladders diverge from the pack
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
    "non_finite",
    "engine_metric_absent",
    "user_input_absent",
    "source_declares_absence",
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


def _at_least(f: _Fig, floor: float) -> _Fig:
    return f if f.value is None else _Fig(max(f.value, floor), None, f.ops)


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


def _grade(value: float, ladder: Mapping[str, str], higher_is_better: bool) -> str:
    rungs = {k: float(v) for k, v in ladder.items()}
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
        gateway = FactsGateway.from_envelope({"canonical_bs": served_cbs},
                                             currency=str(statements.get("currency") or "RON"))
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
    if kind == "metric":
        return {"code": "engine_metric_absent", "inputs": [absence[1]]}
    return {"code": "non_finite", "inputs": [str(absence[1])]}


def _compute_figs(payload: Mapping[str, Any], statements: Mapping[str, Any]
                  ) -> Tuple[Dict[str, _Fig], Dict[str, _Fig], bool]:
    """(value figure per census key, sign-denominator figure per key,
    gross-margin-has-cost-base)."""
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
    gross_profit = _sub(revenue, I("costOfGoodsSold"))
    ebitda = _add(gross_profit, _mul(I("operatingExpenses"), _known(-1.0)), I("otherIncome"))
    ebit = _sub(ebitda, I("depreciationAmortization"))

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
    if _is_num(apl_ni):
        anchored_net_income = _Fig(float(apl_ni), None, (("net_income_statutory", float(apl_ni),
                                                          "assembled_pl.net_income_statutory"),))
    else:
        anchored_net_income = mOr("net_income_statutory", net_income)

    # The statutory EBITDA the served DSCR metrics divide
    # (`stage_compute`: cash EBITDA + account 722): the assembled figure,
    # then the served metric, then the metric's own arithmetic.
    apl_ebitda = apl.get("ebitda_statutory")
    if _is_num(apl_ebitda):
        ebitda_statutory = _Fig(float(apl_ebitda), None, (("ebitda_statutory", float(apl_ebitda),
                                                         "assembled_pl.ebitda_statutory"),))
    else:
        ebitda_statutory = mOr("ebitda_statutory", _add(ebitda, I("capitalizedOwnWork")))

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
    figs["net_margin"] = mPctOr("net_margin", _pct_of(anchored_net_income, revenue, "revenue"))
    figs["roa"] = bsPctOr("roa", _pct_of(anchored_net_income, total_assets, "total assets"))
    figs["roe"] = bsPctOr("roe", _pct_of(anchored_net_income, total_equity, "total equity"))
    invested_capital = _add(total_debt, total_equity)
    figs["roic"] = mPctOr("roic", _pct_of(_mul(ebit, _known(1 - 0.16)),
                                          _at_least(invested_capital, 1.0), "invested capital"))

    figs["debt_to_ebitda"] = bsOr("debt_to_ebitda", _div(total_debt, ebitda, "EBITDA"))
    figs["debt_to_equity"] = bsOr("debt_to_equity", _div(total_debt, total_equity, "total equity"))
    figs["equity_ratio"] = bsPctOr("equity_ratio", _pct_of(total_equity, total_assets, "total assets"))
    figs["debt_to_assets"] = bsPctOr("debt_to_assets", _pct_of(total_debt, total_assets, "total assets"))

    # Fallback = the metric's definition: cash EBITDA ÷ interest (the FE
    # fallback divides EBIT — a different ratio under the same key).
    figs["interest_coverage"] = mOr("interest_coverage", _div(ebitda, interest, "interest expense"))
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

    for key in ("net_debt_to_ebitda", "lt_debt_to_equity", "ebitda_to_interest",
                "operating_margin", "core_ebitda_margin", "inventory_turnover"):
        v = m(key)
        pct = _SPEC_BY_KEY[key].display_unit == "pct"
        if v is None:
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
    return figs, sign, has_cost_base


def _operands(fig: _Fig) -> List[Dict[str, Any]]:
    return [{"name": n, "value": v, "source": s} for (n, v, s) in fig.ops]


def build_ratio_table(served_payload: Mapping[str, Any]) -> Dict[str, Any]:
    """The per-period ratio block for one served payload (see PURITY)."""
    payload = served_payload if isinstance(served_payload, Mapping) else {}
    statements = _dict(payload.get("statements"))
    bands, band_stamp = _served_bands(statements)
    signal = _industry_signal(payload, statements)
    sector_disputed = signal.get("block_sector_content") is True

    declares_absence = bool(statements.get("absentInputs")) or "reportedTotals" in statements
    if declares_absence:
        figs: Dict[str, _Fig] = {}
        sign: Dict[str, _Fig] = {}
        has_cost_base = True
    else:
        figs, sign, has_cost_base = _compute_figs(payload, statements)

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
            row["band"] = _grade(fig.value, ladder, spec.higher_is_better)
        if row["band_status"] != "graded":
            withheld[spec.key] = row["reason"]["code"]
        rows.append(row)

    cv1 = _dict(statements.get("assembled_canonical_v1"))
    if isinstance(payload.get("pack_provenance"), dict):
        pack_provenance, pack_source = payload.get("pack_provenance"), "payload"
    elif isinstance(cv1.get("pack_provenance"), dict):
        pack_provenance, pack_source = cv1.get("pack_provenance"), "statements.assembled_canonical_v1"
    else:
        pack_provenance, pack_source = None, None
    period = _dict(payload.get("period"))

    return {
        "table_version": TABLE_VERSION,
        "stamps": {
            "ratio_table_version": TABLE_VERSION,
            "credit_model_revision": None,
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
        "credit": None,
    }


def ratio_table_json(table: Mapping[str, Any]) -> str:
    """Deterministic serialisation: sorted keys, no NaN, no whitespace drift."""
    return json.dumps(table, sort_keys=True, separators=(",", ":"), allow_nan=False)
