"""Two periods, side by side, without inventing the difference.

`levels`  — detail level as a fact, and the comparability rule.
`lines`   — which statement lines exist, what feeds them, what they need.
`columns` — current / prior / delta / delta %, and the refusals.
`shares`  — ONE period's lines as shares of its own base: the per-side
            computation the two-period common size and the single-period
            block (`analysis.period_common_size`) both run.

Jurisdiction-blind by contract: nothing here names a country, compares a
jurisdiction token, or imports a country pack. The chart-of-accounts fact
(where the synthetic boundary falls) belongs to the pack, and the pack
imports these names — never the other way round.
"""
from __future__ import annotations

from .columns import (
    DISCLOSURE_ABSENT,
    DISCLOSURE_NOT_AT_LEVEL,
    DISCLOSURE_REPORTED,
    MOVEMENT_STATUSES,
    PCT_BASE_FLOOR,
    STATUS_ABSENT_BOTH,
    STATUS_ABSENT_CURRENT,
    STATUS_ABSENT_PRIOR,
    STATUS_COMPARED,
    STATUS_COMPARED_NO_BASE,
    STATUS_INCOMPARABLE,
    STATUS_NOT_DISCLOSED,
    ComparativeColumn,
    ComparativeTable,
    build_comparative_columns,
)
from .levels import (
    ANALYTIC,
    INDETERMINATE,
    LEVELS,
    MIXED,
    SYNTHETIC,
    Comparability,
    assess_comparability,
    carries_analytic_detail,
    effective_level,
)
from .lines import (
    LINE_SPECS,
    UNIT_MONEY,
    UNITS,
    LineSpec,
    coverage_from_envelope,
    read_value,
    spec_for,
    unwrap_envelope,
)

__all__ = [
    "SYNTHETIC", "ANALYTIC", "MIXED", "INDETERMINATE", "LEVELS",
    "effective_level", "carries_analytic_detail",
    "Comparability", "assess_comparability",
    "LineSpec", "LINE_SPECS", "spec_for", "UNIT_MONEY", "UNITS",
    "unwrap_envelope", "coverage_from_envelope", "read_value",
    "ComparativeColumn", "ComparativeTable", "build_comparative_columns",
    "PCT_BASE_FLOOR", "MOVEMENT_STATUSES",
    "DISCLOSURE_REPORTED", "DISCLOSURE_ABSENT", "DISCLOSURE_NOT_AT_LEVEL",
    "STATUS_COMPARED", "STATUS_COMPARED_NO_BASE", "STATUS_ABSENT_PRIOR",
    "STATUS_ABSENT_CURRENT", "STATUS_ABSENT_BOTH", "STATUS_NOT_DISCLOSED",
    "STATUS_INCOMPARABLE",
]
