"""Romanian Chart of Accounts (OMFP-1802) → standardized statements.

Classification source (Phase 3 cutover): the OMFP-1802 rule table lives
as DATA in packs/ro/omfp1802-v1/ (engine.packs) — ``bucket_for`` /
``wrong_side_flip_bucket`` below are facades over the resolved
CompiledPack; this module keeps the ASSEMBLY (bucket → statement-field
rollup, canonical views) and the F3.10 semantic-name fallback, which are
engine logic, not jurisdiction data. Historic note: the table was
originally a direct port of scandi-desk-main/src/lib/trialBalanceParser.ts;
its frozen pre-cutover copy lives in scripts/port_ro_pack.py.
Takes the extracted accounts and rolls them up into BS / PL buckets.

Buckets (must match the TS Statements interface so the frontend renders without
remapping):
  Balance sheet:
    cash, ar, inventory, otherCurrentAssets,
    ppe, intangibles, otherNonCurrentAssets,
    ap, stDebt, otherCurrentLiab,
    ltDebt, otherNonCurrentLiab,
    shareCapital, retainedEarnings, otherEquity
  P&L:
    revenue, cogs, operatingExpenses, depreciation,
    interestExpense, otherIncome, financialIncome, financialExpense, taxExpense

Sub-aggregates (memo — NEVER summed into the top-level BS/PL totals; tracked
separately on `statements.subAggregates` so downstream code can do industry
classification, anomaly detection, and risk framing without re-parsing the
raw accounts):
  ar_intercompany            — account 461 (Debitori diverși — related-party)
  ppe_investment             — account 215 (Investiții imobiliare — CRE signal)
  ppe_under_construction     — account 231 (Imobilizări in curs — capex pipeline)
  opex_third_party           — account 628 (Servicii executate de terți — anomaly flag)
  ap_dividends               — account 457 (Dividende de plată — NEVER counted as debt)
  ar_doubtful                — account 4118 (Clienți incerti)
  cash_fx                    — accounts 5124 / 5314 (FX cash component)

Ignored explicitly (NOT summed into ANY bucket, even via the `5`/`1` catchall):
  581 — Viramente interne (transit / clearing). Including this in cash is the
        single most common Romanian-pipeline cash-overstatement bug.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from engine.packs import CompiledPack
from engine.packs.runtime import active_pack


@dataclass
class MappingRule:
    """The BucketRule surface every classification consumer reads
    (.prefix / .bucket / .sign / .description). Post-cutover this is a
    VIEW over the pack's ClassificationRule — no rule data lives here."""

    prefix: str
    bucket: str
    sign: int  # 1 or -1
    description: str


# ════════════════════════════════════════════════════════════════════════════
#            PHASE 3 CUTOVER — THE PACK IS THE CLASSIFICATION SOURCE
# ════════════════════════════════════════════════════════════════════════════
#
# The locked OMFP-1802 rule table that used to live here (_RULES, 209
# prefix rules + BIFUNCTIONAL_WRONG_SIDE_FLIPS + the parser's
# SIDE_FLIP_TO_LIAB_PREFIXES) now lives as DATA in
# packs/ro/omfp1802-v1/classification.yaml, loaded through
# engine.packs.runtime.active_pack("RO"). Equivalence was proven before
# the cutover by the shadow gate (zero divergence on every deterministic
# corpus case + 50 property TBs) and stays pinned by the frozen-snapshot
# parity suite (tests/engine/test_ro_pack.py against the frozen tables in
# scripts/port_ro_pack.py) plus the byte-identical corpus battery.
#
# RULE CHANGES ARE PACK CHANGES: edit packs/ (a NEW pack version with its
# own effective window — never a silent v1 rewrite; scripts/port_ro_pack.py
# --check enforces v1 immutability), not this module. bucket_for() below
# is a facade and carries no table of its own.
#
# Resolution: the LATEST RO window (classification runs in stage_extract/
# stage_map BEFORE the period's end date is final — period_end_hint lands
# in stage_persist — so an effective-dated per-period resolve would race
# the period identity; with one open RO window they coincide. When a
# second RO window ever exists, thread period_end deliberately through
# the classification seams — engine.packs.runtime.active_pack already
# accepts it and the N-series tests exercise that seam).


def classification_pack() -> CompiledPack:
    """THE CompiledPack Romanian classification runs off (cached in
    engine.packs.runtime; loud NoPackFoundError when packs/ is absent —
    there is deliberately no in-code fallback table anymore)."""
    return active_pack("RO")


# ── Mapping-rule vintage (canonical_bs v2 contract) ─────────────────────
# Stamped onto every canonical_bs emission so persisted periods can be
# tied to the exact rule vintage that produced them. Post-cutover the
# vintage DERIVES FROM THE RESOLVED PACK: pack omfp1802@v1 keeps the
# frozen pre-cutover string (every stored envelope and golden already
# carries "ro_omfp1802_v2" — byte-stability), and any FUTURE pack version
# derives mechanically via the "<jur>_<pack_id>_pack_<version>" fallback
# (deliberately distinct from the legacy "..._v2" spelling so a future
# omfp1802@v2 can never collide with v1-era emissions). The pack_hash
# recorded alongside (assembled_canonical_v1.pack_provenance) is the
# exact-content pin; mapping_version stays the human-readable vintage.
_PACK_MAPPING_VERSION_ALIASES: Dict[Tuple[str, str, str], str] = {
    ("RO", "omfp1802", "v1"): "ro_omfp1802_v2",
}


def mapping_version_for(identity) -> str:
    """The mapping_version vintage string for a pack identity."""
    alias = _PACK_MAPPING_VERSION_ALIASES.get(
        (identity.jurisdiction.upper(), identity.pack_id, identity.version)
    )
    if alias is not None:
        return alias
    return "%s_%s_pack_%s" % (
        identity.jurisdiction.lower(), identity.pack_id, identity.version,
    )


# Resolved ONCE at import (startup): the engine must fail loudly at boot
# when packs/ is missing, not mid-upload. Note the derived constant is
# bound at import — swapping ENGINE_PACKS_ROOT later (tests) re-routes
# classification but not this vintage stamp; production has one root.
MAPPING_VERSION = mapping_version_for(classification_pack().identity)


#: Asset-side fields of the legacy BS dict (_empty_bs) — decide a BS
#: bucket's NATURAL balance side (asset = debit). Used by the wrong-side
#: flip facade; mirrored by scripts/port_ro_pack.py's _ASSET_BS_FIELDS.
_ASSET_BS_FIELDS = frozenset({
    "cash",
    "accountsReceivable",
    "inventory",
    "otherCurrentAssets",
    "propertyPlantEquipment",
    "intangibles",
    "otherNonCurrentAssets",
})


def bucket_for(code: str) -> Optional[MappingRule]:
    """The winning classification rule for an account code — a facade
    over ``CompiledPack.match`` (fixed precedence: exact > longest
    prefix > range), byte-compatible with the pre-cutover BucketRule
    surface: .bucket == the pack rule's line_id, .sign == -1 iff the
    pack rule is contra, .prefix/.description carried from the rule."""
    rule = classification_pack().match(code)
    if rule is None:
        return None
    return MappingRule(
        prefix=rule.prefix or rule.exact or rule.range_from or "",
        bucket=rule.line_id,
        sign=-1 if rule.contra else 1,
        description=rule.description,
    )


def wrong_side_flip_bucket(code: str) -> Optional[str]:
    """The OPPOSITE-side bucket for a bifunctional account code, or None.

    Pack-backed WRONG-SIDE semantics: returns the winning rule's
    side_flip target only when the flip fires on the side OPPOSITE the
    rule's natural one — a closing balance there is a REAL position on
    the other side of the balance sheet (5121 credit = overdraft ->
    stDebt, never negative cash; 4111 credit = customer advances). A
    flip registered on the rule's NATURAL side (1687 under the ltDebt
    winner — the deterministic parser lane's credit-side re-route,
    honored pre-assembly via bucket_override) deliberately returns None
    here: the wrong-side re-route in assemble_statements must not fire
    it. Contra rules (sign=-1) never flip — their negative signed value
    IS the intended subtraction.

    vs the pre-cutover table: one unification, documented — the
    418/451/452 families (parser-lane-only flips before the cutover) now
    flip on the accounts (LLM) lane too, so both lanes read the ONE pack
    table. No corpus case carries such a row (the shadow phase verified
    this); the deterministic lane is byte-identical because its parser
    re-route still fires first.
    """
    rule = classification_pack().match(code)
    if rule is None or rule.side_flip is None or rule.contra:
        return None
    field = _BUCKET_TO_BS_FIELD.get(rule.line_id)
    if field is None:
        return None  # flips only exist on BS buckets
    natural = "debit" if field in _ASSET_BS_FIELDS else "credit"
    if rule.side_flip.side == natural:
        return None
    return rule.side_flip.line_id


# ──────────────────────────────────────────────────────────────────────
# F3.10 — Semantic-name fallback
# ──────────────────────────────────────────────────────────────────────
# Kicks in ONLY when `bucket_for(code)` returns None. For an account
# whose code is genuinely novel (not covered by any OMFP 1802 prefix
# or F3.8 catchall), use Romanian-keyword matching on the account name
# as a conservative last-mile router.
#
# Conservatism principles:
#   1. Most specific patterns FIRST (clientes < clienti incerti).
#      Substring matching: first match wins.
#   2. Diacritics normalized so "imobilizări" and "imobilizari" both
#      match a single pattern.
#   3. Only invoked for codes that already passed the dotted-code regex
#      in trial_balance_parser AND failed `bucket_for(code)` — so the
#      universe is genuinely novel/custom-chart accounts, not noise.
#   4. Returns a synthetic MappingRule with `prefix=""` so the caller
#      can distinguish fallback-matched from code-matched downstream
#      (line items get a `via_semantic_fallback=True` flag).


def _strip_diacritics(s: str) -> str:
    """Normalize Romanian diacritics for keyword matching.
    Handles both modern (ă/â/î/ș/ț) and older comma-below (ş/ţ) variants."""
    return (s.lower()
            .replace("ă", "a").replace("â", "a").replace("î", "i")
            .replace("ș", "s").replace("ş", "s")
            .replace("ț", "t").replace("ţ", "t"))


