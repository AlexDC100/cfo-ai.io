"""THE UNIT LAW for narrative numerics — ratios and typed placeholders.

Two structural rules live here, both born from one live defect
(2026-08-30). The Critical-461 note rendered:

    "holds RON 7,692,203 — 19.6% of total assets 7.467.122,25 €"

a native RON figure beside a display-converted EUR figure inside ONE
claim. The 19.6% was arithmetically CORRECT and native-native
(7,692,202.74 / 39,194,178.46, both RON). The harm was the rendering
boundary: an alert body is authored as a plain string in the source
currency, and only *some* of its numbers later pass through a converting
renderer. Whichever numbers miss that path keep their source magnitude
AND their source label, next to siblings that changed.

──────────────────────────────────────────────────────────────────────
RULE 1 — RATIOS (`Quantity` + `ratio`)
──────────────────────────────────────────────────────────────────────
A ratio is computed from operands of identical UNIT, identical CURRENCY
and identical SCALE, or it is not computed at all. Mismatches raise a
typed refusal (`UnitMismatchError`); nothing is ever coerced, and no
conversion ever participates in a ratio. A zero / absent denominator is
an UNDEFINED ratio (`UndefinedRatioError`), never 0.0 — ABSENT != ZERO.

The scale check is not theoretical: `recommendations.expected_cash_impact
_kron` is fed kRON by two producers and RON by a third, and read as full
units by the UI — a 1000x collision in one column.

──────────────────────────────────────────────────────────────────────
RULE 2 — TYPED PLACEHOLDERS (`templatize` / `render_native`)
──────────────────────────────────────────────────────────────────────
A narrative body should not carry formatted digits. It should carry a
reference to a FACT:

    "Account 461 holds {{money:intercompany_loans}} due from related
     parties — 19.6% of total assets {{money:total_assets}}."

resolved at RENDER time through the same money path the rest of the UI
uses, so every figure in one claim is on one side of the conversion
boundary by construction. The engine is the only layer that knows which
facts are money; it marks them, so no consumer has to guess by magnitude
(the two guesses live in production today — "≥1000 is money" in the
linkifier and "|v| > 1 is money" in the facts expander — and both are
wrong on real rows: a leverage multiple of 8.5x renders as "EUR 1.62").

`templatize` DERIVES the template from the already-rendered text rather
than asking rule authors to write placeholders by hand. That is
deliberate:

  * the plain-text body stays byte-identical, so stored rows that
    predate templates keep rendering exactly as they do today, and
  * `render_native(templatize(text)) == text` byte-for-byte, so the
    template and the plain-text fallback CANNOT disagree.

It also closes the sign trap the frontend cannot reach: the linkify
regex never consumed a leading "-", so every negative money fact
(losses, outflows, negative equity — the figures a CFO reads hardest)
was permanently unconvertible. Here the sign is read off the printed
token, and a body that prints `abs(x)` while the fact stores the signed
value is recorded as `{{money:x|abs}}`.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from dataclasses import dataclass
import re
from typing import Any, Dict, Iterable, List, Optional


# ── Units ────────────────────────────────────────────────────────────────

UNIT_MONEY = "money"        # currency-denominated; converts for display
UNIT_RATIO = "ratio"        # dimensionless multiple (x); NEVER converts
UNIT_PERCENT = "percent"    # fraction 0..1 rendered as %; NEVER converts
UNIT_DAYS = "days"
UNIT_COUNT = "count"
UNIT_SCORE = "score"
UNIT_UNKNOWN = "unknown"    # a refusal, not a default

_DIMENSIONLESS = (UNIT_RATIO, UNIT_PERCENT, UNIT_DAYS, UNIT_COUNT, UNIT_SCORE)


# ── Typed refusals ───────────────────────────────────────────────────────


class UnitMismatchError(ValueError):
    """Raised when a ratio is asked for across a unit / currency / scale
    boundary. Carries both operands so the caller can see what collided
    — the point is to make the mismatch loud, not to pick a winner."""

    def __init__(self, numerator: "Quantity", denominator: "Quantity", reason: str):
        self.numerator = numerator
        self.denominator = denominator
        self.reason = reason
        super().__init__(
            "refusing to divide {num} by {den}: {reason}".format(
                num=numerator.describe(), den=denominator.describe(), reason=reason
            )
        )


class UndefinedRatioError(ValueError):
    """Zero / absent / non-finite denominator. ABSENT != ZERO: the answer
    is 'undefined', which is not the same claim as 'nil'."""


class MissingFactError(KeyError):
    """A template referenced a fact that was not supplied. Rendering a
    hole or a zero would be a fabricated number; refuse instead."""


# ── Quantity ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Quantity:
    """A number that knows what it is. `currency` is meaningful only for
    UNIT_MONEY; `scale` is the multiplier the value is expressed in
    (1 = units, 1000 = thousands)."""

    value: float
    unit: str
    currency: Optional[str] = None
    scale: int = 1
    name: Optional[str] = None

    def describe(self) -> str:
        bits = [self.name or "value", "=", repr(self.value), self.unit]
        if self.unit == UNIT_MONEY:
            bits.append(str(self.currency or "?"))
            if self.scale != 1:
                bits.append("x{0}".format(self.scale))
        return " ".join(bits)


def money(value: float, currency: str, scale: int = 1,
          name: Optional[str] = None) -> Quantity:
    return Quantity(float(value), UNIT_MONEY, (currency or "").upper() or None,
                    int(scale), name)


def ratio_q(value: float, name: Optional[str] = None) -> Quantity:
    return Quantity(float(value), UNIT_RATIO, None, 1, name)


def percent_q(value: float, name: Optional[str] = None) -> Quantity:
    return Quantity(float(value), UNIT_PERCENT, None, 1, name)


def days(value: float, name: Optional[str] = None) -> Quantity:
    return Quantity(float(value), UNIT_DAYS, None, 1, name)


def count(value: float, name: Optional[str] = None) -> Quantity:
    return Quantity(float(value), UNIT_COUNT, None, 1, name)


# ── The ratio law ────────────────────────────────────────────────────────


def _assert_compatible(numerator: Quantity, denominator: Quantity) -> None:
    if numerator.unit != denominator.unit:
        raise UnitMismatchError(
            numerator, denominator,
            "unit {a} != unit {b}".format(a=numerator.unit, b=denominator.unit),
        )
    if numerator.scale != denominator.scale:
        raise UnitMismatchError(
            numerator, denominator,
            "scale {a} != scale {b}".format(a=numerator.scale, b=denominator.scale),
        )
    if numerator.unit == UNIT_MONEY:
        a = (numerator.currency or "").upper()
        b = (denominator.currency or "").upper()
        if not a or not b:
            raise UnitMismatchError(
                numerator, denominator, "a money operand carries no currency",
            )
        if a != b:
            raise UnitMismatchError(
                numerator, denominator, "currency {a} != currency {b}".format(a=a, b=b),
            )


def ratio(numerator: Quantity, denominator: Quantity) -> float:
    """Native quotient of two compatible quantities.

    Identical currency AND scale, or a typed refusal. Conversion never
    participates: both operands are read in the source currency and the
    RESULT is dimensionless, so it is invariant under display currency.
    """
    _assert_compatible(numerator, denominator)
    den = denominator.value
    if den == 0 or den != den or den in (float("inf"), float("-inf")):
        raise UndefinedRatioError(
            "denominator {0} is zero or not finite — the ratio is undefined, "
            "not zero".format(denominator.describe())
        )
    return numerator.value / den


def safe_ratio(numerator: Quantity, denominator: Quantity) -> Optional[float]:
    """`ratio` for callers that legitimately tolerate an undefined answer
    (a rule that simply doesn't fire). Still refuses a unit mismatch —
    that is a bug in every context."""
    try:
        return ratio(numerator, denominator)
    except UndefinedRatioError:
        return None


def pct_of(part: Quantity, whole: Quantity) -> float:
    """Fraction (0..1), not percent points. Alias of `ratio` kept for
    reading rules aloud: `pct_of(intercompany, total_assets)`."""
    return ratio(part, whole)


# ── The fact-unit registry ───────────────────────────────────────────────
#
# Money must be DECLARED. An undeclared name resolves to UNIT_UNKNOWN and
# is therefore never templatized and never converted — a refusal, not a
# default. `tests/engine/test_ratio_units.py` asserts that every fact
# name any deterministic rule emits appears here, so a new rule that
# cites an undeclared money fact fails the gate instead of shipping a
# figure that silently keeps its source label.

_MONEY_FACTS = frozenset([
    "total_assets", "total_liabilities", "total_equity", "drift",
    "rental_revenue", "revenue",
    "bank_debt_total", "net_debt", "share_capital",
    "ebitda", "ebitda_statutory", "ebitda_operational",
    "capitalized_own_work_memo", "revaluation_reserves",
    "intercompany_loans", "dividends_payable",
    "cash", "total_cash", "fx_cash", "cur_liab",
    "cash_from_operating", "capex_real", "capitalized_construction",
    "free_cash_flow",
    "trade_rec", "rec_provisions", "affiliate_income", "net_income",
    # ── Capsule tool-layer metrics (2026-08-30) ────────────────────────
    # The inline answer surface serves these through the SAME facts
    # gateway the dashboard reads, so they are money by the gateway's own
    # declaration — not by inference from magnitude. Undeclared they
    # resolved to UNIT_UNKNOWN, which is a refusal: the Capsule would
    # have declined to render eight legitimate figures. Adding a name
    # here is a deliberate act; the gate in test_ratio_units.py still
    # fails any rule that cites a name absent from this set.
    "equity", "equity_plus_liabilities",
    "current_assets", "current_liabilities", "working_capital",
    "net_result", "expenses", "difference",
    # Found by scripts/check_metric_declared.py, which enumerates the
    # Capsule's own frozen METRICS registry rather than guessing: the
    # scenario tool cites a money delta, and total_expenses is a served
    # metric. Both were resolving to UNIT_UNKNOWN — a refusal — so the
    # surface held the figure and declined to render it.
    "scenario_result_delta", "total_expenses",
    # ── Benchmark + market surfaces (2026-08-30) ──────────────────────
    # Found by an adversarial audit, not by the gate that was supposed to
    # find them: check_metric_declared only read CALL SHAPES, so a plain
    # module-level registry was invisible to it. These four are declared
    # `fmt: "currency"` in _benchmark_engine.METRIC_DISPLAY and were
    # resolving to UNIT_UNKNOWN — a refusal — so the surface held the
    # figure and declined to render it.
    "total_operating_revenue", "ebitda_cash", "ebitda_operating",
    "net_income_operating",
    # serving/facts._MARKET_METRICS: all five were undeclared. A listed
    # company's price and capitalisation are money like any other.
    "price", "market_cap", "enterprise_value",
    # ── Firm cockpit (2026-09-03) ──────────────────────────────────────
    # engine.firm cites served facts under the names above; the ONE money
    # figure it cites that the gateway does not serve is a DECLARED
    # covenant limit (packs/firm/attention.yaml COVENANT_RISK). Listed so
    # the evidence resolves to money at render rather than to a refusal.
    "covenant_limit",
])

_RATIO_FACTS = frozenset([
    "debt_to_ebitda", "net_debt_ebitda", "threshold", "ratio", "cash_ratio",
    # Market multiples from serving/facts._MARKET_METRICS. A multiple is
    # dimensionless: it must never be handed to a currency formatter, and
    # UNIT_UNKNOWN would have refused it outright.
    "pe", "ev_ebitda",
])

_PERCENT_FACTS = frozenset([
    "pct_of_assets", "pct_of_equity", "pct_of_rental_revenue",
    "materials_pct", "prov_pct", "affiliate_dep", "asset_maturity",
    "fx_cash_pct",
    # The cost-structure ratios from _benchmark_engine.METRIC_DISPLAY,
    # every one declared `fmt: "pct"` there. Note the shape: they end in
    # `_revenue`, NOT `_pct`, so the house suffix convention
    # (`endswith("_pct")`) never applied to them — which is exactly how
    # ten of seventeen rows in one registry went undeclared unnoticed.
    "cogs_pct_revenue", "opex_energy_pct_revenue",
    "opex_personnel_pct_revenue", "opex_external_services_pct_revenue",
    "opex_rent_pct_revenue", "depreciation_pct_revenue",
])


def unit_for_fact(name: str) -> str:
    """Unit of a cited fact. Unknown names REFUSE (UNIT_UNKNOWN) — they
    never fall back to money."""
    if name in _MONEY_FACTS:
        return UNIT_MONEY
    if name in _RATIO_FACTS:
        return UNIT_RATIO
    if name in _PERCENT_FACTS:
        return UNIT_PERCENT
    # Suffix conventions for names that follow the house naming, so a new
    # dimensionless fact doesn't need a registry edit to be safe. Money
    # deliberately has NO suffix rule: it must be declared.
    if name.endswith("_pct") or name.endswith("_margin") or name.endswith("_share"):
        return UNIT_PERCENT
    if name.endswith("_ratio") or name.endswith("_multiple") or name.endswith("_x"):
        return UNIT_RATIO
    if name in ("dio", "dso", "dpo", "ccc") or name.endswith("_days"):
        return UNIT_DAYS
    if name.endswith("_count"):
        return UNIT_COUNT
    if name.endswith("_score"):
        return UNIT_SCORE
    return UNIT_UNKNOWN


def units_for(facts: Dict[str, Any]) -> Dict[str, str]:
    """`{fact_name: unit}` for a whole `facts_cited` map. Shipped on the
    alert payload so consumers stop guessing money by magnitude."""
    out = {}  # type: Dict[str, str]
    for name in facts:
        out[name] = unit_for_fact(name)
    return out


# ── Typed placeholders ───────────────────────────────────────────────────

_PLACEHOLDER_RX = re.compile(
    r"\{\{money:(?P<name>[A-Za-z0-9_]+)(?P<opts>(?:\|[a-z0-9]+)*)\}\}"
)

_MAX_DECIMALS = 4


def _token_rx(currency: str) -> "re.Pattern":
    cur = re.escape((currency or "RON").upper())
    return re.compile(
        r"(?P<prefix>" + cur + r" )?"
        r"(?P<num>-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)"
        r"(?P<suffix> " + cur + r")?"
    )


def _decimals_of(num_text: str) -> int:
    if "." not in num_text:
        return 0
    return min(_MAX_DECIMALS, len(num_text.split(".", 1)[1]))


def _money_facts(facts: Dict[str, Any]) -> List[str]:
    names = []  # type: List[str]
    for name, value in facts.items():
        if unit_for_fact(name) != UNIT_MONEY:
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        v = float(value)
        if v != v or v in (float("inf"), float("-inf")):
            continue
        names.append(name)
    return names


def _match_fact(token: str, decimals: int, facts: Dict[str, Any],
                money_names: Iterable[str]) -> Optional[Dict[str, Any]]:
    """Which cited money fact printed exactly this token?

    Exact STRING equality against the fact's own rendering — not a
    tolerance window. That is what makes `render_native` a byte-exact
    inverse. Signed renderings are tried before absolute ones so a
    printed "-382,675" binds to the value, not to its magnitude.
    """
    names = list(money_names)
    fmt = ",.{0}f".format(decimals)
    for name in names:
        if format(float(facts[name]), fmt) == token:
            return {"name": name, "abs": False}
    for name in names:
        if format(abs(float(facts[name])), fmt) == token:
            return {"name": name, "abs": True}
    return None


def templatize(text: str, facts: Dict[str, Any], currency: str) -> str:
    """Replace every cited MONEY figure — and its adjacent currency label
    — with a typed placeholder. Everything else is left exactly as it is.

    A number that does not bind to a cited money fact is NOT touched: we
    cannot assert it is money (it may be a count, a year, an article
    number, a percentage), and guessing a currency onto it is the same
    class of error this exists to fix.

    Idempotent: running it over an already-templatized string is a no-op.
    """
    if not text or not facts:
        return text or ""
    money_names = _money_facts(facts)
    if not money_names:
        return text

    # Placeholder spans from a previous pass are inviolate.
    protected = [(m.start(), m.end()) for m in _PLACEHOLDER_RX.finditer(text)]

    def _inside_protected(start, end):
        for p_start, p_end in protected:
            if start >= p_start and end <= p_end:
                return True
        return False

    out = []  # type: List[str]
    last = 0
    for m in _token_rx(currency).finditer(text):
        start, end = m.start(), m.end()
        if start < last or _inside_protected(start, end):
            continue
        num_text = m.group("num")
        num_start = m.start("num")
        # Boundary guards: never bite a fragment out of a longer number,
        # and never claim a percentage or a multiple as money.
        before = text[num_start - 1] if num_start > 0 else ""
        after = text[end] if end < len(text) else ""
        if before and (before.isdigit() or before in ".,"):
            continue
        if after and (after.isdigit() or after in "%×x^"):
            continue
        has_label = bool(m.group("prefix") or m.group("suffix"))
        try:
            parsed = float(num_text.replace(",", ""))
        except ValueError:
            continue
        # An unlabelled small number is far more likely to be an article
        # number or a day count than money.
        if not has_label and abs(parsed) < 1000:
            continue
        decimals = _decimals_of(num_text)
        hit = _match_fact(num_text, decimals, facts, money_names)
        if hit is None:
            continue

        opts = []  # type: List[str]
        if hit["abs"]:
            opts.append("abs")
        if not has_label:
            opts.append("bare")
        elif m.group("suffix"):
            opts.append("suffix")
        if decimals:
            opts.append("d{0}".format(decimals))
        placeholder = "{{{{money:{name}{opts}}}}}".format(
            name=hit["name"], opts="".join("|" + o for o in opts)
        )
        out.append(text[last:start])
        out.append(placeholder)
        last = end
    out.append(text[last:])
    return "".join(out)


def render_native(template: str, facts: Dict[str, Any], currency: str) -> str:
    """Resolve a template back to NATIVE source-currency prose.

    The byte-exact inverse of `templatize` — which is the whole point:
    the stored plain-text body (the fallback for rows that predate
    templates) and the template can never disagree. Also the renderer for
    any surface that legitimately stays native (exports, the reconcile
    trust chip).
    """
    if not template:
        return template or ""
    cur = (currency or "RON").upper()

    def _sub(m):
        name = m.group("name")
        if name not in facts or not isinstance(facts[name], (int, float)) \
                or isinstance(facts[name], bool):
            raise MissingFactError(
                "template cites '{0}', which is not in facts_cited".format(name)
            )
        opts = [o for o in m.group("opts").split("|") if o]
        value = float(facts[name])
        if "abs" in opts:
            value = abs(value)
        decimals = 0
        for o in opts:
            if o.startswith("d") and o[1:].isdigit():
                decimals = int(o[1:])
        body = format(value, ",.{0}f".format(decimals))
        if "bare" in opts:
            return body
        if "suffix" in opts:
            return "{0} {1}".format(body, cur)
        return "{0} {1}".format(cur, body)

    return _PLACEHOLDER_RX.sub(_sub, template)


def placeholder_names(template: str) -> List[str]:
    """Fact names a template references, in order of appearance."""
    return [m.group("name") for m in _PLACEHOLDER_RX.finditer(template or "")]
