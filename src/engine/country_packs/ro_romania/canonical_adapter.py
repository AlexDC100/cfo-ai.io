"""F4.1b — Romania pack canonical adapter.

Maps Romanian RAS line_items (per the OMFP 1802 chart of accounts) into
the country-agnostic canonical schema defined in
`engine.canonical.schema_v1`. The adapter:

  1. Reads the RAS-routed line_items (the existing post-F3.x output)
  2. Re-routes each item to its canonical leaf bucket per the
     RAS-prefix mapping table below
  3. Emits ALWAYS-POSITIVE magnitudes (per F3.15 operator decision 3b)
  4. Computes parent_aggregate sums + verifies round-trip
     (sum(leaves) == aggregate per F4.1-ROUNDTRIP gate)

This adapter is RO-specific code. Future country packs implement their
own `canonical_adapter.py` that reads their pack's line_item format and
produces the same canonical output shape. The canonical layer guarantees:
methodology files written against `canonical_v1` work for any country
pack that emits to v1.

Per F4.1c+d (next chunks), the engine pipeline calls
`assemble_canonical(line_items, source_data_quality, ...)` after the
existing `assemble_statements()` call, emits the canonical envelope
alongside the legacy `assembled_bs/pl/cf` views. F3.1-PARITY stays
GREEN because the legacy emission is untouched.
"""
from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from engine.canonical import (
    ALL_BUCKETS,
    BS_BUCKETS,
    BucketType,
    PL_BUCKETS,
    PARENT_AGGREGATES_BS,
    PARENT_AGGREGATES_PL,
    SignMeaning,
    bucket_by_name,
    leaves_for_aggregate,
    schema_version,
)

# Rule-table vintage stamped onto every canonical_bs emission. Imported
# from the rules module (the single owner of the constant); the fallback
# only fires under standalone file-loading where the relative import is
# unavailable — it MUST carry the same value.
try:
    from .chart_of_accounts import MAPPING_VERSION
except ImportError:  # standalone module loading (scripts) only
    MAPPING_VERSION = "ro_omfp1802_v2"


# ────────────────────────────────────────────────────────────────────────
# RAS account prefix → canonical bucket name mapping.
#
# More specific prefixes win (longest-match-first) — the same
# longest-prefix resolution the classification pack uses (and the
# pre-cutover _RULES_SORTED used) — but we apply it post-hoc to the
# already-routed line_items rather than re-doing the engine's mapping.
#
# Why post-hoc: line_items already contain the engine's signed amounts
# + ro_account_code + ro_account_name + bucket (the legacy bucket name).
# We use the ro_account_code to decide the canonical bucket; the legacy
# bucket name + bucket_override hints (side-flip) are read to detect
# special routing cases where the canonical bucket differs from what a
# naive prefix lookup would yield.
# ────────────────────────────────────────────────────────────────────────

