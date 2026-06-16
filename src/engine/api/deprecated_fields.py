"""F4.6 — deprecated-field warnings emitted on /api/period responses.

Per F3.15 operator decision 3e (parallel migration): legacy fields stay
byte-identical for a minimum of 2 quarters after the canonical surface
reaches feature parity, then are removed. The deprecated_fields array
gives consumers (FE, briefing engine, external API users) an early
warning + a clear migration target so they can switch ahead of the
sunset date.

Each entry shape:
  {
    "field": "statements.assembled_bs",
    "replacement": "statements.assembled_canonical_v1.aggregates",
    "sunset_at": "2026-11-23",              # ISO date, +2Q from F4.1
    "introduced": "F4.1c (2026-05-23)",     # when the replacement shipped
    "rationale": "...",
    "severity": "warning"                    # warning | info
  }

Consumers should:
  - Log a warning when reading a deprecated field
  - Track usage so they can prove zero-traffic before sunset
  - Switch to the replacement before sunset_at
"""
from __future__ import annotations

from typing import Any, Dict, List


# Sunset = F4.1f deploy date + 2Q. Adjust if cutover ceremony slips.
_F4_1_DEPLOY_DATE = "2026-05-23"
_SUNSET_DATE = "2026-11-23"   # 6 months after F4.1


def deprecated_fields_list() -> List[Dict[str, Any]]:
    """Return the static list of legacy fields with their canonical
    replacements + sunset dates. Static because the deprecation roster
    is small + curated; loading from YAML would over-engineer this."""
    return [
        {
            "field": "statements.assembled_bs",
            "replacement": "statements.assembled_canonical_v1.aggregates",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.1c ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "Country-specific bucket schema (assembled_bs) replaced by "
                "canonical_v1 cross-country aggregates with always-positive "
                "magnitudes + sign_meaning metadata (per CANONICAL_SCHEMA_V1.md §3b)."
            ),
            "severity": "warning",
        },
        {
            "field": "statements.assembled_pl",
            "replacement": "statements.assembled_canonical_v1.aggregates",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.1c ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "Country-specific P&L bucket schema replaced by canonical_v1; "
                "EBITDA variants now exposed via assembled_canonical_v1.methodology.ebitda."
            ),
            "severity": "warning",
        },
        {
            "field": "statements.assembled_cf",
            "replacement": "statements.assembled_canonical_v1.aggregates",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.1c ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "Country-specific cash flow bucket schema replaced by canonical_v1 "
                "CF aggregates."
            ),
            "severity": "warning",
        },
        {
            "field": "statements.assembled_pl.ebitda_statutory",
            "replacement": "statements.assembled_canonical_v1.methodology.ebitda.reported",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.2 ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "In-code EBITDA computation replaced by declarative YAML "
                "methodology recipes (methodology/ro_ras_2025_v1.yaml)."
            ),
            "severity": "info",
        },
        {
            "field": "statements.assembled_pl.adjusted_ebitda",
            "replacement": "statements.assembled_canonical_v1.methodology.ebitda.strict",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.2 ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "Adjusted EBITDA is now the 'strict' variant in the methodology layer; "
                "strict subtracts one-off income + provision reversals from reported."
            ),
            "severity": "info",
        },
        {
            "field": "statements.assembled_pl.ebitda_cash",
            "replacement": "statements.assembled_canonical_v1.methodology.ebitda.cash",
            "sunset_at": _SUNSET_DATE,
            "introduced": f"F4.2 ({_F4_1_DEPLOY_DATE})",
            "rationale": (
                "Cash EBITDA now declared via methodology.ebitda.cash; strips all "
                "non-cash operating items per the YAML recipe."
            ),
            "severity": "info",
        },
    ]


def attach_deprecated_fields(response_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Mutate-and-return: add `deprecated_fields` at the top level of
    a response payload. Idempotent (overwrites any existing key)."""
    if not isinstance(response_payload, dict):
        return response_payload
    response_payload["deprecated_fields"] = deprecated_fields_list()
    return response_payload
