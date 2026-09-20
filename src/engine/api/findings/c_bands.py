"""C-BANDS — a ratio that changed band between two periods, as a finding.

The two-period lane, sibling of the single-period ``s_*`` detectors and the
multi-period ``m_*`` analyses. Its input is not a ledger: it is the
two-period ratio block `engine.comparatives.ratio_compare` has already
composed — values, bands, the rung crossed, the distance past it and the
materiality of that distance — so this module DECIDES nothing about a
band. It turns each crossing the composer served into a
:class:`engine.api._finding.Finding` and lets the contract judge it.

ONE CALL. `ratio_compare.compare_ratio_tables` calls
:func:`build_band_findings` exactly once per two-period block, with every
crossed row in rank order. The builder is INJECTED by
`engine.api._comparatives` (the composer's package imports no pack, E8),
the same way the Piotroski checks are.

THE SEVEN, and where each comes from

  subject     the ledger accounts behind the ratio: the current period's
              served line items in the numerator's and the denominator's
              buckets (`SUBJECT_BUCKETS`), contra accounts excluded
              (`CONTRA_ACCOUNT_PREFIXES`), ranked by signed amount on the
              bucket's natural side (largest first)
  evidence    the prior and the current value, as served; comparison
              basis kind ``prior_period``; provenance naming BOTH periods
              and BOTH snapshots
  threshold   ``band_<key>``: the rung crossed, its value, the observed
              current value, the comparator the band ladder implies; the
              source is the served band table
  impact      HEADROOM MONEY on the per-key materiality basis the composer
              served (`ratio_compare.MATERIALITY_BASES`): the numerator at
              the rung against the numerator as held, holding the
              denominator the ratio divides (ccc on its working-capital
              basis, revenue). The two composites have no money
              denominator and state headroom in their OWN unit
              (`NON_MONEY_IMPACT_KEYS`, ruling Q3): Altman Z'' from the rung
              to the value held, in Z units; the letter as the credit
              composite's distance from the rung in notches of the served
              band width. `Finding.validate()` is unchanged: a headroom
              impact in a declared dimensionless unit already satisfies it.
              A crossing with no served rung distance still DEMOTES and is
              still listed
  why_here    the current period's company profile (`_base.build_finding`)
  action      two imperative steps per direction
  confidence  the profile's position, lowered by the stated convention
              that both periods are graded under the CURRENT band table
              and credit model (restated comparatives)

DEMOTION NEVER SHRINKS A LIST. Every crossed row yields exactly one row in
`band_movements.findings`: a surfaced finding, or the check row
`Finding.to_payload()` degrades to, carrying its `missing_elements`. The
improved and deteriorated lists are the composer's, derived from the
movements, never from what surfaced.

SO WHAT. No sentence is authored here beyond the contract's deterministic
render. Each row carries `so_what`: an i18n key and placeholders copied,
as strings, from the served row — no numeral is computed for it, and no
model writes one.

WHY THE CATALOGUE IS EXTENDED IN MEMORY. `_base.build_finding` takes the
why-here, the confidence and the category from the company profile, which
reads them from the pack catalogue by detector id. The band rules are not
single-period detectors (registering them in ``profiles.yaml`` would make
`s_engine.assert_full_coverage` refuse every single-period run), so this
lane registers its own rule ids on a COPY of the loaded catalogue, from the
table below, for the duration of one call. The pack file is not touched.

Pure over its inputs: no clock, no I/O beyond the cached catalogue read.
Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ...ratios import credit_model as CM
from .. import _company_profile as CP
from .. import _finding as F
from . import _base

LANE = "c_bands"
RULE_PREFIX = "band_"

# ── What each ratio is about ─────────────────────────────────────────────

_CA = ("cash", "ar", "inventory", "otherCurrentAssets")
_CL = ("ap", "stDebt", "otherCurrentLiab")
_TA = _CA + ("ppe", "intangibles", "otherNonCurrentAssets")
_EQ = ("shareCapital", "otherEquity", "retainedEarnings")
_DEBT = ("stDebt", "ltDebt")
_EBITDA = ("revenue", "otherIncome", "cogs", "operatingExpenses")
_EBIT = _EBITDA + ("depreciation",)
_NI = _EBIT + ("financialIncome", "financialExpense", "interestExpense", "taxExpense")
_OPEX = ("cogs", "operatingExpenses", "depreciation")

#: key -> (numerator buckets, denominator buckets), over the served line
#: items' `bucket`. Read for the SUBJECT only; no figure comes from here.
SUBJECT_BUCKETS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "current_ratio": (_CA, _CL),
    "quick_ratio": (("cash", "ar"), _CL),
    "cash_ratio": (("cash",), _CL),
    "gross_margin": (("revenue", "cogs"), ("revenue",)),
    "ebitda_margin": (_EBITDA, ("revenue",)),
    "net_margin": (_NI, ("revenue",)),
    "operating_margin": (_EBIT, ("revenue",)),
    "core_ebitda_margin": (_EBITDA, ("revenue",)),
    "roa": (_NI, _TA),
    "roe": (_NI, _EQ),
    "roic": (_EBIT, _DEBT + _EQ),
    "debt_to_ebitda": (_DEBT, _EBITDA),
    "net_debt_to_ebitda": (_DEBT + ("cash",), _EBITDA),
    "debt_to_equity": (_DEBT, _EQ),
    "lt_debt_to_equity": (("ltDebt",), _EQ),
    "equity_ratio": (_EQ, _TA),
    "debt_to_assets": (_DEBT, _TA),
    "interest_coverage": (_EBIT, ("interestExpense",)),
    "ebitda_to_interest": (_EBITDA, ("interestExpense",)),
    "dscr": (_EBITDA, ("interestExpense", "stDebt")),
    "adjusted_dscr": (_EBITDA, ("interestExpense", "stDebt")),
    "dscr_with_lt_principal": (_EBITDA, ("interestExpense", "ltDebt")),
    "dso": (("ar",), ("revenue",)),
    "dio": (("inventory",), _OPEX),
    "dpo": (("ap",), _OPEX),
    "ccc": (("ar", "inventory"), ("ap",)),
    "asset_turnover": (("revenue",), _TA),
    "inventory_turnover": (("cogs",), ("inventory",)),
    "altman_z": (_CA + ("retainedEarnings",), _CL),
    "letter_grade": (_CA + ("retainedEarnings",), _CL),
}

#: English labels the contract's prose renders (the FE renders `label_key`).
LABELS: Dict[str, str] = {
    "current_ratio": "current ratio", "quick_ratio": "quick ratio", "cash_ratio": "cash ratio",
    "gross_margin": "gross margin", "ebitda_margin": "EBITDA margin", "net_margin": "net margin",
    "operating_margin": "operating margin", "core_ebitda_margin": "core EBITDA margin",
    "roa": "return on assets", "roe": "return on equity", "roic": "return on invested capital",
    "debt_to_ebitda": "debt to EBITDA", "net_debt_to_ebitda": "net debt to EBITDA",
    "debt_to_equity": "debt to equity", "lt_debt_to_equity": "long-term debt to equity",
    "equity_ratio": "equity ratio", "debt_to_assets": "debt to assets",
    "interest_coverage": "interest coverage", "ebitda_to_interest": "EBITDA to interest",
    "dscr": "debt service coverage", "adjusted_dscr": "lease-adjusted debt service coverage",
    "dscr_with_lt_principal": "debt service coverage with long-term principal",
    "dso": "days sales outstanding", "dio": "days inventory outstanding",
    "dpo": "days payables outstanding", "ccc": "cash conversion cycle",
    "asset_turnover": "asset turnover", "inventory_turnover": "inventory turnover",
    "altman_z": "Altman Z''", "letter_grade": "credit letter grade",
}

#: group -> (alert category the storage CHECK accepts, why-here copy).
GROUP_POLICY: Dict[str, Tuple[str, str]] = {
    # No template puts {financing_audience} before a verb: an audience may be
    # one reader ("the shareholder") or two ("the group treasury and the
    # statutory auditor"), and no single verb form agrees with both.
    "liquidity": (
        "liquidity",
        "Short-term cover is the first read for {financing_audience} on a "
        "{profile_label}: {scope} changing band between the two periods "
        "changes that conversation before any covenant is tested."),
    "profitability": (
        "margin",
        "For a {profile_label}, {scope} is the earnings line everything else "
        "is sized from by {financing_audience}, so a change of band year on "
        "year moves the valuation and the credit view together."),
    "leverage": (
        "leverage",
        "A {profile_label} is underwritten by {financing_audience} on the debt "
        "it carries against what it earns and owns; {scope} moving band "
        "between the two periods changes that answer."),
    "coverage": (
        "leverage",
        "A {profile_label} is tested by {financing_audience} on whether "
        "earnings pay the interest and the principal; {scope} changing band "
        "year on year changes the headroom on that test."),
    "efficiency": (
        "working_capital",
        "Working-capital days decide how much cash a {profile_label} ties up "
        "to trade; {scope} moving band between the two periods changes the "
        "funding asked of {financing_audience}."),
    "distress": (
        "leverage",
        "The Altman zone is the one-line distress read taken by "
        "{financing_audience} on a {profile_label}; {scope} moving zone "
        "changes it before any single ratio is read."),
    "credit": (
        "leverage",
        "The letter is how a {profile_label} is graded in one word by "
        "{financing_audience}; {scope} moving a notch changes that grade."),
}

#: The convention every band finding carries in its confidence position.
RESTATEMENT_CAVEAT = (
    "Both periods are graded on the current band table and credit model "
    "revision (restated comparatives), a convention rather than the bands "
    "in force when the earlier period was filed.")

#: Caveat copy this lane states in place of the pack's single-period text.
#: The pack's `approximated_cash_flow` caveat says the cash-flow lines are
#: approximated "because no prior period was supplied" — true of a
#: single-period finding, false inside a finding that compares two loaded
#: periods. What IS approximated is each period's cash-flow lines, built at
#: persist time from that one period's balances (ruling Q4, 2026-09-15).
TWO_PERIOD_CAVEATS: Dict[str, str] = {
    CP.CAVEAT_APPROX_CF: (
        "Cash-flow lines are indirect-method approximations built from a "
        "single period's balances; working-capital movements carry a wide "
        "band."),
}

#: The two composites are not graded on the pack's band table: the Altman
#: zones and the letter ladder are the serve-time credit model's constants.
#: key -> (source prefix, rung name -> constant name or None for the ladder
#: grade itself, the basis sentence's name for the ladder).
COMPOSITE_LADDERS: Dict[str, Tuple[str, Dict[str, str], str]] = {
    "altman_z": ("credit_model", {"healthy": "ALTMAN_SAFE_FROM", "watch": "ALTMAN_GREY_FROM"},
                 "the credit model's Altman Z'' zones"),
    "letter_grade": ("credit_model", {}, "the credit model's letter ladder (CREDIT_LETTER_LADDER)"),
}

#: The figure a row prints when it is not the ratio's own value: the letter
#: is graded on the credit composite, and the figure is that score.
FIGURE_LABELS: Dict[str, str] = {"letter_grade": "credit composite"}

#: Contra accounts — accumulated depreciation and amortisation (28x),
#: impairment adjustments on fixed assets (29x), inventory provisions (39x)
#: and receivable provisions (49x). They sit in an asset bucket with a
#: negative balance and are never what a ratio is ABOUT: ranked by absolute
#: balance, retail's current ratio named 491 (a provision) and a PP&E-heavy
#: book's return on assets named 2813 (depreciation). Ruling Q5, 2026-09-15.
CONTRA_ACCOUNT_PREFIXES: Tuple[str, ...] = ("28", "29", "39", "49")

SUBJECT_NUMERATOR_ACCOUNTS = 2
SUBJECT_DENOMINATOR_ACCOUNTS = 1

#: Altman Z'' prints as a plain two-decimal index, as the methodology
#: writes it ("Altman Z'' = 3.09"), never with the ratio marker (ruling Q7).
_UNIT_OF = {"x": F.UNIT_RATIO, "pct": F.UNIT_PERCENT, "days": F.UNIT_DAYS,
            "z": F.UNIT_INDEX, "grade": F.UNIT_SCORE}

#: The keys whose impact is headroom in their own dimensionless unit.
NON_MONEY_IMPACT_KEYS: Dict[str, str] = {"altman_z": F.UNIT_INDEX, "letter_grade": F.UNIT_NOTCHES}

MONEY_AT_RUNG = "band_numerator_at_rung"
MONEY_HELD = "band_numerator_held"


def rule_id_for(key: str) -> str:
    return RULE_PREFIX + key


def subject_coverage(keys: Sequence[str]) -> Dict[str, Any]:
    """TC-12: which of `keys` the subject table covers, and which it does not."""
    covered = sorted(k for k in keys if k in SUBJECT_BUCKETS and k in LABELS)
    missing = sorted(k for k in keys if k not in SUBJECT_BUCKETS or k not in LABELS)
    return {"covered": covered, "missing": missing}


# ── The catalogue the profile reads ──────────────────────────────────────


def lane_catalog(base: "CP.ProfileCatalog", rows: Sequence[Mapping[str, Any]]) -> "CP.ProfileCatalog":
    """A COPY of `base` with one detector spec per crossed row's rule id and
    the two-period caveat copy (`TWO_PERIOD_CAVEATS`). The pack file and the
    cached catalogue are left untouched."""
    cat = copy.copy(base)
    detectors = dict(base.detectors)
    for row in rows:
        rid = rule_id_for(row["key"])
        category, why = GROUP_POLICY[row["group"]]
        detectors[rid] = CP.DetectorSpec(
            id=rid, category=category, profiles=("all",), requires_signals=(),
            units={}, labels={}, default={}, by_profile={},
            why_here_default=why, why_here_by_profile={})
    cat.detectors = detectors
    caveats = dict(base.confidence_caveats)
    caveats.update(TWO_PERIOD_CAVEATS)
    cat.confidence_caveats = caveats
    return cat


# ── Subject ──────────────────────────────────────────────────────────────


def _accounts(line_items: Sequence[Mapping[str, Any]], buckets: Sequence[str],
              limit: int, taken: Sequence[str]) -> List[F.Account]:
    wanted = set(buckets)
    candidates = []
    for li in line_items:
        if not isinstance(li, Mapping) or li.get("bucket") not in wanted:
            continue
        code = str(li.get("ro_account_code") or "")
        amount = li.get("amount")
        if not code or code in taken or isinstance(amount, bool) or not isinstance(amount, (int, float)):
            continue
        # Only what the SUBJECT element accepts: a served code the contract
        # rejects (carniprod serves `701.00'`) or a nameless line would demote
        # the whole finding over formatting, while a valid account in the
        # same bucket stands next in line.
        if not F.is_ledger_code(code) or not str(li.get("ro_account_name") or "").strip():
            continue
        if code.startswith(CONTRA_ACCOUNT_PREFIXES):
            continue
        # Served line items are signed on their bucket's natural side
        # (positive = the side the bucket is named for), so the largest
        # SIGNED amount is the largest contribution to the bucket; a line
        # on the opposite side ranks after every line on the natural side.
        candidates.append((-float(amount), code, li))
    candidates.sort(key=lambda c: (c[0], c[1]))
    out = []  # type: List[F.Account]
    for _neg, code, li in candidates:
        if code in [a.code for a in out]:
            continue
        out.append(F.Account(code=code, name=str(li.get("ro_account_name") or "").strip(),
                             statement=li.get("statement"), bucket=li.get("bucket")))
        if len(out) >= limit:
            break
    return out


def _subject(key: str, line_items: Sequence[Mapping[str, Any]]) -> List[F.Account]:
    numerator, denominator = SUBJECT_BUCKETS.get(key, ((), ()))
    accounts = _accounts(line_items, numerator, SUBJECT_NUMERATOR_ACCOUNTS, ())
    accounts += _accounts(line_items, denominator, SUBJECT_DENOMINATOR_ACCOUNTS,
                          [a.code for a in accounts])
    return accounts


# ── Impact: headroom money ───────────────────────────────────────────────


def _headroom(row: Mapping[str, Any], denominators: Mapping[str, Mapping[str, Any]],
              period_days: float, reader: "_base.Reader") -> Tuple[Optional[F.Impact], Dict[str, float]]:
    """The numerator at the rung and as held, on the denominator the
    materiality divided. None when the composer served no materiality for
    the row (no money denominator): the finding demotes, and says so."""
    mv = row["movement"]
    if row["key"] in NON_MONEY_IMPACT_KEYS:
        return _own_unit_headroom(row), {}
    if mv.get("materiality") is None or mv.get("rung_crossed") is None:
        return None, {}
    den = (denominators.get(row["key"]) or {}).get("value")
    if den is None:
        return None, {}
    unit = row["display_unit"]
    scale = {"x": Decimal(1), "pct": Decimal(100), "days": Decimal(repr(period_days))}.get(unit)
    if scale is None:
        return None, {}
    d = abs(Decimal(den))
    held = Decimal(row["current"]["value"]) * d / scale
    at_rung = Decimal(mv["rung_crossed"]["value"]) * d / scale
    if held == at_rung:
        return None, {}
    if row["key"] == "ccc":
        # A sum of day counts has no numerator of its own; its money is the
        # working capital those days tie up on revenue (ruling Q3).
        label = "the working capital %s ties up at the %s rung, versus as held" % (
            LABELS[row["key"]], mv["rung_crossed"]["name"])
    else:
        label = "the numerator of %s at the %s rung, versus as held" % (
            LABELS[row["key"]], mv["rung_crossed"]["name"])
    impact = F.headroom_impact(
        rule_id_for(row["key"]), label,
        observed=reader.q(float(held), MONEY_HELD),
        limit=reader.q(float(at_rung), MONEY_AT_RUNG))
    impact = replace(impact, baseline_fact=MONEY_AT_RUNG, adjusted_fact=MONEY_HELD)
    return impact, {MONEY_AT_RUNG: float(at_rung), MONEY_HELD: float(held)}


def _own_unit_headroom(row: Mapping[str, Any]) -> Optional[F.Impact]:
    """Headroom for a composite, in its own unit, read off the served
    movement: Altman Z'' at the rung versus as held; the letter as the
    composite's signed distance from the rung in notches of the served
    band width (at the rung = 0). None when the composer served no rung
    (or, for the letter, no band width)."""
    mv = row["movement"]
    rung = mv.get("rung_crossed") or {}
    if rung.get("value") is None or row["current"].get("value") is None:
        return None
    unit = NON_MONEY_IMPACT_KEYS[row["key"]]
    if row["key"] == "altman_z":
        label = "Altman Z'' at the %s rung, versus as held" % rung["name"]
        limit = _ratio_units_quantity(float(Decimal(rung["value"])), unit)
        observed = _ratio_units_quantity(float(row["current"]["value"]), unit)
    else:
        width = mv.get("band_width")
        if width is None or Decimal(width) == 0:
            return None
        signed = (Decimal(row["current"]["value"]) - Decimal(rung["value"])) / Decimal(width)
        label = ("the credit composite against the %s rung, in notches of the %s-point band"
                 % (rung["name"], width))
        limit = _ratio_units_quantity(0.0, unit)
        observed = _ratio_units_quantity(float(signed), unit)
    return F.headroom_impact(rule_id_for(row["key"]), label, observed=observed, limit=limit)


def _ratio_units_quantity(value: float, unit: str) -> Any:
    return F._ratio_units.Quantity(float(value), unit)


# ── The finding ──────────────────────────────────────────────────────────


def _sentence_case(text: str) -> str:
    """First character upper, the rest as written ("EBITDA", "Altman" and
    ledger codes keep their case)."""
    return text[:1].upper() + text[1:]


def _figure_value(value: float, unit: str) -> float:
    return float(value) / 100.0 if unit == "pct" else float(value)


def _comparator(row: Mapping[str, Any]) -> str:
    up = row["movement"]["rungs_crossed"] > 0
    if row["higher_is_better"]:
        return ">=" if up else "<"
    return "<=" if up else ">"


def _severity(row: Mapping[str, Any]) -> str:
    mv = row["movement"]
    if mv["rungs_crossed"] > 0:
        return "low"
    if mv["to"] == "critical" or mv["rungs_crossed"] <= -2:
        return "high"
    return "medium"


def _steps(row: Mapping[str, Any], codes: Sequence[str], labels: Mapping[str, str]) -> Tuple[F.ActionStep, ...]:
    label = LABELS[row["key"]]
    rung = (row["movement"].get("rung_crossed") or {}).get("name") or "band"
    code_text = ", ".join(codes) or "the ratio's accounts"
    first = F.ActionStep(
        imperative="Reconcile the %s movement from %s to %s to the ledger"
                   % (label, labels["prior"], labels["current"]),
        artefact="two-period balance listing for accounts %s" % code_text,
        provider="the financial controller",
        horizon="before the next board pack")
    if row["movement"]["rungs_crossed"] > 0:
        second = F.ActionStep(
            imperative="Confirm the move past the %s rung comes from recurring trading, "
                       "not a single posting" % rung,
            artefact="list of non-recurring entries on accounts %s in %s"
                     % (code_text, labels["current"]),
            provider="the financial controller")
    else:
        second = F.ActionStep(
            imperative="Quantify what returns %s to the %s rung" % (label, rung),
            artefact="headroom schedule for the numerator and the denominator of %s" % label,
            provider="the FP&A team")
    return (first, second)


def _so_what(row: Mapping[str, Any], labels: Mapping[str, str]) -> Dict[str, Any]:
    mv = row["movement"]
    direction = "improved" if mv["rungs_crossed"] > 0 else "deteriorated"
    materiality = mv.get("materiality") or {}
    return {
        "key": "statements.ratioCmp.bandFinding.%s" % direction,
        "placeholders": {
            "label_key": row["label_key"],
            "from": mv["from"], "to": mv["to"],
            "rung": (mv.get("rung_crossed") or {}).get("name"),
            "rung_value": (mv.get("rung_crossed") or {}).get("value"),
            "prior_value": row["prior"]["value_q"], "current_value": row["current"]["value_q"],
            "delta": row["delta"]["value"], "delta_unit": row["delta"]["unit"],
            "headroom_money": materiality.get("headroom_money"),
            "current_label": labels["current"], "prior_label": labels["prior"],
        },
    }


def _threshold_source(key: str, rung: str, bands_stamp: Mapping[str, Any]) -> str:
    """Where the rung's value is defined: the served band table for a census
    ratio, the credit model's constant for a composite."""
    if key in COMPOSITE_LADDERS:
        prefix, constants, _name = COMPOSITE_LADDERS[key]
        if key == "letter_grade":
            return "%s#CREDIT_LETTER_LADDER.%s" % (prefix, rung)
        return "%s#%s" % (prefix, constants.get(rung, "altman_thresholds.%s" % rung))
    return "%s#%s.%s" % (bands_stamp.get("source") or "served_bands", key, rung)


