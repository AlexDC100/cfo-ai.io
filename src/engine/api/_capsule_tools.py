"""THE CAPSULE TOOL LAYER — read-only, allowlisted retrieval for the inline AI surface.

The Capsule's answer lane never receives raw files, raw envelopes or a
database handle. It receives the OUTPUT OF THESE TOOLS: typed values that
already carry their unit, their currency and their provenance, or a typed
REFUSAL naming exactly what is missing. Retrieval happens BEFORE
generation, always — the model is handed facts and a question, never a
place to look.

WHAT THIS MODULE GUARANTEES

C2 — NO WRITE TOOL EXISTS, BY CONSTRUCTION, NOT BY PROMPT.
    Three independent structural gates, each sufficient on its own:
      1. :data:`TOOL_ALLOWLIST` is a frozen tuple of the eight read
         tools. :func:`_build_registry` refuses to build a registry
         containing a name outside it, refuses a spec that does not
         declare ``read_only``, refuses any name whose leading verb is a
         mutation verb (:data:`WRITE_VERB_PREFIXES`), and refuses a
         registry that is missing an allowlisted name.
      2. :data:`TOOL_REGISTRY` is a ``MappingProxyType`` — assigning a
         new tool into it raises ``TypeError`` at runtime. The only
         public way to build another registry,
         :func:`register_tools`, runs the same validation and returns a
         NEW frozen mapping; it never mutates this one.
      3. :func:`dispatch` re-checks the name against
         :data:`TOOL_ALLOWLIST` BEFORE it looks anything up, so even a
         registry that was somehow replaced cannot smuggle a name past
         the allowlist. A refused call returns a typed refusal and NEVER
         invokes the planted callable.
    ``tests/engine/test_capsule_tools.py`` plants a write tool at each of
    those three seams and proves all three hold.

C5 — MISSING DATA IS NAMED, NEVER ESTIMATED, NEVER ZEROED.
    Every absence returns a :class:`ToolGap` carrying the tool, a stable
    ``code``, the exact ``missing`` names, a human ``detail`` ("December
    2024 has no attached file") and the ``fix`` that would close it
    ("Upload the trial balance for December 2024."). A gap is a RESULT,
    not an exception: the surface renders it. No accessor substitutes a
    zero, an average, a prior period or a "roughly".

ALIGNMENT — a comparison is refused unless it is honest.
    Cross-period and cross-entity reads are permitted only when
      · both sides belong to the SAME entity (LIMIT_SAME_ENTITY),
      · both sides are in the SAME native currency — nothing here ever
        converts (LIMIT_NATIVE_UNITS),
      · both sides carry a LABELLED fiscal period, so the reader can see
        which months are being compared (LIMIT_LABELLED_PERIOD).
    Otherwise the tool returns a typed :class:`ToolLimitation` stating
    the rule it will not break. A limitation is not a gap: the data is
    present, the COMPARISON is what would be wrong.

MONEY AND RATIO DISCIPLINE.
    Money is carried as INTEGER MINOR UNITS end to end
    (:class:`ToolMoney`) — the same convention as the facts gateway;
    the only float appears at ``to_payload()``, the serialization
    boundary. Ratios are computed on NATIVE operands through
    :mod:`engine.api._ratio_units` (identical unit, identical scale,
    identical currency, or a typed refusal), and the exact integer
    numerator/denominator pair rides along so any consumer can
    re-derive the quotient. Every result also exposes ``facts`` +
    ``fact_units`` maps: the answer lane binds ``{{money:<fact>}}``
    placeholders against those, so a figure reaches the DOM only through
    the money renderer, with provenance attached.

SOURCE OF TRUTH.
    Balance-sheet and P&L concepts come from ``engine.serving``'s
    :class:`FactsGateway` — the ONE sanctioned reader — over the
    period's persisted ``assembled_canonical_v1`` envelope. This module
    re-implements none of that arithmetic and reads no envelope totals
    itself. Account detail comes from the period's persisted line items;
    findings come from the deterministic single-period detector engine.

NO AI IN ANY NUMERIC PATH. This module imports no model client and makes
no network call. It is pure over its injected :class:`CapsuleContext`,
so the same context always produces the same bytes.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import _ratio_units
from ..serving import (
    Fact,
    FactsGateway,
    LockedRatio,
    MarketRatio,
    MarketRefusal,
    MissingFactError,
)

logger = logging.getLogger(__name__)

#: Contract version of the tool payloads. The answer lane pins this;
#: bump ONLY with a note in the lane hand-off and a schema test update.
CAPSULE_TOOLS_VERSION = "ct1"


# ══════════════════════════════════════════════════════════════════════
# THE ALLOWLIST (C2)
# ══════════════════════════════════════════════════════════════════════

TOOL_GET_FACTS = "get_facts"
TOOL_COMPARE_PERIODS = "compare_periods"
TOOL_GET_ACCOUNT = "get_account"
TOOL_LIST_FINDINGS = "list_findings"
TOOL_GET_BENCHMARK = "get_benchmark"
TOOL_RUN_SCENARIO_PREVIEW = "run_scenario_preview"
TOOL_GET_PUBLIC_COMPANY = "get_public_company"
TOOL_SEARCH_HELP = "search_help"

#: The complete, frozen set of tool names this surface may ever call.
#: Adding a name here is a deliberate, reviewed act; a tool that is not
#: listed cannot be registered and cannot be dispatched.
TOOL_ALLOWLIST = (
    TOOL_GET_FACTS,
    TOOL_COMPARE_PERIODS,
    TOOL_GET_ACCOUNT,
    TOOL_LIST_FINDINGS,
    TOOL_GET_BENCHMARK,
    TOOL_RUN_SCENARIO_PREVIEW,
    TOOL_GET_PUBLIC_COMPANY,
    TOOL_SEARCH_HELP,
)  # type: Tuple[str, ...]

#: Leading verbs that name a MUTATION. A tool whose name starts with one
#: is refused at registry-construction time even if somebody also added
#: it to the allowlist — the two gates are deliberately independent, so
#: a single careless edit cannot open a write path.
WRITE_VERB_PREFIXES = (
    "set_", "update_", "write_", "delete_", "create_", "insert_",
    "upsert_", "patch_", "post_", "put_", "apply_", "save_", "store_",
    "remove_", "drop_", "truncate_", "mark_", "dismiss_", "approve_",
    "reject_", "reconcile_", "upload_", "send_", "publish_", "move_",
    "assign_", "reset_", "purge_", "sync_", "refresh_", "mutate_",
    "edit_", "rename_", "archive_", "restore_", "override_", "commit_",
    "release_", "reserve_", "charge_", "bill_", "enqueue_", "trigger_",
)  # type: Tuple[str, ...]


class ToolRegistryError(RuntimeError):
    """A registry was built with something that is not a sanctioned
    read-only tool. Fatal on purpose: a write tool that reached this
    surface would be a data-mutation path reachable from a text box."""


# ══════════════════════════════════════════════════════════════════════
# RESULT TYPES
# ══════════════════════════════════════════════════════════════════════

# Stable refusal codes. Surfaces group and translate on these strings.
GAP_PERIOD_NOT_FOUND = "period_not_found"
GAP_NO_PERIODS = "no_periods"
GAP_NO_SOURCE_FILE = "no_source_file"
GAP_NO_SERVED_STATEMENT = "no_served_statement"
GAP_CONCEPT_ABSENT = "concept_absent"
GAP_UNKNOWN_METRIC = "unknown_metric"
GAP_NEEDS_TRIAL_BALANCE = "needs_trial_balance"
GAP_FEED_INPUT_ABSENT = "feed_input_absent"
GAP_NOT_FOUND = "not_found"
GAP_UNDEFINED_RATIO = "undefined_ratio"
GAP_BAD_ARGUMENTS = "bad_arguments"
GAP_TOOL_NOT_ALLOWLISTED = "tool_not_allowlisted"
GAP_TOOL_ERROR = "tool_error"

LIMIT_SAME_ENTITY = "same_entity"
LIMIT_NATIVE_UNITS = "native_units"
LIMIT_LABELLED_PERIOD = "labelled_period"
LIMIT_SAMPLE_SIZE = "sample_size"
LIMIT_PREVIEW_SCOPE = "preview_scope"
LIMIT_CROSS_ENTITY = "cross_entity"


@dataclass(frozen=True)
class ToolMoney:
    """One money answer: integer minor units, its currency, its
    provenance, and the FACT NAME the answer lane binds
    ``{{money:<fact>}}`` against."""

    fact: str
    metric: str
    amount_minor: int
    currency: str
    provenance: Dict[str, Any]
    label_key: str = ""
    #: Human context for the row — never a number.
    scope: str = ""

    unit = _ratio_units.UNIT_MONEY

    def native(self) -> float:
        """Serialization boundary: the 2-decimal float consumers render.
        The division happens HERE, once, on the way out."""
        return self.amount_minor / 100.0

    def quantity(self) -> "_ratio_units.Quantity":
        return _ratio_units.money(self.native(), self.currency, name=self.fact)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "money",
            "fact": self.fact,
            "metric": self.metric,
            "unit": self.unit,
            "amount_minor": self.amount_minor,
            "value": self.native(),
            "currency": self.currency,
            "scope": self.scope,
            "label_key": self.label_key,
            "provenance": dict(self.provenance or {}),
        }


@dataclass(frozen=True)
class ToolRatio:
    """One dimensionless answer, computed on NATIVE operands through
    :mod:`_ratio_units` — never on display-converted ones.

    The exact integer operand pair rides along so a reader can re-derive
    the quotient to the last cent; ``value`` is the float the law
    produced, and it is invariant under display currency by
    construction.
    """

    fact: str
    metric: str
    unit: str
    value: float
    numerator_minor: int
    denominator_minor: int
    currency: str
    provenance: Dict[str, Any]
    label_key: str = ""
    scope: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "ratio",
            "fact": self.fact,
            "metric": self.metric,
            "unit": self.unit,
            "value": self.value,
            "numerator_minor": self.numerator_minor,
            "denominator_minor": self.denominator_minor,
            # The operands' currency, recorded so the pair is auditable.
            # The RATIO itself is dimensionless and never converts.
            "operand_currency": self.currency,
            "scope": self.scope,
            "label_key": self.label_key,
            "provenance": dict(self.provenance or {}),
        }


@dataclass(frozen=True)
class ToolRow:
    """A non-numeric row (a finding, a help topic, an account label).
    Any money it carries is carried as :class:`ToolMoney` in ``money``,
    never as a formatted string."""

    kind: str
    row_id: str
    fields: Dict[str, Any] = field(default_factory=dict)
    money: Tuple["ToolMoney", ...] = ()

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "id": self.row_id,
            "fields": copy.deepcopy(self.fields),
            "money": [m.to_payload() for m in self.money],
        }


@dataclass(frozen=True)
class ToolGap:
    """C5 — a typed ABSENCE.

    Says exactly what is missing and exactly what would close it. It
    never carries a substitute value, because the whole point is that
    there is no honest number to carry.
    """

    tool: str
    code: str
    missing: Tuple[str, ...]
    detail: str
    fix: str
    #: Set only for the public-summary paywall (PS5) — the value exists
    #: in principle, a trial balance would unlock it.
    upsell_key: str = ""

    @property
    def refused(self) -> bool:
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "gap",
            "tool": self.tool,
            "code": self.code,
            "missing": list(self.missing),
            "detail": self.detail,
            "fix": self.fix,
            "upsell_key": self.upsell_key,
        }


@dataclass(frozen=True)
class ToolLimitation:
    """The data is present; the READ would be dishonest. States the rule
    rather than performing the comparison anyway."""

    tool: str
    rule: str
    detail: str
    #: What the caller could legitimately ask for instead.
    alternative: str = ""

    @property
    def refused(self) -> bool:
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "limitation",
            "tool": self.tool,
            "rule": self.rule,
            "detail": self.detail,
            "alternative": self.alternative,
        }


@dataclass(frozen=True)
class ToolResult:
    """What one tool call produced. ``ok`` is True only when at least one
    VALUE came back; a result may still carry gaps and limitations
    alongside values (a two-metric comparison where one metric is
    absent is exactly that shape)."""

    tool: str
    values: Tuple[Any, ...] = ()
    gaps: Tuple[ToolGap, ...] = ()
    limitations: Tuple[ToolLimitation, ...] = ()
    rows: Tuple[ToolRow, ...] = ()
    notes: Tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return bool(self.values) or bool(self.rows)

    def money_values(self) -> List[ToolMoney]:
        return [v for v in self.values if isinstance(v, ToolMoney)]

    def facts(self) -> Dict[str, float]:
        """``{fact_name: native_value}`` — the map the answer lane binds
        ``{{money:<fact>}}`` placeholders against. Row-carried money is
        included, so a finding's figures are bindable too."""
        out = {}  # type: Dict[str, float]
        for value in self.values:
            if isinstance(value, ToolMoney):
                out[value.fact] = value.native()
            elif isinstance(value, ToolRatio):
                out[value.fact] = value.value
        for row in self.rows:
            for m in row.money:
                out[m.fact] = m.native()
        return out

    def fact_units(self) -> Dict[str, str]:
        """``{fact_name: unit}`` — DECLARED by this layer, not guessed by
        magnitude. The gateway told us which values are money; nothing
        downstream has to infer it."""
        out = {}  # type: Dict[str, str]
        for value in self.values:
            if isinstance(value, ToolMoney):
                out[value.fact] = value.unit
            elif isinstance(value, ToolRatio):
                out[value.fact] = value.unit
        for row in self.rows:
            for m in row.money:
                out[m.fact] = m.unit
        return out

    def currency(self) -> Optional[str]:
        """The ONE currency of this result, or None when it carries no
        money. Two currencies in one result is impossible by
        construction (every cross-period read refuses on
        LIMIT_NATIVE_UNITS first); the assertion here makes that
        structural rather than hoped-for."""
        seen = set()
        for m in self.money_values():
            seen.add(m.currency)
        for row in self.rows:
            for m in row.money:
                seen.add(m.currency)
        if not seen:
            return None
        if len(seen) > 1:
            raise AssertionError(
                "capsule tool %s produced money in %d currencies (%s) — a "
                "single result must never straddle the conversion boundary"
                % (self.tool, len(seen), sorted(seen))
            )
        return sorted(seen)[0]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": CAPSULE_TOOLS_VERSION,
            "tool": self.tool,
            "read_only": True,
            "ok": self.ok,
            "values": [v.to_payload() for v in self.values],
            "rows": [r.to_payload() for r in self.rows],
            "gaps": [g.to_payload() for g in self.gaps],
            "limitations": [l.to_payload() for l in self.limitations],
            "notes": list(self.notes),
            "facts": self.facts(),
            "fact_units": self.fact_units(),
            "currency": self.currency(),
        }


