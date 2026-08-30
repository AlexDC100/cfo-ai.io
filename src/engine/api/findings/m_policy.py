"""THE MULTI-PERIOD ANALYSIS TABLE — what each analysis measures, against
what number, and what a reader is asked to DO about it.

This is the lane's data, held the way `profiles.yaml` holds the
single-period lane's: one entry per analysis, carrying its parameters
with units and labels, its severity ladder, its comparison basis, its
why-here copy and its action templates. Nothing here branches on a
company. There is no profile id in this file and no `if profile == ...`
anywhere in the lane — the same N7 rule the single-period detectors live
under, enforced by a guard in
`tests/engine/test_findings_multi_period.py`.

PACK FIRST, TABLE SECOND
:func:`resolve_threshold` asks the COMPANY PROFILE for the parameter
first. When the country pack registers a multi-period detector, its
tuned, profile-aware value wins immediately and the finding records the
`profiles.yaml#...` address that judged the company. Until it does, the
cross-profile default below is used and the finding records THIS file's
address instead. Both are truthful; neither is silent. What is
structurally impossible is a threshold with no stated origin.

WHY THE DEFAULTS ARE CROSS-PROFILE
Because a per-profile number written here would be exactly the `elif`
ladder the profile catalogue exists to replace. A multi-period parameter
that genuinely needs tuning per structure belongs in the pack, where the
tuning is data and the reader can find it.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from .. import _company_profile as CP
from .. import _finding as F
from . import m_series as S

#: The address prefix a finding records when the threshold came from this
#: table rather than from the pack.
POLICY_SOURCE = "engine.api.findings.m_policy#ANALYSES"


# ── Types ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ParameterSpec:
    """One threshold parameter: its number, its unit, the words a reader
    sees, the comparison it makes and the severity crossing it earns."""

    name: str
    label: str
    unit: str
    comparator: str
    default: float
    severity: str = "medium"


@dataclass(frozen=True)
class ActionTemplate:
    """One step, pre-committed to an imperative verb from the contract's
    lexicon, an artefact and a provider. The tokens are filled from the
    measurement, so the step names THIS company's accounts and periods."""

    imperative: str
    artefact: str
    provider: str
    horizon: Optional[str] = None


@dataclass(frozen=True)
class AnalysisSpec:
    id: str
    label: str
    category: str
    #: Ordered most-severe-first. The first band whose comparison HOLDS is
    #: the one the finding reports, so a finding never cites a limit it
    #: did not actually cross.
    bands: Tuple[str, ...]
    #: Evaluated as preconditions; never reported as the threshold.
    gates: Tuple[str, ...]
    parameters: Dict[str, ParameterSpec]
    min_periods: int
    min_years: int
    basis_kind: str
    why_here: str
    actions: Tuple[ActionTemplate, ...]
    materiality_basis: str

    def parameter(self, name: str) -> ParameterSpec:
        if name not in self.parameters:
            raise KeyError(
                "analysis %r declares no parameter %r (has %r)"
                % (self.id, name, sorted(self.parameters)))
        return self.parameters[name]


@dataclass(frozen=True)
class ResolvedThreshold:
    """A parameter WITH ITS ADDRESS — the pack's, or this table's."""

    analysis_id: str
    parameter: str
    label: str
    unit: str
    comparator: str
    value: float
    severity: str
    source: str
    tuned: bool
    profile_id: str


def _p(name, label, unit, comparator, default, severity="medium"):
    return ParameterSpec(name=name, label=label, unit=unit,
                         comparator=comparator, default=default,
                         severity=severity)


# ── The table ────────────────────────────────────────────────────────────
#
# Units are the contract's: `count` for periods, `percent` for a share or
# a change expressed as a fraction, `days` for a working-capital cycle,
# `score` for a robust deviation. NONE of them is money — deliberately.
# A dimensionless threshold survives a display-currency change untouched,
# and it keeps every finding title free of a currency label, which is the
# adjacency that produced the Critical-461 render defect.

ANALYSES = {}  # type: Dict[str, AnalysisSpec]


def _register(spec: AnalysisSpec) -> AnalysisSpec:
    ANALYSES[spec.id] = spec
    return spec