def _graded_on(key: str, bands_stamp: Mapping[str, Any]) -> str:
    if key in COMPOSITE_LADDERS:
        return "%s under credit model revision %s" % (COMPOSITE_LADDERS[key][2],
                                                       CM.CREDIT_MODEL_REVISION)
    return "the %s band table (sha256 %s) under one credit model revision" % (
        bands_stamp.get("source") or "served", str(bands_stamp.get("table_sha256") or "")[:12])


def _finding(row: Mapping[str, Any], ctx: "_base.Ctx", *, labels: Mapping[str, str],
             ids: Mapping[str, Optional[str]], bands_stamp: Mapping[str, Any],
             line_items: Sequence[Mapping[str, Any]], denominators: Mapping[str, Mapping[str, Any]],
             period_days: float) -> F.Finding:
    key, mv = row["key"], row["movement"]
    unit = row["display_unit"]
    f_unit = _UNIT_OF[unit]
    rid = rule_id_for(key)
    label = LABELS[key]
    accounts = _subject(key, line_items)
    codes = [a.code for a in accounts]
    # The scope as a sentence embeds it (why-here) and as a title opens with it.
    embedded_scope = "%s on %s" % (label, " / ".join(codes)) if codes else label
    scope = _sentence_case(embedded_scope)

    prior_v = _figure_value(row["prior"]["value"], unit)
    current_v = _figure_value(row["current"]["value"], unit)
    figure_label = FIGURE_LABELS.get(key, label)
    bag = (_base.Bag()
           ._add("%s__prior" % key, prior_v, f_unit, "%s in %s" % (figure_label, labels["prior"]))
           ._add("%s__current" % key, current_v, f_unit, "%s in %s" % (figure_label, labels["current"])))
    impact, money = _headroom(row, denominators, period_days, ctx.reader)
    for name, value in money.items():
        bag.fact_only(name, value)

    rung = mv.get("rung_crossed") or {}
    threshold = None  # type: Optional[F.Threshold]
    if rung.get("value") is not None:
        # No rung served, no threshold: the finding demotes by name rather
        # than carrying a NaN limit no JSON reader accepts.
        threshold = F.Threshold(
            rule_id=rid, parameter=str(rung.get("name") or ""),
            # "<rung> rung of <label>": the title prints the limit right
            # before this label, and "30 days days sales outstanding" is what
            # "<label> <rung> rung" read like on every days row.
            parameter_label="%s rung of %s" % (rung.get("name") or "", figure_label),
            comparator=_comparator(row), limit=_figure_value(float(Decimal(rung["value"])), unit),
            observed=current_v, unit=f_unit,
            source=_threshold_source(key, str(rung["name"]), bands_stamp))
    comparison = F.ComparisonBasis(
        kind="prior_period",
        description="the same company's %s (period %s) against %s (period %s), both graded on %s"
                    % (labels["current"], ids.get("current_period_id"), labels["prior"],
                       ids.get("prior_period_id"), _graded_on(key, bands_stamp)),
        basis_value=prior_v, basis_unit=f_unit)
    finding = _base.build_finding(
        ctx, rid, _severity(row), accounts, scope=scope, bag=bag, comparison=comparison,
        threshold_element=threshold, impact=impact, steps=_steps(row, codes, labels),
        method_caveat=RESTATEMENT_CAVEAT)
    evidence = finding.evidence
    provenance = replace(evidence.provenance, prior_period_id=ids.get("prior_period_id"),
                         prior_snapshot_id=ids.get("prior_snapshot_id"))
    why = ctx.profile.why_here(rid, scope=embedded_scope)
    why = replace(why, rationale=_sentence_case(why.rationale))
    return replace(finding, evidence=replace(evidence, provenance=provenance), why_here=why)