_RAS_TO_CANONICAL: List[tuple] = [
    # ─── Class 1 — Capital, reserves, LT liabilities ───
    ("1012",  "share_capital"),
    ("101",   "share_capital"),
    ("104",   "share_premium"),
    ("105",   "revaluation_reserves"),
    ("1061",  "legal_reserves"),
    ("1068",  "other_reserves"),
    ("106",   "other_reserves"),
    ("1171",  "retained_earnings_prior_years"),     # C-net component
    ("1174",  "accumulated_losses_prior_years"),    # D-net component (error corrections)
    ("117",   "retained_earnings_prior_years"),     # catchall — sign decides
    ("121",   "current_year_profit"),               # sign decides at write
    ("129",   "profit_distribution_provision"),
    ("151",   "provisions_lt"),                     # LT >12m portion
    ("1621",  "lt_debt_bank"),
    ("1622",  "lt_debt_bank"),
    ("1623",  "lt_debt_bank"),
    ("1625",  "lt_debt_bank"),
    ("162",   "lt_debt_bank"),
    ("161",   "lt_debt_other"),               # bonds
    ("164",   "lt_debt_other"),               # non-standard LT-loan analytic
    ("165",   "lt_debt_other"),               # non-standard LT-loan analytic
    ("166",   "lt_debt_other"),
    ("167",   "lt_debt_other"),
    ("168",   "lt_debt_bank"),
    ("169",   "lt_debt_other"),               # contra-debt: signed sum is negative, nets vs 161
    # Closing-identity gap fixes: the legacy table routes 13x (F3.8
    # subsidy catchall) and 14x (equity-instrument gains/losses) but the
    # canonical map previously had NO rule for either — those balances
    # reached line_items yet dropped out of every canonical total, a
    # silent one-sided leak (assets ≠ E+L by exactly the dropped value).
    ("13",    "government_grants_deferred"),  # Subvenții pt. investiții (13x family)
    ("14",    "other_reserves"),              # Câștiguri/pierderi instrumente capital
    # ─── Class 2 — Fixed assets ───
    ("201",   "intangibles_other"),
    ("203",   "intangibles_other"),
    ("205",   "intangibles_other"),
    ("207",   "intangibles_goodwill"),
    ("208",   "intangibles_other"),
    ("211",   "ppe_land"),
    ("212",   "ppe_buildings"),
    ("2131",  "ppe_machinery_equipment"),
    ("2132",  "ppe_machinery_equipment"),
    ("2133",  "ppe_machinery_equipment"),
    ("213",   "ppe_machinery_equipment"),
    ("214",   "ppe_furniture_office"),
    ("215",   "investment_property"),
    ("22",    "ppe_buildings"),                     # concession property → buildings family
    ("231",   "ppe_under_construction"),
    ("232",   "ppe_under_construction"),
    ("23",    "ppe_under_construction"),
    ("261",   "financial_investments_affiliates"),
    ("263",   "financial_investments_affiliates"),
    ("265",   "financial_investments_other"),
    ("2671",  "other_non_current_assets"),
    ("2678",  "other_non_current_assets"),
    ("267",   "other_non_current_assets"),
    ("269",   "financial_investments_other"),  # contra: signed sum negative, nets vs 26x per OMFP bilanț
    ("26",    "financial_investments_other"),
    ("2801",  "accumulated_amortization_intangibles"),
    ("2803",  "accumulated_amortization_intangibles"),
    ("2805",  "accumulated_amortization_intangibles"),
    ("2808",  "accumulated_amortization_intangibles"),
    ("280",   "accumulated_amortization_intangibles"),
    ("2811",  "accumulated_depreciation_ppe"),
    ("2812",  "accumulated_depreciation_ppe"),
    ("2813",  "accumulated_depreciation_ppe"),
    ("2814",  "accumulated_depreciation_ppe"),
    ("2815",  "accumulated_depreciation_ppe"),
    ("281",   "accumulated_depreciation_ppe"),
    ("29",    "accumulated_impairment_ppe"),
    # ─── Class 3 — Inventory ───
    ("301",   "inventory_raw_materials"),
    ("302",   "inventory_consumables"),
    ("303",   "inventory_consumables"),
    ("331",   "inventory_wip"),
    ("341",   "inventory_wip"),
    ("345",   "inventory_finished_goods"),
    ("351",   "inventory_at_third_parties"),
    ("357",   "inventory_at_third_parties"),
    ("371",   "inventory_merchandise_resale"),
    ("381",   "inventory_packaging"),
    ("391",   "inventory_provisions"),
    ("392",   "inventory_provisions"),
    ("393",   "inventory_provisions"),
    ("394",   "inventory_provisions"),
    ("395",   "inventory_provisions"),
    ("396",   "inventory_provisions"),
    ("397",   "inventory_provisions"),
    ("398",   "inventory_provisions"),
    ("39",    "inventory_provisions"),
    ("3",     "inventory_raw_materials"),           # catchall: default to raw_materials
    # ─── Class 4 — Receivables / Payables ───
    ("401",   "ap_trade"),
    ("403",   "ap_trade"),
    ("404",   "ap_trade"),
    ("405",   "ap_trade"),
    ("408",   "accrued_expenses"),
    ("4091",  "ar_supplier_advances"),
    ("4092",  "ar_supplier_advances"),
    ("4093",  "ppe_advances"),
    ("409",   "ar_supplier_advances"),
    ("4111",  "ar_trade_gross"),
    ("4118",  "ar_doubtful_gross"),
    ("411",   "ar_trade_gross"),
    ("413",   "ar_trade_gross"),
    ("418",   "ar_trade_gross"),                    # customer accruals (D-side); side-flip handles C
    ("419",   "customer_advances"),
    ("421",   "ap_personnel_salaries"),
    ("423",   "ap_personnel_salaries"),
    ("4281",  "ap_personnel_other"),
    ("4282",  "ar_personnel"),                      # employee advances are AR-side
    ("4283",  "ap_personnel_other"),
    ("425",   "ar_personnel"),                      # salary advances
    ("426",   "ap_personnel_other"),
    ("427",   "ap_personnel_other"),
    ("4315",  "ap_personnel_social"),
    ("4316",  "ap_personnel_social"),
    ("431",   "ap_personnel_social"),
    ("436",   "ap_personnel_social"),
    ("4382",  "ar_personnel"),                      # social receivable
    ("438",   "ap_personnel_social"),
    ("43",    "ap_personnel_social"),
    ("4411",  "ap_tax"),
    ("441",   "ap_tax"),
    ("4424",  "ar_tax_recoverable"),
    ("4426",  "ar_tax_recoverable"),
    ("4428",  "ap_tax"),                      # C-natural; D-side flips via legacy-bucket side detection
    ("442",   "ap_tax"),
    ("444",   "ap_tax"),
    ("445",   "ap_tax"),
    ("446",   "ap_tax"),
    ("447",   "ap_tax"),
    ("4482",  "ar_tax_recoverable"),
    ("448",   "ap_tax"),
    ("44",    "ap_tax"),
    ("451",   "ar_intercompany"),                   # D-side; C-side hits ap_intercompany via override
    ("452",   "ar_intercompany"),
    ("455",   "ar_intercompany"),
    ("456",   "share_capital"),                     # shareholder settlement → contributed capital
    ("457",   "ap_dividends"),
    ("461",   "ar_intercompany"),                   # debtors with intercompany nature
    ("462",   "ap_other"),
    ("471",   "prepaid_expenses_st"),
    ("472",   "deferred_revenue_st"),
    ("473",   "ar_other"),                          # settlement clearings
    ("475",   "government_grants_deferred"),
    ("478",   "government_grants_deferred"),
    ("481",   "ar_other"),
    ("491",   "ar_provisions"),
    ("495",   "ar_provisions"),
    ("496",   "ar_provisions"),
    ("49",    "ar_provisions"),               # complete 49x contra-AR family (mirrors legacy "49" rule)
    # ─── Class 5 — Cash ───
    ("509",   "st_debt_other"),
    ("5121",  "cash_operating"),
    ("5124",  "cash_fx"),
    ("5125",  "cash_operating"),
    ("5191",  "st_debt_bank"),
    ("5192",  "st_debt_bank"),
    ("519",   "st_debt_bank"),
    ("5311",  "cash_operating"),
    ("5314",  "cash_fx"),
    ("531",   "cash_operating"),
    ("532",   "ar_other"),                          # meal vouchers etc. — quasi-cash but non-liquid
    ("54",    "cash_operating"),                    # acreditive
    ("51",    "cash_operating"),                    # catchall
    ("50",    "short_term_investments"),
    ("581",   None),                                # transit — never in totals
    ("59",    "ar_provisions"),                     # cash adjustments — contra
    # ─── Class 6 — Expenses ───
    # Legacy F3.8 "60" catchall counterpart (606/608-variants without a
    # longer rule) — absent here before the closing-identity pass, which
    # left such line_items canonically unrouted.
    ("60",    "materials_non_inventory"),
    ("601",   "cogs_raw_materials"),
    ("602",   "cogs_auxiliary_consumables"),
    ("603",   "materials_non_inventory"),
    ("604",   "materials_non_inventory"),
    ("605",   "energy_utilities"),
    ("6024",  "cogs_auxiliary_consumables"),
    ("6051",  "energy_utilities"),
    ("607",   "cogs_merchandise"),
    ("608",   "cogs_packaging"),
    ("609",   "discounts_received_supplier"),
    ("611",   "maintenance_repairs"),
    ("6123",  "rent_operating_lease"),
    ("612",   "rent_operating_lease"),
    ("613",   "insurance"),
    ("615",   "third_party_services"),              # training
    ("618",   "third_party_services"),              # misc services
    ("61",    "third_party_services"),
    ("622",   "third_party_services"),
    ("623",   "travel_protocol"),
    ("624",   "transport_logistics"),
    ("625",   "travel_protocol"),
    ("626",   "third_party_services"),
    ("627",   "third_party_services"),
    ("628",   "third_party_services"),
    ("62",    "third_party_services"),
    ("635",   "other_operating_taxes"),
    ("63",    "other_operating_taxes"),
    ("641",   "personnel_wages"),
    ("642",   "personnel_benefits"),
    ("645",   "personnel_social_security"),
    ("6458",  "personnel_social_security"),
    ("6461",  "personnel_other_contributions"),
    ("646",   "personnel_other_contributions"),
    ("64",    "personnel_wages"),
    ("65",    "other_operating_expenses"),
    ("6651",  "fx_loss_realized"),
    ("665",   "fx_loss_realized"),
    ("666",   "interest_expense"),
    ("667",   "discount_charges"),
    ("668",   "other_financial_expense"),
    ("66",    "other_financial_expense"),
    ("67",    "other_operating_expenses"),
    ("6811",  "depreciation_ppe"),
    ("6812",  "provision_charges"),
    ("6813",  "impairment_ppe_intangibles"),
    ("6814",  "impairment_receivables"),
    ("68",    "depreciation_ppe"),
    ("691",   "income_tax_current"),
    ("6912",  "income_tax_deferred"),
    ("69",    "income_tax_current"),
    # ─── Class 7 — Revenue ───
    ("701",   "revenue_products"),
    ("702",   "revenue_semi_finished"),
    ("703",   "revenue_residual_products"),
    ("704",   "revenue_services"),
    ("705",   "revenue_services"),
    ("706",   "revenue_rental_royalty"),
    ("707",   "revenue_merchandise_resale"),
    ("708",   "revenue_other_operating"),
    ("709",   "revenue_commercial_reductions"),
    ("70",    "revenue_other_operating"),
    ("711",   "inventory_variation_memo"),
    ("712",   "inventory_variation_memo"),
    ("71",    "inventory_variation_memo"),
    ("721",   "capitalized_own_work_memo"),
    ("722",   "capitalized_own_work_memo"),
    ("725",   "capitalized_own_work_memo"),
    ("72",    "capitalized_own_work_memo"),
    ("740",   "government_grants_recognized"),
    ("74",    "government_grants_recognized"),
    ("758",   "other_operating_income_recurring"),
    ("75",    "other_operating_income_recurring"),
    ("7611",  "dividend_income_affiliates"),
    ("7612",  "dividend_income_affiliates"),
    ("762",   "dividend_income_other"),
    ("763",   "dividend_income_other"),
    ("7651",  "fx_gain_realized"),
    ("765",   "fx_gain_realized"),
    ("766",   "interest_income"),
    ("767",   "discounts_received_financial"),
    ("768",   "other_financial_income"),
    ("76",    "other_financial_income"),
    ("77",    "other_operating_income_one_off"),
    ("781",   "provision_reversals"),
    ("78",    "provision_reversals"),
]

# Sorted longest-prefix-first for resolution speed + correctness.
_RAS_TO_CANONICAL_SORTED = sorted(_RAS_TO_CANONICAL, key=lambda p: -len(p[0]))


def _canonical_bucket_for_ras(code: str, name_hint: str = "") -> Optional[str]:
    """Resolve a RAS account code to its canonical bucket name.

    Returns None for codes that intentionally drop out of canonical
    totals (581 transit). For codes that don't match any rule, returns
    None and the caller routes to `_unmapped_to_canonical`.
    """
    code = (code or "").strip()
    if not code:
        return None
    for prefix, canonical in _RAS_TO_CANONICAL_SORTED:
        if code.startswith(prefix):
            return canonical
    return None


def _sign_aware_canonical(
    code: str,
    canonical_name: Optional[str],
    signed_amount: float,
) -> Optional[str]:
    """F4.1b-cont fix #2 — dual-direction RAS account families need
    sign-aware routing to the right canonical bucket.

    The legacy engine collapses both directions into a single bucket
    (retainedEarnings) and stores the signed sum. The canonical schema
    SPLITS by economic direction (retained_earnings_prior_years vs
    accumulated_losses_prior_years; current_year_profit vs
    current_year_loss) so that every bucket carries a single
    sign_meaning. The router has to use the signed_amount to decide.

    Carniprod 117 family triggered this: 117.1 (-11M loss) + 117.4
    (-7.8M loss) + 1175 (+4M profit) all routed to retained_earnings_
    prior_years under the naive prefix-only map; magnitude-as-abs then
    summed 22.9M into equity instead of -14.9M signed.
    """
    if not canonical_name:
        return canonical_name
    # 117 family: positive → retained, negative → losses
    if code.startswith("117") and canonical_name == "retained_earnings_prior_years":
        if signed_amount < 0:
            return "accumulated_losses_prior_years"
    # 121 family: positive → profit, negative → loss
    # (only fires if 121 ever appears in line_items — usually it's in
    # ignored_items and gets injected via current_year_pnl kwarg)
    if code.startswith("121") and canonical_name == "current_year_profit":
        if signed_amount < 0:
            return "current_year_loss"
    return canonical_name