M_DIRECTION = _register(AnalysisSpec(
    id="m_direction",
    label="Sustained direction",
    category="working_capital",
    bands=("severe_consecutive_periods", "min_consecutive_periods"),
    gates=("min_cumulative_change",),
    parameters={
        "min_consecutive_periods": _p(
            "min_consecutive_periods", "consecutive adverse periods",
            F.UNIT_COUNT, ">=", 3.0, "medium"),
        "severe_consecutive_periods": _p(
            "severe_consecutive_periods", "consecutive adverse periods (severe)",
            F.UNIT_COUNT, ">=", 5.0, "high"),
        "min_cumulative_change": _p(
            "min_cumulative_change", "cumulative move across the run",
            F.UNIT_PERCENT, ">=", 0.10, "medium"),
    },
    min_periods=4, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "One bad period is trading noise for a {profile_label}; the same "
        "direction repeated without a break is the operating pattern, and "
        "{financing_audience} reads the run rather than the last point."),
    actions=(
        ActionTemplate(
            imperative="Pull the {line} movements for each of the {periods} "
                       "periods to {latest_label}",
            artefact="per-period movement listing for account {codes}",
            provider="the financial controller",
            horizon="before the next board pack"),
        ActionTemplate(
            imperative="Split the cumulative move on {codes} between volume, "
                       "price and one-off entries",
            artefact="volume/price bridge for {line} across the run",
            provider="the commercial controller"),
    ),
    materiality_basis="line",
))

M_MAGNITUDE = _register(AnalysisSpec(
    id="m_magnitude",
    label="Outlier movement",
    category="data_quality",
    bands=("severe_k_mad", "k_mad"),
    gates=(),
    parameters={
        "k_mad": _p("k_mad", "robust deviation ceiling (scaled MAD)",
                    F.UNIT_SCORE, ">", 3.0, "medium"),
        "severe_k_mad": _p("severe_k_mad",
                           "robust deviation ceiling (scaled MAD, severe)",
                           F.UNIT_SCORE, ">", 5.0, "high"),
    },
    min_periods=5, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "The comparison is the company's own history, not a sector table: "
        "for a {profile_label} a movement this far outside its own habitual "
        "range is either a real event {financing_audience} has not been told "
        "about, or a posting that belongs in a different period."),
    actions=(
        ActionTemplate(
            imperative="Trace the {latest_label} movement on {codes} to its "
                       "source documents",
            artefact="journal listing for account {codes} in {latest_label}",
            provider="the financial controller",
            horizon="within this close"),
        ActionTemplate(
            imperative="Confirm whether the largest entry is a trading "
                       "movement or a reclassification",
            artefact="posting narrative and supporting document for the "
                     "largest {line} entry",
            provider="the accounting team"),
    ),
    materiality_basis="line",
))

M_DECOUPLE = _register(AnalysisSpec(
    id="m_decouple",
    label="Decoupling from its driver",
    category="margin",
    bands=("severe_divergence", "divergence_high"),
    gates=(),
    parameters={
        "divergence_high": _p(
            "divergence_high", "growth gap against the driver line",
            F.UNIT_PERCENT, ">", 0.15, "medium"),
        "severe_divergence": _p(
            "severe_divergence", "growth gap against the driver line (severe)",
            F.UNIT_PERCENT, ">", 0.30, "high"),
    },
    min_periods=2, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "For a {profile_label} these two lines are supposed to move "
        "together; when they stop, the margin has already changed and the "
        "revenue number {financing_audience} looks at has not shown it yet."),
    actions=(
        ActionTemplate(
            imperative="Split the {line} movement against {driver} between "
                       "price, mix and volume",
            artefact="contribution bridge for {line} versus {driver}",
            provider="the commercial controller",
            horizon="with the next monthly result"),
        ActionTemplate(
            imperative="Recompute the gross margin holding the observed "
                       "intensity for the next two periods",
            artefact="restated margin forecast on the observed ratio",
            provider="the FP&A team"),
    ),
    materiality_basis=S.BASIS_REVENUE,
))

M_VELOCITY = _register(AnalysisSpec(
    id="m_velocity",
    label="Working-capital cycle break",
    category="working_capital",
    bands=("severe_days_break", "days_break_high"),
    gates=(),
    parameters={
        "days_break_high": _p(
            "days_break_high", "break from the company's own median cycle",
            F.UNIT_DAYS, ">", 15.0, "medium"),
        "severe_days_break": _p(
            "severe_days_break",
            "break from the company's own median cycle (severe)",
            F.UNIT_DAYS, ">", 30.0, "high"),
    },
    min_periods=3, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "A {profile_label} funds the gap between paying and being paid out "
        "of the same cash that settles payroll; a cycle that lengthens this "
        "far converts a profitable period into a borrowing one, which is "
        "what {financing_audience} sizes the facility on."),
    actions=(
        ActionTemplate(
            imperative="Pull the aged listing behind account {codes} at both "
                       "period ends",
            artefact="aged balance by counterparty at {prior_label} and "
                     "{latest_label}",
            provider="the credit control team",
            horizon="within this close"),
        ActionTemplate(
            imperative="Recompute the 13-week cash forecast at the observed "
                       "cycle length",
            artefact="restated 13-week cash forecast",
            provider="the treasury team"),
    ),
    materiality_basis="line",
))