def band_finding_objects(crossed: Sequence[Mapping[str, Any]], *,
                         current_payload: Mapping[str, Any],
                         current_label: str, prior_label: str,
                         current_period_id: Optional[str], prior_period_id: Optional[str],
                         current_snapshot_id: Optional[str], prior_snapshot_id: Optional[str],
                         bands_stamp: Mapping[str, Any],
                         denominators: Mapping[str, Mapping[str, Any]],
                         period_days: float,
                         caen: Optional[str] = None) -> List[Tuple[Mapping[str, Any], F.Finding]]:
    """`(crossed row, Finding)` per crossed row, in the order given — the
    typed objects `build_band_findings` serialises (a gate validates these
    directly)."""
    if not crossed:
        return []
    statements = current_payload.get("statements") if isinstance(current_payload.get("statements"), dict) else {}
    line_items = [li for li in (current_payload.get("line_items") or []) if isinstance(li, Mapping)]
    catalog = lane_catalog(CP.load_catalog(), crossed)
    profile = CP.build_company_profile(
        dict(statements), period_id=str(current_period_id or ""), caen=caen,
        catalog=catalog, snapshot_id=current_snapshot_id)
    ctx = _base.Ctx(profile=profile, reader=_base.Reader(statements),
                    period_id=str(current_period_id or ""), snapshot_id=current_snapshot_id)
    labels = {"current": current_label, "prior": prior_label}
    ids = {"current_period_id": current_period_id, "prior_period_id": prior_period_id,
           "current_snapshot_id": current_snapshot_id, "prior_snapshot_id": prior_snapshot_id}
    return [(row, _finding(row, ctx, labels=labels, ids=ids, bands_stamp=bands_stamp,
                           line_items=line_items, denominators=denominators,
                           period_days=period_days))
            for row in crossed]