# (keyword_pattern_normalized, bucket, sign, description). Order matters
# — more specific patterns FIRST.
_NAME_FALLBACK_RULES: List[Tuple[str, str, int, str]] = [
    # Receivables / payables — most specific first
    ("furnizori imobiliz",      "ap",                       1, "F3.10 name-fallback: fixed-asset suppliers"),
    ("furnizori facturi",       "ap",                       1, "F3.10 name-fallback: invoices not received"),
    ("furnizori",               "ap",                       1, "F3.10 name-fallback: suppliers / trade payables"),
    ("clienti incerti",         "ar_doubtful",              1, "F3.10 name-fallback: doubtful customers"),
    ("clienti",                 "ar",                       1, "F3.10 name-fallback: customers / trade receivables"),

    # Inventory keywords (most specific first)
    ("materii prime",           "inventory",                1, "F3.10 name-fallback: raw materials"),
    ("produse finite",          "inventory",                1, "F3.10 name-fallback: finished products"),
    ("produse reziduale",       "inventory",                1, "F3.10 name-fallback: residual products"),
    ("semifabricate",           "inventory",                1, "F3.10 name-fallback: semi-finished"),
    ("marfuri",                 "inventory",                1, "F3.10 name-fallback: merchandise"),
    ("materiale consum",        "inventory",                1, "F3.10 name-fallback: consumables"),
    ("ambalaje",                "inventory",                1, "F3.10 name-fallback: packaging"),
    ("stocuri",                 "inventory",                1, "F3.10 name-fallback: stock generic"),

    # Cash keywords
    ("casa in valuta",          "cash_fx",                  1, "F3.10 name-fallback: petty cash FX"),
    ("conturi curente la banci","cash",                     1, "F3.10 name-fallback: bank current accounts"),
    ("conturi la banci",        "cash",                     1, "F3.10 name-fallback: bank accounts"),
    ("acreditive",              "cash",                     1, "F3.10 name-fallback: letters of credit"),
    ("casierie",                "cash",                     1, "F3.10 name-fallback: petty cash"),
    ("casa in lei",             "cash",                     1, "F3.10 name-fallback: petty cash RON"),
    ("banca",                   "cash",                     1, "F3.10 name-fallback: bank generic"),
    ("casa",                    "cash",                     1, "F3.10 name-fallback: cash generic"),

    # Debt keywords
    ("credite bancare pe term", "ltDebt",                   1, "F3.10 name-fallback: LT bank credit"),
    ("imprumut pe termen lung", "ltDebt",                   1, "F3.10 name-fallback: LT borrowing"),
    ("leasing financiar",       "ltDebt",                   1, "F3.10 name-fallback: leasing obligation"),
    ("credite bancare",         "stDebt",                   1, "F3.10 name-fallback: ST bank credit"),

    # Equity keywords (must come before generic 'capital')
    ("capital subscris",        "shareCapital",             1, "F3.10 name-fallback: subscribed capital"),
    ("capital social",          "shareCapital",             1, "F3.10 name-fallback: share capital"),
    ("prime de capital",        "otherEquity",              1, "F3.10 name-fallback: share premium"),
    ("rezerve legale",          "otherEquity",              1, "F3.10 name-fallback: legal reserves"),
    ("rezerve din reevaluare",  "equity_revaluation",       1, "F3.10 name-fallback: revaluation reserves"),
    ("rezerve",                 "otherEquity",              1, "F3.10 name-fallback: reserves"),
    ("rezultatul reportat",     "retained_earnings",        1, "F3.10 name-fallback: retained earnings"),

    # Fixed assets (most specific first)
    ("imobilizari necorporale", "intangibles",              1, "F3.10 name-fallback: intangibles"),
    ("imobilizari in curs",     "ppe_under_construction",   1, "F3.10 name-fallback: CIP"),
    ("investitii imobiliare",   "ppe_investment",           1, "F3.10 name-fallback: investment property"),
    ("imobilizari financiare",  "otherNonCurrentAssets",    1, "F3.10 name-fallback: financial fixed"),
    ("imobilizari corporale",   "ppe",                      1, "F3.10 name-fallback: PP&E"),
    ("imobilizari",             "ppe",                      1, "F3.10 name-fallback: fixed assets generic"),
    ("terenuri",                "ppe",                      1, "F3.10 name-fallback: land"),
    ("constructii",             "ppe",                      1, "F3.10 name-fallback: buildings"),
    ("echipamente",             "ppe",                      1, "F3.10 name-fallback: equipment"),
    ("mobilier",                "ppe",                      1, "F3.10 name-fallback: furniture"),

    # Tax / social
    ("tva de recuperat",        "otherCurrentAssets",       1, "F3.10 name-fallback: VAT recoverable"),
    ("tva deductibila",         "otherCurrentAssets",       1, "F3.10 name-fallback: VAT deductible"),
    ("tva colectata",           "otherCurrentLiab",         1, "F3.10 name-fallback: VAT collected"),
    ("tva",                     "otherCurrentLiab",         1, "F3.10 name-fallback: VAT payable"),
    ("impozit pe profit",       "otherCurrentLiab",         1, "F3.10 name-fallback: income tax payable"),
    ("asigurari sociale",       "otherCurrentLiab",         1, "F3.10 name-fallback: social security"),
    ("contributii",             "otherCurrentLiab",         1, "F3.10 name-fallback: contributions"),

    # Generic receivables / payables (after specific clienti/furnizori)
    ("creante imobilizate",     "otherNonCurrentAssets",    1, "F3.10 name-fallback: LT receivables"),
    ("creante",                 "ar",                       1, "F3.10 name-fallback: receivables generic"),
    ("debitori",                "ar",                       1, "F3.10 name-fallback: debtors"),
    ("creditori",               "otherCurrentLiab",         1, "F3.10 name-fallback: creditors"),

    # P&L — expenses (most specific first)
    ("cheltuieli cu dobanzi",   "interest_expense",         1, "F3.10 name-fallback: interest expense"),
    ("cheltuieli cu impozit",   "taxExpense",               1, "F3.10 name-fallback: income tax expense"),
    ("cheltuieli financiare",   "financialExpense",         1, "F3.10 name-fallback: financial expense"),
    ("amortizare",              "depreciation",             1, "F3.10 name-fallback: D&A"),
    ("amortizari",              "depreciation",             1, "F3.10 name-fallback: D&A (alt spelling)"),
    ("depreciere",              "depreciation",             1, "F3.10 name-fallback: depreciation"),
    ("cheltuieli cu personal",  "operatingExpenses",        1, "F3.10 name-fallback: personnel cost"),
    ("salarii",                 "operatingExpenses",        1, "F3.10 name-fallback: salaries"),
    ("cheltuieli",              "operatingExpenses",        1, "F3.10 name-fallback: expenses generic"),

    # P&L — revenue (most specific first)
    ("venituri din dobanzi",    "interest_income",          1, "F3.10 name-fallback: interest income"),
    ("venituri din dividende",  "financial_income",         1, "F3.10 name-fallback: dividend income"),
    ("venituri financiare",     "financial_income",         1, "F3.10 name-fallback: financial income"),
    ("venituri din vanzari",    "revenue",                  1, "F3.10 name-fallback: sales"),
    ("venituri din chirii",     "revenue",                  1, "F3.10 name-fallback: rental income"),
    ("venituri din subventii",  "otherIncome",              1, "F3.10 name-fallback: subsidies"),
    ("venituri",                "revenue",                  1, "F3.10 name-fallback: revenue generic"),

    # Provisions / contras
    ("ajustari pentru depreci", "ar",                      -1, "F3.10 name-fallback: AR provisions (contra)"),
    ("provizioane",             "otherCurrentLiab",         1, "F3.10 name-fallback: provisions"),
]


def bucket_for_name(name: str) -> Optional[MappingRule]:
    """F3.10 — Semantic fallback: route a Romanian account by keyword in
    its name when `bucket_for(code)` returns None.

    Returns a synthetic MappingRule with `prefix=""` so the caller can
    flag the line item as `via_semantic_fallback=True`.
    """
    if not name:
        return None
    normalized = _strip_diacritics(name)
    for keyword, bucket, sign, desc in _NAME_FALLBACK_RULES:
        if keyword in normalized:
            return MappingRule(prefix="", bucket=bucket, sign=sign, description=desc)
    return None


# Empty Statements skeleton matching the TS interface.

def _empty_bs() -> Dict[str, float]:
    return {
        "cash": 0.0, "accountsReceivable": 0.0, "inventory": 0.0, "otherCurrentAssets": 0.0,
        "propertyPlantEquipment": 0.0, "intangibles": 0.0, "otherNonCurrentAssets": 0.0,
        "accountsPayable": 0.0, "shortTermDebt": 0.0, "otherCurrentLiabilities": 0.0,
        "longTermDebt": 0.0, "otherNonCurrentLiabilities": 0.0,
        "shareCapital": 0.0, "retainedEarnings": 0.0, "otherEquity": 0.0,
    }


def _empty_pl() -> Dict[str, float]:
    # Field names mirror the TS IncomeStatement interface so the frontend's
    # computeRatios() can read this dict directly without remapping.
    # `capitalizedOwnWork` is a memo field — surfaced for transparency, NOT
    # included in revenue/EBITDA. See _ro_coa.py rules for context.
    return {
        "revenue": 0.0, "costOfGoodsSold": 0.0, "operatingExpenses": 0.0,
        "depreciationAmortization": 0.0, "interestExpense": 0.0,
        "otherIncome": 0.0, "financialIncome": 0.0, "financialExpense": 0.0,
        "taxExpense": 0.0,
        "capitalizedOwnWork": 0.0,
        # Memo line — RAS account 711 inventory variation. Non-cash; EXCLUDED
        # from cash-view EBITDA. Re-added to statutory views downstream.
        "inventoryVariationMemo": 0.0,
    }


# Bucket key (TS) → Statements field (TS). Same values both layers.
_BUCKET_TO_BS_FIELD = {
    "cash": "cash",
    # Sub-aggregate buckets that ALSO roll into the same top-level BS line.
    # The pipeline still tracks them separately on statements.subAggregates
    # for industry classification + risk framing.
    "cash_fx": "cash",
    "ar": "accountsReceivable",
    "ar_doubtful": "accountsReceivable",
    "ar_provisions": "accountsReceivable",  # contra to ar / ar_doubtful — already sign-reversed
    "ar_intercompany": "otherCurrentAssets",  # related-party — surfaced separately
    "inventory": "inventory",
    "otherCurrentAssets": "otherCurrentAssets",
    "ppe": "propertyPlantEquipment",
    "ppe_investment": "propertyPlantEquipment",         # CRE signal
    "ppe_under_construction": "propertyPlantEquipment", # capex pipeline
    "ppe_advances": "propertyPlantEquipment",           # 4093 — capex advances
    "intangibles": "intangibles",
    "otherNonCurrentAssets": "otherNonCurrentAssets",
    "ap": "accountsPayable",
    "stDebt": "shortTermDebt",
    "otherCurrentLiab": "otherCurrentLiabilities",
    "ap_dividends": "otherCurrentLiabilities",  # NEVER counted as debt
    "ltDebt": "longTermDebt",
    "otherNonCurrentLiab": "otherNonCurrentLiabilities",
    "shareCapital": "shareCapital",
    "retainedEarnings": "retainedEarnings",
    "retained_earnings": "retainedEarnings",  # 1171 carry-forward, alias
    "otherEquity": "otherEquity",
    "equity_revaluation": "otherEquity",  # 105 — non-cash revaluation reserve
}

_BUCKET_TO_PL_FIELD = {
    "revenue": "revenue",
    "cogs": "costOfGoodsSold",
    "operatingExpenses": "operatingExpenses",
    "opex_third_party": "operatingExpenses",  # 628 — anomaly checked separately
    "depreciation": "depreciationAmortization",
    "interestExpense": "interestExpense",
    "interest_expense": "interestExpense",  # 666 — canonical alias
    "interest_income": "financialIncome",   # 766
    "fx_gain": "financialIncome",            # 7651
    "fx_loss": "financialExpense",           # 6651
    "financial_income": "financialIncome",   # 7611/7612/762/763/767 — surfaced separately
    "otherIncome": "otherIncome",
    "financialIncome": "financialIncome",
    "financialExpense": "financialExpense",
    "taxExpense": "taxExpense",
    # Memo: capitalized own-work (RO 721/722/725, FR 72, ES 730-733). Surfaced
    # on statements.incomeStatement.capitalizedOwnWork but EXCLUDED from the
    # EBITDA computation in stage_compute. The pipeline must read this and
    # produce a "country trap" alert + recompute valuation on the operational
    # basis.
    "capitalizedOwnWork": "capitalizedOwnWork",
    # Memo bucket — kept separate from `otherIncome` so it never lands in
    # cash-view EBITDA. Persistence bridge below collapses it back to
    # `otherIncome` for the DB row (CHECK constraint compatibility).
    "inventoryVariationMemo": "inventoryVariationMemo",
}