# ══════════════════════════════════════════════════════════════════════
# THE CONTEXT — what a caller injects
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class AccountRow:
    """One persisted trial-balance line, in integer minor units."""

    code: str
    name: str
    amount_minor: int
    currency: str
    statement: str = ""
    bucket: str = ""


@dataclass(frozen=True)
class PeriodRef:
    """One period, as this layer needs it.

    ``label`` is the LABELLED fiscal period ("December 2024"). A period
    without one cannot take part in a comparison — a reader who cannot
    see which months are being compared cannot check the claim.
    """

    period_id: str
    label: str
    entity_id: str
    currency: str = "RON"
    period_end: str = ""
    #: The persisted ``assembled_canonical_v1`` envelope. None when the
    #: period has no attached file yet — the C5 headline case.
    envelope: Optional[Dict[str, Any]] = None
    #: ``assembled["statements"]`` — needed by the detector engine.
    statements: Optional[Dict[str, Any]] = None
    accounts: Tuple[AccountRow, ...] = ()
    caen: Optional[str] = None
    snapshot_id: Optional[str] = None

    @property
    def has_source_file(self) -> bool:
        return isinstance(self.envelope, dict) and bool(self.envelope)


@dataclass(frozen=True)
class BenchmarkStat:
    """A peer-group percentile band. Percentiles are values in the
    metric's OWN unit — never converted, never re-based."""

    peer_group: str
    metric: str
    unit: str
    p25: Optional[float] = None
    p50: Optional[float] = None
    p75: Optional[float] = None
    sample_size: int = 0
    source: str = ""
    as_of: str = ""
    currency: str = ""


@dataclass(frozen=True)
class HelpTopic:
    topic_id: str
    title_key: str
    body_key: str
    route: str = ""
    keywords: Tuple[str, ...] = ()


@dataclass(frozen=True)
class PublicCompanyRef:
    """A listed entity served from a pm1 ``public_market`` envelope."""

    entity: str
    name: str
    envelope: Optional[Dict[str, Any]] = None
    currency: str = ""


