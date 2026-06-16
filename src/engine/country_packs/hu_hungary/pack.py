"""F4.5 Hungary pack — SKELETON.

Implements CountryAccountingPack Protocol with placeholder logic.
Every method returns a sensible-but-empty result so the engine doesn't
crash when the pack is registered. Realistic processing requires
sourcing Hungarian fixtures + calibrating the chart-of-accounts
mapping (operator action).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from engine.core.types import (
    AltmanThresholds,
    AssembledEnvelope,
    BucketRule,
    CalibrationTier,
    ClassifierSignals,
    CreditLadderEntry,
    DetectionConfidence,
    NumberFormat,
    ParsedAccount,
)


class HungaryPack:
    """Hungary country pack — SKELETON / UNCALIBRATED.

    Implements every CountryAccountingPack Protocol member but with
    placeholder logic. Detection returns low confidence so the
    classifier prefers the RO pack on RO uploads. Used solely to exercise
    F4.4 fan-out routing's multi-pack branch.
    """

    # ── 1. Identity ─────────────────────────────────────────
    country_code: str = "HU"
    country_name: str = "Hungary"
    accounting_standard: str = "lt_001_2017_iv"   # Act C of 2000, 2017 IV
    pack_version: str = "0.1.0-skeleton"
    calibration_tier: CalibrationTier = CalibrationTier.EXPERIMENTAL

    # ── 2. Locale / display ─────────────────────────────────
    currency: str = "HUF"
    number_format: NumberFormat = NumberFormat(
        decimal_separator=",",
        thousands_separator=" ",      # Hungarian uses thin-space thousands
        currency_position="suffix",
    )
    primary_language: str = "hu"

    # ── 7. Valuation defaults (placeholder; refine with HU benchmarks) ──
    risk_free_rate: float = 0.07         # HU 10Y govt approx
    country_risk_premium: float = 0.015  # additional vs RO

    # ── 8. Validation thresholds + regression anchors ───────
    bs_reconciliation_tolerance_pct: float = 0.5
    altman_thresholds: AltmanThresholds = AltmanThresholds(
        variant="z_double_prime_em",
        distress_max=1.10,
        safe_min=2.60,
    )
    # Empty ladder until first calibrated fixture lands.
    credit_letter_grade_ladder: Tuple[CreditLadderEntry, ...] = ()

    # No regression fixtures yet (skeleton). Filled when operator sources
    # real HU trial balances and graduates the pack out of EXPERIMENTAL.
    regression_fixtures: Tuple = ()
    methodology_doc_path: str = ""   # No methodology doc yet

    # ────────────────────────────────────────────────────────
    # Protocol methods
    # ────────────────────────────────────────────────────────

    def detect_from_content(
        self, content: bytes, filename: str = "",
    ) -> DetectionConfidence:
        """Always return LOW confidence so the RO pack wins on RO uploads
        and the classifier surfaces operator-required on genuinely-HU
        content (until calibrated). Honest about uncertainty."""
        return DetectionConfidence(
            country_code=self.country_code,
            confidence=0.0,
            signals={"calibration": 0.0},  # Dict[str, float] per Protocol
            detected_language=None,
            detected_currency=None,
        )

    # ── 4. Parsing (Protocol methods, all stubs) ────────────
    def parse_trial_balance(self, content: bytes, filename: str) -> List[Any]:
        """Skeleton: returns empty list. Real implementation would parse
        Hungarian SZL trial balance formats (e.g. NAV-compatible TXT)."""
        return []

    def parse_pasted_trial_balance(self, text: str) -> List[Any]:
        """Skeleton: returns empty list."""
        return []

    def accounts_to_canonical_tsv(self, accounts: List[Any]) -> str:
        """Skeleton: returns minimal TSV header so downstream LLM
        preambles don't crash on empty input."""
        return "code\tname\tamount\n"

    def accounts_to_assemble_shape(self, raw_rows: List[Any]) -> List[Any]:
        """Identity mapping for the skeleton — every row passes through
        unchanged. Real implementation would normalise Hungarian
        software-export formats to the dict shape."""
        return list(raw_rows or [])

    def compute_statutory_net_profit_anchor(self, raw_rows: List[Any]) -> float:
        """Skeleton: 0.0. Hungarian SZL uses a different control-account
        convention; real implementation maps to that."""
        return 0.0

    def bucket_for(self, account_code: str) -> Optional[BucketRule]:
        """Delegate to the SZL chart-of-accounts skeleton. Returns None
        until _RULES is filled via calibration."""
        from . import chart_of_accounts as _szl
        rule = _szl.bucket_for(account_code)
        if rule is None:
            return None
        return BucketRule(prefix=rule.prefix, bucket=rule.bucket,
                          sign=rule.sign, description=rule.description)

    def persistence_bucket(self, canonical_bucket: str) -> str:
        return canonical_bucket  # identity mapping; no legacy bridge needed

    def assemble_statements(
        self,
        accounts: List[ParsedAccount],
        *,
        company_name: str,
        currency: str,
        period_label: str,
        industry: Optional[str] = None,
    ) -> AssembledEnvelope:
        """Delegates to the SZL chart-of-accounts skeleton's
        assemble_statements. Returns a well-shaped envelope with every
        account routed as unmapped until _RULES is calibrated."""
        from . import chart_of_accounts as _szl
        from . import canonical_adapter as _szl_canonical
        acct_dicts: List[Dict[str, Any]] = []
        for a in (accounts or []):
            if isinstance(a, dict):
                acct_dicts.append(a)
            else:
                acct_dicts.append({
                    "code": getattr(a, "code", ""),
                    "name": getattr(a, "name", ""),
                    "amount": float(getattr(a, "amount", 0) or 0),
                })
        result = _szl.assemble_statements(
            acct_dicts, company_name=company_name, currency=currency,
            period_label=period_label, industry=industry,
        )
        # Attach canonical envelope (empty until calibrated) so the
        # F4.1-CANONICAL gate's structure check passes on HU data.
        try:
            result["assembled_canonical_v1"] = _szl_canonical.assemble_canonical(
                result.get("lineItems") or [],
                source_data_quality=None,
                current_year_pnl=0.0,
            )
        except Exception:  # noqa: BLE001
            pass
        return result

    def classify_industry(self, signals: ClassifierSignals) -> Dict[str, Any]:
        """No industry signal until calibrated. Confidence 0 → caller's
        generic-industry fallback applies."""
        return {
            "industry_key": None,
            "confidence": 0.0,
            "signals": {"note": "HU skeleton pack: no industry signals computed"},
        }