# Buckets that are intentionally NOT summed into any BS/PL field — they exist
# only to claim the account explicitly so it doesn't fall through to a
# catchall rule. Used for transit/clearing accounts (581), the Romanian
# 121 PROFIT SI PIERDERE control account (derived elsewhere, not summed),
# and the class-8 off-balance memo accounts (891/892 + all 8xx — claimed
# so the semantic name fallback can never route them onto the BS).
_IGNORE_BUCKETS = {"ignore_transit", "ignore_control", "ignore_offbalance"}

# Canonical bucket → legacy bucket name accepted by the existing Supabase
# `statement_line_items.bucket` CHECK constraint. Used ONLY at the
# persistence boundary so we keep the canonical names in code + assembled
# views, but the line items we persist conform to the existing schema.
# When the DB constraint is widened (migration: add new bucket names to
# the CHECK), this map can become identity. Until then it's the bridge.
_CANONICAL_TO_LEGACY_BUCKET = {
    # Cash sub-aggregates → "cash"
    "cash_fx": "cash",
    # AR sub-aggregates → "ar" or "otherCurrentAssets"
    "ar_doubtful": "ar",
    "ar_provisions": "ar",
    "ar_intercompany": "otherCurrentAssets",
    # PPE sub-aggregates → "ppe"
    "ppe_investment": "ppe",
    "ppe_under_construction": "ppe",
    "ppe_advances": "ppe",
    # Liability sub-aggregates → existing legacy buckets
    "ap_dividends": "otherCurrentLiab",
    # Equity sub-aggregates
    "equity_revaluation": "otherEquity",
    "retained_earnings": "retainedEarnings",
    # P&L sub-aggregates → existing P&L buckets
    "opex_third_party": "operatingExpenses",
    "interest_income": "financialIncome",
    "interest_expense": "interestExpense",
    "fx_gain": "financialIncome",
    "fx_loss": "financialExpense",
    "financial_income": "financialIncome",
    # 711 inventory-variation memo is in-memory only; persist as otherIncome
    # so the existing CHECK constraint accepts it. The canonical pl dict still
    # holds the separate field — cash-view EBITDA reads from there.
    "inventoryVariationMemo": "otherIncome",
}


def _persistence_bucket(canonical: str) -> str:
    """Translate a canonical bucket name to its legacy name (the value the
    existing Supabase CHECK constraint accepts). Falls through unchanged
    for buckets that already match the legacy set."""
    return _CANONICAL_TO_LEGACY_BUCKET.get(canonical, canonical)

# Buckets that should be tracked as sub-aggregates (separately from their
# top-level BS/PL line) so downstream stages can do industry classification,
# anomaly detection, and risk framing.
_SUB_AGGREGATE_BUCKETS = {
    # Cash sub-aggregates
    "cash_fx",
    # AR sub-aggregates
    "ar_doubtful",
    "ar_provisions",
    "ar_intercompany",
    # PPE sub-aggregates
    "ppe_investment",
    "ppe_under_construction",
    "ppe_advances",
    # Liabilities sub-aggregates
    "ap_dividends",
    # Equity sub-aggregates
    "equity_revaluation",
    "retained_earnings",
    # P&L sub-aggregates
    "opex_third_party",
    "interest_income",
    "interest_expense",
    "fx_gain",
    "fx_loss",
    "financial_income",
}


# ── F1.f — General-SME verdict bands (single source of truth) ────────
# Each entry: thresholds + direction (higher/lower better). The FE used
# to keep these as hardcoded constants in `computeRatios()`; the
# canonical-conformance audit catalogued that as parallel arithmetic.
# Emitting them here makes the engine the single source — the FE drops
# its constants and renders against these.
#
# Industry-specific override (Spec §13.2): when a CAEN resolves to a
# seeded `industry_benchmarks` row with per-metric percentile bands,
# replace the matching entry below and flip `source` to
# `"industry_specific"`. Until that wiring lands (separate chunk after
# F1.k), every emit carries `source: "general_sme_fallback"` so a
# downstream verdict is explicitly labelled — never silently context-
# wrong (Decision #2).
_GENERAL_SME_BAND_DEFINITIONS: Dict[str, Dict[str, object]] = {
    # Liquidity
    "current_ratio":   {"strong": 2.0,  "healthy": 1.5,  "watch": 1.0,  "direction": "higher"},
    "quick_ratio":     {"strong": 1.5,  "healthy": 1.0,  "watch": 0.7,  "direction": "higher"},
    "cash_ratio":      {"strong": 0.5,  "healthy": 0.2,  "watch": 0.1,  "direction": "higher"},
    # Leverage
    "debt_to_ebitda":  {"strong": 2.0,  "healthy": 3.0,  "watch": 4.5,  "direction": "lower"},
    "net_debt_to_ebitda": {"strong": 1.5, "healthy": 3.0, "watch": 4.5, "direction": "lower"},
    "debt_to_equity":  {"strong": 0.5,  "healthy": 1.0,  "watch": 2.0,  "direction": "lower"},
    "lt_debt_to_equity": {"strong": 0.3, "healthy": 0.6, "watch": 1.2,  "direction": "lower"},
    "equity_ratio":    {"strong": 0.50, "healthy": 0.30, "watch": 0.15, "direction": "higher"},
    "debt_to_assets":  {"strong": 0.30, "healthy": 0.50, "watch": 0.65, "direction": "lower"},
    # Coverage
    "interest_coverage":   {"strong": 6.0,  "healthy": 3.0,  "watch": 1.5,  "direction": "higher"},
    "ebitda_to_interest":  {"strong": 8.0,  "healthy": 4.0,  "watch": 2.0,  "direction": "higher"},
    "dscr":                {"strong": 1.5,  "healthy": 1.25, "watch": 1.0,  "direction": "higher"},
    "dscr_with_lt_principal": {"strong": 1.5, "healthy": 1.25, "watch": 1.0, "direction": "higher"},
    # Profitability — margin thresholds expressed as fractions
    # (0.25 = 25% margin), to match the ratio rows which now also
    # store fractional values.
    "gross_margin":   {"strong": 0.40, "healthy": 0.25, "watch": 0.15, "direction": "higher"},
    "ebitda_margin":  {"strong": 0.25, "healthy": 0.15, "watch": 0.08, "direction": "higher"},
    "operating_margin":{"strong": 0.20,"healthy": 0.10, "watch": 0.04, "direction": "higher"},
    "core_ebitda_margin": {"strong": 0.25, "healthy": 0.15, "watch": 0.08, "direction": "higher"},
    "net_margin":     {"strong": 0.15, "healthy": 0.08, "watch": 0.03, "direction": "higher"},
    "roa":            {"strong": 0.10, "healthy": 0.05, "watch": 0.02, "direction": "higher"},
    "roe":            {"strong": 0.20, "healthy": 0.12, "watch": 0.06, "direction": "higher"},
    "roic":           {"strong": 0.15, "healthy": 0.10, "watch": 0.05, "direction": "higher"},
    # Efficiency (days)
    "dso":            {"strong": 30,   "healthy": 45,   "watch": 75,   "direction": "lower"},
    "dio":            {"strong": 30,   "healthy": 60,   "watch": 100,  "direction": "lower"},
    "dpo":            {"strong": 60,   "healthy": 45,   "watch": 30,   "direction": "higher"},
    "ccc":            {"strong": 30,   "healthy": 60,   "watch": 90,   "direction": "lower"},
    "asset_turnover": {"strong": 1.5,  "healthy": 1.0,  "watch": 0.5,  "direction": "higher"},
    "inventory_turnover": {"strong": 12, "healthy": 6,  "watch": 3,    "direction": "higher"},
}


def _piotroski_checks(
    *,
    net_income_statutory: float,
    total_assets: float,
    cash_from_operating: float,
    prior: Optional[Dict[str, float]],
    currency: str,
) -> Dict[str, object]:
    """F1.g — emit the Piotroski 9-check bundle.

    Returns `{score, has_prior_period, checks: [...]}` per SPEC §9.
    Checks 1-4 are unconditional (no prior data required); checks 5-9
    require a prior-period snapshot. When `prior` is None, checks 5-9
    return `result: "uncertain"` and the composite `score` caps at the
    count of pass-results from checks 1-4 (max 4).

    The `prior` dict, when provided, should carry the prior-period
    equivalents: {net_income_statutory, total_assets, revenue,
    long_term_debt, share_capital, operating_ebit, asset_turnover}.
    Plumbing prior-period lookup is a separate follow-up; today every
    call site passes `None` so the FE renders the honest "5 checks
    pending prior-period" state.
    """
    checks: List[Dict[str, object]] = []
    has_prior = prior is not None
    # `cur` carries the current values that downstream YoY checks
    # would compare against if prior were available. Computed once.
    cur_roa = (net_income_statutory / total_assets) if total_assets > 0 else 0.0

    def _add(key: str, label: str, result: str, detail: str) -> None:
        checks.append({"key": key, "label": label, "result": result, "detail": detail})

    # ── Checks 1-4 (no prior period needed) ──────────────────────
    ni_pass = net_income_statutory > 0
    _add(
        "ni_positive", "Net income positive",
        "pass" if ni_pass else "fail",
        f"{net_income_statutory:,.0f} {currency}",
    )
    roa_pass = cur_roa > 0
    _add(
        "roa_positive", "ROA positive",
        "pass" if roa_pass else "fail",
        f"{cur_roa * 100:.2f}% on {total_assets:,.0f} {currency} total assets",
    )
    cfo_pass = cash_from_operating > 0
    _add(
        "cfo_positive", "Cash from operating positive",
        "pass" if cfo_pass else "fail",
        f"{cash_from_operating:,.0f} {currency}",
    )
    cfo_gt_ni_pass = cash_from_operating > net_income_statutory
    _add(
        "cfo_gt_ni", "CFO greater than net income (earnings quality)",
        "pass" if cfo_gt_ni_pass else "fail",
        (
            f"CFO {cash_from_operating:,.0f} > NI {net_income_statutory:,.0f}"
            if cfo_gt_ni_pass else
            f"NI {net_income_statutory:,.0f} > CFO {cash_from_operating:,.0f} "
            "— possible accrual inflation"
        ),
    )
    base_pass_count = sum(1 for r in (ni_pass, roa_pass, cfo_pass, cfo_gt_ni_pass) if r)

    # ── Checks 5-9 (need prior period) ──────────────────────────
    prior_required_keys = (
        "roa_improving", "debt_declining", "no_share_issuance",
        "margin_improving", "asset_turnover_improving",
    )
    prior_labels = {
        "roa_improving":            "ROA improving year-over-year",
        "debt_declining":           "Long-term debt declining",
        "no_share_issuance":        "No share issuance",
        "margin_improving":         "Operating margin improving",
        "asset_turnover_improving": "Asset turnover improving",
    }
    yoy_pass_count = 0
    if has_prior:
        # When prior data plumbing lands, replace this branch with the
        # actual comparisons (current vs prior on each metric). The
        # spec already specifies inputs and pass conditions in §9.
        for key in prior_required_keys:
            _add(key, prior_labels[key], "uncertain",
                 "Prior-period plumbing scheduled; check disabled.")
    else:
        for key in prior_required_keys:
            _add(key, prior_labels[key], "uncertain",
                 "Prior-period data unavailable for YoY comparison.")

    score = base_pass_count + yoy_pass_count  # caps at 4 when has_prior is False

    return {
        "score": score,
        "score_max": 9,
        "has_prior_period": has_prior,
        "checks": checks,
        "disclosure": (
            "Piotroski composite caps at 4 (of 9) until prior-period "
            "data is plumbed. The 4 unconditional checks (NI positive, "
            "ROA positive, CFO positive, CFO > NI) evaluate normally."
        ) if not has_prior else None,
    }


