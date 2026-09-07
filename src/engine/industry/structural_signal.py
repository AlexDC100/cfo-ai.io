"""What the account mix says the company does — with the evidence.

THE PROBLEM THIS EXISTS FOR
===========================
`organizations.industry_key` is a USER SETTING chosen once at signup.
Nothing checked it against the book. The Agras Dec-2025 report was headed
"Real estate · residential rental" over a trial balance carrying 301 raw
materials, 341 semi-finished, 345 finished goods and 26.5M of 607
merchandise cost — and the sector-calibrated content downstream (findings
gated on `industries: [...]`, industry-keyed Debt/EBITDA thresholds, the
AI narrative's sector vocabulary) followed the setting, not the book.

WHAT THIS RETURNS, AND WHAT IT REFUSES TO RETURN
================================================
A RANKED set of candidate families, each carrying the ACCOUNTS, their
balances and the share of revenue or assets they represent. Never a bare
label: a signal a reader cannot audit is not evidence.

It answers at FAMILY level — manufacturing / trade / real_estate /
services — because that is what a Romanian chart of accounts actually
discriminates. It does NOT claim to tell food manufacturing from
industrial manufacturing, or commercial from residential rental: the
account codes do not carry that, and asserting it would be a fabrication.
Sub-sector remains the user's to state; this module's job is to notice
when the user's answer and the book are in different FAMILIES.

It says `undetermined` rather than guessing when:
  · no family clears `_MIN_SCORE`, or
  · the top two families are within `_MIN_MARGIN` of each other, or
  · too little of the mix is measurable to score the leader at all
    (`_MIN_AVAILABLE_WEIGHT`) — a book with no revenue and no assets
    tells you nothing, and "generic" would be a claim, not a reading.

ABSENT IS NOT ZERO
==================
A marker whose BASIS is unavailable (revenue 0 → every share-of-revenue
marker; total assets 0 → every share-of-assets marker) is not scored as
"did not fire". It is dropped from the family's denominator and recorded
with `"available": false`, so a book that carries half the evidence is
not silently graded as if it had failed the other half.

CALIBRATION
===========
Measured on the four committed real books (see
`tests/engine/test_structural_industry_signal.py`, which asserts these):

  agras       manufacturing 1.000  (2nd trade 0.125)      DECIDED
  carniprod   manufacturing 1.000  (2nd real_estate .125) DECIDED
  retail      trade         1.000  (2nd —      0.000)     DECIDED
  realestate  real_estate   0.625  (2nd services 0.200)   DECIDED

No I/O. No DB. No network. Python 3.9 (no `X | Y`, no `match`).
"""

from __future__ import annotations

from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple

SCHEMA_VERSION = "structural-industry-signal/1"

# ── The families this module is willing to name ───────────────────────
FAMILY_MANUFACTURING = "manufacturing"
FAMILY_TRADE = "trade"
FAMILY_REAL_ESTATE = "real_estate"
FAMILY_SERVICES = "services"

FAMILIES: Tuple[str, ...] = (
    FAMILY_MANUFACTURING,
    FAMILY_TRADE,
    FAMILY_REAL_ESTATE,
    FAMILY_SERVICES,
)

FAMILY_DISPLAY: Dict[str, str] = {
    FAMILY_MANUFACTURING: "Manufacturing / production",
    FAMILY_TRADE: "Trade / distribution",
    FAMILY_REAL_ESTATE: "Real estate / property",
    FAMILY_SERVICES: "Services",
}