@dataclass(frozen=True)
class CapsuleContext:
    """Everything the tools may read. Nothing else is reachable from
    this surface — no client, no session, no filesystem."""

    entity_id: str = ""
    periods: Tuple[PeriodRef, ...] = ()
    benchmarks: Tuple[BenchmarkStat, ...] = ()
    help_topics: Tuple[HelpTopic, ...] = ()
    public_companies: Tuple[PublicCompanyRef, ...] = ()
    #: Minimum peer sample below which a benchmark is stated as a
    #: limitation instead of a comparison.
    min_peer_sample: int = 5


# ══════════════════════════════════════════════════════════════════════
# METRIC REGISTRY (data)
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class MetricSpec:
    """One servable metric.

    ``accessor`` names a :class:`FactsGateway` method for money metrics.
    Ratio metrics name two money metrics instead and are computed
    through the ratio law — never by dividing two rendered numbers.
    """

    metric: str
    fact: str
    unit: str
    label_key: str
    accessor: str = ""
    numerator: str = ""
    denominator: str = ""


def _money_metric(metric: str, fact: str, accessor: str) -> MetricSpec:
    return MetricSpec(metric=metric, fact=fact, unit=_ratio_units.UNIT_MONEY,
                      label_key="capsule.metric." + metric, accessor=accessor)


def _ratio_metric(metric: str, fact: str, unit: str,
                  numerator: str, denominator: str) -> MetricSpec:
    return MetricSpec(metric=metric, fact=fact, unit=unit,
                      label_key="capsule.metric." + metric,
                      numerator=numerator, denominator=denominator)


#: Every metric name the Capsule may ask for. A name outside this table
#: is an ``unknown_metric`` gap listing the ones that exist — never a
#: silent empty answer.
#:
#: Fact names reuse the engine's declared money-fact vocabulary
#: (``_ratio_units._MONEY_FACTS``) wherever one already exists
#: (total_assets / total_liabilities / total_equity / revenue /
#: net_income / ebitda / drift), so a Capsule figure and a finding
#: figure name the same thing. Names with no declared counterpart carry
#: their unit explicitly on the payload — this layer DECLARES units, it
#: never leaves a consumer to infer money from magnitude.
METRICS = MappingProxyType({
    spec.metric: spec
    for spec in (
        _money_metric("total_assets", "total_assets", "total_assets"),
        _money_metric("total_liabilities", "total_liabilities", "total_liabilities"),
        _money_metric("equity", "total_equity", "equity"),
        _money_metric("equity_plus_liabilities", "equity_plus_liabilities",
                      "equity_plus_liabilities"),
        _money_metric("current_assets", "current_assets", "current_assets"),
        _money_metric("current_liabilities", "cur_liab", "current_liabilities"),
        _money_metric("working_capital", "working_capital", "working_capital"),
        _money_metric("net_result", "net_income", "net_result"),
        _money_metric("revenue", "revenue", "revenue"),
        _money_metric("expenses", "total_expenses", "expenses"),
        _money_metric("ebitda", "ebitda", "ebitda"),
        _money_metric("difference", "drift", "difference"),
        _ratio_metric("current_ratio", "current_ratio", _ratio_units.UNIT_RATIO,
                      "current_assets", "current_liabilities"),
        _ratio_metric("equity_ratio", "equity_share", _ratio_units.UNIT_PERCENT,
                      "equity", "total_assets"),
        _ratio_metric("net_margin", "net_margin", _ratio_units.UNIT_PERCENT,
                      "net_result", "revenue"),
    )
})  # type: Mapping[str, MetricSpec]

#: Driver metrics :func:`run_scenario_preview` may move. Deliberately
#: two: the preview is arithmetic on served facts, not a re-run of the
#: pipeline, and it says so.
SCENARIO_DRIVERS = ("revenue", "expenses")


# ══════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════