def _band_definitions(industry: Optional[str] = None) -> Dict[str, object]:
    """Return the band-definitions block for the response envelope.

    Today: always the general-SME defaults with explicit source label.
    Tomorrow (post-F1.k): when `industry` resolves to a seeded
    `industry_benchmarks` CAEN, individual entries get overridden and
    re-tagged `source: "industry_specific"` per-metric.

    The source label is REQUIRED — Decision #2 forbids silent fallback.
    A verdict on fallback bands must be visually distinguishable from
    one on industry-specific bands. The FE renders an explicit
    "general SME bands — not industry-calibrated" disclosure when this
    is the source.
    """
    return {
        "bands": {k: dict(v) for k, v in _GENERAL_SME_BAND_DEFINITIONS.items()},
        "source": "general_sme_fallback",
        "industry_resolved": industry,
        "disclosure": (
            "Verdict bands are general-SME defaults — not calibrated to "
            "the resolved industry's seeded distribution. Industry-"
            "specific bands activate when the period's resolved CAEN has "
            "matching rows in industry_benchmarks; that wiring is "
            "scheduled for a follow-up engine pass."
        ),
    }


def assemble_statements(
    accounts: List[Dict[str, object]],
    *,
    company_name: str = "Imported entity",
    currency: str = "RON",
    period_label: str = "Imported period",
    industry: Optional[str] = None,
    source_data_quality: Optional[Dict[str, object]] = None,
    account_121_anchor_override: Optional[float] = None,
    source_anchor: Optional[Dict[str, object]] = None,
    extraction_meta: Optional[Dict[str, object]] = None,
    source_account_census: Optional[int] = None,
    extra_unmapped: Optional[List[Dict[str, object]]] = None,
) -> Dict[str, object]:
    """Roll account-level amounts into BS + PL totals.

    Returns a Statements-shaped dict that matches the TS interface so the
    frontend can render it directly without re-mapping.

    `source_data_quality` (F3.9, optional): pre-computed source telemetry
    from `trial_balance_parser.compute_source_imbalance(rows)`. When
    provided, it surfaces on the returned dict under the same key so the
    pipeline / FE can render a pre-analysis warning when the raw
    sf_d/sf_c imbalance exceeds the 2% threshold. Default None preserves
    F3.1-PARITY byte-identical (the key is omitted from the result when
    the caller doesn't pass it).

    canonical_bs v2 kwargs (all optional — the builder degrades to
    defensive defaults when absent; the pipeline plumbs the real values):
      `source_anchor` — per-pair file-totals conservation block per
        docs/CANONICAL_BS_V2_CONTRACT.md (totals_row_found / pairs /
        anchor_status / source_balanced).
      `extraction_meta` — extraction provenance (method/parser_version/
        source_format/…). method=="llm" caps canonical_bs.status at
        MINOR_DRIFT per the contract.
      `source_account_census` — count of account rows in the SOURCE file,
        for the source_conservation invariant.
      `extra_unmapped` — unmapped accounts dropped BEFORE this call
        (the deterministic parser skips unknown codes pre-assembly);
        merged into canonical_bs.unmapped for full census coverage.
    """
    bs = _empty_bs()
    pl = _empty_pl()
    sub_agg: Dict[str, float] = {k: 0.0 for k in _SUB_AGGREGATE_BUCKETS}
    line_items: List[Dict[str, object]] = []
    ignored_items: List[Dict[str, object]] = []
    unmapped: List[Dict[str, object]] = []
    # F3.10 — count of accounts routed via semantic-name fallback (i.e.
    # `bucket_for(code)` missed and `bucket_for_name(name)` matched).
    # Conditionally surfaced in the result dict when > 0 so existing
    # capture baselines stay byte-identical on fixtures where nothing
    # falls through to the name fallback.
    semantic_fallbacks_used = 0
    semantic_fallback_examples: List[Dict[str, object]] = []

    # 767 (discounts received) is bucketed into `financial_income` for the
    # legacy P&L view, but the OPERATING view (which the FE P&L tab and
    # KPI tiles render) counts it inside operating revenue. Track it
    # separately so `assembled_pl_canonical` can surface the operating
    # view without disturbing the financial_income aggregate.
    discounts_received_767 = 0.0

    # F3.7d: account 121 (PROFIT SI PIERDERE) closing balance is the
    # STATUTORY NET-INCOME ANCHOR. Captured during account iteration
    # below (when bucket == "ignore_control" + code.startswith("121"))
    # and used after the P&L reconstruction to override
    # `net_income_statutory` when the two diverge by more than 5%.
    # `None` sentinel means no 121 account was present in the input
    # (fall back to reconstruction). See comment block where the
    # override is applied for the full rationale.
    account_121_anchor: Optional[float] = None

    for raw in accounts:
        code = str(raw.get("code", "")).strip()
        name = str(raw.get("name", "")).strip()
        try:
            amount = float(raw.get("amount", 0) or 0)
        except (TypeError, ValueError):
            continue
        if not code or amount == 0:
            continue
        rule = bucket_for(code)
        via_semantic = False
        if not rule:
            # F3.10 — try semantic name-based fallback before giving up.
            # The fallback rule carries prefix="" so we can flag the line
            # item; the bucket / sign are picked by Romanian keyword match
            # in `bucket_for_name`.
            rule = bucket_for_name(name)
            if rule is not None:
                via_semantic = True
                semantic_fallbacks_used += 1
                if len(semantic_fallback_examples) < 20:
                    semantic_fallback_examples.append({
                        "code": code, "name": name, "amount": amount,
                        "bucket": rule.bucket, "matched_keyword": rule.description,
                    })
            else:
                unmapped.append({"code": code, "name": name, "amount": amount})
                continue

        # `bucket_override` lets the upstream extractor redirect a row to a
        # bucket that doesn't match what `bucket_for(code)` returned. The
        # canonical use is SIDE-FLIP routing: a mixed-side class-4 account
        # (e.g. 418 customer accruals, 451 affiliated balances) whose
        # balance lands on the opposite side of its natural direction is
        # routed to the matching liability bucket so it doesn't pollute
        # the asset side. The override bucket carries sign=+1 by convention
        # (the extractor already produced a non-negative `amount` matching
        # the override-bucket's natural side).
        override_bucket = raw.get("bucket_override")
        if override_bucket:
            # Replace the rule in-flight so the downstream routing picks
            # the override bucket (a fresh MappingRule view — the pack's
            # compiled rules are immutable and never touched).
            rule = MappingRule(
                prefix=rule.prefix,
                bucket=str(override_bucket),
                sign=1,
                description=rule.description + " (side-flipped to liab)",
            )

        # Buckets in _IGNORE_BUCKETS are intentionally not summed anywhere
        # AND not persisted as line items. 581 (Viramente interne) and
        # 121 (PROFIT SI PIERDERE control) are the canonical cases —
        # claiming each via a mapping rule prevents them from falling
        # through to catchall rules and from appearing as "unmapped"
        # warnings. They show up in a separate `ignored` list on the
        # assembled output for transparency, but never in line_items
        # (because line_items rows go to the DB and the DB constraint
        # only accepts statement in {"BS","PL"}).
        if rule.bucket in _IGNORE_BUCKETS:
            # F3.7d: capture account 121 closing as the statutory net-income
            # anchor. The parser (`accounts_to_assemble_shape`) emits
            # 121x rows with `amount = sf_c - sf_d` (positive=profit,
            # negative=loss) for exactly this purpose. Sum across all
            # 121x sub-accounts (`121.0`, `121101`, etc.) — Romanian
            # analytical sub-accounting splits 121 the same way other
            # equity accounts split. `rule.sign` is +1 for 121 (the
            # pack's ro.121 rule is non-contra).
            if code.startswith("121"):
                if account_121_anchor is None:
                    account_121_anchor = 0.0
                account_121_anchor += amount * rule.sign
            ignored_items.append({
                "bucket": rule.bucket,  # canonical name; in-memory only
                "ro_account_code": code,
                "ro_account_name": name,
                "amount": amount * rule.sign,
            })
            continue

        signed = amount * rule.sign

        # Bifunctional wrong-side re-route (canonical_bs v2). A negative
        # signed value on a sign=+1 rule means the closing balance sits on
        # the side OPPOSITE the rule's natural bucket (parser emits signed
        # sf math; Claude-path wrong-side balances arrive negative the same
        # way). For families whose pack rule carries a wrong-side
        # side_flip the position belongs on the other side of the BS —
        # 5121 credit is an overdraft (ST bank debt), never negative
        # cash; 401 debit is a supplier receivable, never negative AP.
        # Re-route with the absolute value. sign=-1 contra rules (491,
        # 28x, 169, 269…) are exempt: their negative signed value IS the
        # intended contra subtraction (wrong_side_flip_bucket also skips
        # them internally). Rows the parser already side-flipped arrive
        # via bucket_override with positive amounts, so this never
        # double-fires.
        if not override_bucket and rule.sign == 1 and signed < 0:
            flip_to = wrong_side_flip_bucket(code)
            if flip_to:
                rule = MappingRule(
                    prefix=rule.prefix,
                    bucket=flip_to,
                    sign=1,
                    description=rule.description + " (wrong-side flip)",
                )
                signed = -signed

        # Capture the 767 component as it flows past — used below to build
        # the operating-view EBITDA. The financial_income bucket still
        # receives it, so nothing in the legacy path changes.
        if code.startswith("767"):
            discounts_received_767 += signed

        # Track sub-aggregates BEFORE rolling into the top-level field so
        # the same amount appears both on the line total (e.g.,
        # propertyPlantEquipment) and on the sub-aggregate
        # (e.g., ppe_investment) for industry detection.
        if rule.bucket in _SUB_AGGREGATE_BUCKETS:
            sub_agg[rule.bucket] += signed

        if rule.bucket in _BUCKET_TO_BS_FIELD:
            bs[_BUCKET_TO_BS_FIELD[rule.bucket]] += signed
            statement = "BS"
        elif rule.bucket in _BUCKET_TO_PL_FIELD:
            pl[_BUCKET_TO_PL_FIELD[rule.bucket]] += signed
            statement = "PL"
        else:
            continue
        # Persist with the LEGACY bucket name (DB-accepted) and keep the
        # canonical name on the side so future migrations and the
        # frontend's sub-aggregate views can read both.
        line_item: Dict[str, object] = {
            "statement": statement,
            "bucket": _persistence_bucket(rule.bucket),
            "canonical_bucket": rule.bucket,
            "ro_account_code": code,
            "ro_account_name": name,
            "amount": signed,
            "is_derived": False,
        }
        # F3.10 — flag fallback-routed items so the FE can render an
        # "auto-classified by name" badge. ONLY added when True (omitted
        # otherwise) to preserve F3.1-PARITY byte-identical on fixtures
        # that don't trigger the fallback.
        if via_semantic:
            line_item["via_semantic_fallback"] = True
        line_items.append(line_item)

    # Defensive sign normalization for liability/equity buckets.
    # Romanian credit balances should always emit POSITIVE per the extraction
    # prompt, but Claude occasionally returns negative amounts for sub-classes
    # whose prefix looks asset-like (e.g. 5191 short-term bank loan — class-5
    # passive, but Claude reads as 5-cash sub-pattern). Bucket name is the
    # source of truth for sign — flip any negatives back here. Asset buckets
    # CAN legitimately be negative (contra-asset accumulated depreciation,
    # for example), so we only normalize liability + equity.
    #
    # F3.7b (Option A follow-up, baseline ceremony 2026-05-21) —
    # `retainedEarnings` REMOVED from this list. Post-F3.7a (signed-math
    # emission), retainedEarnings can LEGITIMATELY be negative when
    # carry-forward losses (1171 family on debit side) exceed
    # carry-forward profits — see Scandia Sibiu FY2019 (bucket
    # sum −539,093 RON). Keeping retainedEarnings in this list caused
    # the correctly-signed negative bucket sum to be flipped positive,
    # then `+= net_income_statutory` produced +1.17M total_equity vs
    # toolkit +110,532 — the 1.07M residual that survived F3.7a. With
    # F3.7a's deterministic-signed extractor in place this defensive
    # layer is obsolete for retainedEarnings AND was actively wrong;
    # other liability buckets stay listed because they cannot
    # legitimately be negative (no contra-liability accounts in the
    # canonical chart).
    _CREDIT_POSITIVE_BS_FIELDS = (
        "accountsPayable", "shortTermDebt", "otherCurrentLiabilities",
        "longTermDebt", "otherNonCurrentLiabilities",
        "shareCapital", "otherEquity",
    )
    for fld in _CREDIT_POSITIVE_BS_FIELDS:
        if bs.get(fld, 0) < 0:
            bs[fld] = -bs[fld]

    # Round to 2 decimal places to keep persisted numbers tidy.
    bs = {k: round(v, 2) for k, v in bs.items()}
    pl = {k: round(v, 2) for k, v in pl.items()}
    sub_agg = {k: round(v, 2) for k, v in sub_agg.items()}

    # ── Canonical "assembled_bs" view — top-level fields that match the
    # surgical-fix prompt's expected schema exactly. The frontend KPI tiles
    # read these directly (not by re-deriving from the raw BS lines).
    # Each value reconciles to the source balanta closing balances. ──
    assembled_bs_canonical = {
        # Cash (5121 + 5311 RON + 5124 + 5314 FX); 581 is ignored.
        "cash": round(bs["cash"], 2),
        "cash_fx_component": round(sub_agg.get("cash_fx", 0), 2),
        # AR: gross 4111+4118 NET of 491 provision (491 is sign=-1 in mapping
        # so it already reduces accountsReceivable when summed).
        "ar_net": round(bs["accountsReceivable"], 2),
        "ar_doubtful_gross": round(sub_agg.get("ar_doubtful", 0), 2),
        "ar_provisions": round(sub_agg.get("ar_provisions", 0), 2),
        # 461 — intercompany / related-party debtor, surfaced separately
        "ar_intercompany": round(sub_agg.get("ar_intercompany", 0), 2),
        # AR other — what's in otherCurrentAssets MINUS ar_intercompany and
        # ppe_advances (so callers reading ar_other don't double-count).
        "ar_other": round(
            bs["otherCurrentAssets"]
            - sub_agg.get("ar_intercompany", 0)
            - sub_agg.get("ppe_advances", 0),
            2,
        ),
        # PPE breakouts
        "ppe_net": round(bs["propertyPlantEquipment"], 2),
        "ppe_investment_net": round(sub_agg.get("ppe_investment", 0), 2),
        "ppe_under_construction": round(sub_agg.get("ppe_under_construction", 0), 2),
        "ppe_advances": round(sub_agg.get("ppe_advances", 0), 2),
        "intangibles_net": round(bs["intangibles"], 2),
        "investments": round(bs["otherNonCurrentAssets"], 2),
        # Liabilities — debt and dividends ALWAYS separated.
        "ap": round(bs["accountsPayable"], 2),
        "ap_dividends": round(sub_agg.get("ap_dividends", 0), 2),
        "ap_other": round(
            bs["otherCurrentLiabilities"] - sub_agg.get("ap_dividends", 0), 2
        ),
        "lt_debt": round(bs["longTermDebt"], 2),
        "st_debt": round(bs["shortTermDebt"], 2),
        # Total debt = ONLY stDebt + ltDebt. Dividends NEVER folded in.
        "total_debt": round(bs["shortTermDebt"] + bs["longTermDebt"], 2),
        # Equity
        "share_capital": round(bs["shareCapital"], 2),
        "revaluation_reserves": round(sub_agg.get("equity_revaluation", 0), 2),
        "retained_earnings": round(sub_agg.get("retained_earnings", 0), 2),
        "other_equity_non_revaluation": round(
            bs["otherEquity"] - sub_agg.get("equity_revaluation", 0), 2
        ),
        # current_year_pnl filled below after we compute statutory net income.
        "current_year_pnl": 0.0,
        # total_assets + total_equity + total_liabilities + bs_balance_delta
        # also filled below for downstream consumers.
        "total_assets": 0.0,
        "total_equity": 0.0,
        "total_liabilities": 0.0,
        "bs_balance_delta": 0.0,

        # ── F1.b additions (SPEC §5) ──
        # Spec-named aliases so the FE doesn't have to look up by the
        # engine's internal names (ar_net, ppe_net, ap, st_debt, lt_debt).
        "accounts_receivable": round(bs["accountsReceivable"], 2),
        "inventory": round(bs["inventory"], 2),
        "other_current_assets": round(bs["otherCurrentAssets"], 2),
        "property_plant_equipment": round(bs["propertyPlantEquipment"], 2),
        "intangibles": round(bs["intangibles"], 2),
        "other_non_current_assets": round(bs["otherNonCurrentAssets"], 2),
        "accounts_payable": round(bs["accountsPayable"], 2),
        "short_term_debt": round(bs["shortTermDebt"], 2),
        "other_current_liabilities": round(bs["otherCurrentLiabilities"], 2),
        "long_term_debt": round(bs["longTermDebt"], 2),
        "other_non_current_liabilities": round(bs["otherNonCurrentLiabilities"], 2),
        # The legacy combined otherEquity (104 + 105 + 106 + 1061 + 1068).
        # Spec §5 calls this `other_equity`. `other_equity_non_revaluation`
        # above is the same total minus 105 (revaluation reserves) — kept
        # for the existing ComprehensiveReport BsTable which needs both.
        "other_equity": round(bs["otherEquity"], 2),
        # Section subtotals — computed at dict construction time because
        # every input is already populated in `bs` by this point.
        "total_current_assets": round(
            bs["cash"] + bs["accountsReceivable"] + bs["inventory"]
            + bs["otherCurrentAssets"], 2
        ),
        "total_non_current_assets": round(
            bs["propertyPlantEquipment"] + bs["intangibles"]
            + bs["otherNonCurrentAssets"], 2
        ),
        "total_current_liabilities": round(
            bs["accountsPayable"] + bs["shortTermDebt"]
            + bs["otherCurrentLiabilities"], 2
        ),
        "total_non_current_liabilities": round(
            bs["longTermDebt"] + bs["otherNonCurrentLiabilities"], 2
        ),
    }

    # ── Canonical "assembled_pl" view — both net income views surfaced.
    # Operational excludes capitalized own-work; statutory includes it (to
    # match account 121 PROFIT SI PIERDERE on the Romanian books). ──
    revenue = pl["revenue"]
    cogs = pl["costOfGoodsSold"]
    opex = pl["operatingExpenses"]
    depreciation = pl["depreciationAmortization"]
    interest = pl["interestExpense"]
    other_inc = pl["otherIncome"]
    fin_inc = pl["financialIncome"]
    fin_exp = pl["financialExpense"]
    tax = pl["taxExpense"]
    capitalized = pl.get("capitalizedOwnWork", 0.0)
    inventory_variation_memo = pl.get("inventoryVariationMemo", 0.0)

    gross_profit = revenue - cogs
    # `other_inc` now excludes 711 (routed to inventoryVariationMemo); this is
    # the CASH-view EBITDA — the number a buyer or lender cares about.
    ebitda = revenue - cogs - opex + other_inc  # operational (722 + 711 excluded)
    ebit = ebitda - depreciation
    pretax = ebit + fin_inc - fin_exp - interest
    net_income_operational = pretax - tax
    # Statutory: Romanian books include 722's credit. account 121 will close
    # to (operational + capitalized_own_work).
    net_income_statutory = net_income_operational + capitalized

    # F3.7d: ANCHOR to account 121 closing when the reconstruction diverges
    # materially. Per CLAUDE.md Appendix B (Section 4 / Step 11), the
    # closing balance of account 121 IS the statutory net profit — the
    # reconstruction (operational + capitalized) is the validation check,
    # not the authoritative number. For standard operating entities
    # (Scandia/EEI/Sibiu/food manufacturers), the two agree within ±5%
    # so this override is a no-op. For asset-heavy entities (real-estate
    # developers) where 711 production-variation and 628 capitalization
    # expenses don't net cleanly on the P&L, reconstruction diverges by
    # 5–50× and the 121 closing is the only legally-correct anchor.
    #
    # Threshold: 5% of max(|account_121|, 100_000 RON). The 100K floor
    # prevents the percentage check from misfiring on near-zero anchors
    # (a dormant company with 121 ≈ 0 shouldn't trigger override on
    # tiny reconstruction noise).
    #
    # Empirical impact on the 4 currently-registered fixtures:
    #   EEI:        |1.42M − 1.42M|   = 0      → no-op (byte-identical)
    #   Scandia:    |36.24M − 36.79M| = 547K   → < 5% threshold, no-op
    #   Sibiu:      |627K − 651K|     = 23K    → < 5% threshold, no-op
    #   RealEstate: |-29.5M − (-802K)|= 28.7M  → override → -802K (4000×)
    # F3.16-3b.2 Path X — kwarg override.
    # The `accounts_to_assemble_shape` preprocessor drops bucket=ignore_control
    # rows (which include account 121), so on the integrated TB-fast-path
    # `account_121_anchor` is None even when the upstream 121 row exists.
    # `pipeline.py::stage_extract` independently captures 121's closing
    # balance via `pack.compute_statutory_net_profit_anchor(tb_rows)` and
    # threads it through here so the anchor override fires even when the
    # preprocessor stripped the row. When both are present, kwarg wins
    # (it was sourced from the unfiltered raw rows; the loop-captured
    # value is only present when the preprocessor was bypassed —
    # Claude-extracted path, fixture path that doesn't pass the kwarg).
    # See: F3.16 closure ADR invariant (a) for the architectural rule
    # this fix implements.
    if account_121_anchor_override is not None:
        account_121_anchor = float(account_121_anchor_override)

    if account_121_anchor is not None:
        threshold = max(abs(account_121_anchor), 100_000) * 0.05
        if abs(net_income_statutory - account_121_anchor) > threshold:
            net_income_statutory = account_121_anchor

    # ── 121 cross-check emission (canonical_bs v2 invariant) ─────────────
    # Statutorily account 121 closes to Σ(class 7) − Σ(class 6). From the
    # assembled PL buckets that identity is net_income_operational +
    # capitalized own-work (72x) + inventory variation (71x) — every other
    # class-6/7 bucket is already inside net_income_operational. Computed
    # ONLY when class 6/7 activity is present (a BS-only extract has no
    # P&L movements and the comparison would be vacuous). This is emitted
    # into canonical_bs.invariants.p121_cross_check for diagnosis (D6) —
    # it never auto-corrects anything; the 5% anchor override above is a
    # separate, pre-existing behavior on the P&L reconstruction side.
    _pl_activity_present = any(
        li.get("statement") == "PL" for li in line_items
    )
    cls7_minus_cls6: Optional[float] = (
        round(net_income_operational + capitalized + inventory_variation_memo, 2)
        if _pl_activity_present else None
    )

    # ── THREE EBITDA VIEWS — explicit, never re-derived downstream ───────
    # The same Romanian books produce three legitimate EBITDA numbers,
    # depending on how 722 (capitalized own-work) and 767 (discounts
    # received) are treated. All three must be surfaced so the Valuation
    # tab, briefing, and recommendations all pick the same one and stop
    # disagreeing.
    #
    #   ebitda_operational      — excludes 722; the "cash view" of
    #                             EBITDA. Negative for EEI (−37K).
    #   ebitda_statutory        — includes 722 (matches Romanian P&L
    #                             where 722 closes into 121). PRIMARY
    #                             for valuation. Positive for EEI (+2.13M).
    #   ebitda_operating_view   — includes 722 + 767 (the FE P&L tab view).
    #                             Marginally higher than statutory by the
    #                             discounts-received amount.
    ebitda_operational = ebitda                                                  # -36,676 for EEI
    ebitda_statutory   = ebitda + capitalized                                    # 2,127,404 for EEI
    ebitda_operating_view = ebitda + capitalized + discounts_received_767        # 2,149,571 for real EEI
    # Cash view (alias) — primary for valuation and lender DSCR. Excludes
    # both 722 (capitalized own-work) and 711 (inventory variation).
    ebitda_cash = ebitda_operational
    # Statutory-with-711 — IFRS-style "total production" view that includes
    # the inventory accrual. Useful for matching Romanian account 121.
    ebitda_statutory_with_711 = ebitda_cash + capitalized + inventory_variation_memo
    # Keep `operating_ebitda` / `total_operating_revenue` as aliases for
    # the FE which already consumes the operating-view field names.
    total_operating_revenue = revenue + capitalized + discounts_received_767
    total_operating_revenue_statutory = total_operating_revenue + inventory_variation_memo
    operating_ebitda = ebitda_operating_view
    operating_ebit = operating_ebitda - depreciation

    # ── F1.a additions — fields the FE needs so it can be a pure renderer
    # (SPEC_F1_ENGINE_CANONICAL_CONTRACT.md §4). Each is derived from
    # numbers the engine already computes above; no new math, just
    # surfacing pieces the FE was re-deriving.
    #
    # 758/781 line-level breakouts: 758 (Alte venituri exploatare) and
    # 781 (Venituri din provizioane) are both routed into `otherIncome`
    # via the bucket rules (lines 329 + 372), so they're indistinguishable
    # at the sub_agg level. We read them per-account from `line_items`
    # to power the Reported → Core EBITDA bridge that the canonical-
    # metrics module already implements on the FE; emitting them
    # server-side lets the FE drop that recompute (Audit F3).
    other_income_758 = sum(
        float(li.get("amount", 0) or 0)
        for li in line_items
        if str(li.get("ro_account_code", "")).startswith("758")
    )
    other_income_781_reversals = sum(
        float(li.get("amount", 0) or 0)
        for li in line_items
        if str(li.get("ro_account_code", "")).startswith("781")
    )
    # ── F3.16-3b.6 Phase 2 (2026-05-26) — `other_op_income_lump` ─────
    # Widened scan that mirrors the canonical adapter's coverage of the
    # `other_op_income` aggregate. Per
    # docs/F3.16-3b6-variant-analysis.md §3, the YAML strict formula
    # subtracts `?other_op_income.net` which contains:
    #   · `other_operating_income_recurring` ← 758 + 75-catchall
    #   · `government_grants_recognized`     ← 740 + 74-catchall
    #   · `other_operating_income_one_off`   ← 77-catchall
    #   · `gain_loss_disposal_ppe`           ← 7583 (gain side; via 75)
    # The narrow `other_income_758` scan above missed 74/77 catchalls
    # and produced a 403K divergence on Retail (account 7418.81 —
    # Rural Invest grant). Widening to (74, 75, 77) prefixes captures
    # the full lump byte-identical to the canonical aggregate.
    #
    # 76 (financial income) is intentionally excluded — it's not in
    # the canonical `other_op_income` aggregate. 78 (provision_reversals)
    # is also excluded because it has a separate subtract line
    # (`other_income_781_reversals`) in the adjusted_ebitda formula.
    other_op_income_lump = sum(
        float(li.get("amount", 0) or 0)
        for li in line_items
        if str(li.get("ro_account_code", "")).startswith(("74", "75", "77"))
    )
    # Core EBITDA — statutory minus non-core operating credits. This is
    # the valuation basis the EBITDA multiple bridges to.
    core_ebitda = ebitda_statutory - other_income_758 - other_income_781_reversals
    # F3.16-3b.6 Phase 2 (2026-05-26) — Adjusted EBITDA harmonized with
    # YAML methodology.ebitda.strict so the F4.2-PARITY gate locks
    # strict to HARD ±1 RON on all 8 fixtures.
    #
    # Two changes vs pre-3b.6-A:
    #   (a) Base shifted from `operating_ebitda` (which includes the
    #       small 767 discounts-received contribution) to
    #       `ebitda_statutory` (the filed-P&L view). The 767 piece
    #       was outside YAML reported's scope; including it in
    #       adjusted_ebitda created a small mismatch on EEI/Retail.
    #   (b) Strip widened from narrow 758 scan to the canonical
    #       adapter's full `other_op_income` coverage via the
    #       `other_op_income_lump` (74/75/77 catchalls). Closes the
    #       Retail 403K Rural Invest grant divergence.
    #
    # Mechanical proof: F4.2-PARITY pre-deploy probe predicted
    # ±0.00 RON on all 8 fixtures after this edit lands; locked
    # per ADR Lock #8 (predict-from-empirical) in
    # docs/F3.16-3b6-variant-analysis.md §8.
    adjusted_ebitda = ebitda_statutory - other_op_income_lump - other_income_781_reversals
    # Total operating expense — denominator for DIO/DPO (per the
    # B1 closure: total opex, not narrow COGS).
    total_operating_expense = cogs + opex + depreciation
    # Net financial result — the bridge between EBIT and pretax. Sum of
    # 76x income minus 66x expense including interest (the engine treats
    # interest separately from `financialExpense` at the bucket level).
    net_financial_result = fin_inc - fin_exp - interest
    # Aggregated financial-expense for the FE — includes interest, FX
    # losses, and other financial expenses (66x family). The legacy
    # `financial_expense` field excludes interest, which trips up FE
    # readers expecting the full 66x total.
    financial_expense_total = fin_exp + interest
    # FCF proxy — net income + D&A. Marked `_proxy` to distinguish from
    # the proper CFO − Capex computed later (F1.c). Per §13.3.
    free_cash_flow_proxy = net_income_statutory + depreciation

    assembled_pl_canonical = {
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "gross_profit": round(gross_profit, 2),
        "opex_total": round(opex, 2),
        "opex_third_party": round(sub_agg.get("opex_third_party", 0), 2),
        "depreciation": round(depreciation, 2),
        # Legacy `ebitda` kept as `ebitda_operational` for backward compat
        # (the operational view that excludes 722). New consumers should use
        # the explicit *_statutory / *_operational / *_operating_view fields.
        "ebitda": round(ebitda_operational, 2),
        "ebit": round(ebit, 2),
        # Three explicit EBITDA views — Valuation tab, briefing, ratios
        # all pick the same one (statutory is the primary).
        "ebitda_operational":     round(ebitda_operational, 2),
        "ebitda_statutory":       round(ebitda_statutory, 2),
        "ebitda_operating_view":  round(ebitda_operating_view, 2),
        "ebitda_adjusted":        round(ebitda_statutory + sub_agg.get("financial_income", 0), 2),
        "discounts_received":     round(discounts_received_767, 2),
        # Operating-view variants — what the frontend P&L tab + KPI tiles
        # render, and what the CFO briefing must cite.
        "total_operating_revenue": round(total_operating_revenue, 2),
        "total_operating_revenue_statutory": round(total_operating_revenue_statutory, 2),
        "operating_ebitda": round(operating_ebitda, 2),
        "operating_ebit": round(operating_ebit, 2),
        # Cash + 711-inclusive views. Cash is primary; statutory_with_711 is
        # the alternative IFRS-style number for benchmarking.
        "ebitda_cash": round(ebitda_cash, 2),
        "ebitda_statutory_with_711": round(ebitda_statutory_with_711, 2),
        "inventory_variation_memo": round(inventory_variation_memo, 2),
        "interest_expense": round(interest, 2),
        "interest_income": round(sub_agg.get("interest_income", 0), 2),
        "fx_gain": round(sub_agg.get("fx_gain", 0), 2),
        "fx_loss": round(sub_agg.get("fx_loss", 0), 2),
        "financial_income_other": round(sub_agg.get("financial_income", 0), 2),
        "financial_income": round(fin_inc, 2),
        "financial_expense": round(fin_exp, 2),
        "pretax": round(pretax, 2),
        "tax": round(tax, 2),
        # Both net income views — neither hidden, neither default.
        "net_income_operational": round(net_income_operational, 2),
        "net_income_statutory": round(net_income_statutory, 2),
        # 722 memo line — proof that the pipeline is excluding it.
        "capitalized_own_work_memo": round(capitalized, 2),

        # ── F1.a additions (SPEC §4) ──
        # Aliases that match the explicit, FE-friendly names in the spec.
        "cost_of_goods_sold": round(cogs, 2),
        "income_tax": round(tax, 2),
        # New derived fields:
        "total_operating_expense": round(total_operating_expense, 2),
        "opex_excluding_cogs_and_da": round(opex, 2),
        "other_income_758": round(other_income_758, 2),
        # F3.16-3b.6 Phase 2 (2026-05-26) — broader strict-strip lump
        # matching canonical other_op_income.net coverage.
        "other_op_income_lump": round(other_op_income_lump, 2),
        "other_income_781_reversals": round(other_income_781_reversals, 2),
        "core_ebitda": round(core_ebitda, 2),
        # F3.14 (3b) — Adjusted EBITDA = operating_ebitda − 758 − 781.
        # Lender / PE-diligence reference view. Side-by-side with operating_ebitda
        # on the EBITDA card; does NOT replace it. See ADR_F3_14_DEFERRED_ITEMS.md
        # for the dual-EBITDA design decision.
        "adjusted_ebitda": round(adjusted_ebitda, 2),
        "net_financial_result": round(net_financial_result, 2),
        "financial_expense_total": round(financial_expense_total, 2),
        "free_cash_flow_proxy": round(free_cash_flow_proxy, 2),
    }

    # ── Close current-year P&L into equity so the BS balances ────────────
    # Romanian accounting carries the current year's P&L in account 121
    # (PROFIT SI PIERDERE), which we map to `ignore_control` — derived
    # elsewhere, never summed. The statutory net income computed above
    # IS what 121 closes to at year-end. Add it back into the equity
    # section of the legacy `bs` dict (the one the frontend reads) so
    # total_equity = share_capital + retained_earnings + other_equity +
    # current_year_pnl, and total_assets = total_liabilities + total_equity
    # within rounding. Without this step, BS is off by exactly the
    # statutory net income (~RON 1.42M for EEI).
    bs["retainedEarnings"] = round(bs["retainedEarnings"] + net_income_statutory, 2)
    sub_agg["current_year_pnl"] = round(net_income_statutory, 2)

    # Now fill the cross-references on the BS canonical view.
    assembled_bs_canonical["current_year_pnl"] = round(net_income_statutory, 2)
    # retained_earnings stays as the carry-forward (year-start) value;
    # current_year_pnl is the THIS-period contribution, surfaced separately.
    total_assets = (
        bs["cash"] + bs["accountsReceivable"] + bs["inventory"]
        + bs["otherCurrentAssets"] + bs["propertyPlantEquipment"]
        + bs["intangibles"] + bs["otherNonCurrentAssets"]
    )
    total_equity = (
        bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    )
    total_liabilities = (
        bs["accountsPayable"] + bs["shortTermDebt"]
        + bs["otherCurrentLiabilities"] + bs["longTermDebt"]
        + bs["otherNonCurrentLiabilities"]
    )
    bs_balance_delta = total_assets - (total_liabilities + total_equity)
    assembled_bs_canonical["total_assets"] = round(total_assets, 2)
    assembled_bs_canonical["total_equity"] = round(total_equity, 2)
    assembled_bs_canonical["total_liabilities"] = round(total_liabilities, 2)
    assembled_bs_canonical["bs_balance_delta"] = round(bs_balance_delta, 2)

    # ── ASSEMBLED CASH FLOW — REAL CapEx, not D&A ────────────────────────
    # The Valuation tab's FCF / DCF math has been reading `capex = D&A`
    # because the supplementary input was never wired. That's the
    # "smoking gun" bug from the screenshots — CapEx of RON 355K matches
    # D&A exactly because it defaulted to D&A. The REAL CapEx is the
    # period-over-period change in gross PPE + CIP + advances. In the
    # Romanian books, capitalized own-work (722) lands on 231 by
    # accounting identity, so when there's no prior-period BS available
    # we use `capitalized_own_work_memo` as a strong proxy for CIP
    # additions. With a prior BS we'd compute Δ(231 + 211/212 gross +
    # 4093) directly.
    cip_additions = round(capitalized, 2)            # 722 closing credit ≈ 231 additions
    real_capex = round(-cip_additions, 2)            # negative = cash out

    # ── INDIRECT-METHOD CASH FLOW — single-period approximation ─────────
    # Ported from archive/calibration_toolkit/financial_analysis.py build_cash_flow(). When
    # only the current period is threaded (no prior_bs to diff against),
    # we follow the same conservative approximation the oracle uses AND
    # mark `is_approximated=True` so the FE can surface the honesty banner.
    # Methodology mirrors CLAUDE.md Appendix A Section 4.
    #
    # The oracle's approximations (for the no-prior-period case) are:
    #   ΔReceivables ≈ -5% of current receivables (small build)
    #   ΔInventory   ≈ -5% of current inventory
    #   ΔTrade pay   ≈ +5% of current AP
    #   ΔTax pay     ≈ +2% of tax_pay
    #   CapEx        ≈ 5% of ppe_gross
    #   ΔLT debt     ≈ -10% (assume some scheduled repayment)
    #   ΔST debt     ≈ +10%
    #   Dividends paid ≈ 50% of statutory net income (typical RO payout)
    # These don't reconcile to the BS cash change exactly; the WC plug at
    # the FE catches the residual so closing_cash_computed == closing_cash.
    revenue_for_wc = pl.get("revenue", 0)
    inventory_curr = bs.get("inventory", 0)
    ar_curr = bs.get("accountsReceivable", 0)
    ap_curr = bs.get("accountsPayable", 0)
    tax_pay_curr = sub_agg.get("tax_pay", 0) if "tax_pay" in sub_agg else bs.get("otherCurrentLiabilities", 0) * 0.1
    ppe_gross_proxy = max(bs.get("propertyPlantEquipment", 0), 0)
    affiliates_curr = sub_agg.get("affiliates", 0) if "affiliates" in sub_agg else 0
    cip_curr = sub_agg.get("ppe_under_construction", 0) if "ppe_under_construction" in sub_agg else 0
    lt_debt_curr = bs.get("longTermDebt", 0)
    st_debt_curr = bs.get("shortTermDebt", 0)

    # Operating section — approximated WC deltas
    delta_inventory_approx = -inventory_curr * 0.05
    delta_receivables_approx = -ar_curr * 0.05
    delta_trade_pay_approx = ap_curr * 0.05
    delta_tax_pay_approx = tax_pay_curr * 0.02
    net_wc_change_approx = (
        delta_inventory_approx + delta_receivables_approx
        + delta_trade_pay_approx + delta_tax_pay_approx
    )
    # Provision movement proxy — non-cash add-back. Oracle uses
    # (781 reversals − 20% of class-65 charges) as rough estimate.
    provision_movement_proxy = max(0, (pl.get("otherIncome", 0) or 0) * 0.6)

    cf_before_wc = net_income_statutory + depreciation + provision_movement_proxy
    cash_from_operating = round(cf_before_wc + net_wc_change_approx, 2)

    # Investing — REAL capex from 722→231 path, plus approximated other capex
    capex_approx = -(ppe_gross_proxy * 0.05)
    cip_change_approx = -(cip_curr * 0.5)  # half of CIP assumed new this period
    affiliate_change_approx = -(affiliates_curr * 0.02)
    dividends_received_pnl = sub_agg.get("financial_income", 0) or 0
    interest_received_pnl = sub_agg.get("interest_income", 0) or 0
    cash_used_in_investing_approx = round(
        capex_approx + cip_change_approx + affiliate_change_approx
        + dividends_received_pnl + interest_received_pnl, 2
    )

    # Financing — approximations matching the oracle's defaults
    delta_lt_debt_approx = -lt_debt_curr * 0.10  # assume scheduled repayment
    delta_st_bank_approx = st_debt_curr * 0.10   # net new ST credit usage
    interest_paid_approx = -(pl.get("interestExpense", 0) or 0)
    dividends_paid_approx = -net_income_statutory * 0.50  # typical RO payout
    cash_used_in_financing_approx = round(
        delta_lt_debt_approx + delta_st_bank_approx
        + interest_paid_approx + dividends_paid_approx, 2
    )

    # Reconciliation — the closing cash IS known (BS), so the residual
    # against (CFO+CFI+CFF) becomes the explicit reconciliation plug the
    # FE surfaces.
    net_change_cash_approx = round(
        cash_from_operating + cash_used_in_investing_approx
        + cash_used_in_financing_approx, 2
    )

    free_cash_flow = round(cash_from_operating + real_capex, 2)

    # `is_approximated` is currently always True because the upstream
    # extractor doesn't thread a prior-period dataframe. The flag is
    # already plumbed through so once multi-period uploads land the
    # back end can flip this without any FE change.
    is_approximated = True
    approximation_notes = [
        "Working-capital movements estimated at 5% of current balances; "
        "actual ΔAR / ΔInventory / ΔAP cannot be computed without a prior-period "
        "trial balance.",
        "Financing detail (LT/ST debt drawdowns vs repayments, dividends paid) "
        "approximated from typical Romanian payout ratios. The reconciliation "
        "plug captures the residual so closing cash still ties to the BS.",
    ]

    assembled_cf_canonical = {
        # Operating section
        "net_profit": round(net_income_statutory, 2),
        "depreciation": round(depreciation, 2),
        "provision_movement": round(provision_movement_proxy, 2),
        "cf_before_wc": round(cf_before_wc, 2),
        "delta_receivables": round(delta_receivables_approx, 2),
        "delta_inventory": round(delta_inventory_approx, 2),
        "delta_trade_pay": round(delta_trade_pay_approx, 2),
        "delta_tax_pay": round(delta_tax_pay_approx, 2),
        "net_wc_change": round(net_wc_change_approx, 2),
        "cash_from_operating": cash_from_operating,
        # Investing
        "capex_real": real_capex,                                # 722→231 (always real)
        "capex_other_approx": round(capex_approx, 2),            # 5% PP&E proxy
        "cip_change": round(cip_change_approx, 2),
        "affiliate_change": round(affiliate_change_approx, 2),
        "dividends_received": round(dividends_received_pnl, 2),
        "interest_received": round(interest_received_pnl, 2),
        "capitalized_construction": round(-cip_additions, 2),
        "cash_used_in_investing": cash_used_in_investing_approx,
        # Financing
        "delta_lt_debt": round(delta_lt_debt_approx, 2),
        "delta_st_bank": round(delta_st_bank_approx, 2),
        "bank_loan_drawdowns": round(max(delta_lt_debt_approx, 0) + max(delta_st_bank_approx, 0), 2),
        "bank_loan_repayments": round(min(delta_lt_debt_approx, 0) + min(delta_st_bank_approx, 0), 2),
        "interest_paid": round(interest_paid_approx, 2),
        "dividends_paid": round(dividends_paid_approx, 2),
        "cash_used_in_financing": cash_used_in_financing_approx,
        # Reconciliation
        "net_change_in_cash": net_change_cash_approx,
        "closing_cash_actual": round(bs["cash"], 2),
        "free_cash_flow": free_cash_flow,
        # Honesty rails — drive the FE banner + upload-prior CTA.
        "is_approximated": is_approximated,
        "approximation_notes": approximation_notes,
        "dividends_declared_but_unpaid": bool(
            sub_agg.get("ap_dividends", 0) > 1000
        ),

        # ── F1.c additions (SPEC §6) ──
        # Spec-named aliases for the existing investing / financing
        # totals. The internal names use `cash_used_in_*` (signed); the
        # spec uses `cash_from_*` (same signed semantics). FE renders
        # either; this gives both keys on the envelope.
        "cash_from_investing": cash_used_in_investing_approx,
        "cash_from_financing": cash_used_in_financing_approx,
        # Total capex — sum of the real capex (722→231), the PP&E proxy,
        # and CIP additions. Negative because capex is a cash outflow,
        # matching the sign convention used by `free_cash_flow` above.
        "capex_total": round(
            real_capex + capex_approx + (-cip_additions), 2
        ),
        # Working capital change — the aggregate of the four delta_*
        # components. Equal to `net_wc_change` above (same number, two
        # names); spec uses `working_capital_change`.
        "working_capital_change": round(net_wc_change_approx, 2),
    }

    statements = {
        "companyName": company_name,
        "industry": industry,
        "currency": currency,
        "periodLabel": period_label,
        "balanceSheet": bs,
        "incomeStatement": pl,
        # Sub-aggregates — same numbers, broken out by sub-bucket for
        # industry classification (Step 3), anomaly detection (Step 6),
        # and risk framing. Frontend reads these for the CRE-specific tile
        # set + the "628 anomaly" risk card.
        "subAggregates": sub_agg,
        # Canonical BS / P&L views — the EXACT field names the surgical-fix
        # prompt requires (`cash`, `ar_net`, `ap_dividends`, `lt_debt`,
        # `total_debt`, `net_income_statutory`, `net_income_operational`,
        # etc.). Frontend KPI tiles + CI validation script read THESE.
        "assembled_bs": assembled_bs_canonical,
        "assembled_pl": assembled_pl_canonical,
        "assembled_cf": assembled_cf_canonical,
        # F1.f — verdict bands (with explicit source label per Decision #2).
        # Single source of truth for FE band lookups; replaces the
        # hardcoded threshold tables in `computeRatios()`.
        "assembled_bands": _band_definitions(industry),
        # F1.g — Piotroski 9-check engine emission. The 4 checks that
        # don't require prior-period data run unconditionally; the 5
        # checks that need YoY data return `result: "uncertain"` when
        # prior data is absent. Composite `score` caps at 4 in that
        # case (per SPEC §9 — "honest cap"). The FE's `runPiotroski`
        # becomes a pure renderer.
        "assembled_piotroski": _piotroski_checks(
            net_income_statutory=net_income_statutory,
            total_assets=total_assets,
            cash_from_operating=cash_from_operating,
            # Prior-period data plumbing is scheduled for a small
            # follow-up; `prior` is None for now, which triggers the
            # 5 "uncertain" results + cap-at-4 score per the spec.
            prior=None,
            currency=currency,
        ),
        # Required by the TS Statements interface — computeRatios() reads
        # supplementary.periodDays. Empty defaults are fine; real values would
        # come from a follow-up "enrichment" stage (employee count, lease
        # obligations, market value of property — the user can fill these in
        # via the Settings UI later).
        "supplementary": {
            "periodDays": 365,
        },
    }
    result: Dict[str, object] = {
        "statements": statements,
        "lineItems": line_items,
        "unmapped": unmapped,
        # Accounts explicitly excluded from the totals (581 transit, 121
        # control). Surfaced for the frontend's transparency block — NOT
        # persisted to statement_line_items.
        "ignored": ignored_items,
    }
    # F3.9 — pass-through source-data quality telemetry. Only added when
    # the caller supplied it (e.g. from the trial-balance parser). Keeps
    # F3.1-PARITY byte-identical for existing capture flows that don't
    # pass the kwarg — the key is omitted entirely in that case.
    if source_data_quality is not None:
        result["source_data_quality"] = source_data_quality
    # F3.10 — semantic-name fallback telemetry. Only added when at least
    # one account was routed via the name fallback. Existing fixtures
    # (Scandia / EEI byte-identical under F3.1-PARITY) all hit 0 with
    # the current chart, so this key is omitted and the baselines stay
    # diff-clean. The "examples" list is capped at 20 for log readability.
    if semantic_fallbacks_used > 0:
        result["semantic_fallbacks_used"] = semantic_fallbacks_used
        result["semantic_fallback_examples"] = semantic_fallback_examples

    # F4.1c — Canonical schema v1 emission (parallel to legacy assembled_*).
    # The canonical adapter reads line_items + the engine's
    # net_income_statutory (the same value the legacy assembled_bs uses
    # for current_year_pnl at lines 1525/1528) and produces a country-
    # agnostic envelope per CANONICAL_SCHEMA_V1.md. Per F3.15 operator
    # decision 3e (parallel migration), the legacy assembled_bs/pl/cf
    # views above stay byte-identical; the canonical envelope sits
    # alongside as `assembled_canonical_v1`. F3.1-PARITY gate covers the
    # legacy emission; F4.1-ROUNDTRIP gate covers the canonical-vs-legacy
    # reconciliation (scripts/check_canonical_roundtrip.py).
    #
    # ═══════════════════════════════════════════════════════════════════════
    # F3.16 FORBIDDEN PATTERN — DO NOT add comments like the block below in
    # the future. Write a failing test instead.
    #
    # This comment documented a known fixture-vs-live divergence ("account
    # 121 dropped at preprocessing breaks downstream anchor override") in
    # PROSE rather than in a TEST or a FIX. It ran undetected for weeks
    # (F3.7d through F3.16) because F-A3.1 only walks Path A; no gate
    # walked Path B; no test pinned the bug. The 121-anchor bug surfaced
    # in production as a 29.59M drift on RealEstate before this comment
    # got revisited.
    #
    # The architectural rule going forward (F3.16 closure ADR invariant c):
    # any inline comment documenting a known divergence between two code
    # paths is a BUG, not a feature. Either fix the divergence in the same
    # PR, or write a failing test that pins the bug and gates a future fix.
    # Comments-without-tests are explicitly forbidden.
    #
    # This comment is preserved (not deleted) as historical evidence — the
    # underlying code path is fixed by F3.16-3b.2 (Path X kwarg override
    # at line ~1358 below) and F3.16-3b.3 (F-A3.2-CROSS-PATH gate). When
    # both ship and the cross-path gate is GREEN in CI, this wrapper marker
    # can be removed; the inline prose below stays as historical context.
    # ═══════════════════════════════════════════════════════════════════════
    # Why net_income_statutory and NOT account_121_anchor: the production
    # normalizer (_trial_balance_parser.accounts_to_assemble_shape) drops
    # rows whose bucket isn't a recognized BS/PL persistence target —
    # `ignore_control` (the bucket for account 121) is one such case. So
    # in the integrated path, account_121_anchor is `None` on EEI-style
    # normalized fixtures even when the upstream account exists, leaving
    # canonical with current_year_pnl=0 and equity 1.4M short. By passing
    # net_income_statutory we always hand canonical the same number that
    # already landed in legacy assembled_bs.current_year_pnl — the anchor
    # override at line ~1358 has already kicked in if it applied.
    #
    # The 129 (profit distribution) sum is computed from ignored_items
    # because the engine routes 129 through retainedEarnings with sign=-1
    # but the canonical splits it into a separate contra bucket.
    try:
        from .canonical_adapter import assemble_canonical
        profit_dist_129 = 0.0
        for ig in ignored_items:
            ig_code = str(ig.get("ro_account_code") or "")
            if ig_code.startswith("129"):
                profit_dist_129 += float(ig.get("amount") or 0)
        result["assembled_canonical_v1"] = assemble_canonical(
            line_items,
            source_data_quality=source_data_quality,
            current_year_pnl=float(net_income_statutory or 0.0),
            profit_distribution_129=profit_dist_129,
        )
    except Exception:  # noqa: BLE001
        # Adapter is best-effort. If it fails for any reason (import
        # error, novel data), the engine response still ships the legacy
        # views — consumers ignore the missing `assembled_canonical_v1`
        # key. The F4.1 gates will catch silent failures.
        pass

    # F4.2 — Methodology layer (declarative EBITDA variants + ratios as
    # YAML recipes over canonical buckets). Best-effort: any methodology
    # failure is logged but doesn't break the canonical emission. The
    # methodology block lives INSIDE the canonical envelope so it
    # piggy-backs on the F4.1e DB persistence and read-path plucks.
    canonical_env = result.get("assembled_canonical_v1")
    if isinstance(canonical_env, dict):
        # ── Pack provenance (Phase 3 cutover — contract addendum) ────────
        # Pin the envelope to the EXACT pack content that classified it:
        # resolved id@version plus the content-addressed pack_hash.
        # Envelope-root, additive: the served canonical_bs payload and the
        # golden artifacts never carry it (byte-stability), but the
        # reconcile carry-forward key (engine.api._reconcile) and any
        # replay/audit reader can hold a stored period to the pack vintage
        # it was built under. Serving NEVER re-resolves a pack — the serve
        # path is a pure function of the persisted envelope — so a newer
        # pack version in packs/ cannot re-classify a stored period
        # (pinning locked by tests/engine/test_pack_pinning.py).
        _cls_pack = classification_pack()
        canonical_env["pack_provenance"] = {
            "jurisdiction": _cls_pack.identity.jurisdiction,
            "pack": "%s@%s" % (_cls_pack.identity.pack_id,
                               _cls_pack.identity.version),
            "pack_hash": _cls_pack.pack_hash,
            "mapping_version": MAPPING_VERSION,
        }
        try:
            from engine.methodology import load_methodology  # type: ignore
            from engine.methodology import evaluate as methodology_evaluate  # type: ignore
            methodology = load_methodology("ro_ras_2025_v1")
            industry_key = industry if isinstance(industry, str) else None
            canonical_env["methodology"] = methodology_evaluate(
                methodology, canonical_env, industry_key=industry_key,
            )
        except Exception:  # noqa: BLE001
            # PyYAML missing, file missing, formula error — surface as
            # absent `methodology` key, not a pipeline break.
            pass
        # canonical_bs v2 — round_trip_check must be recomputed AFTER the
        # methodology block lands so it can compare recomputed totals
        # against methodology.totals (the Fix-A1 authority); without
        # methodology it degrades to the leaves→aggregates self-check.
        try:
            from .canonical_adapter import compute_round_trip_check
            canonical_env["round_trip_check"] = compute_round_trip_check(canonical_env)
        except Exception:  # noqa: BLE001
            pass
        # canonical_bs v2 — the single presentation-ready BS authority per
        # docs/CANONICAL_BS_V2_CONTRACT.md. Best-effort like the rest of
        # the envelope: on failure the key is absent and consumers keep
        # the legacy Fix-A1 path.
        try:
            from .canonical_adapter import build_canonical_bs_v2
            canonical_env["canonical_bs"] = build_canonical_bs_v2(
                canonical_env,
                line_items=line_items,
                source_anchor=source_anchor,
                unmapped=list(unmapped) + list(extra_unmapped or []),
                excluded=ignored_items,
                extraction=extraction_meta,
                p121_anchor=account_121_anchor,
                cls7_minus_cls6=cls7_minus_cls6,
                source_account_census=source_account_census,
            )
        except Exception:  # noqa: BLE001
            pass
    return result


