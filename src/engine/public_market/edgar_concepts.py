# -*- coding: utf-8 -*-
"""us-gaap / dei concept mapping and fact selection for the EDGAR adapter.

Pure logic: no I/O, no network, no clocks. Python 3.9 (no match, no X|Y).

DESIGN LAWS (mirrors the engine's E-class invariants for the public_market
document class):

* ABSENT != ZERO. A concept the filer never tagged yields NO figure — never a
  zero. Callers surface a typed refusal instead (see edgar.build_summary_ir).
* Deterministic selection. Given the same companyfacts bytes, the same figure
  is selected every time: selection keys are total orders (end, filed,
  accession), never dict/set iteration order.
* Provenance-first. Selection returns the raw SEC fact untouched so the caller
  can carry accession/form/fy/fp/filed into per-figure provenance.

FALLBACK CHAINS — order and rationale
-------------------------------------
Chains are PERIOD-ANCHORED, not first-present: the target period is the
freshest qualifying annual period end across ALL chain members, and the chain
order only breaks ties among concepts that have a fact at that target end.
Reason (observed in the real Apple bytes committed as a fixture): Apple tags
both `Revenues` (last annual end 2018-09-29 — stale) and
`RevenueFromContractWithCustomerExcludingAssessedTax` (current). A naive
first-present walk would report 2018 revenue as "latest".

REVENUE_CHAIN, in priority order at the anchored period:
  1. Revenues — the umbrella total; broadest correct concept when tagged.
  2. RevenueFromContractWithCustomerExcludingAssessedTax — ASC 606 contract
     revenue net of assessed taxes; what most large filers tag post-2018.
  3. RevenueFromContractWithCustomerIncludingAssessedTax — rare variant; only
     reached when the filer tagged neither of the above for the period.
  4. SalesRevenueNet — pre-ASC-606 legacy concept (deprecated 2018); kept so
     older fiscal years still resolve.

NET_INCOME_CHAIN: NetIncomeLoss (attributable to the parent) preferred over
ProfitLoss (includes noncontrolling interests).

EQUITY_CHAIN: StockholdersEquity (parent) preferred over the
IncludingPortionAttributableToNoncontrollingInterest variant. The chosen
concept name always travels in provenance, so the consumer can see which
scope it got.

TOTAL DEBT — "require both or refuse":
  total_debt = short-term debt + long-term debt, and BOTH sides must resolve
  at the SAME instant (period end) or the figure is refused. Never report one
  side alone as "total debt" — that is a silent understatement.

  Short side: `DebtCurrent` (the umbrella) when tagged. Apple — like many
  filers — does not tag it, so the fallback is a COMPOSITE anchored on
  `LongTermDebtCurrent` (current portion of long-term debt, REQUIRED) plus
  optional add-on lines `CommercialPaper` and `ShortTermBorrowings` when the
  filer tagged them at the same instant. Scoped exception to ABSENT != ZERO,
  and deliberately narrow: an add-on concept absent from the same filing is a
  balance-sheet line the filer does not have (they tag it when they have it),
  not missing data — but the composite still refuses when its ANCHOR is
  absent, so a figure is never fabricated from optional lines alone.

  Long side: `LongTermDebtNoncurrent` only. `LongTermDebt` is deliberately
  EXCLUDED: for many filers (Apple included) it is total long-term debt
  INCLUDING the current portion, so combining it with the short side would
  double-count `LongTermDebtCurrent`.

SHARES: dei `EntityCommonStockSharesOutstanding` — the cover-page share count.
Its `end` is the cover date (not the fiscal period end) and it is stated in
whole shares, not currency: no minor-unit conversion applies.

UNITS: EDGAR us-gaap USD facts are whole-dollar decimal values. The engine
stores integer minor units (cents): value_minor = val * 100, computed through
Decimal over the JSON literal and REFUSED (typed) if the result is not an
integer — sub-cent values are never rounded into existence.
"""

import datetime
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional, Tuple


class EdgarError(Exception):
    """Base for every typed EDGAR-adapter error. `code` is machine-readable
    (journal/DLQ records carry it); `message` is for humans. Errors are the
    ONLY failure channel — no function in this package returns a silent
    empty/zero on failure."""

    code = "EDGAR"

    def __init__(self, message):
        super(EdgarError, self).__init__(message)
        self.message = message


class EdgarFormatError(EdgarError):
    """Bytes/values that do not conform to the documented EDGAR format.

    Typed refusal: raised instead of guessing (never silently coerced).
    `reason` distinguishes sub-cases machine-readably:
      "non_integral"  — a USD value not representable in integer cents
      "unparseable"   — bytes/values that don't parse at all
    """

    code = "FORMAT"

    def __init__(self, message, reason="unparseable"):
        super(EdgarFormatError, self).__init__(message)
        self.reason = reason


# --------------------------------------------------------------------------
# Concept chains (see module docstring for order rationale)
# --------------------------------------------------------------------------

REVENUE_CHAIN = [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
]

NET_INCOME_CHAIN = ["NetIncomeLoss", "ProfitLoss"]

ASSETS_CHAIN = ["Assets"]

EQUITY_CHAIN = [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
]

# Short-term debt: umbrella first; composite fallback (anchor + optional add-ons)
SHORT_DEBT_UMBRELLA_CHAIN = ["DebtCurrent"]
SHORT_DEBT_ANCHOR = "LongTermDebtCurrent"
SHORT_DEBT_ADDONS = ["CommercialPaper", "ShortTermBorrowings"]

# Long-term debt: LongTermDebt is EXCLUDED on purpose (double-count trap —
# it includes the current portion for many filers).
LONG_DEBT_CHAIN = ["LongTermDebtNoncurrent"]