def _fold(text: Any) -> str:
    """Lowercase, diacritic-folded, whitespace-collapsed — the one
    normaliser used for every label/keyword match here."""
    raw = "" if text is None else str(text)
    decomposed = unicodedata.normalize("NFD", raw)
    stripped = "".join(ch for ch in decomposed
                       if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", stripped).strip().lower()


def _gateway_for(period: PeriodRef) -> Optional[FactsGateway]:
    if not isinstance(period.envelope, dict) or not period.envelope:
        return None
    return FactsGateway.from_envelope(
        period.envelope, currency=(period.currency or "RON"))


def _provenance(period: PeriodRef, gateway: Optional[FactsGateway],
                fact: Optional[Fact] = None) -> Dict[str, Any]:
    """Provenance every value carries: which period, which snapshot,
    which served line, which tier."""
    out = {
        "period_id": period.period_id,
        "period_label": period.label,
        "entity_id": period.entity_id,
        "source": "assembled_canonical_v1",
    }  # type: Dict[str, Any]
    if gateway is not None:
        out["tier"] = gateway.tier
    if fact is not None and isinstance(fact.provenance, dict):
        for key in ("snapshot_id", "line_id"):
            if fact.provenance.get(key) is not None:
                out[key] = fact.provenance.get(key)
    elif period.snapshot_id:
        out["snapshot_id"] = period.snapshot_id
    return out


def _resolve_period(ctx: CapsuleContext, ref: Any
                    ) -> Tuple[Optional[PeriodRef], Optional[ToolGap]]:
    """Resolve a period by id, by label, or by period_end. Returns
    ``(period, None)`` or ``(None, gap)`` — never a "closest" period: a
    near-miss answer about the wrong month is the worst outcome here."""
    if not ctx.periods:
        return None, ToolGap(
            tool="", code=GAP_NO_PERIODS, missing=("period",),
            detail="This workspace has no period yet.",
            fix="Upload a trial balance to create the first period.")
    wanted = _fold(ref)
    if not wanted:
        # No period named: the most recent one that actually has a file.
        for period in ctx.periods:
            if period.has_source_file:
                return period, None
        return ctx.periods[0], None
    for period in ctx.periods:
        if period.period_id == str(ref):
            return period, None
    for period in ctx.periods:
        if _fold(period.label) == wanted or _fold(period.period_end) == wanted:
            return period, None
    known = ", ".join([p.label or p.period_id for p in ctx.periods][:12])
    if known:
        fix = "Ask about one of: %s." % known
    else:
        fix = "Upload a trial balance to create a period."
    return None, ToolGap(
        tool="", code=GAP_PERIOD_NOT_FOUND, missing=(str(ref),),
        detail="No period called %r in this workspace." % str(ref),
        fix=fix)


def _stamp(gap: ToolGap, tool: str) -> ToolGap:
    """Gaps are built by shared helpers that do not know the caller;
    the dispatcher-facing tool name is stamped on the way out."""
    if gap.tool:
        return gap
    return ToolGap(tool=tool, code=gap.code, missing=gap.missing,
                   detail=gap.detail, fix=gap.fix, upsell_key=gap.upsell_key)


def _no_file_gap(tool: str, period: PeriodRef) -> ToolGap:
    label = period.label or period.period_id
    return ToolGap(
        tool=tool, code=GAP_NO_SOURCE_FILE, missing=(label,),
        detail="%s has no attached file." % label,
        fix="Upload the trial balance for %s." % label)


def _money_fact(tool: str, period: PeriodRef, gateway: FactsGateway,
                spec: MetricSpec, fact_suffix: str = ""
                ) -> Tuple[Optional[ToolMoney], Optional[ToolGap]]:
    """One money metric off the gateway, or the typed reason there is
    none. Every refusal the gateway can produce is mapped here — none of
    them degrades to a zero."""
    accessor = getattr(gateway, spec.accessor, None)
    if accessor is None:  # pragma: no cover — registry/gateway drift
        return None, ToolGap(
            tool=tool, code=GAP_CONCEPT_ABSENT, missing=(spec.metric,),
            detail="The facts gateway has no accessor for %s." % spec.metric,
            fix="Report this: the metric registry and the gateway disagree.")
    try:
        value = accessor()
    except MissingFactError as exc:
        return None, ToolGap(
            tool=tool, code=GAP_CONCEPT_ABSENT, missing=(spec.metric,),
            detail="%s does not carry %s (%s)."
                   % (period.label or period.period_id, spec.metric, exc),
            fix="Upload the full trial balance for %s to serve this figure."
                % (period.label or period.period_id))
    if isinstance(value, LockedRatio):
        return None, ToolGap(
            tool=tool, code=GAP_NEEDS_TRIAL_BALANCE, missing=(spec.metric,),
            detail="%s is served from a public filing, which carries no "
                   "account-level detail for %s."
                   % (period.label or period.period_id, spec.metric),
            fix="Upload the trial balance for %s to unlock it."
                % (period.label or period.period_id),
            upsell_key=value.upsell_key)
    if isinstance(value, MarketRefusal):
        return None, ToolGap(
            tool=tool, code=GAP_FEED_INPUT_ABSENT,
            missing=tuple(value.missing) or (spec.metric,),
            detail=value.detail or "The feed did not publish %s."
                   % ", ".join(value.missing or (spec.metric,)),
            fix="No fix inside the product — the source feed does not "
                "publish this input.")
    if not isinstance(value, Fact):  # pragma: no cover — defensive
        return None, ToolGap(
            tool=tool, code=GAP_CONCEPT_ABSENT, missing=(spec.metric,),
            detail="%s returned an unexpected shape." % spec.metric,
            fix="Report this: the gateway contract changed.")
    return ToolMoney(
        fact=spec.fact + fact_suffix,
        metric=spec.metric,
        amount_minor=value.amount_minor,
        currency=value.currency,
        provenance=_provenance(period, gateway, value),
        label_key=spec.label_key,
        scope=period.label or period.period_id,
    ), None


def _ratio_value(tool: str, period: PeriodRef, gateway: FactsGateway,
                 spec: MetricSpec, fact_suffix: str = ""
                 ) -> Tuple[Optional[ToolRatio], Optional[ToolGap],
                            Optional[ToolLimitation]]:
    """One ratio, computed on NATIVE operands through the ratio law."""
    num_spec = METRICS[spec.numerator]
    den_spec = METRICS[spec.denominator]
    num, gap = _money_fact(tool, period, gateway, num_spec)
    if gap is not None:
        return None, gap, None
    den, gap = _money_fact(tool, period, gateway, den_spec)
    if gap is not None:
        return None, gap, None
    try:
        if spec.unit == _ratio_units.UNIT_PERCENT:
            value = _ratio_units.pct_of(num.quantity(), den.quantity())
        else:
            value = _ratio_units.ratio(num.quantity(), den.quantity())
    except _ratio_units.UnitMismatchError as exc:
        return None, None, ToolLimitation(
            tool=tool, rule=LIMIT_NATIVE_UNITS,
            detail="%s and %s are not in the same native unit (%s) — this "
                   "layer never converts to make a ratio work."
                   % (num_spec.metric, den_spec.metric, exc),
            alternative="Ask for each figure on its own.")
    except _ratio_units.UndefinedRatioError:
        return None, ToolGap(
            tool=tool, code=GAP_UNDEFINED_RATIO, missing=(den_spec.metric,),
            detail="%s is zero in %s, so %s is undefined — not zero."
                   % (den_spec.metric, period.label or period.period_id,
                      spec.metric),
            fix="Check whether %s is genuinely absent for this period."
                % den_spec.metric), None
    return ToolRatio(
        fact=spec.fact + fact_suffix,
        metric=spec.metric,
        unit=spec.unit,
        value=value,
        numerator_minor=num.amount_minor,
        denominator_minor=den.amount_minor,
        currency=num.currency,
        provenance=_provenance(period, gateway),
        label_key=spec.label_key,
        scope=period.label or period.period_id,
    ), None, None


def _metric_value(tool: str, period: PeriodRef, gateway: FactsGateway,
                  metric: str, fact_suffix: str = ""
                  ) -> Tuple[Optional[Any], Optional[ToolGap],
                             Optional[ToolLimitation]]:
    spec = METRICS.get(metric)
    if spec is None:
        return None, _unknown_metric_gap(tool, metric), None
    if spec.accessor:
        value, gap = _money_fact(tool, period, gateway, spec, fact_suffix)
        return value, gap, None
    return _ratio_value(tool, period, gateway, spec, fact_suffix)


def _unknown_metric_gap(tool: str, metric: str) -> ToolGap:
    return ToolGap(
        tool=tool, code=GAP_UNKNOWN_METRIC, missing=(str(metric),),
        detail="%r is not a metric this surface serves." % str(metric),
        fix="Ask for one of: %s." % ", ".join(sorted(METRICS.keys())))


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


# ══════════════════════════════════════════════════════════════════════
# THE EIGHT TOOLS — every one of them a pure read
# ══════════════════════════════════════════════════════════════════════


def get_facts(ctx: CapsuleContext, metric: Any = None,
              period: Any = None) -> ToolResult:
    """One served metric for one period, with provenance."""
    tool = TOOL_GET_FACTS
    spec = METRICS.get(str(metric or ""))
    if spec is None:
        return ToolResult(tool=tool, gaps=(_unknown_metric_gap(tool, metric),))
    period_ref, gap = _resolve_period(ctx, period)
    if gap is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap, tool),))
    if not period_ref.has_source_file:
        return ToolResult(tool=tool, gaps=(_no_file_gap(tool, period_ref),))
    gateway = _gateway_for(period_ref)
    if gateway is None:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT,
            missing=(period_ref.label or period_ref.period_id,),
            detail="%s has a file but no served statement yet."
                   % (period_ref.label or period_ref.period_id),
            fix="Re-run the analysis for %s."
                % (period_ref.label or period_ref.period_id)),))
    value, gap, limitation = _metric_value(tool, period_ref, gateway,
                                           spec.metric)
    return ToolResult(
        tool=tool,
        values=(value,) if value is not None else (),
        gaps=(gap,) if gap is not None else (),
        limitations=(limitation,) if limitation is not None else (),
    )


def compare_periods(ctx: CapsuleContext, metrics: Any = None,
                    p1: Any = None, p2: Any = None) -> ToolResult:
    """The same metrics on two periods, plus the delta — but ONLY where
    the comparison is honest.

    Three alignment rules, checked before any figure is read:
    same entity, same native currency, both periods labelled. Each
    failure returns a stated :class:`ToolLimitation` instead of a
    number, because a delta across entities, across currencies or
    across unlabelled periods reads exactly like a real one.
    """
    tool = TOOL_COMPARE_PERIODS
    wanted = [str(m) for m in _as_list(metrics)] or ["total_assets"]
    a, gap_a = _resolve_period(ctx, p1)
    if gap_a is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap_a, tool),))
    b, gap_b = _resolve_period(ctx, p2)
    if gap_b is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap_b, tool),))

    if a.period_id == b.period_id:
        return ToolResult(tool=tool, limitations=(ToolLimitation(
            tool=tool, rule=LIMIT_LABELLED_PERIOD,
            detail="Both sides resolve to %s — there is nothing to compare."
                   % (a.label or a.period_id),
            alternative="Name two different periods."),))
    if a.entity_id != b.entity_id:
        return ToolResult(tool=tool, limitations=(ToolLimitation(
            tool=tool, rule=LIMIT_SAME_ENTITY,
            detail="%s and %s belong to different entities; a delta between "
                   "them would not describe one business."
                   % (a.label or a.period_id, b.label or b.period_id),
            alternative="Compare two periods of the same company."),))
    if not a.label or not b.label:
        unlabelled = a.period_id if not a.label else b.period_id
        return ToolResult(tool=tool, limitations=(ToolLimitation(
            tool=tool, rule=LIMIT_LABELLED_PERIOD,
            detail="Period %s carries no fiscal-period label, so a reader "
                   "could not tell which months this compares." % unlabelled,
            alternative="Set the period label, then compare."),))
    cur_a = (a.currency or "").upper()
    cur_b = (b.currency or "").upper()
    if cur_a != cur_b:
        return ToolResult(tool=tool, limitations=(ToolLimitation(
            tool=tool, rule=LIMIT_NATIVE_UNITS,
            detail="%s is in %s and %s is in %s. Nothing here converts, so "
                   "the difference between them is not a number this "
                   "surface will state."
                   % (a.label, cur_a or "?", b.label, cur_b or "?"),
            alternative="Ask for each period's figure on its own."),))

    for side in (a, b):
        if not side.has_source_file:
            return ToolResult(tool=tool, gaps=(_no_file_gap(tool, side),))
    gw_a = _gateway_for(a)
    gw_b = _gateway_for(b)
    if gw_a is None or gw_b is None:
        missing_side = a if gw_a is None else b
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT,
            missing=(missing_side.label or missing_side.period_id,),
            detail="%s has no served statement yet."
                   % (missing_side.label or missing_side.period_id),
            fix="Re-run the analysis for %s."
                % (missing_side.label or missing_side.period_id)),))

    values = []  # type: List[Any]
    gaps = []  # type: List[ToolGap]
    limitations = []  # type: List[ToolLimitation]
    for metric in wanted:
        va, ga, la = _metric_value(tool, a, gw_a, metric, "_a")
        vb, gb, lb = _metric_value(tool, b, gw_b, metric, "_b")
        for gap in (ga, gb):
            if gap is not None:
                gaps.append(gap)
        for limitation in (la, lb):
            if limitation is not None:
                limitations.append(limitation)
        if va is not None:
            values.append(va)
        if vb is not None:
            values.append(vb)
        if isinstance(va, ToolMoney) and isinstance(vb, ToolMoney):
            # Integer arithmetic in minor units, same currency by the
            # alignment check above. b − a: "what changed since a".
            values.append(ToolMoney(
                fact=METRICS[metric].fact + "_delta",
                metric=metric + ".delta",
                amount_minor=vb.amount_minor - va.amount_minor,
                currency=vb.currency,
                provenance={
                    "basis": "%s minus %s" % (b.label, a.label),
                    "from_period_id": a.period_id,
                    "to_period_id": b.period_id,
                    "entity_id": a.entity_id,
                    "source": "assembled_canonical_v1",
                },
                label_key="capsule.metric." + metric + ".delta",
                scope="%s vs %s" % (b.label, a.label),
            ))
    notes = ("Both sides are %s, in %s, for the same entity."
             % ("labelled periods", cur_a),)
    return ToolResult(tool=tool, values=tuple(values), gaps=tuple(gaps),
                      limitations=tuple(limitations), notes=notes)