def _side_flip_canonical(
    line_item: Dict[str, Any],
    canonical_name: Optional[str],
) -> Optional[str]:
    """F4.1b-cont fix #3 — detect side-flip by reading the legacy
    line_item.bucket directly (not the consumed-and-discarded
    `bucket_override`). When the engine routed a credit-positive
    balance from a normally-asset-side RAS prefix (e.g. 455 receivable
    from affiliate is actually a payable TO affiliate because the
    closing balance is credit), the line_item.bucket name reveals it.

    Handles every SIDE_FLIP_TO_LIAB_PREFIXES family from the parser
    (418, 451, 452, 455, 461, 467, 425, 1687) AND the prefix-stable
    flips inside the engine (e.g. 162x LT debt routed to short-term
    when interest period expires).

    Legacy bucket strings that indicate a liability (canonical should
    flip to liability):
      otherCurrentLiab, otherCurrentLiabilities, accountsPayable, ap,
      shortTermDebt, longTermDebt, ap_dividends, otherNonCurrentLiab.
    """
    if not canonical_name:
        return canonical_name
    legacy_bucket = (line_item.get("bucket") or line_item.get("canonical_bucket") or "").strip()
    liab_legacy_buckets = {
        "otherCurrentLiab", "otherCurrentLiabilities",
        "otherNonCurrentLiab", "otherNonCurrentLiabilities",
        "accountsPayable", "ap", "ap_dividends",
        "shortTermDebt", "stDebt", "st_debt",
        "longTermDebt", "ltDebt", "lt_debt",
    }
    if legacy_bucket in liab_legacy_buckets:
        # Map AR-side canonical → AP-side canonical (or LT-debt where applicable).
        flip_map = {
            "ar_trade_gross":         "ap_other",
            "ar_doubtful_gross":      "ap_other",
            "ar_intercompany":        "ap_intercompany",
            "ar_personnel":           "ap_personnel_other",
            "ar_supplier_advances":   "customer_advances",
            "ar_tax_recoverable":     "ap_tax",
            "ar_other":               "ap_other",
            # PPE accounts can side-flip when the line_item indicates a liab
            # (rare; happens with 232 advances when net direction inverts).
            "ppe_advances":           "ap_other",
            # Cash side-flips to ST debt for 519x analytical sub-codes
            # already handled by the prefix map; this is the safety net —
            # and the live path for 512x overdrafts, which the legacy layer
            # re-routes to stDebt via BIFUNCTIONAL_WRONG_SIDE_FLIPS.
            "cash_operating":         "st_debt_bank",
            "cash_fx":                "st_debt_bank",
        }
        return flip_map.get(canonical_name, canonical_name)
    # Opposite direction (canonical_bs v2): the legacy layer routed a
    # C-natural bifunctional account (401 debit, 419 debit, 462 debit,
    # 4428 debit…) to an ASSET bucket via BIFUNCTIONAL_WRONG_SIDE_FLIPS,
    # but the naive prefix lookup above still says liability. Follow the
    # legacy side so the canonical row sits on the same side of the BS.
    asset_legacy_buckets = {
        "cash", "cash_fx", "ar", "ar_doubtful", "ar_intercompany",
        "inventory", "otherCurrentAssets", "ppe", "ppe_investment",
        "ppe_under_construction", "ppe_advances", "intangibles",
        "otherNonCurrentAssets", "accountsReceivable",
    }
    if legacy_bucket in asset_legacy_buckets:
        flip_map_to_asset = {
            "ap_trade":          "ar_supplier_advances",  # 401 debit = advance to supplier
            "ap_other":          "ar_other",              # 462 debit = sundry receivable
            "ap_tax":            "ar_tax_recoverable",    # 4428/442x debit = deferred input VAT
            "customer_advances": "ar_other",              # 419 debit = refund due from customer
            "ap_intercompany":   "ar_intercompany",
            "ap_personnel_other": "ar_personnel",
        }
        return flip_map_to_asset.get(canonical_name, canonical_name)
    return canonical_name


def _route_line_item(li: Dict[str, Any]):
    """Single source of truth for line_item → canonical-leaf routing.

    Returns `(code, name, signed_amount, canonical_name)` or None when the
    row carries no code / zero amount. `canonical_name` is None for 581
    transit and unmapped codes — the caller decides how to surface those.
    Used by BOTH `assemble_canonical` (leaf sums) and
    `build_canonical_bs_v2` (per-row leaf_ids traceability) so the two can
    never route the same account differently.
    """
    code = str(li.get("ro_account_code") or "").strip()
    name = str(li.get("ro_account_name") or "").strip()
    signed_amount = float(li.get("amount") or 0)
    if not code or signed_amount == 0:
        return None
    canonical_name = _canonical_bucket_for_ras(code, name)
    canonical_name = _sign_aware_canonical(code, canonical_name, signed_amount)
    canonical_name = _side_flip_canonical(li, canonical_name)
    return code, name, signed_amount, canonical_name


def _sign_adjusted_magnitude(
    canonical_name: str,
    signed_amount: float,
) -> float:
    """Convert the engine's signed amount into the always-positive
    canonical magnitude. The sign_meaning metadata in the canonical
    schema tells consumers how to compose totals.

    Rules:
      · asset_positive / liability_positive / equity_positive / revenue_positive
        / expense_positive: magnitude = max(signed_amount, 0). If the
        engine emitted a negative for one of these (rare; defensive-flip
        leftover), the magnitude is the absolute value but should also
        trigger a warning.
      · asset_negative / equity_negative / revenue_negative / expense_negative:
        magnitude = abs(signed_amount). The bucket carries a contra-
        relationship; consumer subtracts.
      · signed (memo lines, CFO deltas): magnitude = abs(signed_amount);
        a separate sign field travels with the bucket (handled by the
        caller when packaging the canonical envelope).
    """
    bucket = bucket_by_name(canonical_name)
    if bucket is None:
        return abs(signed_amount)
    return abs(signed_amount)


