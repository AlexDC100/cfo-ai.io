"""Shared types used by `CountryAccountingPack` implementations and the
universal engine core.

The shapes here mirror what `engine.api._ro_coa` already returns today;
they are extracted to a country-agnostic location so non-Romanian packs
can produce the same canonical output. F3.1 introduces the types as a
documented contract; F3.2 will formally validate every pack output
against `CanonicalFinancialModel`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple


class CalibrationTier(str, Enum):
    """How well a country pack has been calibrated against real trial
    balances. The product UI surfaces this verbatim — never overclaim.

    Tier rules (per the F3 kickoff):
      - DEEPLY_CALIBRATED  — ≥ 10 real fixtures, native-speaker reviewed.
      - PARTIALLY_CALIBRATED — ≥ 3 real fixtures.
      - EXPERIMENTAL — ≥ 1 real fixture, processed end-to-end with
                       reconciliation recorded.
      - BENCHMARK_ONLY — pack metadata + benchmarks exist, no fixtures.
                         No analysis path implemented.
      - UNSUPPORTED — country recognised but no pack; uploads enter
                      Review Mode.
    """
    DEEPLY_CALIBRATED = "deeply_calibrated"
    PARTIALLY_CALIBRATED = "partially_calibrated"
    EXPERIMENTAL = "experimental"
    BENCHMARK_ONLY = "benchmark_only"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class NumberFormat:
    """Locale number formatting. Romanian books: '1.234.567,89'."""
    decimal_separator: str = "."
    thousands_separator: str = ","
    currency_position: Literal["prefix", "suffix"] = "suffix"


@dataclass(frozen=True)
class BucketRule:
    """The country-pack's per-account-code routing decision. Mirrors the
    `_BucketRule` shape that `_ro_coa.bucket_for()` returns today.

    Attributes
    ----------
    bucket : str
        Canonical bucket name (e.g. 'cash', 'revenue', 'cogs',
        'shortTermDebt'). The set of valid bucket names is defined by
        `CanonicalFinancialModel` (F3.2).
    sign : int
        +1 or -1. When -1, the engine flips the raw debit-credit netted
        amount before aggregating — used for contra-asset / contra-equity
        accounts (e.g. Romanian 281 amortisation).
    description : str
        Human-readable label of what this account represents in the
        country's accounting standard.
    persistence_bucket : Optional[str]
        For backwards-compat with the DB schema's CHECK constraint on
        `statement_line_items.bucket`, packs may emit a "canonical"
        bucket name (e.g. 'inventoryVariationMemo') that the persistence
        layer translates to a legacy DB-accepted bucket. None means the
        canonical and persistence buckets are identical.
    """
    bucket: str
    sign: int
    description: str = ""
    persistence_bucket: Optional[str] = None


@dataclass
class ParsedAccount:
    """One row from a parsed trial balance, normalised to a country-
    agnostic shape. Each country pack's `parse_trial_balance()` returns
    a list of these.

    `amount` is the raw debit-credit netted value before any sign flip
    from `BucketRule.sign`; the engine's `assemble_statements()` applies
    the sign during aggregation.
    """
    code: str
    name: str
    amount: float
    bucket_override: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DetectionConfidence:
    """Per-upload signal from a pack's `detect_from_content()`. The
    F3.3 upload-classifier compares each registered pack's confidence
    and picks the highest, or routes to Review Mode if no pack scores
    above the threshold.

    `signals` is the per-signal score breakdown (each in [0, 1]) so
    the FE can render a "why this country" explanation. Each pack is
    free to define its own signal names — the classifier doesn't
    interpret them, just surfaces them.
    """
    country_code: str
    confidence: float  # 0.0 - 1.0
    signals: Dict[str, float] = field(default_factory=dict)
    detected_language: Optional[str] = None
    detected_layout: Optional[str] = None
    detected_currency: Optional[str] = None
    detected_standard: Optional[str] = None  # "OMFP 1802 / RAS", "HGB", etc.
    # F3.8b — accounting-software vendor / file-format signature when
    # the pack can identify it. Values are pack-specific strings, e.g.:
    #   "ro_pdf_winmentor", "ro_pdf_saga", "ro_pdf_ciel", "ro_pdf_generic"
    #   "ro_xlsx_10col", "ro_xlsx_extended", "ro_xlsx_group"
    # FE surfaces this in the Confidence Indicator to tell the user
    # "we recognized this as a WinMENTOR PDF export". None when the
    # format is unknown or doesn't carry a discriminating signature.
    detected_format: Optional[str] = None
    notes: Tuple[str, ...] = ()


# ── F3.3 confidence-engine shapes ────────────────────────────────────

class LayoutKind(str, Enum):
    """Trial-balance layout families. Country packs report which
    layout they detected so the FE can label uploads in Review Mode.
    """
    FULL_DEBIT_CREDIT_MOVEMENT = "full_debit_credit_movement"   # SAGA 10-col
    CLOSING_BALANCE_ONLY = "closing_balance_only"                # 6-col
    MOVEMENT_ONLY = "movement_only"                              # YTD-only
    FINANCIAL_STATEMENT_EXPORT = "financial_statement_export"    # statutory F30/F10
    PDF_FULL_MOVEMENT = "pdf_full_movement"                      # F3.8 RO PDF 5-period
    EXTENDED_GROUP = "extended_group"                            # F3.9 multi-sheet 20-col
    UNKNOWN = "unknown"


class ReconciliationStatus(str, Enum):
    """Per-upload reconciliation traffic-light. Computed against the
    pack's `bs_reconciliation_tolerance_pct` threshold."""
    GREEN = "green"     # within tolerance
    AMBER = "amber"     # >= tolerance but < 2× tolerance
    RED = "red"         # >= 2× tolerance