def get_account(ctx: CapsuleContext, code: Any = None,
                period: Any = None) -> ToolResult:
    """One account's persisted balance, or its children when the code is
    a class prefix.

    Children are listed INDIVIDUALLY and never summed into a subtotal
    this layer invented: a rolled-up figure nobody published is
    indistinguishable from one that was.
    """
    tool = TOOL_GET_ACCOUNT
    wanted = re.sub(r"[^0-9A-Za-z.]", "", str(code or ""))
    if not wanted:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_BAD_ARGUMENTS, missing=("code",),
            detail="No account code was given.",
            fix="Name an account code, e.g. 461 or 5121."),))
    period_ref, gap = _resolve_period(ctx, period)
    if gap is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap, tool),))
    if not period_ref.accounts:
        if not period_ref.has_source_file:
            return ToolResult(tool=tool, gaps=(_no_file_gap(tool, period_ref),))
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_CONCEPT_ABSENT, missing=("account_detail",),
            detail="%s carries no account-level detail."
                   % (period_ref.label or period_ref.period_id),
            fix="Upload the trial balance for %s — a summary filing has no "
                "account rows." % (period_ref.label or period_ref.period_id)),))

    exact = [r for r in period_ref.accounts if r.code == wanted]
    children = ([r for r in period_ref.accounts
                 if r.code.startswith(wanted) and r.code != wanted]
                if not exact else [])
    hits = exact or children
    if not hits:
        if len(wanted) > 3:
            fix = ("Check the code, or ask for the shorter prefix %s."
                   % wanted[:3])
        else:
            fix = ("Check the code — this period's trial balance carries no "
                   "balance on it.")
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NOT_FOUND, missing=(wanted,),
            detail="The trial balance for %s carries no account %s."
                   % (period_ref.label or period_ref.period_id, wanted),
            fix=fix),))
    rows = []  # type: List[ToolRow]
    values = []  # type: List[Any]
    for row in hits:
        money = ToolMoney(
            fact="account_" + re.sub(r"[^0-9A-Za-z]", "_", row.code),
            metric="account." + row.code,
            amount_minor=row.amount_minor,
            currency=row.currency or period_ref.currency,
            provenance={
                "period_id": period_ref.period_id,
                "period_label": period_ref.label,
                "entity_id": period_ref.entity_id,
                "line_id": row.code,
                "source": "statement_line_items",
                "snapshot_id": period_ref.snapshot_id,
            },
            label_key="capsule.account",
            scope=period_ref.label or period_ref.period_id,
        )
        values.append(money)
        rows.append(ToolRow(kind="account", row_id=row.code, fields={
            "code": row.code, "name": row.name,
            "statement": row.statement, "bucket": row.bucket,
        }, money=(money,)))
    notes = ()  # type: Tuple[str, ...]
    if children:
        notes = ("%d sub-accounts of %s are listed individually; no subtotal "
                 "is computed here." % (len(children), wanted),)
    return ToolResult(tool=tool, values=tuple(values), rows=tuple(rows),
                      notes=notes)


def list_findings(ctx: CapsuleContext, period: Any = None) -> ToolResult:
    """The period's SURFACED findings plus what was checked.

    The detectors are deterministic and already carry the seven-element
    contract, their own figures and their own templates — this tool
    hands them over untouched. Silence is a claim too: when nothing
    fires, the checks that ran come back so the surface can say what was
    looked at.
    """
    tool = TOOL_LIST_FINDINGS
    period_ref, gap = _resolve_period(ctx, period)
    if gap is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap, tool),))
    if not isinstance(period_ref.statements, dict) or not period_ref.statements:
        if not period_ref.has_source_file:
            return ToolResult(tool=tool, gaps=(_no_file_gap(tool, period_ref),))
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT,
            missing=("statements",),
            detail="%s has no assembled statements to check."
                   % (period_ref.label or period_ref.period_id),
            fix="Re-run the analysis for %s."
                % (period_ref.label or period_ref.period_id)),))
    # Lazy import: the detector package pulls the profile catalogue and
    # the country pack; this module must stay importable without them.
    from . import findings as findings_pkg

    result = findings_pkg.run_single_period(
        period_ref.statements, period_id=period_ref.period_id,
        caen=period_ref.caen, snapshot_id=period_ref.snapshot_id)
    rows = []  # type: List[ToolRow]
    for payload in result.surfaced():
        rows.append(ToolRow(
            kind="finding",
            row_id=str(payload.get("rule_key") or ""),
            fields=copy.deepcopy(payload),
        ))
    checks = result.all_checks()
    notes = ("%d detector check(s) ran on %s."
             % (len(checks), period_ref.label or period_ref.period_id),)
    silence = result.silence_statement()
    if silence is not None:
        rows.append(ToolRow(kind="silence", row_id="silence",
                            fields=copy.deepcopy(silence)))
    return ToolResult(tool=tool, rows=tuple(rows), notes=notes)


def get_benchmark(ctx: CapsuleContext, peer_group: Any = None,
                  metric: Any = None) -> ToolResult:
    """A peer-group percentile band for one metric.

    A band computed on a handful of peers is stated as a limitation, not
    served as a comparison: "the median of four companies" is a number
    that reads far more authoritative than it is.
    """
    tool = TOOL_GET_BENCHMARK
    group = _fold(peer_group)
    wanted = _fold(metric)
    if not group or not wanted:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_BAD_ARGUMENTS,
            missing=tuple([n for n, v in (("peer_group", group),
                                          ("metric", wanted)) if not v]),
            detail="A benchmark needs both a peer group and a metric.",
            fix="Name the peer group and the metric."),))
    for stat in ctx.benchmarks:
        if _fold(stat.peer_group) != group or _fold(stat.metric) != wanted:
            continue
        if stat.sample_size < ctx.min_peer_sample:
            return ToolResult(tool=tool, limitations=(ToolLimitation(
                tool=tool, rule=LIMIT_SAMPLE_SIZE,
                detail="%s has %d peer(s) for %s — below the %d needed to "
                       "state a band." % (stat.peer_group, stat.sample_size,
                                          stat.metric, ctx.min_peer_sample),
                alternative="Widen the peer group."),))
        rows = (ToolRow(kind="benchmark",
                        row_id="%s:%s" % (stat.peer_group, stat.metric),
                        fields={
                            "peer_group": stat.peer_group,
                            "metric": stat.metric,
                            "unit": stat.unit,
                            "p25": stat.p25, "p50": stat.p50, "p75": stat.p75,
                            "sample_size": stat.sample_size,
                            "source": stat.source,
                            "as_of": stat.as_of,
                            "currency": stat.currency,
                        }),)
        return ToolResult(tool=tool, rows=rows, notes=(
            "Percentiles are in the metric's own unit (%s); nothing is "
            "converted." % stat.unit,))
    groups = sorted({s.peer_group for s in ctx.benchmarks})
    return ToolResult(tool=tool, gaps=(ToolGap(
        tool=tool, code=GAP_NOT_FOUND, missing=(str(peer_group), str(metric)),
        detail="No benchmark for %r in peer group %r."
               % (str(metric), str(peer_group)),
        fix=("Set the industry for this period, then ask again."
             if not groups else
             "Available peer groups: %s." % ", ".join(groups[:12]))),))


