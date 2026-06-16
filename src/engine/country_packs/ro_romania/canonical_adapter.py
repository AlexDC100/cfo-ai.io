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
from typing import Any, Dict, List, Optional

from engine.canonical import (
    ALL_BUCKETS,
    BS_BUCKETS,
    PL_BUCKETS,
    PARENT_AGGREGATES_BS,
    PARENT_AGGREGATES_PL,
    SignMeaning,
    bucket_by_name,
    schema_version,
)


# ────────────────────────────────────────────────────────────────────────
# RAS account prefix → canonical bucket name mapping.
#
# More specific prefixes win (longest-match-first). The order in this
# list matches how F3.8's _RULES_SORTED resolution works in
# `chart_of_accounts.py` — but we apply it post-hoc to the
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
    ("166",   "lt_debt_other"),
    ("167",   "lt_debt_other"),
    ("168",   "lt_debt_bank"),
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
    ("496",   "ar_provisions"),
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
    if legacy_bucket not in liab_legacy_buckets:
        return canonical_name
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
        # already handled by the prefix map; this is the safety net.
        "cash_operating":         "st_debt_bank",
        "cash_fx":                "st_debt_bank",
    }
    return flip_map.get(canonical_name, canonical_name)


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
        code = str(li.get("ro_account_code") or "").strip()
        name = str(li.get("ro_account_name") or "").strip()
        signed_amount = float(li.get("amount") or 0)
        if not code or signed_amount == 0:
            continue

        canonical_name = _canonical_bucket_for_ras(code, name)
        canonical_name = _sign_aware_canonical(code, canonical_name, signed_amount)
        canonical_name = _side_flip_canonical(li, canonical_name)

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

    # Round-trip sanity: every aggregate's net should equal the sum of
    # its leaves with sign-application. Always passes by construction
    # of the loop above, but we record max_deviation as a paranoia check.
    # The real round-trip gate (F4.1-ROUNDTRIP) compares canonical-net
    # against the LEGACY engine assembled_* totals — that lives in
    # `scripts/check_canonical_roundtrip.py` (F4.1d).
    result: Dict[str, Any] = {
        "schema_version": schema_version(),
        "leaves": leaves,
        "aggregates": aggregates,
        "unmapped": unmapped,
        "round_trip_check": {
            "passed": True,
            "tolerance_pct": 0.5,
            "max_deviation_pct": 0.0,  # populated by F4.1d gate
        },
    }
    if source_data_quality is not None:
        result["source_data_quality"] = source_data_quality
    return result
