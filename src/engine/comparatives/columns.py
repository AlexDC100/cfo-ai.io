"""THE COLUMN MODEL — current, prior, delta, delta %, and the refusals.

Two assembled envelopes in, one row per statement line out. Every row
carries what each period reported, what changed, and — where nothing may
be said — which of the three reasons is why.

THE THREE THINGS THIS MODEL WILL NOT DO.

  IT WILL NOT FABRICATE A ZERO. A line one period discloses and the other
  does not is ABSENT on the second side. Not 0.00, not a full write-off,
  not a hundred percent of anything. The measured case is real: the
  condensed Scandia book contains no doubtful-receivable row at all, and
  the assembled envelope's fields are dense, so the field reads 0.0 for a
  balance that was never disclosed. Coverage — the buckets the book
  actually fed — is what tells those two zeros apart.

  IT WILL NOT DIVIDE BY A ZERO BASE. A line that was zero and is now
  positive has a delta and NO percentage. Not infinity, not "+100%",
  not a large number standing in for one. `PCT_BASE_FLOOR` is half a
  cent, so a base that rounds to zero is treated as zero rather than
  producing a percentage in the millions.

  IT WILL NOT MOVE A FIGURE THE OTHER PERIOD NEVER DISCLOSED. Exposure by
  counterparty, an ageing schedule — a subdivision of a synthetic account
  is not in a synthetic book at any value. Against one, these report that
  the period did not disclose them at that detail level. Never a delta,
  never a direction, never a word like "improved".

NO VERDICTS LIVE HERE. The model returns numbers and statuses; whether a
movement is good news depends on the line's sign convention and on the
business, and both belong to the layer above. Nothing in this module
emits an adjective.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, FrozenSet, Mapping, Optional, Sequence, Tuple

from engine.serving.change_kind import COMPARED as CHANGE_COMPARED
from engine.serving.change_kind import classify as classify_change

from .levels import ANALYTIC, Comparability, assess_comparability, carries_analytic_detail
from .lines import (
    LINE_SPECS,
    ZERO_FLOOR,
    LineSpec,
    coverage_from_envelope,
    read_value,
    unwrap_envelope,
)

__all__ = [
    "PCT_BASE_FLOOR",
    "MONEY_DP",
    "PCT_DP",
    "DISCLOSURE_REPORTED",
    "DISCLOSURE_ABSENT",
    "DISCLOSURE_NOT_AT_LEVEL",
    "STATUS_COMPARED",
    "STATUS_COMPARED_NO_BASE",
    "STATUS_ABSENT_PRIOR",
    "STATUS_ABSENT_CURRENT",
    "STATUS_ABSENT_BOTH",
    "STATUS_NOT_DISCLOSED",
    "STATUS_INCOMPARABLE",
    "MOVEMENT_STATUSES",
    "COVERAGE_FROM_LINE_ITEMS",
    "COVERAGE_UNKNOWN",
    "ComparativeColumn",
    "ComparativeTable",
    "build_comparative_columns",
]

#: A base whose magnitude is below half a cent is a zero base. The same
#: name `lines.read_value` uses to decide that a zero under unknown
#: coverage is absent — one floor, one meaning of "zero" in the package.
PCT_BASE_FLOOR = ZERO_FLOOR

#: Money is reported to the cent, percentages to six places. Both are
#: rounded on the WAY OUT so two hosts agree byte for byte; neither input
#: is rounded before it is subtracted.
MONEY_DP = 2
PCT_DP = 6

# ── What one period said about one line ──────────────────────────────
#: The period's book fed this line and the envelope holds a number.
DISCLOSURE_REPORTED = "reported"
#: The period's book fed nothing into this line. Absent. Not zero.
DISCLOSURE_ABSENT = "absent"
#: The line is a subdivision below the synthetic boundary and this period
#: is not kept at that depth. Not absent — not disclosable.
DISCLOSURE_NOT_AT_LEVEL = "not_disclosed_at_this_detail_level"

# ── What the pair permits ────────────────────────────────────────────
STATUS_COMPARED = "compared"
STATUS_COMPARED_NO_BASE = "compared_no_base"
STATUS_ABSENT_PRIOR = "absent_prior"
STATUS_ABSENT_CURRENT = "absent_current"
STATUS_ABSENT_BOTH = "absent_both"
STATUS_NOT_DISCLOSED = "not_disclosed_at_this_detail_level"
STATUS_INCOMPARABLE = "incomparable"

#: The ONLY statuses that carry a movement. A narrator that reads columns
#: through `ComparativeTable.movements()` cannot describe a refusal as a
#: change, because a refusal is not in the sequence.
MOVEMENT_STATUSES: Tuple[str, ...] = (STATUS_COMPARED, STATUS_COMPARED_NO_BASE)

#: Coverage provenance, recorded per side so a caller never has to guess
#: whether ABSENT meant "the book fed nothing" or "we could not tell".
#: Under unknown coverage a bucket-backed zero reads absent (see
#: `lines.read_value`); it is never assumed dense.
COVERAGE_FROM_LINE_ITEMS = "line_items"
COVERAGE_UNKNOWN = "unknown_zero_reads_absent"


@dataclass(frozen=True)
class ComparativeColumn:
    """One statement line across two periods."""

    key: str
    statement: str
    label: str
    unit: str
    requires: str
    current: Optional[float]
    prior: Optional[float]
    delta: Optional[float]
    delta_pct: Optional[float]
    current_disclosure: str
    prior_disclosure: str
    status: str
    note: str
    #: plan_contract_v2 section 7 (engine.serving.change_kind): set only
    #: when the status is compared or compared_no_base, else None. A kind
    #: other than "compared" carries no delta_pct and renders in words.
    change_kind: Optional[str] = None

    @property
    def has_movement(self) -> bool:
        return self.status in MOVEMENT_STATUSES


@dataclass(frozen=True)
class ComparativeTable:
    current_label: str
    prior_label: str
    comparability: Comparability
    current_coverage_source: str
    prior_coverage_source: str
    columns: Tuple[ComparativeColumn, ...]

    def by_key(self, key: str) -> Optional[ComparativeColumn]:
        for col in self.columns:
            if col.key == key:
                return col
        return None

    def movements(self) -> Tuple[ComparativeColumn, ...]:
        """Only the lines that actually moved between two disclosed
        values. Everything else is a refusal and is not here."""
        return tuple(c for c in self.columns if c.status in MOVEMENT_STATUSES)

    def refusals(self) -> Tuple[ComparativeColumn, ...]:
        return tuple(c for c in self.columns if c.status not in MOVEMENT_STATUSES)


def _round_money(value: float) -> float:
    rounded = round(value, MONEY_DP)
    # -0.0 and 0.0 are the same money; only one of them should ever be
    # rendered, or two hosts print different strings for one fact.
    return 0.0 if rounded == 0 else rounded


def _fmt(value: float) -> str:
    return "%.2f" % value


def _disclosure(
    envelope: Mapping[str, Any],
    spec: LineSpec,
    coverage: Optional[FrozenSet[str]],
    level: str,
    level_known: bool,
) -> Tuple[Optional[float], str]:
    if level_known and spec.requires == ANALYTIC and not carries_analytic_detail(level):
        return None, DISCLOSURE_NOT_AT_LEVEL
    value = read_value(envelope, spec, coverage)
    if value is None:
        return None, DISCLOSURE_ABSENT
    return value, DISCLOSURE_REPORTED


def build_comparative_columns(
    current_envelope: Mapping[str, Any],
    prior_envelope: Mapping[str, Any],
    current_level: str,
    prior_level: str,
    current_label: str = "current",
    prior_label: str = "prior",
    specs: Optional[Sequence[LineSpec]] = None,
) -> ComparativeTable:
    """Build the two-column comparison.

    `current_level` / `prior_level` are the detail levels of the two
    books, spelled with the vocabulary in `engine.comparatives.levels`
    and detected by the country pack that owns the chart (the detector
    is `detail_level.classify_detail_level` inside it). They are
    REQUIRED:
    striking a comparison without knowing what depth each book is kept at
    is the defect this module exists to prevent, so there is no default
    and no inference.

    Pure: no clock, no I/O, no global state. Same envelopes in, same
    table out, on any host.
    """
    if specs is None:
        specs = LINE_SPECS
    comparability = assess_comparability(current_level, prior_level)
    level_known = comparability.comparable

    # Unwrap once, loudly, before anything is read — a shape error must
    # surface as an error, never as a table of absences.
    unwrap_envelope(current_envelope)
    unwrap_envelope(prior_envelope)

    cur_cov = coverage_from_envelope(current_envelope)
    pri_cov = coverage_from_envelope(prior_envelope)

    columns = []
    for spec in specs:
        cur_val, cur_disc = _disclosure(
            current_envelope, spec, cur_cov, current_level, level_known)
        pri_val, pri_disc = _disclosure(
            prior_envelope, spec, pri_cov, prior_level, level_known)

        delta = None  # type: Optional[float]
        delta_pct = None  # type: Optional[float]
        change_kind = None  # type: Optional[str]

        if not comparability.comparable:
            status = STATUS_INCOMPARABLE
            note = comparability.reason
        elif DISCLOSURE_NOT_AT_LEVEL in (cur_disc, pri_disc):
            status = STATUS_NOT_DISCLOSED
            withheld = []
            if cur_disc == DISCLOSURE_NOT_AT_LEVEL:
                withheld.append("%s (%s)" % (current_label, current_level))
            if pri_disc == DISCLOSURE_NOT_AT_LEVEL:
                withheld.append("%s (%s)" % (prior_label, prior_level))
            note = (
                "%s is a subdivision below the synthetic account boundary; "
                "not disclosed at this detail level by %s — no movement is "
                "computed" % (spec.label, " and ".join(withheld))
            )
        elif cur_disc == DISCLOSURE_REPORTED and pri_disc == DISCLOSURE_REPORTED:
            delta = _round_money(cur_val - pri_val)
            # THE ONE CLASSIFIER decides whether a percentage may exist at
            # all. Across zero or across sign there is none: 6.1M becoming
            # -107.6M is "turned negative", never -1,863% or -19x.
            change = classify_change(pri_val, cur_val, PCT_BASE_FLOOR)
            change_kind = change.kind
            if abs(pri_val) < PCT_BASE_FLOOR:
                status = STATUS_COMPARED_NO_BASE
                note = (
                    "%s reported %s, below the %.3f base floor, so the "
                    "change is stated as an amount and carries no "
                    "percentage" % (prior_label, _fmt(pri_val), PCT_BASE_FLOOR)
                )
            elif change.kind != CHANGE_COMPARED:
                status = STATUS_COMPARED
                note = (
                    "both periods reported %s; the change is %s, so it is "
                    "stated as an amount and carries no percentage"
                    % (spec.label, change.kind.replace("_", " "))
                )
            else:
                ratio = (cur_val - pri_val) / abs(pri_val)
                if ratio != ratio or ratio in (float("inf"), float("-inf")):
                    status = STATUS_COMPARED_NO_BASE
                    note = ("percentage not representable against %s reported "
                            "by %s" % (_fmt(pri_val), prior_label))
                else:
                    delta_pct = round(ratio, PCT_DP)
                    status = STATUS_COMPARED
                    note = "both periods reported %s" % spec.label
        elif cur_disc == DISCLOSURE_REPORTED:
            status = STATUS_ABSENT_PRIOR
            note = (
                "%s did not report %s; absent, which is not zero — no "
                "change is computed against it" % (prior_label, spec.label)
            )
        elif pri_disc == DISCLOSURE_REPORTED:
            status = STATUS_ABSENT_CURRENT
            note = (
                "%s did not report %s; absent, which is not zero — no "
                "change is computed against it" % (current_label, spec.label)
            )
        else:
            status = STATUS_ABSENT_BOTH
            note = "neither period reported %s" % spec.label

        columns.append(ComparativeColumn(
            key=spec.key,
            statement=spec.statement,
            label=spec.label,
            unit=spec.unit,
            requires=spec.requires,
            current=None if cur_val is None else _round_money(cur_val),
            prior=None if pri_val is None else _round_money(pri_val),
            delta=delta,
            delta_pct=delta_pct,
            current_disclosure=cur_disc,
            prior_disclosure=pri_disc,
            status=status,
            note=note,
            change_kind=change_kind,
        ))

    return ComparativeTable(
        current_label=current_label,
        prior_label=prior_label,
        comparability=comparability,
        current_coverage_source=(
            COVERAGE_UNKNOWN if cur_cov is None else COVERAGE_FROM_LINE_ITEMS),
        prior_coverage_source=(
            COVERAGE_UNKNOWN if pri_cov is None else COVERAGE_FROM_LINE_ITEMS),
        columns=tuple(columns),
    )