def run_scenario_preview(ctx: CapsuleContext, drivers: Any = None,
                         period: Any = None) -> ToolResult:
    """Deterministic arithmetic on served facts — never a pipeline re-run.

    Each driver moves ONE served money metric by a percentage or an
    absolute amount, in the period's own currency and in integer minor
    units. The preview reports the moved figures and the resulting
    change in net result, and states its own scope: it does not
    re-derive the balance sheet, re-run detectors, or persist anything.
    """
    tool = TOOL_RUN_SCENARIO_PREVIEW
    period_ref, gap = _resolve_period(ctx, period)
    if gap is not None:
        return ToolResult(tool=tool, gaps=(_stamp(gap, tool),))
    if not period_ref.has_source_file:
        return ToolResult(tool=tool, gaps=(_no_file_gap(tool, period_ref),))
    gateway = _gateway_for(period_ref)
    if gateway is None:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT,
            missing=(period_ref.label or period_ref.period_id,),
            detail="%s has no served statement to preview against."
                   % (period_ref.label or period_ref.period_id),
            fix="Re-run the analysis for %s."
                % (period_ref.label or period_ref.period_id)),))

    parsed = _as_list(drivers)
    if not parsed:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_BAD_ARGUMENTS, missing=("drivers",),
            detail="No driver was given.",
            fix="Name a driver, e.g. {\"metric\": \"revenue\", "
                "\"mode\": \"pct\", \"value\": -0.1}."),))

    values = []  # type: List[Any]
    gaps = []  # type: List[ToolGap]
    limitations = []  # type: List[ToolLimitation]
    result_delta_minor = 0
    applied = 0
    for driver in parsed:
        if not isinstance(driver, dict):
            gaps.append(ToolGap(
                tool=tool, code=GAP_BAD_ARGUMENTS, missing=("driver",),
                detail="A driver must be an object with metric/mode/value.",
                fix="Send {\"metric\": …, \"mode\": \"pct\"|\"absolute\", "
                    "\"value\": …}."))
            continue
        metric = str(driver.get("metric") or "")
        mode = str(driver.get("mode") or "pct")
        if metric not in SCENARIO_DRIVERS:
            gaps.append(ToolGap(
                tool=tool, code=GAP_UNKNOWN_METRIC, missing=(metric,),
                detail="%r is not a driver this preview can move." % metric,
                fix="Movable drivers: %s." % ", ".join(SCENARIO_DRIVERS)))
            continue
        if mode not in ("pct", "absolute"):
            gaps.append(ToolGap(
                tool=tool, code=GAP_BAD_ARGUMENTS, missing=("mode",),
                detail="%r is not a driver mode." % mode,
                fix="Use \"pct\" (a fraction, e.g. -0.1) or \"absolute\"."))
            continue
        try:
            raw = float(driver.get("value"))
        except (TypeError, ValueError):
            gaps.append(ToolGap(
                tool=tool, code=GAP_BAD_ARGUMENTS, missing=("value",),
                detail="Driver %s carries no numeric value." % metric,
                fix="Send a number for \"value\"."))
            continue
        base, gap = _money_fact(tool, period_ref, gateway, METRICS[metric])
        if gap is not None:
            gaps.append(gap)
            continue
        if mode == "pct":
            delta_minor = int(round(base.amount_minor * raw))
        else:
            delta_minor = int(round(raw * 100))
        moved = ToolMoney(
            fact="scenario_" + METRICS[metric].fact,
            metric="scenario." + metric,
            amount_minor=base.amount_minor + delta_minor,
            currency=base.currency,
            provenance={
                "period_id": period_ref.period_id,
                "period_label": period_ref.label,
                "entity_id": period_ref.entity_id,
                "basis_metric": metric,
                "basis_amount_minor": base.amount_minor,
                "driver_mode": mode,
                "driver_value": raw,
                "preview": True,
                "source": "assembled_canonical_v1",
            },
            label_key="capsule.metric.scenario." + metric,
            scope=period_ref.label or period_ref.period_id,
        )
        values.append(base)
        values.append(moved)
        # Revenue up lifts the result; expenses up reduce it.
        result_delta_minor += (delta_minor if metric == "revenue"
                               else -delta_minor)
        applied += 1

    if applied:
        values.append(ToolMoney(
            fact="scenario_result_delta",
            metric="scenario.net_result.delta",
            amount_minor=result_delta_minor,
            currency=period_ref.currency,
            provenance={
                "period_id": period_ref.period_id,
                "period_label": period_ref.label,
                "entity_id": period_ref.entity_id,
                "basis": "revenue movement minus expense movement",
                "preview": True,
                "source": "assembled_canonical_v1",
            },
            label_key="capsule.metric.scenario.net_result.delta",
            scope=period_ref.label or period_ref.period_id,
        ))
        limitations.append(ToolLimitation(
            tool=tool, rule=LIMIT_PREVIEW_SCOPE,
            detail="This preview moves the named lines only. It does not "
                   "re-derive the balance sheet, re-run the detectors, or "
                   "save anything.",
            alternative="Open Scenarios for a full model."))
    return ToolResult(tool=tool, values=tuple(values), gaps=tuple(gaps),
                      limitations=tuple(limitations))


def get_public_company(ctx: CapsuleContext, entity: Any = None) -> ToolResult:
    """Market-tier figures for a listed entity, straight off the feed.

    A metric the feed never published comes back as a gap naming the
    missing input — enterprise value without a cash figure is not
    "enterprise value minus nothing".
    """
    tool = TOOL_GET_PUBLIC_COMPANY
    wanted = _fold(entity)
    if not wanted:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_BAD_ARGUMENTS, missing=("entity",),
            detail="No company was named.", fix="Name a ticker or company."),))
    match = None  # type: Optional[PublicCompanyRef]
    for company in ctx.public_companies:
        if _fold(company.entity) == wanted or _fold(company.name) == wanted:
            match = company
            break
    if match is None:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NOT_FOUND, missing=(str(entity),),
            detail="No listed company matches %r here." % str(entity),
            fix="Check the ticker, or open Markets to search."),))
    if not isinstance(match.envelope, dict) or not match.envelope:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT, missing=(match.entity,),
            detail="%s has no market snapshot loaded." % match.entity,
            fix="Open %s in Markets to load its filing." % match.entity),))
    gateway = FactsGateway.from_envelope(
        match.envelope, currency=(match.currency or "USD"))
    if gateway is None:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NO_SERVED_STATEMENT, missing=(match.entity,),
            detail="%s carries no servable snapshot." % match.entity,
            fix="Re-sync %s in Markets." % match.entity),))

    values = []  # type: List[Any]
    gaps = []  # type: List[ToolGap]
    for metric_id, accessor_name in (("price", "market_price"),
                                     ("market_cap", "market_cap"),
                                     ("enterprise_value", "enterprise_value"),
                                     ("pe", "pe"),
                                     ("ev_ebitda", "ev_ebitda")):
        accessor = getattr(gateway, accessor_name, None)
        if accessor is None:  # pragma: no cover — gateway drift
            continue
        try:
            value = accessor()
        except MissingFactError as exc:
            gaps.append(ToolGap(
                tool=tool, code=GAP_CONCEPT_ABSENT, missing=(metric_id,),
                detail="%s: %s" % (match.entity, exc),
                fix="No fix inside the product — the feed does not carry it."))
            continue
        provenance = {
            "entity_id": match.entity,
            "entity_name": match.name,
            "tier": gateway.tier,
            "source": "public_market",
        }
        if isinstance(value, MarketRefusal):
            gaps.append(ToolGap(
                tool=tool, code=GAP_FEED_INPUT_ABSENT,
                missing=tuple(value.missing) or (metric_id,),
                detail=value.detail or "%s did not publish %s for %s."
                       % ("The feed", ", ".join(value.missing or (metric_id,)),
                          match.entity),
                fix="No fix inside the product — the source feed does not "
                    "publish this input."))
        elif isinstance(value, MarketRatio):
            values.append(ToolRatio(
                fact="market_" + metric_id, metric="market." + metric_id,
                unit=_ratio_units.UNIT_RATIO, value=value.to_float(),
                numerator_minor=value.numerator_minor,
                denominator_minor=value.denominator_minor,
                currency=value.currency, provenance=dict(provenance,
                                                         **value.provenance),
                label_key="capsule.metric.market." + metric_id,
                scope=match.entity))
        elif isinstance(value, Fact):
            values.append(ToolMoney(
                fact="market_" + metric_id, metric="market." + metric_id,
                amount_minor=value.amount_minor, currency=value.currency,
                provenance=dict(provenance, **(value.provenance or {})),
                label_key="capsule.metric.market." + metric_id,
                scope=match.entity))
    limitation = ToolLimitation(
        tool=tool, rule=LIMIT_CROSS_ENTITY,
        detail="%s is a different entity from this workspace. Its figures "
               "stand on their own; this surface will not net them against "
               "your periods." % match.entity,
        alternative="Use Markets to compare listed peers with each other.")
    return ToolResult(tool=tool, values=tuple(values), gaps=tuple(gaps),
                      limitations=(limitation,))