# ── RO chart-of-accounts groups (OMFP 1802) ───────────────────────────
# Every group is named once here and quoted by the markers, so a reader
# checking a marker's evidence and a reader checking this table are
# reading the same list.
_ACCOUNT_GROUPS: Dict[str, Tuple[Tuple[str, ...], str]] = {
    # PL — revenue
    "rev_own_production": (("701", "702", "703"), "Sales of own production (701 finished, 702 semi-finished, 703 residues)"),
    "rev_merchandise":    (("707",), "Sales of merchandise bought for resale (707)"),
    "rev_services":       (("704", "705"), "Services rendered and studies (704, 705)"),
    "rev_rent":           (("706",), "Rent and royalties (706)"),
    "rev_all":            (("70",), "Net turnover (class 70, 709 reductions included as served)"),
    # PL — cost
    "cost_materials":     (("601", "602"), "Raw materials and consumables consumed (601, 602)"),
    "cost_merchandise":   (("607",), "Cost of merchandise sold (607)"),
    # BS — stock
    "stock_raw":          (("301", "302", "303", "381"), "Raw-material, consumable and packaging stock (301, 302, 303, 381)"),
    "stock_production":   (("331", "332", "341", "345", "346"), "Work-in-progress and own-produced stock (331, 332, 341, 345, 346)"),
    "stock_merchandise":  (("371",), "Merchandise held for resale (371)"),
    "stock_all":          (("3",), "Class-3 stock, net of 39x provisions"),
    # BS — tangible fixed assets, at gross
    "fixed_land_building": (("211", "212"), "Land and buildings (211, 212)"),
    "fixed_equipment":     (("213", "214"), "Plant, equipment, vehicles and fittings (213, 214)"),
    "fixed_investment":    (("215",), "Investment property (215)"),
}


def _codes(group: str) -> Tuple[str, ...]:
    return _ACCOUNT_GROUPS[group][0]


def _group_label(group: str) -> str:
    return _ACCOUNT_GROUPS[group][1]


# ── Decision thresholds — stated once, quoted into the served payload ──
_MIN_SCORE = 0.55            # the leader must clear this to be a reading
_MIN_MARGIN = 0.15           # …and stand this far clear of the runner-up
_MIN_AVAILABLE_WEIGHT = 4.0  # …on at least this much measurable evidence

_STRONG = 3.0
_SUPPORTING = 1.0


class _Marker(object):
    """One scored observation about the account mix.

    `basis` names WHAT the observation is a share of. A marker whose
    basis is not measurable is dropped from the denominator rather than
    counted as a miss — see the module docstring.
    """

    def __init__(
        self,
        key: str,
        family: str,
        weight: float,
        basis: str,
        numerator: Sequence[str],
        threshold: float,
        direction: str,
        sentence: str,
        requires: Optional[Sequence[str]] = None,
    ) -> None:
        self.key = key
        self.family = family
        self.weight = weight
        self.basis = basis              # 'revenue' | 'assets' | 'tangible_fixed'
        self.numerator = tuple(numerator)  # account-group names
        self.threshold = threshold
        self.direction = direction      # 'gte' | 'lt'
        self.sentence = sentence
        # Other markers of the same family that must have FIRED for this
        # one to count. Absence-of-X is only evidence next to a positive.
        self.requires = tuple(requires or ())