M_REVERSAL = _register(AnalysisSpec(
    id="m_reversal",
    label="Period-end entry reversed after the date",
    category="data_quality",
    bands=("severe_reversal_share", "reversal_share_min"),
    gates=("spike_share_of_basis_min",),
    parameters={
        "reversal_share_min": _p(
            "reversal_share_min", "share of the period-end move given back",
            F.UNIT_PERCENT, ">", 0.80, "high"),
        "severe_reversal_share": _p(
            "severe_reversal_share",
            "share of the period-end move given back (severe)",
            F.UNIT_PERCENT, ">", 0.95, "critical"),
        "spike_share_of_basis_min": _p(
            "spike_share_of_basis_min", "materiality floor for the move",
            F.UNIT_PERCENT, ">=", 0.02, "high"),
    },
    min_periods=3, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "The figure a {profile_label} was measured on at the period end was "
        "not the figure that survived the next period; {financing_audience} "
        "certifies covenants off the first one, and the reversal is the "
        "evidence it was not the operating position."),
    actions=(
        ActionTemplate(
            imperative="Trace the {spike_label} entry on {codes} and the "
                       "entry that reversed it in {latest_label}",
            artefact="the journal pair with narrative and approver",
            provider="the financial controller",
            horizon="before these accounts are approved"),
        ActionTemplate(
            imperative="Disclose the pair to the statutory auditor as a "
                       "period-end adjustment",
            artefact="schedule of period-end entries reversed after the date",
            provider="the reporting manager"),
    ),
    materiality_basis="line",
))

M_DORMANT = _register(AnalysisSpec(
    id="m_dormant",
    label="Dormant balance",
    category="working_capital",
    bands=("severe_dormant_periods", "min_dormant_periods"),
    gates=("min_share_of_basis", "movement_tolerance"),
    parameters={
        "min_dormant_periods": _p(
            "min_dormant_periods", "consecutive periods without movement",
            F.UNIT_COUNT, ">=", 3.0, "medium"),
        "severe_dormant_periods": _p(
            "severe_dormant_periods",
            "consecutive periods without movement (severe)",
            F.UNIT_COUNT, ">=", 5.0, "high"),
        "min_share_of_basis": _p(
            "min_share_of_basis", "materiality floor for a dormant balance",
            F.UNIT_PERCENT, ">=", 0.01, "medium"),
        "movement_tolerance": _p(
            "movement_tolerance", "movement tolerance around the balance",
            F.UNIT_PERCENT, "<=", 0.005, "medium"),
    },
    min_periods=4, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "An asset a {profile_label} has not collected, consumed or written "
        "off across this many periods is not working capital, it is capital "
        "parked; it still counts in the current-asset total "
        "{financing_audience} reads."),
    actions=(
        ActionTemplate(
            imperative="Pull the {line} sub-ledger with the last settlement "
                       "date per counterparty",
            artefact="aged account {codes} listing with last movement dates",
            provider="the financial controller",
            horizon="before the next covenant certificate"),
        ActionTemplate(
            imperative="Recompute the equity ratio with the dormant balance "
                       "excluded",
            artefact="restated gearing calculation",
            provider="the treasury team"),
    ),
    materiality_basis="line",
))

M_TREND = _register(AnalysisSpec(
    id="m_trend",
    label="Multi-period deterioration",
    category="leverage",
    bands=("severe_slope", "min_slope_per_period"),
    gates=("min_agreement", "projection_periods"),
    parameters={
        "min_slope_per_period": _p(
            "min_slope_per_period", "fitted deterioration per period",
            F.UNIT_PERCENT, ">", 0.01, "medium"),
        "severe_slope": _p(
            "severe_slope", "fitted deterioration per period (severe)",
            F.UNIT_PERCENT, ">", 0.03, "high"),
        "min_agreement": _p(
            "min_agreement", "share of pairwise slopes agreeing on direction",
            F.UNIT_PERCENT, ">=", 0.70, "medium"),
        "projection_periods": _p(
            "projection_periods", "projection horizon",
            F.UNIT_COUNT, ">=", 3.0, "medium"),
    },
    min_periods=4, min_years=0,
    basis_kind="prior_period",
    why_here=(
        "A {profile_label} is refinanced on where the line is going, not "
        "where it stands: held at the fitted rate this reaches the "
        "projected level inside the tenor {financing_audience} has already "
        "committed."),
    actions=(
        ActionTemplate(
            imperative="Model the {line} share forward on the fitted slope "
                       "and name the period it breaches the covenant",
            artefact="{horizon}-period projection with the breach period "
                     "identified",
            provider="the FP&A team",
            horizon="with the next forecast round"),
        ActionTemplate(
            imperative="Agree a per-period corrective target for {line} with "
                       "the responsible manager",
            artefact="signed action plan carrying a target for each period",
            provider="the operations lead"),
    ),
    materiality_basis="line",
))