def assemble_canonical(
    line_items: List[Dict[str, Any]],
    *,
    source_data_quality: Optional[Dict[str, Any]] = None,
    current_year_pnl: float = 0.0,
    profit_distribution_129: float = 0.0,
) -> Dict[str, Any]:
    """Adapter entry point. Takes the engine's existing line_items and
    produces the canonical v1 envelope.

    `current_year_pnl` (F4.1b-cont fix #1): account 121 closing balance
    (the statutory net profit anchor — positive for profit, negative
    for loss). The engine routes 121 to `ignore_control` so it's
    NOT in line_items; the caller MUST pass it explicitly. Otherwise
    the canonical retained_earnings aggregate is understated by the
    current year's result. Read from `assembled_bs.current_year_pnl`
    at the call site.

    `profit_distribution_129` (F4.1b-cont fix #1b): account 129
    closing D balance (allocated profit, e.g. legal reserve transfer).
    Also excluded from line_items via ignore_control. Routes to
    `profit_distribution_provision` canonical bucket which is contra
    to current_year_profit.

    Returned shape::

        {
            "schema_version": "canonical_v1.0.0",
            "leaves": {
                "<canonical_name>": {
                    "magnitude": float,           # always non-negative
                    "sign_meaning": str,           # from canonical schema
                    "ras_line_items_count": int,   # provenance: # of source rows
                    "ras_line_items_sum_signed": float,  # original signed sum
                },
                ...
            },
            "aggregates": {
                "<parent_aggregate>": {
                    "net": float,                  # signed sum after applying contras
                    "leaves": [...]                # canonical_names that compose this
                },
                ...
            },
            "unmapped": [
                {"code": "...", "name": "...", "amount": float, "reason": "..."},
                ...
            ],
            "source_data_quality": {...} | null,
            "round_trip_check": {
                "passed": bool,
                "tolerance_pct": float,
                "max_deviation_pct": float,
            }
        }

    The legacy `assembled_bs / assembled_pl / assembled_cf` views on the
    engine response are NOT touched — this adapter ADDS the canonical
    envelope alongside them per the F3.15 parallel-migration discipline.
    """
    leaves: Dict[str, Dict[str, Any]] = {}
    unmapped: List[Dict[str, Any]] = []

    for li in line_items:
        routed = _route_line_item(li)
        if routed is None:
            continue
        code, name, signed_amount, canonical_name = routed

        if canonical_name is None:
            # Intentionally-dropped account (581 transit) or unmapped novel.
            # We only surface as "unmapped" if a rule didn't intentionally
            # drop it; the 581 case is silent.
            if code.startswith("581"):
                continue
            unmapped.append({
                "code": code,
                "name": name,
                "amount": signed_amount,
                "reason": "no_canonical_mapping",
            })
            continue

        bucket = bucket_by_name(canonical_name)
        if bucket is None:
            unmapped.append({
                "code": code,
                "name": name,
                "amount": signed_amount,
                "reason": f"canonical_bucket_not_in_schema: {canonical_name}",
            })
            continue

        magnitude = _sign_adjusted_magnitude(canonical_name, signed_amount)
        # F3.15 decision 3b: canonical leaves carry ALWAYS-POSITIVE
        # magnitudes (the sign_meaning metadata says how to compose). A
        # negative magnitude would corrupt every consumer's composition.
        assert magnitude >= 0, (
            "A-033: canonical leaf magnitude must be non-negative, got %r "
            "for %s (account %s) — magnitudes are always positive; "
            "direction lives in sign_meaning" % (magnitude, canonical_name, code)
        )
        entry = leaves.setdefault(canonical_name, {
            "magnitude": 0.0,
            "sign_meaning": bucket.sign_meaning.value,
            "ras_line_items_count": 0,
            "ras_line_items_sum_signed": 0.0,
        })
        entry["magnitude"] = round(entry["magnitude"] + magnitude, 2)
        entry["ras_line_items_count"] += 1
        entry["ras_line_items_sum_signed"] = round(
            entry["ras_line_items_sum_signed"] + signed_amount, 2
        )

    # F4.1b-cont fix #1 — inject current_year_pnl (account 121) and
    # profit_distribution_129 (account 129) into the equity leaves.
    # These are excluded from line_items because the engine routes
    # them to `ignore_control`. Sign decides which canonical bucket.
    if current_year_pnl > 0:
        bucket = bucket_by_name("current_year_profit")
        leaves["current_year_profit"] = {
            "magnitude": round(current_year_pnl, 2),
            "sign_meaning": bucket.sign_meaning.value,
            "ras_line_items_count": 1,
            "ras_line_items_sum_signed": round(current_year_pnl, 2),
        }
    elif current_year_pnl < 0:
        bucket = bucket_by_name("current_year_loss")
        leaves["current_year_loss"] = {
            "magnitude": round(abs(current_year_pnl), 2),
            "sign_meaning": bucket.sign_meaning.value,
            "ras_line_items_count": 1,
            "ras_line_items_sum_signed": round(current_year_pnl, 2),
        }
    if profit_distribution_129 != 0:
        bucket = bucket_by_name("profit_distribution_provision")
        leaves["profit_distribution_provision"] = {
            "magnitude": round(abs(profit_distribution_129), 2),
            "sign_meaning": bucket.sign_meaning.value,
            "ras_line_items_count": 1,
            "ras_line_items_sum_signed": round(profit_distribution_129, 2),
        }

    # Compute parent_aggregates as signed-net values applying contras.
    #
    # F4.1b-cont fix #4 — use `ras_line_items_sum_signed` (the engine's
    # signed math) instead of `magnitude` (abs). The engine handles
    # contras within otherwise-positive buckets correctly via signing
    # (e.g. 348/378 price differentials emit negative when credit-
    # balance to reduce inventory; 129 emits negative to reduce retained
    # earnings; etc.). Using abs() lost the sign and double-counted
    # those contras into the wrong direction — Retail asset 3.51% over
    # was specifically account 348 negative-balance counted positive.
    aggregates: Dict[str, Dict[str, Any]] = {}
    for agg_name, leaf_names in {**__import__("engine.canonical", fromlist=["PARENT_AGGREGATES_BS"]).PARENT_AGGREGATES_BS,
                                  **__import__("engine.canonical", fromlist=["PARENT_AGGREGATES_PL"]).PARENT_AGGREGATES_PL}.items():
        net = 0.0
        leaves_in_agg = []
        for leaf_name in leaf_names:
            if leaf_name not in leaves:
                continue
            leaves_in_agg.append(leaf_name)
            sm = leaves[leaf_name]["sign_meaning"]
            signed_sum = leaves[leaf_name]["ras_line_items_sum_signed"]
            # Explicit contra buckets carry already-negative engine signed
            # sums (their MappingRule has sign=-1), so adding signed_sum
            # gives the correct subtraction in the aggregate. Buckets
            # the canonical adapter computed via abs() (current_year_profit
            # via current_year_pnl kwarg, etc.) carry positive signed_sum
            # and add normally. The catch: for *_negative sign_meaning
            # buckets where signed_sum is NEGATIVE (the normal case),
            # adding directly works; the rare positive signed_sum on a
            # negative bucket would also add — which is what we want
            # (it represents an unusual partial-reversal).
            if sm in (
                SignMeaning.ASSET_NEGATIVE.value,
                SignMeaning.EQUITY_NEGATIVE.value,
                SignMeaning.REVENUE_NEGATIVE.value,
                SignMeaning.EXPENSE_NEGATIVE.value,
            ):
                # Engine emits these with sign=-1, so signed_sum is
                # already negative; magnitude-as-abs is positive. We
                # want the bucket to REDUCE the aggregate by its
                # absolute value — equivalent to adding the negative
                # signed_sum.
                net += signed_sum  # already negative from engine
            else:
                # Positive-sign bucket: use signed_sum to preserve any
                # contra contributions within (e.g. 348 raw mat price
                # differential credit-balance lowers inventory_raw_mat).
                net += signed_sum
        if leaves_in_agg:
            aggregates[agg_name] = {
                "net": round(net, 2),
                "leaves": leaves_in_agg,
            }

    result: Dict[str, Any] = {
        "schema_version": schema_version(),
        "leaves": leaves,
        "aggregates": aggregates,
        "unmapped": unmapped,
    }
    # Real round-trip check (was a hardcoded {passed: True} placeholder —
    # any consumer trusting it was reading a constant, not a measurement).
    # At this point the envelope has no methodology block yet, so the
    # check runs on the aggregates basis; `assemble_statements` refreshes
    # it after methodology evaluation to compare against methodology.totals.
    result["round_trip_check"] = compute_round_trip_check(result)
    if source_data_quality is not None:
        result["source_data_quality"] = source_data_quality
    return result


# ────────────────────────────────────────────────────────────────────────
# canonical_bs v2 — the single presentation-ready Balance Sheet authority
# (docs/CANONICAL_BS_V2_CONTRACT.md). Everything below is deterministic:
# every iteration that reaches the output is either over a fixed
# declaration-order list or explicitly sorted.
# ────────────────────────────────────────────────────────────────────────

_BS_SIGN_MEANINGS = {
    SignMeaning.ASSET_POSITIVE.value, SignMeaning.ASSET_NEGATIVE.value,
    SignMeaning.LIABILITY_POSITIVE.value,
    SignMeaning.EQUITY_POSITIVE.value, SignMeaning.EQUITY_NEGATIVE.value,
}


def _recompute_side_totals(leaves: Dict[str, Any]) -> Dict[str, float]:
    """Recompute assets / equity / liabilities straight from the leaves'
    engine-signed sums (contra leaves carry negative sums, so plain
    addition applies the contra math). Iteration sorted for determinism."""
    totals = {"assets": 0.0, "equity": 0.0, "liabilities": 0.0}
    for name in sorted(leaves):
        bucket = bucket_by_name(name)
        if bucket is None:
            continue
        signed = float((leaves[name] or {}).get("ras_line_items_sum_signed") or 0)
        if bucket.bucket_type == BucketType.ASSET:
            totals["assets"] += signed
        elif bucket.bucket_type == BucketType.LIABILITY:
            totals["liabilities"] += signed
        elif bucket.bucket_type == BucketType.EQUITY:
            totals["equity"] += signed
    return {k: round(v, 2) for k, v in sorted(totals.items())}


