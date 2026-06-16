"""F4.5-prep — Hungarian SZL chart-of-accounts skeleton.

Mirrors the structure of `ro_romania/chart_of_accounts.py` but with an
EMPTY rule table. Calibration requires real Hungarian trial balances
(operator action). Until rules are filled, every account routes as
unmapped and `assemble_statements` returns an empty-but-well-shaped
envelope.

Hungarian SZL (Számviteli törvény / Act C of 2000) uses the same
4-digit chart-of-accounts structure as RAS conceptually, but the
specific account assignments differ. The class-1 through class-9
mapping below is the SZL standard SKELETON — operator fills the
per-account-prefix rules during calibration.

CALIBRATION LOOP (follows F4.1b-cont pattern):
  1. Operator drops 3-5 HU trial balances into files/hu/.
  2. Add fixture loaders to scripts/measure_bs_drift.py (load_hu_*).
  3. Fill _RULES below with prefix → canonical-bucket mappings (~150
     prefixes for a typical SZL chart).
  4. Run F-A3.1: docker exec cfo-ai-backend python3 /app/scripts/
     measure_bs_drift.py. Expect RED on HU fixtures initially.
  5. Iterate _RULES + sign-aware overrides until drift <0.5% across
     all HU fixtures (same target as RO calibration).
  6. Bump pack_version to 1.0.0 + calibration_tier to PARTIALLY_CALIBRATED
     in pack.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


@dataclass(frozen=True)
class HuMappingRule:
    """Same shape as RO MappingRule for cross-pack consistency."""
    prefix: str
    bucket: str          # canonical bucket name (from schema_v1)
    sign: int            # +1 or -1
    description: str = ""


# ─── SZL class boundaries (structural reference) ───────────────────
# Operator fills the per-prefix rules under each class header during
# calibration. The structure is documented here so the operator knows
# what to expect when reading the first real HU trial balance.
#
# Class 1: Immobilized assets (Befektetett eszközök)        → asset
# Class 2: Inventory (Készletek)                            → asset
# Class 3: Receivables / cash / securities (Követelések)    → asset / mixed
# Class 4: Equity + liabilities (Saját tőke, kötelezettségek) → equity / liability
# Class 5: Costs by type (Költségek költségnemenként)        → expense
# Class 6: Costs by activity (Költségek tevékenységenként)   → expense (alt view)
# Class 7: Revenues + cost of sales (Bevételek)              → revenue / expense
# Class 8: Reclassifications (Átvezetések)                   → memo / control
# Class 9: Closing accounts (Zárószámlák)                    → control
#
# Account 491 (Zárás) in SZL plays a similar control role to RO 121.

_RULES: List[HuMappingRule] = [
    # ── Class 1 — Immobilized assets (placeholder) ──
    # HuMappingRule("11",  "intangibles_other", 1, "Immateriális javak"),
    # HuMappingRule("12",  "ppe_land",          1, "Ingatlanok és kapcsolódó vagyoni értékű jogok"),
    # ...
    # ── Class 2 — Inventory ──
    # HuMappingRule("21",  "inventory_raw_materials",  1, "Anyagok"),
    # ...
    # ── Class 4 — Equity + liabilities ──
    # HuMappingRule("411", "share_capital",  1, "Jegyzett tőke"),
    # ...
    # ── Class 9 — Closing (control accounts) ──
    # HuMappingRule("491", "ignore_control", 1, "Évi nyitó/záró control"),
]


_IGNORE_BUCKETS = {"ignore_transit", "ignore_control"}


def bucket_for(account_code: str) -> Optional[HuMappingRule]:
    """Longest-prefix match against the SZL rules. Returns None when no
    rule matches — caller routes to unmapped. Same semantics as the RO
    `chart_of_accounts.bucket_for()`."""
    code = str(account_code or "").strip()
    if not code:
        return None
    best: Optional[HuMappingRule] = None
    for rule in _RULES:
        if code.startswith(rule.prefix):
            if best is None or len(rule.prefix) > len(best.prefix):
                best = rule
    return best


def assemble_statements(
    accounts: List[Dict[str, Any]],
    *,
    company_name: str = "Entity",
    currency: str = "HUF",
    period_label: str = "",
    industry: Optional[str] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Skeleton assembly — returns empty-but-well-shaped envelope until
    _RULES is filled via the calibration loop. Every account routes as
    unmapped (with reason='hu_pack_uncalibrated') so the operator can
    see which accounts need rule coverage."""
    line_items: List[Dict[str, Any]] = []
    unmapped: List[Dict[str, Any]] = []
    for a in accounts or []:
        code = str(a.get("code") or "").strip()
        name = str(a.get("name") or "").strip()
        amount = float(a.get("amount") or 0)
        if not code or amount == 0:
            continue
        rule = bucket_for(code)
        if rule is None or rule.bucket in _IGNORE_BUCKETS:
            unmapped.append({
                "code": code, "name": name, "amount": amount,
                "reason": "hu_pack_uncalibrated" if rule is None else "ignore_control",
            })
            continue
        signed = amount * rule.sign
        line_items.append({
            "statement": "BS",  # placeholder; real impl decides BS vs PL
            "bucket": rule.bucket,
            "canonical_bucket": rule.bucket,
            "ro_account_code": code,   # reuse field name for cross-pack consistency
            "ro_account_name": name,
            "amount": signed,
            "is_derived": False,
        })

    return {
        "statements": {
            "companyName": company_name,
            "currency": currency,
            "periodLabel": period_label,
            "balanceSheet": {},
            "incomeStatement": {},
            "assembled_bs": {"total_assets": 0, "bs_balance_delta": 0,
                              "total_liabilities": 0, "total_equity": 0},
            "assembled_pl": {},
            "assembled_cf": {},
        },
        "lineItems": line_items,
        "unmapped": unmapped,
        "ignored": [],
        "pack_notice": (
            f"HU pack uncalibrated: {len(unmapped)} of "
            f"{len(unmapped) + len(line_items)} accounts unmapped. "
            f"Fill _RULES in chart_of_accounts.py to proceed."
        ),
    }


def persistence_bucket(canonical_bucket: str) -> str:
    """Identity mapping — no legacy bridge needed."""
    return canonical_bucket