def search_help(ctx: CapsuleContext, topic: Any = None) -> ToolResult:
    """Deterministic keyword search over the shipped help catalogue.

    No model, no ranking model, no network — a substring match over
    reviewed copy, so the same question always surfaces the same page.
    """
    tool = TOOL_SEARCH_HELP
    wanted = _fold(topic)
    if not wanted:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_BAD_ARGUMENTS, missing=("topic",),
            detail="No topic was given.", fix="Name what you need help with."),))
    hits = []  # type: List[ToolRow]
    for entry in ctx.help_topics:
        haystack = [entry.topic_id, entry.title_key, entry.body_key]
        haystack.extend(entry.keywords)
        if any(wanted in _fold(part) for part in haystack):
            hits.append(ToolRow(kind="help", row_id=entry.topic_id, fields={
                "topic_id": entry.topic_id,
                "title_key": entry.title_key,
                "body_key": entry.body_key,
                "route": entry.route,
            }))
    if not hits:
        return ToolResult(tool=tool, gaps=(ToolGap(
            tool=tool, code=GAP_NOT_FOUND, missing=(str(topic),),
            detail="No help topic matches %r." % str(topic),
            fix="Try a shorter phrase, or open the glossary."),))
    return ToolResult(tool=tool, rows=tuple(hits))


# ══════════════════════════════════════════════════════════════════════
# THE REGISTRY (C2) — frozen, validated, read-only by construction
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class ToolParam:
    name: str
    type: str
    required: bool = False
    description: str = ""

    def to_schema(self) -> Dict[str, Any]:
        return {"name": self.name, "type": self.type,
                "required": self.required, "description": self.description}


@dataclass(frozen=True)
class ToolSpec:
    """One registered tool. ``read_only`` is not a hint — a spec that
    does not assert it cannot be registered."""

    name: str
    fn: Callable[..., ToolResult]
    description: str
    params: Tuple[ToolParam, ...]
    returns: str
    read_only: bool = True

    def to_schema(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "read_only": self.read_only,
            "params": [p.to_schema() for p in self.params],
            "returns": self.returns,
        }


_SPECS = (
    ToolSpec(
        name=TOOL_GET_FACTS, fn=get_facts,
        description="One served financial metric for one period, in minor "
                    "units with provenance.",
        params=(
            ToolParam("metric", "string", True,
                      "One of the registered metric names."),
            ToolParam("period", "string", False,
                      "Period id or fiscal label; defaults to the most "
                      "recent period that has a file."),
        ),
        returns="ToolMoney or ToolRatio, or a typed gap."),
    ToolSpec(
        name=TOOL_COMPARE_PERIODS, fn=compare_periods,
        description="The same metrics on two periods plus the delta, only "
                    "when same-entity / same-currency / labelled-period "
                    "alignment holds.",
        params=(
            ToolParam("metrics", "string[]", True, "Metric names."),
            ToolParam("p1", "string", True, "Earlier period id or label."),
            ToolParam("p2", "string", True, "Later period id or label."),
        ),
        returns="Per-metric values for both sides plus a delta, or a stated "
                "limitation."),
    ToolSpec(
        name=TOOL_GET_ACCOUNT, fn=get_account,
        description="One account's balance for a period, or its children "
                    "when the code is a prefix. No invented subtotals.",
        params=(
            ToolParam("code", "string", True, "RAS account code, e.g. 461."),
            ToolParam("period", "string", False, "Period id or label."),
        ),
        returns="One ToolMoney per matched account row."),
    ToolSpec(
        name=TOOL_LIST_FINDINGS, fn=list_findings,
        description="The period's surfaced findings and the checks that ran.",
        params=(ToolParam("period", "string", False, "Period id or label."),),
        returns="Finding rows plus a silence statement when nothing fired."),
    ToolSpec(
        name=TOOL_GET_BENCHMARK, fn=get_benchmark,
        description="A peer-group percentile band for one metric.",
        params=(
            ToolParam("peer_group", "string", True, "Peer group key."),
            ToolParam("metric", "string", True, "Metric name."),
        ),
        returns="A percentile row, or a limitation when the sample is thin."),
    ToolSpec(
        name=TOOL_RUN_SCENARIO_PREVIEW, fn=run_scenario_preview,
        description="Deterministic what-if arithmetic over served facts. "
                    "Writes nothing and re-runs nothing.",
        params=(
            ToolParam("drivers", "object[]", True,
                      "[{metric, mode: pct|absolute, value}]"),
            ToolParam("period", "string", False, "Period id or label."),
        ),
        returns="Base and moved figures plus the implied result delta."),
    ToolSpec(
        name=TOOL_GET_PUBLIC_COMPANY, fn=get_public_company,
        description="Market-tier figures for a listed entity, with a typed "
                    "refusal for every input the feed did not publish.",
        params=(ToolParam("entity", "string", True, "Ticker or name."),),
        returns="Market money/ratio values plus feed-absence gaps."),
    ToolSpec(
        name=TOOL_SEARCH_HELP, fn=search_help,
        description="Deterministic keyword search over the shipped help "
                    "catalogue.",
        params=(ToolParam("topic", "string", True, "What to look up."),),
        returns="Help rows with i18n keys and a route."),
)  # type: Tuple[ToolSpec, ...]


def _validate_spec(spec: ToolSpec) -> None:
    """Every structural reason a spec may not be registered. Runs before
    anything is callable — the C2 construction gate."""
    if not isinstance(spec, ToolSpec):
        raise ToolRegistryError(
            "not a ToolSpec: %r — the capsule registry takes validated "
            "specs only" % (spec,))
    if not spec.read_only:
        raise ToolRegistryError(
            "tool %r does not declare read_only — this surface has no write "
            "path, by construction" % spec.name)
    lowered = spec.name.lower()
    for prefix in WRITE_VERB_PREFIXES:
        if lowered.startswith(prefix):
            raise ToolRegistryError(
                "tool %r names a mutation (%r) — the capsule tool layer is "
                "read-only" % (spec.name, prefix))
    if spec.name not in TOOL_ALLOWLIST:
        raise ToolRegistryError(
            "tool %r is not in TOOL_ALLOWLIST %r — a tool this surface may "
            "call is a reviewed decision, not a registration side effect"
            % (spec.name, list(TOOL_ALLOWLIST)))
    if not callable(spec.fn):
        raise ToolRegistryError("tool %r has no callable" % spec.name)


def _build_registry(specs: Sequence[ToolSpec]) -> Mapping[str, ToolSpec]:
    """Validate, de-duplicate, require full coverage, and FREEZE.

    Returns a ``MappingProxyType``: the result cannot be added to, so a
    tool cannot be planted into a live registry at runtime.
    """
    out = {}  # type: Dict[str, ToolSpec]
    for spec in specs:
        _validate_spec(spec)
        if spec.name in out:
            raise ToolRegistryError("tool %r registered twice" % spec.name)
        out[spec.name] = spec
    missing = [name for name in TOOL_ALLOWLIST if name not in out]
    if missing:
        raise ToolRegistryError(
            "allowlisted tools have no implementation: %r — an allowlisted "
            "name with no spec is a tool the operator believes exists"
            % missing)
    return MappingProxyType(out)


