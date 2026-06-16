"""F3.1 — The `CountryAccountingPack` interface.

Every country pack (`engine.country_packs.<country>/pack.py`) implements
this Protocol. The universal engine core dispatches every country-
specific decision via this interface; nothing in `engine.core/*` or in
country-agnostic parts of `engine.api/*` may reference Romanian (or any
specific country's) account codes, labels, or conventions directly.

This module is import-cheap by design: the Protocol uses `typing` only,
no runtime dispatch logic. The actual pack implementations are loaded
on demand by `country_pack_registry`.

# Implementation note
Python's `Protocol` is structural — any class that has the listed
attributes and methods conforms. Packs may also inherit from
`CountryAccountingPack` for explicit declaration; either works.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, Tuple, runtime_checkable

from .types import (
    AltmanThresholds,
    AssembledEnvelope,
    BucketRule,
    CalibrationTier,
    ClassifierSignals,
    CreditLadderEntry,
    DetectionConfidence,
    FixturePath,
    NumberFormat,
    ParsedAccount,
)


@runtime_checkable
class CountryAccountingPack(Protocol):
    """Interface every country pack must satisfy.

    The Protocol is split into eight conceptual sections matching the
    F3.1 inventory categories:
      1. Identity / metadata
      2. Locale / display
      3. Detection (consumed by F3.3 upload-classifier)
      4. Trial-balance parsing
      5. Account-code → canonical-bucket mapping
      6. Canonical statement assembly
      7. Industry classification + valuation defaults
      8. Validation thresholds + regression anchors

    Romania is the first implementation (`country_packs.ro_romania.RomaniaPack`);
    every subsequent pack follows the same shape, calibrated against
    real fixtures per the F3 kickoff rules.
    """

    # ── 1. Identity ─────────────────────────────────────────
    country_code: str           # ISO 3166-1 alpha-2, e.g. "RO"
    country_name: str           # "Romania"
    accounting_standard: str    # "OMFP 1802 / RAS"
    pack_version: str           # SemVer; bump on calibration or rule change
    calibration_tier: CalibrationTier

    # ── 2. Locale / display ─────────────────────────────────
    currency: str                       # ISO 4217, e.g. "RON"
    number_format: NumberFormat
    primary_language: str               # ISO 639-1, e.g. "ro"

    # ── 3. Detection ────────────────────────────────────────
    def detect_from_content(
        self, content: bytes, filename: str
    ) -> DetectionConfidence:
        """Return a confidence score that this pack should process the
        given upload. The F3.3 classifier asks every registered pack
        and picks the highest scorer, routing to Review Mode if none
        clears the threshold.
        """
        ...

    # ── 4. Parsing ──────────────────────────────────────────
    def parse_trial_balance(
        self, content: bytes, filename: str
    ) -> List[Any]:
        """Parse a trial-balance file (xlsx / csv / pdf / json) into a
        country-agnostic list of account rows. The pack owns layout
        detection (SAGA / WinMentor / Crystal Reports for RO; whatever
        the equivalent local software ecosystems are for other
        countries).

        Return type is `List[Any]` during the F3.1 transition because
        the legacy modules return dict-shaped rows; F3.1d normalises
        to `ParsedAccount` once the data moves into the pack.
        """
        ...

    def parse_pasted_trial_balance(self, text: str) -> List[Any]:
        """Parse a copy-pasted trial-balance text (CSV / TSV / labeled
        block). Used by the paste-trial-balance endpoint.
        """
        ...

    def accounts_to_canonical_tsv(self, accounts: List[Any]) -> str:
        """Serialize a parsed account list into the canonical TSV the
        LLM stages consume as preamble. Country-specific because column
        headers and decimal/thousands separators differ.
        """
        ...

    def accounts_to_assemble_shape(self, raw_rows: List[Any]) -> List[Any]:
        """Normalise raw parser rows to the dict shape
        `assemble_statements()` expects. Identity-mapping for packs
        whose parser already emits that shape.
        """
        ...

    def compute_statutory_net_profit_anchor(self, raw_rows: List[Any]) -> float:
        """Extract the country's statutory net-profit anchor from raw
        parser rows. For Romania this is the closing C-balance of
        account 121 (OMFP 1802 control account). Returns 0 when no
        anchor can be derived.
        """
        ...

    # ── 5. Account mapping ──────────────────────────────────
    def bucket_for(self, account_code: str) -> Optional[BucketRule]:
        """Map a country-specific account code (e.g. RO RAS '601') to a
        canonical bucket + sign. Returns None when the code is not
        recognised — the caller decides whether to route to a catchall
        bucket or surface to the user via Review Mode (F3.4).
        """
        ...

    def persistence_bucket(self, canonical_bucket: str) -> str:
        """Translate a canonical bucket name (e.g.
        'inventoryVariationMemo') to a DB-storable bucket the
        `statement_line_items` table's CHECK constraint accepts.
        Identity mapping for buckets that already match the constraint.
        """
        ...

    # ── 6. Canonical assembly ───────────────────────────────
    def assemble_statements(
        self,
        accounts: List[ParsedAccount],
        *,
        company_name: str,
        currency: str,
        period_label: str,
        industry: Optional[str] = None,
    ) -> AssembledEnvelope:
        """The core canonical-assembly entry point. Same signature as
        `_ro_coa.assemble_statements()` today. Returns a dict
        `{statements: {...}, lineItems: [...], accountsUnmapped: int,
        ...}` whose shape is defined by `CanonicalFinancialModel`
        (formalised in F3.2).
        """
        ...

    # ── 7. Industry classification + valuation ──────────────
    def classify_industry(
        self, signals: ClassifierSignals
    ) -> Dict[str, Any]:
        """Map revenue / cost mix signals to an industry key (e.g.
        'food_manufacturing', 'real_estate_commercial') with a
        confidence score. The country pack owns the local industry-
        code system (CAEN for RO, NACE / localised codes elsewhere).

        Returns a dict at minimum containing:
          - industry_key: Optional[str]  (None when no class > threshold)
          - confidence: float in [0, 1]
          - signals: Dict[str, Any]  (which signals fired and how strong)

        Mirrors the existing `_ro_coa.detect_industry()` return shape
        so pipeline.py call sites that read `.get("confidence", 0)`
        keep working unchanged during F3.1c.
        """
        ...

    risk_free_rate: float           # decimal, e.g. 0.0675 for RO 2026
    country_risk_premium: float     # additional ERP add-on

    # ── 8. Validation + regression anchors ──────────────────
    bs_reconciliation_tolerance_pct: float  # 0.5 for RO
    altman_thresholds: AltmanThresholds
    credit_letter_grade_ladder: Tuple[CreditLadderEntry, ...]

    regression_fixtures: Tuple[FixturePath, ...]
    methodology_doc_path: str       # repo-relative path to METHODOLOGY.md