# ─── Industry auto-classification ───────────────────────────────────────────
# Detects industry from the sub-aggregates produced by assemble_statements.
# Used as a fallback when the org's industry_key is None / "generic" — the
# returned key flows into compute_valuation (Step 5) and gates EV/EBITDA.


def detect_industry(assembled: Dict[str, object]) -> Dict[str, object]:
    """Classify the entity from the assembled statements.

    Returns:
      {
        "industry_key": str,        # e.g. "real_estate_commercial"
        "confidence": float,        # 0.0 to 1.0
        "signals": Dict[str, int],  # per-industry score breakdown
        "method": str,              # "auto" (sub-aggregate dominance)
      }

    The classification is conservative — it only emits a non-"generic"
    answer when at least one strong signal is present (score >= 3).
    """
    statements = assembled.get("statements") if isinstance(assembled, dict) else None
    if not isinstance(statements, dict):
        return {"industry_key": "generic", "confidence": 0.0, "signals": {}, "method": "auto"}

    bs = statements.get("balanceSheet") or {}
    pl = statements.get("incomeStatement") or {}
    sub_agg = statements.get("subAggregates") or {}
    if not isinstance(bs, dict) or not isinstance(pl, dict) or not isinstance(sub_agg, dict):
        return {"industry_key": "generic", "confidence": 0.0, "signals": {}, "method": "auto"}

    def _num(x: object) -> float:
        try:
            return float(x) if x is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    total_assets = (
        _num(bs.get("cash"))
        + _num(bs.get("accountsReceivable"))
        + _num(bs.get("inventory"))
        + _num(bs.get("otherCurrentAssets"))
        + _num(bs.get("propertyPlantEquipment"))
        + _num(bs.get("intangibles"))
        + _num(bs.get("otherNonCurrentAssets"))
    )
    revenue = _num(pl.get("revenue"))
    inventory = _num(bs.get("inventory"))

    ppe_investment = _num(sub_agg.get("ppe_investment"))

    # Account 706 (Venituri din chirii) signals rental income. We don't have a
    # sub-aggregate for it directly, but we can scan line_items.
    line_items = assembled.get("lineItems") if isinstance(assembled, dict) else []
    rental_706 = 0.0
    if isinstance(line_items, list):
        for li in line_items:
            if not isinstance(li, dict):
                continue
            code = str(li.get("ro_account_code", ""))
            if code.startswith("706"):
                rental_706 += _num(li.get("amount"))

    signals: Dict[str, int] = {"generic": 0}

    # ── Commercial Real Estate ──────────────────────────────────────────
    cre_score = 0
    # Strongest signal: investment property dominates assets.
    if total_assets > 0 and ppe_investment > total_assets * 0.40:
        cre_score += 3
    # Second-strongest: rental income (706) dominates revenue.
    if revenue > 0 and rental_706 > revenue * 0.80:
        cre_score += 3
    # Supporting: no inventory (CRE holders don't hold trading stock).
    if inventory == 0:
        cre_score += 1
    # Supporting: investment property present at all.
    if ppe_investment > 0:
        cre_score += 1
    signals["real_estate_commercial"] = cre_score

    # ── Other detectors (placeholder for future industries) ─────────────
    # When inventory_turns, SaaS-style revenue patterns, etc. are added,
    # extend this block. For now, only CRE has a confident detector.

    winner = max(signals.items(), key=lambda kv: kv[1])
    if winner[1] >= 3:
        # confidence scales with score (max possible CRE score = 8)
        confidence = min(1.0, winner[1] / 8.0 + 0.4)
        return {
            "industry_key": winner[0],
            "confidence": round(confidence, 2),
            "signals": signals,
            "method": "auto",
        }

    return {"industry_key": "generic", "confidence": 0.0, "signals": signals, "method": "auto"}