def compute_round_trip_check(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """REAL round-trip check: recompute leaves → aggregates → totals and
    compare against what the envelope carries.

    Two bases, picked by what's available:
      · `methodology_totals` — envelope.methodology.totals present (the
        Fix-A1 authority): recomputed side totals must match its
        total_assets / total_equity / total_liabilities within 0.5%.
      · `aggregates_only` — no methodology yet (PyYAML missing, or the
        first pass inside `assemble_canonical`): recomputed aggregate
        nets must match the stored `aggregates` block.

    `max_deviation_pct` is in PERCENT units (0.5 == 0.5%), matching
    `tolerance_pct`. Deterministic: comparisons iterate in sorted order.
    """
    leaves = envelope.get("leaves") or {}
    stored_aggregates = envelope.get("aggregates") or {}
    max_dev_pct = 0.0
    worst = ""

    def _observe(key: str, reference: float, recomputed: float) -> None:
        nonlocal max_dev_pct, worst
        dev_pct = abs(recomputed - reference) / max(abs(reference), 1.0) * 100.0
        if dev_pct > max_dev_pct:
            max_dev_pct = dev_pct
            worst = key

    # Aggregates: recompute each net from the leaves' signed sums (the
    # same math `assemble_canonical` uses) and compare to the stored net.
    for agg_name in sorted(stored_aggregates):
        leaf_names = leaves_for_aggregate(agg_name)
        if not leaf_names:
            continue
        recomputed = 0.0
        for leaf_name in leaf_names:
            if leaf_name in leaves:
                recomputed += float((leaves[leaf_name] or {}).get("ras_line_items_sum_signed") or 0)
        stored = float((stored_aggregates.get(agg_name) or {}).get("net") or 0)
        _observe(f"aggregate:{agg_name}", stored, round(recomputed, 2))

    # Totals: compare recomputed side totals against methodology.totals
    # when the methodology block landed (it's attached after
    # assemble_canonical returns, so only the assemble_statements refresh
    # sees it).
    methodology_totals = ((envelope.get("methodology") or {}).get("totals") or {})
    basis = "aggregates_only"
    if isinstance(methodology_totals, dict) and methodology_totals:
        recomputed_sides = _recompute_side_totals(leaves)
        side_by_key = {
            "total_assets": "assets",
            "total_equity": "equity",
            "total_liabilities": "liabilities",
        }
        compared_any = False
        for key in sorted(side_by_key):
            if key in methodology_totals and methodology_totals[key] is not None:
                _observe(
                    f"totals:{key}",
                    float(methodology_totals[key]),
                    recomputed_sides[side_by_key[key]],
                )
                compared_any = True
        if compared_any:
            basis = "methodology_totals"

    return {
        "passed": max_dev_pct <= 0.5,
        "tolerance_pct": 0.5,
        "max_deviation_pct": round(max_dev_pct, 6),
        "basis": basis,
        "worst": worst,
    }


# OMFP 1802 bilanț sections ← canonical parent aggregates. Leaf-level
# overrides split aggregates that OMFP presents across two sections.
_AGGREGATE_TO_SECTION: Dict[str, str] = {
    "cash_and_equivalents":        "current_assets",
    "trade_receivables_net":       "current_assets",
    "other_receivables":           "current_assets",
    "inventory_net":               "current_assets",
    "prepaid_expenses_and_other":  "prepaid_expenses",
    "ppe_net":                     "non_current_assets",
    "investment_property":         "non_current_assets",
    "right_of_use_assets":         "non_current_assets",
    "intangibles_net":             "non_current_assets",
    "financial_investments":       "non_current_assets",
    "deferred_tax_assets":         "non_current_assets",
    "other_non_current_assets":    "non_current_assets",
    "trade_payables":              "current_liabilities",
    "tax_payables":                "current_liabilities",
    "personnel_payables":          "current_liabilities",
    "other_payables_st":           "current_liabilities",
    "financial_liabilities_st":    "current_liabilities",
    "deferred_revenue_st":         "current_liabilities",
    "provisions_st":               "provisions",
    "provisions_lt":               "provisions",
    "financial_liabilities_lt":    "non_current_liabilities",
    "deferred_tax_liabilities":    "non_current_liabilities",
    "pension_liabilities":         "non_current_liabilities",
    "deferred_income_lt":          "deferred_income",
    "other_non_current_liabilities": "non_current_liabilities",
    "contributed_capital":         "equity",
    "reserves":                    "equity",
    "retained_earnings":           "equity",
    "treasury_shares":             "equity",
    "accumulated_oci":             "equity",
    "non_controlling_interest":    "equity",
    "convertible_debt_equity_component": "equity",
}
_LEAF_SECTION_OVERRIDES: Dict[str, str] = {
    # OMFP bilanț splits the deferred_revenue_st aggregate: 419 customer
    # advances are Datorii (current), 472 deferred revenue is Venituri în
    # avans (its own section, with the LT grants).
    "deferred_revenue_st": "deferred_income",
    "customer_advances":   "current_liabilities",
}

# Fixed presentation order — the contract's section order.
_BS_V2_SECTION_ORDER: List[str] = [
    "non_current_assets", "current_assets", "prepaid_expenses",
    "equity", "provisions", "non_current_liabilities",
    "current_liabilities", "deferred_income",
]
_BS_V2_ASSET_SECTIONS = {"non_current_assets", "current_assets", "prepaid_expenses"}
_BS_V2_EQUITY_SECTIONS = {"equity"}
# Everything not asset/equity is a liability-side section (provisions,
# non_current_liabilities, current_liabilities, deferred_income).

# BS_BUCKETS declaration order — the deterministic within-section row order.
_BS_LEAF_ORDER: Dict[str, int] = {
    b.canonical_name: i for i, b in enumerate(BS_BUCKETS)
}

# ── Closing-identity machinery (CLOSING-IDENTITY MODE) ──────────────────
# The identity partition runs in INTEGER CENTS end to end: every
# value-bearing account contributes its signed closing balance to exactly
# one side of the statement, so for a source whose SF pair balances
# (D == C after netting off-balance class 8), assets − (equity +
# liabilities) == ΣSF_D − ΣSF_C == 0 EXACTLY — by construction, never by
# tolerance. Floats appear only at serialization (cents / 100.0).


def _cents(value: Any) -> int:
    """Parse a 2-decimal currency value into exact integer cents."""
    try:
        return int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        return 0


# Kwarg-injected equity leaves replaced by the closing-column result line.
_RESULT_LEAF_NAMES = {"current_year_profit", "current_year_loss"}

# Legacy bucket names that place a line_item on the ASSET side of the
# legacy BS (mirrors chart_of_accounts._BUCKET_TO_BS_FIELD's asset
# fields). Used ONLY to side-place canonically-unrouted ("stray")
# line_items into the Unclassified rows — their legacy placement is the
# side evidence the canonical router lost.
_LEGACY_ASSET_BUCKETS = {
    "cash", "cash_fx", "ar", "ar_doubtful", "ar_provisions",
    "ar_intercompany", "inventory", "otherCurrentAssets", "ppe",
    "ppe_investment", "ppe_under_construction", "ppe_advances",
    "intangibles", "otherNonCurrentAssets",
}


def _section_for_leaf(leaf_name: str) -> Optional[str]:
    """Map a canonical BS leaf to its OMFP presentation section. Returns
    None for non-BS leaves (PL / memo / CF)."""
    if leaf_name in _LEAF_SECTION_OVERRIDES:
        section = _LEAF_SECTION_OVERRIDES[leaf_name]
        # A section id outside the fixed presentation order would KeyError
        # deep inside the cents accumulation (or worse, silently misplace
        # value); fail here, at the mapping, with the offending entry named.
        assert section in _BS_V2_SECTION_ORDER, (
            "A-030: leaf %r maps to unknown section %r — every "
            "_LEAF_SECTION_OVERRIDES / _AGGREGATE_TO_SECTION value must be "
            "one of _BS_V2_SECTION_ORDER" % (leaf_name, section)
        )
        return section
    bucket = bucket_by_name(leaf_name)
    if bucket is None or bucket.bucket_type not in (
        BucketType.ASSET, BucketType.LIABILITY, BucketType.EQUITY
    ):
        return None
    section = _AGGREGATE_TO_SECTION.get(bucket.parent_aggregate)
    if section is not None:
        assert section in _BS_V2_SECTION_ORDER, (
            "A-030: leaf %r maps to unknown section %r — every "
            "_LEAF_SECTION_OVERRIDES / _AGGREGATE_TO_SECTION value must be "
            "one of _BS_V2_SECTION_ORDER" % (leaf_name, section)
        )
        return section
    # Defensive fallback for a schema aggregate this map doesn't know yet:
    # side-correct placement beats dropping the leaf from presentation.
    if bucket.bucket_type == BucketType.ASSET:
        return "current_assets"
    if bucket.bucket_type == BucketType.EQUITY:
        return "equity"
    return "current_liabilities"


def _matched_ras_prefix(code: str) -> str:
    """The RAS prefix that routed this code, for the row's account_codes
    grouping. Falls back to the code itself for kwarg-injected leaves."""
    for prefix, _canonical in _RAS_TO_CANONICAL_SORTED:
        if code.startswith(prefix):
            return prefix
    return code


def _load_run_bs_diagnosis():
    """Import `run_bs_diagnosis` without depending on the whole
    `engine.confidence` package: its __init__ pulls sibling modules
    (anomalies, quality_envelope) that are absent in some checkouts, and
    a broken package import must not silently disable BS diagnosis.
    Falls back to loading reconciliation_checks.py by file path."""
    try:
        from engine.confidence.reconciliation_checks import run_bs_diagnosis
        return run_bs_diagnosis
    except Exception:  # noqa: BLE001 — package __init__ may be unimportable
        import importlib.util
        import sys as _sys
        path = (
            Path(__file__).resolve().parents[2] / "confidence" / "reconciliation_checks.py"
        )
        mod_name = "_ro_reconciliation_checks_standalone"
        cached = _sys.modules.get(mod_name)
        if cached is not None:
            return cached.run_bs_diagnosis
        spec = importlib.util.spec_from_file_location(mod_name, str(path))
        mod = importlib.util.module_from_spec(spec)
        _sys.modules[mod_name] = mod  # register before exec (dataclasses)
        spec.loader.exec_module(mod)
        return mod.run_bs_diagnosis


def _excluded_reason(code: str, bucket: str) -> str:
    """Contract-facing reason for an excluded account."""
    if code.startswith("891"):
        return "opening_balance_sheet_account"
    if code.startswith("892"):
        return "closing_balance_sheet_account"
    if bucket == "ignore_offbalance" or code.startswith(("8", "9")):
        return "off_balance_memo_account"
    if bucket == "ignore_transit" or code.startswith("581"):
        return "transit_account_581"
    if bucket == "ignore_control" or code.startswith("121"):
        return "profit_control_account_121"
    return "excluded_by_rule"


def build_canonical_bs_v2(
    envelope: Dict[str, Any],
    *,
    line_items: Optional[List[Dict[str, Any]]] = None,
    source_anchor: Optional[Dict[str, Any]] = None,
    unmapped: Optional[List[Dict[str, Any]]] = None,
    excluded: Optional[List[Dict[str, Any]]] = None,
    extraction: Optional[Dict[str, Any]] = None,
    p121_anchor: Optional[float] = None,
    cls7_minus_cls6: Optional[float] = None,
    source_account_census: Optional[int] = None,
) -> Dict[str, Any]:
    """Build the FULL canonical_bs v2 object per
    docs/CANONICAL_BS_V2_CONTRACT.md from the canonical envelope's leaves.

    CLOSING-IDENTITY MODE: the whole statement is a TOTAL PARTITION of
    the source's value-bearing accounts, accumulated in INTEGER CENTS —
    floats only at serialization. Every account contributes its signed
    closing (SF) balance to exactly one side:
      · classified leaves — routed line_items, per OMFP placement;
      · unmapped accounts — explicit `unclassified_debit` /
        `unclassified_credit` rows (IN the totals, still listed in
        `unmapped`, flagged via D9_UNMAPPED_INCLUDED);
      · the current-year result — from the SAME closing column
        (121_SF + ΣSF(cls 7) − ΣSF(cls 6), the parser-attached
        `source_anchor.closing_result` block), falling back to the
        envelope's reconstruction leaf when that source data is absent
        (LLM / PDF paths) — `invariants.result_basis` says which;
      · excluded accounts (class 8 incl. 891/892, 581 transit) stay
        OUT of both the statement and the source-balance judgment.
    Consequence (invariants.identity_holds): a balanced deterministic
    source yields difference == 0.00 EXACTLY, by construction — nonzero
    difference remains possible only for imbalanced sources (D1),
    anchor divergence (D0), llm extraction, or fallback-path results.

    Rows, section subtotals and totals all derive from the SAME cent
    sums, so they sum to each other BY CONSTRUCTION — asserted at
    the end, never plugged. All optional inputs degrade defensively:
      · `line_items` — for leaf_ids / account_codes traceability; absent
        → rows carry empty lists.
      · `source_anchor` — contract shape (pairs / anchor_status /
        source_balanced); absent → NO_ANCHOR block.
      · `unmapped` / `excluded` — account lists for the transparency
        blocks + source_conservation invariant (excluded accepts the
        assembler's `ignored_items` shape).
      · `extraction` — provenance; method=="llm" caps status at
        MINOR_DRIFT per the contract.
      · `p121_anchor` / `cls7_minus_cls6` — the 121 cross-check values;
        emitted into invariants, never auto-corrected here.
      · `source_account_census` — source-file account count for the
        source_conservation invariant; absent → invariant not falsifiable
        (emitted true).
    """
    leaves = envelope.get("leaves") or {}

    # ── Source anchor + extraction (defensive defaults) ────────────────
    # Built FIRST because the closing-identity result line reads the
    # parser-attached `closing_result` block off the anchor.
    anchor_block: Dict[str, Any] = (
        dict(source_anchor) if isinstance(source_anchor, dict) else {
            "totals_row_found": False,
            "pairs": {},
            "anchor_status": "NO_ANCHOR",
            "source_balanced": None,
        }
    )
    extraction_block: Dict[str, Any] = {"method": "deterministic"}
    if isinstance(extraction, dict):
        extraction_block.update(extraction)

    # ── Traceability + identity partition (INTEGER CENTS) ──────────────
    # Re-runs the SAME routing (`_route_line_item`) the envelope used, so
    # a row's leaf_ids always agree with the leaf sums beneath it, and
    # accumulates each BS leaf in exact integer cents — the arithmetic
    # basis of the closing identity. Canonically-unrouted BS line_items
    # ("strays": legacy placed them, the canonical map didn't) are NOT
    # dropped — they land in the Unclassified rows below, side-placed by
    # their legacy bucket, and are surfaced in `unmapped`.
    leaf_codes: Dict[str, set] = {}
    leaf_prefixes: Dict[str, set] = {}
    leaf_cents: Dict[str, int] = {}
    stray_bs_items: List[tuple] = []  # (code, name, debit_signed_cents)
    for li in (line_items or []):
        routed = _route_line_item(li)
        if routed is None:
            continue
        code, li_name, signed, canonical_name = routed
        if canonical_name is None:
            if code.startswith("581"):
                # Nonzero transit closing = real money in transit — route
                # into the partition as a stray (debit-signed) so the
                # identity holds; the parser-exclusion path below does the
                # same for the deterministic route. Zero balances (the
                # normal 581 state) contribute nothing either way.
                if _cents(signed) != 0:
                    stray_bs_items.append((code, li_name, _cents(signed)))
                continue
            if str(li.get("statement") or "") == "BS":
                legacy_bucket = str(
                    li.get("canonical_bucket") or li.get("bucket") or ""
                )
                # Contribution as a DEBIT-signed balance: legacy asset
                # placement carries +signed, E/L placement −signed.
                b_cents = (
                    _cents(signed) if legacy_bucket in _LEGACY_ASSET_BUCKETS
                    else -_cents(signed)
                )
                stray_bs_items.append((code, li_name, b_cents))
            # PL-statement strays carry movement data; the result line is
            # sourced from the SF closing column, so nothing to place.
            continue
        leaf_codes.setdefault(canonical_name, set()).add(code)
        leaf_prefixes.setdefault(canonical_name, set()).add(_matched_ras_prefix(code))
        bucket = bucket_by_name(canonical_name)
        if bucket is not None and bucket.bucket_type in (
            BucketType.ASSET, BucketType.LIABILITY, BucketType.EQUITY
        ):
            leaf_cents[canonical_name] = leaf_cents.get(canonical_name, 0) + _cents(signed)

    # ── Unmapped accounts — IN the totals AND loudly visible ───────────
    # Contract 1(a): excluding unmapped balances broke the identity — a
    # balanced source minus a dropped account is an imbalanced statement.
    # Every unmapped account now contributes its signed closing balance
    # to an explicit Unclassified row (debit side under current assets /
    # credit side under current liabilities) while STAYING in the
    # `unmapped` transparency list + a D9 diagnosis entry. Never
    # silently classified, never dropped.
    unmapped_out: List[Dict[str, Any]] = []
    for u in (unmapped or []):
        if not isinstance(u, dict):
            continue
        entry = {
            "code": str(u.get("code") or ""),
            "name": str(u.get("name") or ""),
            "reason": str(u.get("reason") or "no_rule"),
        }
        # Carry whatever balance fields the caller had (amount on the
        # assembler shape; sf_d/sf_c when the parser layer supplies them).
        for key in ("amount", "sf_d", "sf_c"):
            if key in u:
                entry[key] = u[key]
        unmapped_out.append(entry)
    for code, li_name, b_cents in sorted(stray_bs_items):
        unmapped_out.append({
            "code": code,
            "name": li_name,
            "reason": "no_canonical_mapping",
            "amount": b_cents / 100.0,
        })
    unmapped_out.sort(key=lambda e: (e["code"], e["name"]))

    uncls_cents = {"debit": 0, "credit": 0}
    uncls_codes: Dict[str, List[str]] = {"debit": [], "credit": []}

    def _include_unclassified(code: str, b_cents: int) -> None:
        if b_cents > 0:
            uncls_cents["debit"] += b_cents
            uncls_codes["debit"].append(code)
        elif b_cents < 0:
            uncls_cents["credit"] += -b_cents
            uncls_codes["credit"].append(code)

    for u in unmapped_out:
        if u.get("reason") == "no_canonical_mapping":
            continue  # strays are included via their exact side-signed cents below
        code_str = str(u.get("code") or "")
        # Class 6/7 codes are ALREADY absorbed by the result line —
        # attach_closing_result sums EVERY class-6/7 tb_row's closing
        # balance, mapped or not. Routing an unmapped 6xx/7xx into the
        # Unclassified rows as well double-counted it (adversarial-
        # verifier probe: balanced 5121/799 pair → difference −100).
        # They stay in the `unmapped` list for visibility; their value
        # rides in the result row only.
        if code_str[:1] in ("6", "7"):
            u["reason"] = str(u.get("reason") or "no_rule") + "_absorbed_in_result"
            continue
        # Class 9 (management accounting) is off-balance like class 8 —
        # a self-balancing 9xx pair kept the identity but inflated both
        # sides via Unclassified rows. Exclude from the statement with
        # the same vocabulary as class 8.
        if code_str[:1] == "9":
            u["reason"] = "off_balance_management_class_9"
            continue
        if "sf_d" in u or "sf_c" in u:
            b_cents = _cents(u.get("sf_d")) - _cents(u.get("sf_c"))
        else:
            # Assembler-shape entry (LLM path): a single signed amount with
            # no side columns — positive is read as a debit-side balance.
            b_cents = _cents(u.get("amount"))
        _include_unclassified(u["code"], b_cents)
    for code, _li_name, b_cents in sorted(stray_bs_items):
        _include_unclassified(code, b_cents)

    # 581 (viramente interne) — excluded from the statement by the parser
    # but INCLUDED in the source-balance judgment, so a nonzero closing
    # 581 broke the identity (verifier probe: difference −50). A nonzero
    # 581 closing balance is real money in transit: include it in the
    # partition by balance side, exactly like an unclassified balance,
    # and surface it in `unmapped` so it stays loudly visible.
    for ex in (excluded or []):
        if not isinstance(ex, dict):
            continue
        if str(ex.get("code") or "")[:3] != "581":
            continue
        b_cents = _cents(ex.get("sf_d")) - _cents(ex.get("sf_c"))
        if b_cents == 0:
            continue
        _include_unclassified(str(ex.get("code")), b_cents)
        unmapped_out.append({
            "code": str(ex.get("code")),
            "name": str(ex.get("name") or "Viramente interne"),
            "reason": "transit_581_nonzero_closing_included",
            "amount": b_cents / 100.0,
        })
    unmapped_out.sort(key=lambda e: (e["code"], e["name"]))

    # ── Current-year result — from the SAME closing column (1b) ────────
    # result = 121_SF + (Σ SF(class 7) − Σ SF(class 6)), all read from
    # the source's own solduri-finale columns (the `closing_result` block
    # the pack attaches at parse time). Post-closing TBs: 6/7 SF are 0 →
    # result == 121_SF. Pre-closing: 121_SF is 0 → result == Σ7−Σ6.
    # Mixed: both terms. This is SOURCE data, not a plug — when it is
    # unavailable (LLM path, PDF rows without anchor metadata) the
    # builder falls back to the envelope's injected reconstruction leaf
    # and says so in `invariants.result_basis`.
    closing_result = anchor_block.get("closing_result")
    if (
        isinstance(closing_result, dict)
        and "p121_cents" in closing_result
        and "pl_net_cents" in closing_result
    ):
        result_cents = (
            int(closing_result.get("p121_cents") or 0)
            + int(closing_result.get("pl_net_cents") or 0)
        )
        result_leaf_ids = sorted(str(c) for c in (closing_result.get("codes") or []))
        result_basis = "sf_closing_column"
    else:
        result_cents = (
            _cents((leaves.get("current_year_profit") or {}).get("ras_line_items_sum_signed"))
            + _cents((leaves.get("current_year_loss") or {}).get("ras_line_items_sum_signed"))
        )
        result_leaf_ids = []
        result_basis = "reconstruction"

    # ── Rows — fixed section order then schema order, all in cents ─────
    sortable_rows: List[tuple] = []
    row_leaf_names = sorted(
        (set(leaves) | set(leaf_cents)) - _RESULT_LEAF_NAMES
    )
    for leaf_name in row_leaf_names:
        section = _section_for_leaf(leaf_name)
        if section is None:
            continue
        if leaf_name in leaf_cents:
            amount_cents = leaf_cents[leaf_name]
        else:
            # Kwarg-injected leaf with no line_item backing (129 on the
            # ignore path) — its envelope signed sum is the only value.
            amount_cents = _cents(
                (leaves.get(leaf_name) or {}).get("ras_line_items_sum_signed")
            )
        if amount_cents == 0:
            continue
        bucket = bucket_by_name(leaf_name)
        sortable_rows.append((
            (
                _BS_V2_SECTION_ORDER.index(section),
                _BS_LEAF_ORDER.get(leaf_name, len(_BS_LEAF_ORDER)),
                leaf_name,
            ),
            {
                "id": leaf_name,
                "section": section,
                "label_key": f"bs.row.{leaf_name}",
                "label": bucket.display_label if bucket else leaf_name,
                "account_codes": sorted(leaf_prefixes.get(leaf_name, set())),
                "amount": amount_cents / 100.0,
                "opening": None,  # prior-period column not plumbed yet
                "leaf_ids": sorted(leaf_codes.get(leaf_name, set())),
            },
            amount_cents,
        ))

    if result_cents != 0:
        result_id = "current_year_profit" if result_cents > 0 else "current_year_loss"
        result_bucket = bucket_by_name(result_id)
        result_prefixes = sorted({
            ("121" if c.startswith("121") else c[:1]) for c in result_leaf_ids
        })
        sortable_rows.append((
            (
                _BS_V2_SECTION_ORDER.index("equity"),
                _BS_LEAF_ORDER.get(result_id, len(_BS_LEAF_ORDER)),
                result_id,
            ),
            {
                "id": result_id,
                "section": "equity",
                "label_key": f"bs.row.{result_id}",
                "label": result_bucket.display_label if result_bucket else result_id,
                "account_codes": result_prefixes,
                "amount": result_cents / 100.0,
                "opening": None,
                "leaf_ids": result_leaf_ids,
            },
            result_cents,
        ))

    for side, section, row_id, label in (
        ("debit", "current_assets", "unclassified_debit",
         "Unclassified — debit side"),
        ("credit", "current_liabilities", "unclassified_credit",
         "Unclassified — credit side"),
    ):
        cents = uncls_cents[side]
        if cents == 0:
            continue
        codes = sorted(set(uncls_codes[side]))
        sortable_rows.append((
            (
                _BS_V2_SECTION_ORDER.index(section),
                len(_BS_LEAF_ORDER) + 1,  # always last within the section
                row_id,
            ),
            {
                "id": row_id,
                "section": section,
                "label_key": f"bs.row.{row_id}",
                "label": label,
                "account_codes": codes,
                "amount": cents / 100.0,
                "opening": None,
                "leaf_ids": codes,
            },
            cents,
        ))

    sortable_rows.sort(key=lambda t: t[0])
    rows: List[Dict[str, Any]] = [t[1] for t in sortable_rows]

    # Result-row law: the derived current-year result appears as EXACTLY
    # one row iff result_cents is nonzero, carrying exactly result_cents —
    # a duplicate (e.g. the kwarg-injected reconstruction leaf ALSO
    # rendering as a plain row) would double-count the result in equity.
    _result_rows = [
        c for _k, r, c in sortable_rows
        if r["id"] in ("current_year_profit", "current_year_loss")
    ]
    assert (
        len(_result_rows) == (1 if result_cents != 0 else 0)
        and all(c == result_cents for c in _result_rows)
    ), (
        "A-032: current-year result must appear as exactly one row iff "
        "result_cents != 0 and carry it exactly — result_cents=%d, result "
        "rows carry %r" % (result_cents, _result_rows)
    )

    # Serialization conservation at the row boundary: every row's float
    # `amount` must round-trip to the exact integer cents it was built
    # from (floats appear ONLY at serialization; a magnitude too large
    # for exact cent representation must fail loud, not drift silently).
    assert sum(_cents(r["amount"]) for r in rows) == sum(
        c for _k, _r, c in sortable_rows
    ), (
        "A-034: row amounts no longer round-trip to their integer cents — "
        "float serialization lost precision (magnitude beyond exact cent "
        "range?)"
    )

    section_cents: Dict[str, int] = {s: 0 for s in _BS_V2_SECTION_ORDER}
    for _key, row, amount_cents in sortable_rows:
        section_cents[row["section"]] += amount_cents

    sections = [
        {"id": s, "subtotal": section_cents[s] / 100.0}
        for s in _BS_V2_SECTION_ORDER
    ]

    # ── Totals — sums of the SAME section cents (by construction) ──────
    # Side-partition sanity first: the asset/equity section sets must be
    # disjoint and inside the fixed order (liabilities are the complement
    # — an overlap or an unknown section id would double- or mis-count a
    # whole section into two sides). Membership tests use `in` on the
    # list (no iteration), by design.
    assert not (_BS_V2_ASSET_SECTIONS & _BS_V2_EQUITY_SECTIONS) and all(
        s in _BS_V2_SECTION_ORDER
        for s in sorted(_BS_V2_ASSET_SECTIONS | _BS_V2_EQUITY_SECTIONS)
    ), (
        "A-031: asset/equity section sets must be disjoint subsets of "
        "_BS_V2_SECTION_ORDER — overlap or unknown section would "
        "double-count a side"
    )
    assets_cents = sum(
        section_cents[s] for s in _BS_V2_SECTION_ORDER if s in _BS_V2_ASSET_SECTIONS
    )
    equity_cents = sum(
        section_cents[s] for s in _BS_V2_SECTION_ORDER if s in _BS_V2_EQUITY_SECTIONS
    )
    liabilities_cents = sum(
        section_cents[s] for s in _BS_V2_SECTION_ORDER
        if s not in _BS_V2_ASSET_SECTIONS and s not in _BS_V2_EQUITY_SECTIONS
    )
    difference_cents = assets_cents - (equity_cents + liabilities_cents)
    total_assets = assets_cents / 100.0
    total_equity = equity_cents / 100.0
    total_liabilities = liabilities_cents / 100.0
    equity_plus_liabilities = (equity_cents + liabilities_cents) / 100.0
    difference = difference_cents / 100.0

    # ── Status per the contract tolerance ladder ───────────────────────
    #   BALANCED         |difference| ≤ max(1 RON, 0.001% of assets)
    #   MINOR_DRIFT      |difference| ≤ 0.5% of assets
    #   MATERIAL_IMBALANCE otherwise
    # anchor DIVERGED ⇒ the extraction FAILED regardless of internal
    # balance (the self-validation trap in BS_ENGINE_ROOT_CAUSE Layer 2);
    # llm extraction can never claim BALANCED — caps at MINOR_DRIFT.
    tol_balanced = max(1.0, abs(total_assets) * 0.00001)
    if str(anchor_block.get("anchor_status") or "") == "DIVERGED":
        status = "MATERIAL_IMBALANCE"
    elif abs(difference) <= tol_balanced:
        status = "BALANCED"
    elif abs(difference) <= abs(total_assets) * 0.005:
        status = "MINOR_DRIFT"
    else:
        status = "MATERIAL_IMBALANCE"
    if status == "BALANCED" and str(extraction_block.get("method") or "") == "llm":
        status = "MINOR_DRIFT"

    # ── Transparency blocks — sorted for determinism ───────────────────
    # (`unmapped_out` is built ABOVE, before the rows, because the
    # Unclassified rows consume it — see the identity partition.)
    excluded_by_code: Dict[str, Dict[str, Any]] = {}
    for e in (excluded or []):
        if not isinstance(e, dict):
            continue
        code = str(e.get("code") or e.get("ro_account_code") or "")
        if not code:
            continue
        reason = str(e.get("reason") or _excluded_reason(code, str(e.get("bucket") or "")))
        excluded_by_code.setdefault(code, {"code": code, "reason": reason})
    excluded_out = [excluded_by_code[c] for c in sorted(excluded_by_code)]

    # ── Invariants — recomputed and asserted, never plugged ────────────
    # Row sums recomputed in the SAME integer cents the totals used.
    asset_row_cents = sum(
        c for _k, r, c in sortable_rows if r["section"] in _BS_V2_ASSET_SECTIONS
    )
    el_row_cents = sum(
        c for _k, r, c in sortable_rows if r["section"] not in _BS_V2_ASSET_SECTIONS
    )
    assets_eq_row_sum = asset_row_cents == assets_cents
    el_eq_row_sum = el_row_cents == (equity_cents + liabilities_cents)
    # By construction (rows, subtotals and totals derive from the same
    # cent sums) these can only fail on a builder bug — fail loud.
    assert assets_eq_row_sum, (
        f"A-035: canonical_bs v2: asset rows {asset_row_cents} != totals.assets cents {assets_cents}"
    )
    assert el_eq_row_sum, (
        f"A-036: canonical_bs v2: E+L rows {el_row_cents} != equity+liabilities cents "
        f"{equity_cents + liabilities_cents}"
    )

    # Closing identity (contract invariant `identity_holds`): when the
    # source's own SF pair balances AND extraction is deterministic, the
    # difference must be EXACTLY zero — every value-bearing account
    # contributed its signed closing balance to exactly one side, so
    # assets − (E+L) == ΣSF_D − ΣSF_C == 0 by construction. The premise
    # uses the anchor's own balance judgment when the file carries a
    # totals row; without one, the extracted SF pair sums stand in
    # (parser convention: balanced within 1 RON). Emitted as a boolean,
    # never hard-asserted: a False here is the honest signal that a
    # fallback path (no closing-column data) or an engine defect leaked
    # value — exactly what the diagnosis block then names.
    src_balanced = anchor_block.get("source_balanced")
    pairs_sf = (anchor_block.get("pairs") or {}).get("sf") or None
    extracted_sf_balanced = False
    if isinstance(pairs_sf, dict):
        ext_d, ext_c = pairs_sf.get("extracted_debit"), pairs_sf.get("extracted_credit")
        if ext_d is not None and ext_c is not None:
            extracted_sf_balanced = abs(float(ext_d) - float(ext_c)) <= 1.0
    identity_premise = (
        str(extraction_block.get("method") or "") == "deterministic"
        and (
            src_balanced is True
            or (src_balanced is None and extracted_sf_balanced)
        )
    )
    identity_holds = (not identity_premise) or difference_cents == 0

    # Source conservation: every source account must land in exactly one
    # of classified / unmapped / excluded. Falsifiable only when the
    # caller supplies the source census count.
    classified_codes = set()
    for codes in leaf_codes.values():
        classified_codes.update(codes)
    conservation_count = len(
        classified_codes
        | {e["code"] for e in unmapped_out if e["code"]}
        | set(excluded_by_code)
    )
    source_conservation = (
        True if source_account_census is None
        else conservation_count == int(source_account_census)
    )

    # 121 cross-check: compare only — never auto-correct (the contract's
    # explicit rule; D6 fires off `ok: false`).
    if p121_anchor is not None and cls7_minus_cls6 is not None:
        p121_val = round(float(p121_anchor), 2)
        cls_val = round(float(cls7_minus_cls6), 2)
        p121_ok = abs(p121_val - cls_val) <= max(1.0, abs(p121_val) * 0.005)
        p121_block: Dict[str, Any] = {
            "ok": p121_ok, "p121": p121_val, "cls7_minus_cls6": cls_val,
        }
    else:
        # Not falsifiable — one side of the comparison is absent
        # (BS-only extract, or no 121 row survived extraction).
        p121_block = {"ok": True, "p121": None, "cls7_minus_cls6": None}

    canonical_bs: Dict[str, Any] = {
        "schema": "bs_v2",
        "mapping_version": MAPPING_VERSION,
        "extraction": extraction_block,
        "source_anchor": anchor_block,
        "rows": rows,
        "sections": sections,
        "totals": {
            "assets": total_assets,
            "equity": total_equity,
            "liabilities": total_liabilities,
            "equity_plus_liabilities": equity_plus_liabilities,
            "current_assets": section_cents["current_assets"] / 100.0,
            "current_liabilities": section_cents["current_liabilities"] / 100.0,
        },
        "difference": difference,
        "status": status,
        "diagnosis": [],
        "unmapped": unmapped_out,
        "excluded": excluded_out,
        "invariants": {
            "assets_eq_row_sum": assets_eq_row_sum,
            "el_eq_row_sum": el_eq_row_sum,
            "source_conservation": source_conservation,
            "p121_cross_check": p121_block,
            "identity_holds": identity_holds,
            "result_basis": result_basis,
        },
    }

    # ── Diagnosis (D0-D8) — populated when status != BALANCED ──────────
    # The engine lives in engine.confidence.reconciliation_checks so the
    # pipeline can also run it standalone; import guarded so a diagnosis
    # bug can never take down the canonical_bs emission itself.
    if status != "BALANCED":
        try:
            run_bs_diagnosis = _load_run_bs_diagnosis()
            account_leaves = []
            for li in (line_items or []):
                routed = _route_line_item(li)
                if routed is None:
                    continue
                code, name, signed_amount, _canonical = routed
                account_leaves.append(
                    {"code": code, "name": name, "amount": round(signed_amount, 2)}
                )
            account_leaves.sort(key=lambda a: (a["code"], a["name"]))
            canonical_bs["diagnosis"] = run_bs_diagnosis(
                canonical_bs, account_leaves, anchor_block,
            )
        except Exception:  # noqa: BLE001
            canonical_bs["diagnosis"] = []

    # ── D9_UNMAPPED_INCLUDED — emitted whenever Unclassified rows carry
    # value, REGARDLESS of status (contract-additive code): the statement
    # totals now include balances no mapping rule claimed, and that must
    # stay loud even on a perfectly balanced sheet. Appended after the
    # engine's D0-D8 entries — deterministic order preserved.
    if uncls_cents["debit"] or uncls_cents["credit"]:
        parts = []
        for side, label in (("debit", "debit side"), ("credit", "credit side")):
            if uncls_cents[side]:
                codes = ", ".join(sorted(set(uncls_codes[side])))
                parts.append(
                    f"{label} {uncls_cents[side] / 100.0:,.2f} RON ({codes})"
                )
        canonical_bs["diagnosis"] = list(canonical_bs.get("diagnosis") or []) + [{
            "code": "D9_UNMAPPED_INCLUDED",
            "detail": (
                "unmapped accounts included in statement totals as "
                "Unclassified rows: " + "; ".join(parts)
            ),
            "leaf_ids": sorted(set(uncls_codes["debit"]) | set(uncls_codes["credit"])),
        }]

    return canonical_bs