_MARKERS: Tuple[_Marker, ...] = (
    # ── Manufacturing ────────────────────────────────────────────────
    _Marker("own_production_revenue", FAMILY_MANUFACTURING, _STRONG, "revenue",
            ("rev_own_production",), 0.30, "gte",
            "Sales of own production are {pct} of revenue"),
    _Marker("production_stock", FAMILY_MANUFACTURING, _SUPPORTING, "assets",
            ("stock_production",), 0.005, "gte",
            "Work-in-progress / own-produced stock is {pct} of total assets"),
    _Marker("material_cost", FAMILY_MANUFACTURING, _SUPPORTING, "revenue",
            ("cost_materials",), 0.20, "gte",
            "Raw materials and consumables consumed are {pct} of revenue"),
    _Marker("raw_material_stock", FAMILY_MANUFACTURING, _SUPPORTING, "assets",
            ("stock_raw",), 0.005, "gte",
            "Raw-material stock is {pct} of total assets"),
    # ── Trade ────────────────────────────────────────────────────────
    _Marker("merchandise_revenue", FAMILY_TRADE, _STRONG, "revenue",
            ("rev_merchandise",), 0.60, "gte",
            "Sales of merchandise bought for resale are {pct} of revenue"),
    _Marker("merchandise_cost", FAMILY_TRADE, _STRONG, "revenue",
            ("cost_merchandise",), 0.55, "gte",
            "Cost of merchandise sold is {pct} of revenue"),
    _Marker("merchandise_stock", FAMILY_TRADE, _SUPPORTING, "assets",
            ("stock_merchandise",), 0.01, "gte",
            "Merchandise held for resale is {pct} of total assets"),
    _Marker("no_production_stock", FAMILY_TRADE, _SUPPORTING, "assets",
            ("stock_production",), 0.005, "lt",
            "No material work-in-progress stock ({pct} of total assets)",
            requires=("merchandise_revenue", "merchandise_cost")),
    # ── Real estate ──────────────────────────────────────────────────
    _Marker("rent_revenue", FAMILY_REAL_ESTATE, _STRONG, "revenue",
            ("rev_rent",), 0.50, "gte",
            "Rent and royalties are {pct} of revenue"),
    _Marker("investment_property", FAMILY_REAL_ESTATE, _STRONG, "assets",
            ("fixed_investment",), 0.20, "gte",
            "Investment property is {pct} of total assets"),
    _Marker("land_and_buildings_dominate", FAMILY_REAL_ESTATE, _SUPPORTING, "tangible_fixed",
            ("fixed_land_building",), 0.50, "gte",
            "Land and buildings are {pct} of gross tangible fixed assets"),
    _Marker("no_cost_of_sales", FAMILY_REAL_ESTATE, _SUPPORTING, "revenue",
            ("cost_materials", "cost_merchandise"), 0.05, "lt",
            "Materials and merchandise cost is {pct} of revenue"),
    # ── Services ─────────────────────────────────────────────────────
    _Marker("service_revenue", FAMILY_SERVICES, _STRONG, "revenue",
            ("rev_services",), 0.50, "gte",
            "Services rendered are {pct} of revenue"),
    _Marker("no_stock_at_all", FAMILY_SERVICES, _SUPPORTING, "assets",
            ("stock_all",), 0.005, "lt",
            "Class-3 stock is {pct} of total assets"),
    _Marker("no_cost_of_goods", FAMILY_SERVICES, _SUPPORTING, "revenue",
            ("cost_materials", "cost_merchandise"), 0.10, "lt",
            "Materials and merchandise cost is {pct} of revenue"),
)


# ── Workspace-key → families it claims ────────────────────────────────
#
# The comparison is only as honest as this table, so each entry says
# WHY. A key that maps to more than one family cannot be contradicted by
# either of them — the user's label genuinely spans both.
_KEY_FAMILIES: Dict[str, Tuple[Tuple[str, ...], str]] = {
    "real_estate":             ((FAMILY_REAL_ESTATE,), "commercial property — rental income and a property book"),
    "real_estate_residential": ((FAMILY_REAL_ESTATE,), "residential rental — rental income and a property book"),
    "saas":                    ((FAMILY_SERVICES,), "recurring software revenue, no stock"),
    "professional_services":   ((FAMILY_SERVICES,), "billable services, no stock"),
    "healthcare":              ((FAMILY_SERVICES,), "clinical services"),
    "logistics":               ((FAMILY_SERVICES,), "transport services"),
    "retail_ecom":             ((FAMILY_TRADE,), "goods bought for resale"),
    "manufacturing":           ((FAMILY_MANUFACTURING,), "own production"),
    "agriculture":             ((FAMILY_MANUFACTURING,), "own production (crop / livestock output)"),
    # Deliberately two families each — the catalog label spans both, so
    # neither reading contradicts it.
    "fmcg":                    ((FAMILY_TRADE, FAMILY_MANUFACTURING),
                                "the catalog label reads 'food & beverage distribution' but the key is used for food producers too"),
    "construction":            ((FAMILY_MANUFACTURING, FAMILY_SERVICES),
                                "project WIP books like production; contracting books like services"),
    # No families: the user declined to name a sector, so there is no
    # claim for the account mix to contradict.
    "other":                   ((), "generic SME thresholds — the user named no sector"),
}