@dataclass
class ConfidenceReport:
    """Combined per-upload confidence assessment produced by the F3.3
    confidence engine. Consumed by both the API (surfaced on
    /api/period responses) and the FE (rendered as a traffic-light
    badge on every analysis page).

    `review_mode_required` is the authoritative trigger: when True,
    the FE routes the user to Review Mode (F3.4) rather than the
    normal dashboard. Triggered when:
      - country_confidence < 0.90, OR
      - calibration_tier in {EXPERIMENTAL, BENCHMARK_ONLY, UNSUPPORTED}, OR
      - reconciliation_status is RED
    """
    country_code: Optional[str]
    country_confidence: float                 # 0.0 - 1.0
    detected_language: Optional[str]
    detected_currency: Optional[str]
    detected_layout: LayoutKind
    detected_standard: Optional[str]
    calibration_tier: Optional[str]           # CalibrationTier.value or None
    reconciliation_status: ReconciliationStatus
    reconciliation_residual_pct: float        # |bs_balance_delta| / total_assets * 100
    unmapped_residual_pct: float              # sum(catchall) / total_assets * 100
    review_mode_required: bool
    review_mode_reasons: Tuple[str, ...]      # human-readable reasons
    pack_signals: Dict[str, float] = field(default_factory=dict)
    notes: Tuple[str, ...] = ()
    # F3.8b — vendor / file-format signature. Surfaced to FE so the
    # Confidence Indicator can tell the user "we recognised this as a
    # WinMENTOR PDF export" etc.
    detected_format: Optional[str] = None


# ── Pure aliases — these mirror the dict shapes assemble_statements
#    returns today. F3.2 will replace them with TypedDicts.
AssembledEnvelope = Dict[str, Any]
"""The full output of a pack's `assemble_statements()`, shaped like
`_ro_coa.assemble_statements()` returns today: a dict with keys
{statements, lineItems, accountsUnmapped, …}. F3.2 formalises this."""

ClassifierSignals = Dict[str, Any]
"""Loose dict of detection signals — revenue mix by account code, top-3
COGS prefixes, etc. Each country pack's `classify_industry()` reads
the signals it cares about and ignores the rest."""

FixturePath = str
"""Filesystem path (relative or absolute) to a regression fixture used
by F-A3.1-style gates."""


@dataclass(frozen=True)
class AltmanThresholds:
    """Country-specific Altman Z" thresholds. RO uses the EM Z" variant
    (1.10 distress, 2.60 safe)."""
    variant: str  # "z_double_prime_em", "z_original_1968", …
    distress_max: float
    safe_min: float


@dataclass(frozen=True)
class CreditLadderEntry:
    min_score: float
    letter_grade: str  # "AAA / AA", "A", "BBB", …