def build_band_findings(crossed: Sequence[Mapping[str, Any]], *,
                        current_label: str, prior_label: str,
                        **kwargs: Any) -> List[Dict[str, Any]]:
    """One row per crossed row, in the order given (the composer's rank).

    Each row is `Finding.to_payload()` — surfaced, or the check row it
    demotes to — plus the ratio key, the direction and `so_what`. Keyword
    arguments are :func:`band_finding_objects`'."""
    labels = {"current": current_label, "prior": prior_label}
    out = []  # type: List[Dict[str, Any]]
    pairs = band_finding_objects(crossed, current_label=current_label,
                                 prior_label=prior_label, **kwargs)
    for rank, (row, finding) in enumerate(pairs, 1):
        payload = finding.to_payload()
        payload.update({
            "finding_id": "%s:%s->%s" % (rule_id_for(row["key"]), row["movement"]["from"],
                                         row["movement"]["to"]),
            "lane": LANE,
            "rank": rank,
            "ratio_key": row["key"],
            "direction": "improved" if row["movement"]["rungs_crossed"] > 0 else "deteriorated",
            "rungs_crossed": row["movement"]["rungs_crossed"],
            "so_what": _so_what(row, labels),
        })
        out.append(payload)
    return out


__all__ = [
    "CONTRA_ACCOUNT_PREFIXES", "NON_MONEY_IMPACT_KEYS", "GROUP_POLICY", "LABELS", "LANE", "MONEY_AT_RUNG", "MONEY_HELD", "RESTATEMENT_CAVEAT",
    "TWO_PERIOD_CAVEATS",
    "RULE_PREFIX", "SUBJECT_BUCKETS", "COMPOSITE_LADDERS", "FIGURE_LABELS", "band_finding_objects", "build_band_findings",
    "lane_catalog", "rule_id_for",
    "subject_coverage",
]