def _num(x: Any) -> float:
    try:
        if x is None:
            return 0.0
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _sum_codes(
    items: Sequence[Dict[str, Any]],
    statement: str,
    prefixes: Sequence[str],
) -> Tuple[float, List[Dict[str, Any]]]:
    """Total and per-account detail for the accounts under `prefixes`.

    Returns the SERVED amounts unchanged — sign included. A 39x stock
    provision arrives negative and nets down the stock it provisions,
    which is the balance a reader would check against the trial balance.
    """
    total = 0.0
    per_account: Dict[str, float] = {}
    for it in items:
        if str(it.get("statement") or "") != statement:
            continue
        code = str(it.get("ro_account_code") or "").strip()
        if not code:
            continue
        if not any(code.startswith(p) for p in prefixes):
            continue
        amount = _num(it.get("amount"))
        total += amount
        # Roll per-account detail up to the synthetic account (first 3
        # digits) so the evidence list stays readable on a 300-line book.
        head = code[:3]
        per_account[head] = per_account.get(head, 0.0) + amount
    accounts = [
        {"code": c, "amount": round(v, 2)}
        for c, v in sorted(per_account.items())
        if abs(v) >= 0.005
    ]
    return total, accounts


def _pct(value: float) -> str:
    return "%.1f%%" % (value * 100.0)


def _money(value: float) -> str:
    return "{:,.2f}".format(value)