#: The frozen, live registry. Immutable at runtime (MappingProxyType).
TOOL_REGISTRY = _build_registry(_SPECS)  # type: Mapping[str, ToolSpec]


def register_tools(specs: Sequence[ToolSpec]) -> Mapping[str, ToolSpec]:
    """Build ANOTHER frozen registry from ``specs``.

    The only public construction path, and it runs the same validation:
    there is no code path in this module that produces a registry
    containing a write tool. It never mutates :data:`TOOL_REGISTRY`.
    """
    return _build_registry(specs)


def tool_schemas() -> List[Dict[str, Any]]:
    """JSON-serializable schemas for the eight tools, in allowlist order.
    This is what the answer lane hands the model as its tool
    definitions — and there is nothing in it that writes."""
    return [TOOL_REGISTRY[name].to_schema() for name in TOOL_ALLOWLIST]


def _refusal(tool: str, gap: ToolGap) -> ToolResult:
    return ToolResult(tool=tool, gaps=(gap,))


def dispatch(name: Any, args: Optional[Dict[str, Any]],
             ctx: CapsuleContext) -> ToolResult:
    """The ONE entry point. Refuses anything that is not an allowlisted,
    read-only tool BEFORE any lookup, validates the argument names
    against the spec, and turns an unexpected failure into a calm typed
    gap rather than a stack trace on a user's screen."""
    tool_name = str(name or "")
    if tool_name not in TOOL_ALLOWLIST:
        return _refusal(tool_name, ToolGap(
            tool=tool_name, code=GAP_TOOL_NOT_ALLOWLISTED,
            missing=(tool_name,),
            detail="%r is not a tool this surface may call." % tool_name,
            fix="Available tools: %s." % ", ".join(TOOL_ALLOWLIST)))
    spec = TOOL_REGISTRY.get(tool_name)
    if spec is None or not spec.read_only:  # pragma: no cover — defensive
        return _refusal(tool_name, ToolGap(
            tool=tool_name, code=GAP_TOOL_NOT_ALLOWLISTED,
            missing=(tool_name,),
            detail="%r has no read-only implementation." % tool_name,
            fix="Available tools: %s." % ", ".join(TOOL_ALLOWLIST)))
    supplied = dict(args or {})
    allowed = {p.name for p in spec.params}
    unknown = sorted([k for k in supplied if k not in allowed])
    if unknown:
        return _refusal(tool_name, ToolGap(
            tool=tool_name, code=GAP_BAD_ARGUMENTS, missing=tuple(unknown),
            detail="%s does not take %s." % (tool_name, ", ".join(unknown)),
            fix="Arguments: %s." % ", ".join(sorted(allowed))))
    missing_required = sorted([p.name for p in spec.params
                               if p.required and supplied.get(p.name) is None])
    if missing_required:
        return _refusal(tool_name, ToolGap(
            tool=tool_name, code=GAP_BAD_ARGUMENTS,
            missing=tuple(missing_required),
            detail="%s needs %s." % (tool_name, ", ".join(missing_required)),
            fix="Supply %s." % ", ".join(missing_required)))
    try:
        return spec.fn(ctx, **supplied)
    except Exception as exc:  # noqa: BLE001 — the surface must stay calm
        # Logged at exception level so the failure is never silent (the
        # FakeStore lesson), and returned as a typed gap so no raw
        # payload reaches the DOM (A2).
        logger.exception("[capsule] tool %s raised", tool_name)
        return _refusal(tool_name, ToolGap(
            tool=tool_name, code=GAP_TOOL_ERROR, missing=(tool_name,),
            detail="%s could not complete (%s)."
                   % (tool_name, type(exc).__name__),
            fix="Try again; if it persists the period may need re-analysing."))


# ══════════════════════════════════════════════════════════════════════
# HTTP surface
# ══════════════════════════════════════════════════════════════════════


def build_router():  # pragma: no cover — thin wiring, exercised by e2e
    """``/api/capsule/*`` — schemas and dispatch. GET/POST only; there is
    no route here that writes anything."""
    from fastapi import APIRouter, Header, HTTPException
    from pydantic import BaseModel, Field

    from . import _org, _supabase

    class ToolCall(BaseModel):
        args: Dict[str, Any] = Field(default_factory=dict)
        #: Optional hint so the context builder can load account detail
        #: for the period the call is about instead of all of them.
        period: Optional[str] = None

    router = APIRouter(prefix="/api/capsule", tags=["capsule"])

    def _require_jwt(authorization: Optional[str]) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing bearer token.")
        return authorization.split(" ", 1)[1].strip()

    def _context(jwt: str, org_id: str, period_hint: Optional[str],
                 want_detail: bool) -> CapsuleContext:
        """Build the read context from the caller's OWN client, so RLS
        scopes every row to their memberships."""
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "financial_periods",
                filters={"org_id": "eq.%s" % org_id},
                order="period_end.desc",
                limit=24,
            ) or []
            periods = []  # type: List[PeriodRef]
            for row in rows:
                period_id = str(row.get("id") or "")
                label = str(row.get("period_label") or row.get("period_end") or "")
                envelope = row.get("assembled_canonical_v1")
                accounts = ()  # type: Tuple[AccountRow, ...]
                statements = None  # type: Optional[Dict[str, Any]]
                is_target = (not period_hint or period_hint == period_id
                             or _fold(period_hint) == _fold(label))
                if want_detail and is_target:
                    line_items = client.select(
                        "statement_line_items",
                        filters={"period_id": "eq.%s" % period_id},
                        columns="statement,bucket,ro_account_code,"
                                "ro_account_name,amount",
                    ) or []
                    accounts = tuple(
                        AccountRow(
                            code=str(li.get("ro_account_code") or ""),
                            name=str(li.get("ro_account_name") or ""),
                            amount_minor=int(round(
                                float(li.get("amount") or 0) * 100)),
                            currency=str(row.get("currency") or "RON"),
                            statement=str(li.get("statement") or ""),
                            bucket=str(li.get("bucket") or ""),
                        )
                        for li in line_items
                        if li.get("ro_account_code")
                    )
                    try:
                        from .pipeline import _rebuild_assembled_for_briefing
                        statements = _rebuild_assembled_for_briefing(
                            line_items, row, None).get("statements")
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "[capsule] statements rebuild failed for %s",
                            period_id)
                        statements = None
                periods.append(PeriodRef(
                    period_id=period_id,
                    label=label,
                    entity_id=str(row.get("org_id") or org_id),
                    currency=str(row.get("currency") or "RON"),
                    period_end=str(row.get("period_end") or ""),
                    envelope=envelope if isinstance(envelope, dict) else None,
                    statements=statements,
                    accounts=accounts,
                    caen=row.get("caen_code"),
                    snapshot_id=str(row.get("source_document_id") or "") or None,
                ))
        return CapsuleContext(entity_id=org_id, periods=tuple(periods))

    @router.get("/tools")
    def list_tools(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _require_jwt(authorization)
        return {"version": CAPSULE_TOOLS_VERSION, "read_only": True,
                "tools": tool_schemas()}

    @router.post("/tools/{tool_name}")
    def call_tool(tool_name: str, body: ToolCall,
                  authorization: Optional[str] = Header(None),
                  x_org_id: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        want_detail = tool_name in (TOOL_GET_ACCOUNT, TOOL_LIST_FINDINGS)
        ctx = _context(jwt, org_id, body.period or
                       (body.args or {}).get("period"), want_detail)
        return dispatch(tool_name, dict(body.args or {}), ctx).to_payload()

    return router


__all__ = [
    "CAPSULE_TOOLS_VERSION",
    "TOOL_ALLOWLIST", "TOOL_REGISTRY", "WRITE_VERB_PREFIXES",
    "ToolRegistryError", "ToolSpec", "ToolParam",
    "ToolMoney", "ToolRatio", "ToolRow", "ToolGap", "ToolLimitation",
    "ToolResult",
    "AccountRow", "PeriodRef", "BenchmarkStat", "HelpTopic",
    "PublicCompanyRef", "CapsuleContext",
    "METRICS", "MetricSpec", "SCENARIO_DRIVERS",
    "get_facts", "compare_periods", "get_account", "list_findings",
    "get_benchmark", "run_scenario_preview", "get_public_company",
    "search_help",
    "dispatch", "register_tools", "tool_schemas", "build_router",
]