M_SEASONAL = _register(AnalysisSpec(
    id="m_seasonal",
    label="Same period last year",
    category="margin",
    bands=("severe_yoy_change", "yoy_change_high"),
    gates=(),
    parameters={
        "yoy_change_high": _p(
            "yoy_change_high", "adverse move against the same period a year "
                               "earlier",
            F.UNIT_PERCENT, ">", 0.20, "medium"),
        "severe_yoy_change": _p(
            "severe_yoy_change",
            "adverse move against the same period a year earlier (severe)",
            F.UNIT_PERCENT, ">", 0.40, "high"),
    },
    min_periods=2, min_years=2,
    basis_kind="prior_period",
    why_here=(
        "Comparing {latest_label} with the period immediately before it "
        "measures the calendar; comparing it with the same period a year "
        "earlier measures the business. For a {profile_label} only the "
        "second one tells {financing_audience} anything."),
    actions=(
        ActionTemplate(
            imperative="Compare {latest_label} against {prior_label} line by "
                       "line on account {codes}",
            artefact="same-period-last-year variance schedule",
            provider="the financial controller",
            horizon="with the management accounts"),
        ActionTemplate(
            imperative="Confirm whether the change is a calendar effect or a "
                       "level shift",
            artefact="two-year profile for {line} at the same period end",
            provider="the FP&A team"),
    ),
    materiality_basis="line",
))

#: Stable iteration order for every consumer, so a report's "All checks"
#: list does not reshuffle between runs.
ANALYSIS_IDS = tuple(sorted(ANALYSES))


# ── Threshold resolution: pack first, table second ───────────────────────


def resolve_threshold(profile: "CP.CompanyProfile", analysis_id: str,
                      parameter: str) -> ResolvedThreshold:
    """The number that judges THIS company, with the address it came from.

    The country pack is asked first. If it registers this analysis as a
    detector and declares this parameter, its value wins — tuned per
    structural profile, addressed as `profiles.yaml#detectors...`. If it
    does not, the cross-profile default in this table is used and the
    address says so. A threshold with no stated origin is not reachable
    from here.
    """
    spec = ANALYSES[analysis_id]
    param = spec.parameter(parameter)
    try:
        packed = profile.threshold(analysis_id, parameter)
    except (CP.UnknownDetectorError, CP.UnknownThresholdError):
        packed = None
    if packed is not None:
        return ResolvedThreshold(
            analysis_id=analysis_id, parameter=parameter,
            label=packed.parameter_label, unit=packed.unit,
            comparator=param.comparator, value=float(packed.value),
            severity=param.severity, source=packed.source,
            tuned=bool(packed.tuned), profile_id=packed.profile_id)
    return ResolvedThreshold(
        analysis_id=analysis_id, parameter=parameter,
        label=param.label, unit=param.unit, comparator=param.comparator,
        value=float(param.default), severity=param.severity,
        source="%s.%s.%s" % (POLICY_SOURCE, analysis_id, parameter),
        tuned=False, profile_id=profile.profile_id)


def resolve_category(profile: "CP.CompanyProfile", analysis_id: str) -> str:
    """The alert category, from the pack when it knows the analysis and
    from this table otherwise. Both are values the storage CHECK
    constraint accepts."""
    try:
        return profile.category_for(analysis_id)
    except CP.UnknownDetectorError:
        return ANALYSES[analysis_id].category


def render_tokens(template: str, tokens: Dict[str, str]) -> str:
    """Token substitution that cannot raise.

    Deliberately not `str.format`: this copy is prose and a stray brace in
    an account name would take down an analysis for a typo. Unknown tokens
    are left visible, where a reviewer sees them, instead of vanishing.
    """
    text = " ".join((template or "").split())
    for key in sorted(tokens):
        text = text.replace("{%s}" % key, tokens[key])
    return text


__all__ = [
    "ANALYSES", "ANALYSIS_IDS", "AnalysisSpec", "ActionTemplate",
    "ParameterSpec", "ResolvedThreshold", "POLICY_SOURCE",
    "M_DIRECTION", "M_MAGNITUDE", "M_DECOUPLE", "M_VELOCITY", "M_REVERSAL",
    "M_DORMANT", "M_TREND", "M_SEASONAL",
    "render_tokens", "resolve_category", "resolve_threshold",
]