def structural_signal(
    line_items: Iterable[Dict[str, Any]],
    total_assets: Optional[float] = None,
    revenue: Optional[float] = None,
) -> Dict[str, Any]:
    """Read the account mix. Returns a JSON-serializable ranked reading.

    `total_assets` / `revenue` are the SERVED totals when the caller has
    them (`assembled_bs.total_assets`, `assembled_pl.revenue`); both fall
    back to a sum over the line items, and the payload records which
    basis was used so a reader can reproduce every share.
    """
    items = [it for it in (line_items or []) if isinstance(it, dict)]

    # ── The two bases every share is measured against ─────────────────
    revenue_from_items, _ = _sum_codes(items, "PL", _codes("rev_all"))
    if revenue is None or not _is_finite(revenue):
        revenue_value = revenue_from_items
        revenue_basis = "line items, class 70"
    else:
        revenue_value = float(revenue)
        revenue_basis = "served assembled_pl.revenue"

    if total_assets is None or not _is_finite(total_assets):
        # Line-item fallback: every BS bucket the mapping calls an asset.
        assets_value = _sum_asset_buckets(items)
        assets_basis = "line items, asset buckets"
    else:
        assets_value = float(total_assets)
        assets_basis = "served assembled_bs.total_assets"

    tangible_fixed, _ = _sum_codes(
        items, "BS",
        _codes("fixed_land_building") + _codes("fixed_equipment") + _codes("fixed_investment"),
    )

    bases: Dict[str, Dict[str, Any]] = {
        "revenue": {
            "value": round(revenue_value, 2),
            "source": revenue_basis,
            "measurable": revenue_value > 0,
        },
        "assets": {
            "value": round(assets_value, 2),
            "source": assets_basis,
            "measurable": assets_value > 0,
        },
        "tangible_fixed": {
            "value": round(tangible_fixed, 2),
            "source": "line items, 211–215 at gross",
            "measurable": tangible_fixed > 0,
        },
    }

    # ── Score every marker ────────────────────────────────────────────
    fired: Dict[str, bool] = {}
    evaluated: Dict[str, Dict[str, Any]] = {}
    for m in _MARKERS:
        basis = bases[m.basis]
        # Where the numerator's accounts live. `rev_*` / `cost_*` groups
        # are class 6/7 movements (PL); every other group is a closing
        # balance (BS). One rule, read off the group name.
        statement = "PL" if m.numerator[0].startswith(("rev_", "cost_")) else "BS"
        numerator = 0.0
        accounts: List[Dict[str, Any]] = []
        groups: List[str] = []
        for group in m.numerator:
            part, part_accounts = _sum_codes(items, statement, _codes(group))
            numerator += part
            accounts.extend(part_accounts)
            groups.append(_group_label(group))
        record: Dict[str, Any] = {
            "key": m.key,
            "family": m.family,
            "weight": m.weight,
            "reads": groups,
            "accounts": accounts,
            "amount": round(numerator, 2),
            "basis": m.basis,
            "basis_amount": basis["value"],
            "basis_source": basis["source"],
            "test": ("share %s %s" % (">=" if m.direction == "gte" else "<", _pct(m.threshold))),
        }
        if not basis["measurable"]:
            record["available"] = False
            record["fired"] = False
            record["share"] = None
            record["statement"] = (
                "Not measurable — %s is %s, so this share has no denominator."
                % (m.basis.replace("_", " "), _money(basis["value"]))
            )
            evaluated[m.key] = record
            fired[m.key] = False
            continue
        share = numerator / basis["value"]
        hit = share >= m.threshold if m.direction == "gte" else share < m.threshold
        record["available"] = True
        record["share"] = round(share, 6)
        record["fired"] = bool(hit)
        record["statement"] = m.sentence.format(pct=_pct(share)) + (
            " (%s of %s)" % (_money(numerator), _money(basis["value"]))
        )
        evaluated[m.key] = record
        fired[m.key] = bool(hit)

    # A "requires" marker only counts once its positive partner fired.
    for m in _MARKERS:
        if not m.requires:
            continue
        rec = evaluated[m.key]
        if not any(fired.get(k) for k in m.requires):
            if rec.get("fired"):
                rec["fired"] = False
                rec["statement"] += (
                    " — not counted: absence is only evidence next to a positive (%s)."
                    % ", ".join(m.requires)
                )
            fired[m.key] = False

    # ── Roll markers up to families ───────────────────────────────────
    candidates: List[Dict[str, Any]] = []
    for family in FAMILIES:
        markers = [evaluated[m.key] for m in _MARKERS if m.family == family]
        available_weight = sum(r["weight"] for r in markers if r["available"])
        points = sum(r["weight"] for r in markers if r["fired"])
        score = (points / available_weight) if available_weight > 0 else 0.0
        candidates.append({
            "family": family,
            "display": FAMILY_DISPLAY[family],
            "score": round(score, 4),
            "points": round(points, 2),
            "available_weight": round(available_weight, 2),
            "max_weight": round(sum(m.weight for m in _MARKERS if m.family == family), 2),
            "markers": markers,
        })
    candidates.sort(key=lambda c: (-c["score"], -c["points"], c["family"]))

    top = candidates[0]
    runner_up = candidates[1] if len(candidates) > 1 else None
    margin = top["score"] - (runner_up["score"] if runner_up else 0.0)

    reasons: List[str] = []
    if top["available_weight"] < _MIN_AVAILABLE_WEIGHT:
        reasons.append(
            "only %.0f of %.0f points of evidence are measurable on this book (need %.0f)"
            % (top["available_weight"], top["max_weight"], _MIN_AVAILABLE_WEIGHT)
        )
    if top["score"] < _MIN_SCORE:
        reasons.append(
            "the strongest reading scores %.3f, below the %.2f a reading must clear"
            % (top["score"], _MIN_SCORE)
        )
    if margin < _MIN_MARGIN:
        reasons.append(
            "%s (%.3f) and %s (%.3f) are within %.2f of each other"
            % (top["family"], top["score"],
               runner_up["family"] if runner_up else "—",
               runner_up["score"] if runner_up else 0.0,
               _MIN_MARGIN)
        )

    decided = not reasons
    return {
        "schema_version": SCHEMA_VERSION,
        "verdict": "decided" if decided else "undetermined",
        "family": top["family"] if decided else None,
        "display": FAMILY_DISPLAY[top["family"]] if decided else None,
        "score": top["score"],
        "margin": round(margin, 4),
        "candidates": candidates,
        "bases": bases,
        "thresholds": {
            "min_score": _MIN_SCORE,
            "min_margin": _MIN_MARGIN,
            "min_available_weight": _MIN_AVAILABLE_WEIGHT,
        },
        "undetermined_because": reasons,
        "resolves_to": "family",
        "cannot_resolve": (
            "Sub-sector. A Romanian chart of accounts distinguishes production "
            "from trade from property from services; it does not distinguish "
            "food manufacturing from industrial manufacturing, or commercial "
            "from residential rental."
        ),
    }


def _is_finite(x: Any) -> bool:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return False
    return v == v and v not in (float("inf"), float("-inf"))