# dei chain for shares outstanding (unit: shares — a count, not currency)
SHARES_DEI_CHAIN = ["EntityCommonStockSharesOutstanding"]

# Forms that carry audited annual figures.
ANNUAL_FORMS = ("10-K", "20-F", "40-F")

# A fiscal year span in days: wide enough for 52/53-week fiscal calendars,
# narrow enough to exclude the quarterly spans that real filings mislabel
# with fp="FY" (observed in the Apple fixture bytes: 2018 quarters tagged FY).
ANNUAL_SPAN_MIN_DAYS = 330
ANNUAL_SPAN_MAX_DAYS = 400


def span_days(start, end):
    """Day count of an ISO start..end span. Malformed dates are a typed refusal."""
    try:
        d0 = datetime.date.fromisoformat(start)
        d1 = datetime.date.fromisoformat(end)
    except (TypeError, ValueError):
        raise EdgarFormatError("unparseable fact period: %r..%r" % (start, end))
    return (d1 - d0).days


def _is_annual_form(form):
    if not form:
        return False
    # amendments ("10-K/A") still carry annual figures
    return any(form == f or form.startswith(f + "/") for f in ANNUAL_FORMS)


def annual_duration_candidates(facts):
    # type: (List[Dict]) -> List[Dict]
    """Facts usable as an audited ANNUAL flow (revenue, net income).

    Requires: fp == FY, an annual form, an actual ~1-year start..end span.
    fp alone is NOT trusted — see ANNUAL_SPAN_* comment.
    """
    out = []
    for f in facts:
        if f.get("fp") != "FY" or not _is_annual_form(f.get("form")):
            continue
        start = f.get("start")
        end = f.get("end")
        if not start or not end:
            continue
        if ANNUAL_SPAN_MIN_DAYS <= span_days(start, end) <= ANNUAL_SPAN_MAX_DAYS:
            out.append(f)
    return out


def annual_instant_candidates(facts):
    # type: (List[Dict]) -> List[Dict]
    """Facts usable as an ANNUAL balance-sheet instant (assets, equity, debt).

    Instant facts carry no `start`; fp == FY on an annual form means the
    balance date is the fiscal year end.
    """
    out = []
    for f in facts:
        if f.get("fp") != "FY" or not _is_annual_form(f.get("form")):
            continue
        if f.get("start") or not f.get("end"):
            continue
        out.append(f)
    return out


def best_at_end(candidates, end):
    # type: (List[Dict], str) -> Optional[Dict]
    """The authoritative fact for one period end: latest `filed` wins (a later
    filing restates/carries forward the figure), accession breaks exact ties.
    Deterministic total order; None when no candidate has that end."""
    at_end = [f for f in candidates if f.get("end") == end]
    if not at_end:
        return None
    return sorted(at_end, key=lambda f: (f.get("filed") or "", f.get("accn") or ""))[-1]


def _candidates_by_concept(facts_by_concept, chain, kind):
    # type: (Dict[str, List[Dict]], List[str], str) -> Dict[str, List[Dict]]
    picker = annual_duration_candidates if kind == "duration" else annual_instant_candidates
    out = {}
    for concept in chain:
        facts = facts_by_concept.get(concept)
        if facts:
            cands = picker(facts)
            if cands:
                out[concept] = cands
    return out


def select_latest_annual(facts_by_concept, chain, kind):
    # type: (Dict[str, List[Dict]], List[str], str) -> Optional[Tuple[str, Dict]]
    """Period-anchored chain selection (see module docstring).

    1. target_end = freshest annual period end across ALL chain members.
    2. winner = FIRST chain concept holding a fact at target_end
       (chain order is a tie-break at the anchored period, never a way to
       pick a staler period from a higher-priority concept).
    3. within the winner, best_at_end (latest filed) decides.

    Returns (concept, fact) or None when no chain member has an annual fact.
    """
    per_concept = _candidates_by_concept(facts_by_concept, chain, kind)
    if not per_concept:
        return None
    target_end = max(f["end"] for cands in per_concept.values() for f in cands)
    for concept in chain:
        cands = per_concept.get(concept)
        if not cands:
            continue
        fact = best_at_end(cands, target_end)
        if fact is not None:
            return (concept, fact)
    return None


def select_latest_shares(facts):
    # type: (List[Dict]) -> Optional[Dict]
    """Latest cover-page share count: freshest `end` (cover date), latest
    `filed` on ties. Any form qualifies — the cover page is updated on every
    filing and freshness is the point of this figure."""
    usable = [f for f in facts if f.get("end") and f.get("val") is not None]
    if not usable:
        return None
    return sorted(
        usable, key=lambda f: (f["end"], f.get("filed") or "", f.get("accn") or "")
    )[-1]


def usd_to_minor(val):
    """Whole-USD fact value -> integer minor units (cents).

    Goes through Decimal(str(val)) so float artifacts from JSON parsing do not
    leak into the multiplication. A value that does not land on an integer
    number of cents is REFUSED (typed) — sub-cent precision cannot be stored
    honestly in minor units and is never rounded away.
    """
    try:
        cents = Decimal(str(val)) * 100
    except (InvalidOperation, ValueError, TypeError):
        raise EdgarFormatError("unparseable USD value: %r" % (val,))
    integral = cents.to_integral_value()
    if cents != integral:
        raise EdgarFormatError(
            "USD value %r is not representable in integer cents" % (val,),
            reason="non_integral",
        )
    return int(integral)


def shares_to_int(val):
    """dei share counts are whole numbers; anything else is a format refusal."""
    try:
        d = Decimal(str(val))
    except (InvalidOperation, ValueError, TypeError):
        raise EdgarFormatError("unparseable share count: %r" % (val,))
    if d != d.to_integral_value():
        raise EdgarFormatError("fractional share count: %r" % (val,))
    return int(d)