_ASSET_BUCKETS = (
    "cash", "ar", "inventory", "otherCurrentAssets",
    "ppe", "intangibles", "otherNonCurrentAssets",
)


def _sum_asset_buckets(items: Sequence[Dict[str, Any]]) -> float:
    total = 0.0
    for it in items:
        if str(it.get("statement") or "") != "BS":
            continue
        if str(it.get("bucket") or "") in _ASSET_BUCKETS:
            total += _num(it.get("amount"))
    return total


def workspace_families(industry_key: Optional[str]) -> FrozenSet[str]:
    """Families the workspace setting claims. Empty = claims nothing."""
    key = (industry_key or "").strip().lower()
    entry = _KEY_FAMILIES.get(key)
    if entry is None:
        return frozenset()
    return frozenset(entry[0])


def _key_note(industry_key: Optional[str]) -> Optional[str]:
    key = (industry_key or "").strip().lower()
    entry = _KEY_FAMILIES.get(key)
    return entry[1] if entry else None


def industry_agreement(
    signal: Dict[str, Any],
    industry_key: Optional[str],
    industry_display: Optional[str] = None,
) -> Dict[str, Any]:
    """Compare the reading with the workspace setting.

    `agreement` is one of:
      · `agree`         — the setting's family is the one the book reads
      · `disagree`      — different FAMILIES; sector content is blocked
      · `unspecified`   — no setting, or a setting that names no family
                          ("Other"), so there is nothing to contradict
      · `unverifiable`  — the account mix could not be read, or the key
                          is not in the catalog; the setting stands, and
                          the report says the check did not run

    "Materially" is FAMILY level and nothing finer. A user who set
    `real_estate` on a book that reads `real_estate` is not asked to
    confirm `residential` vs `commercial` — the account mix cannot see
    that difference and must not pretend to.
    """
    key = (industry_key or "").strip().lower()
    display = industry_display or industry_key or None
    families = workspace_families(key)
    known_key = key in _KEY_FAMILIES

    if signal.get("verdict") != "decided":
        agreement = "unverifiable"
        reason = (
            "The account mix does not read clearly enough to check the workspace "
            "setting: " + "; ".join(signal.get("undetermined_because") or ["no evidence"]) + "."
        )
    elif not key:
        agreement = "unspecified"
        reason = (
            "This workspace has no industry set. The account mix reads as %s."
            % signal.get("display")
        )
    elif not known_key:
        agreement = "unverifiable"
        reason = (
            "The workspace industry '%s' is not in the catalog this check knows, "
            "so it cannot be compared with the account mix (which reads as %s)."
            % (display, signal.get("display"))
        )
    elif not families:
        agreement = "unspecified"
        reason = (
            "The workspace industry '%s' names no sector (%s), so the account mix "
            "(%s) contradicts nothing."
            % (display, _key_note(key), signal.get("display"))
        )
    elif signal.get("family") in families:
        agreement = "agree"
        reason = (
            "The account mix reads as %s, which is what '%s' claims."
            % (signal.get("display"), display)
        )
    else:
        agreement = "disagree"
        reason = (
            "The account mix looks like %s; this workspace is set to %s."
            % (signal.get("display"), display)
        )

    return {
        "agreement": agreement,
        "block_sector_content": agreement == "disagree",
        "reason": reason,
        "workspace": {
            "industry_key": industry_key or None,
            "display": display,
            "claims_families": sorted(families),
            "catalog_note": _key_note(key),
            "in_catalog": known_key,
        },
    }


def build_industry_signal(
    line_items: Iterable[Dict[str, Any]],
    total_assets: Optional[float] = None,
    revenue: Optional[float] = None,
    industry_key: Optional[str] = None,
    industry_display: Optional[str] = None,
) -> Dict[str, Any]:
    """The whole block served on `/api/period`: reading + agreement.

    One computation, one verdict. The frontend renders this; it does not
    re-derive the comparison, so the banner and the block cannot disagree
    with each other or with anything else that reads the same field.
    """
    signal = structural_signal(line_items, total_assets=total_assets, revenue=revenue)
    signal.update(industry_agreement(signal, industry_key, industry_display))
    return signal
