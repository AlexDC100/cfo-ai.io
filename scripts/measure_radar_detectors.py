#!/usr/bin/env python3
"""MEASURE THE RADAR DETECTORS ON REAL BOOKS.

Runs the twelve pack-declared detectors over the four real Romanian books
in ``tests/engine/fixtures/firm`` and prints, for every one of them, what
it read and what it concluded — accounts, observed against expected, the
quantified impact, and the atoms behind it.

THE TWO SUBSTRATES, AND WHY BOTH ARE REAL
  · the LEDGER comes from ``corpus/<case>/input.xlsx`` parsed by the
    production ``saga_10_col`` front end — the same parse the pipeline
    runs;
  · the TOTALS a share is taken of come from the captured firm fixture's
    engine-assembled statements. Nothing is re-derived here.

CROSS-PERIOD FAMILIES AND WHAT THIS CHECKOUT CANNOT SHOW
No second real period of the same company exists in this repository, so
the seven cross-period families are exercised on spines DERIVED from one
real book by the technique ``tests/engine/test_findings_multi_period``
documents for the statement lane: every denominator is a real number from
a real book and exactly one line is moved period to period. That is
enough to show the arithmetic and the refusals; it is NOT a measurement
of how often those families fire on real histories, and this report says
so rather than implying otherwise.

STATISTICAL HONESTY — the rule ``scripts/measure_error_budget.py`` sets:
a proportion is reported with a 95% Wilson score interval (stdlib
``statistics.NormalDist``), and a family whose N cannot support one prints
"N INSUFFICIENT to certify" instead of a number that looks like a
measurement.

REPRODUCIBLE: no clock, no network, sorted iteration. Two runs produce
byte-identical output.

Usage:
  .venv/bin/python scripts/measure_radar_detectors.py [--json]

Python 3.9-compatible, stdlib maths only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import replace
from statistics import NormalDist
from typing import Any, Dict, List, Optional, Sequence, Tuple

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "src"))

from engine.api import _company_profile as CP           # noqa: E402
from engine.frontends.saga10 import Saga10FrontEnd      # noqa: E402
from engine.radar.detectors import (BasisTotals, BookSeries,  # noqa: E402
                                    PeriodBook, load_pack, run_detectors)

CASES = ("agras", "carniprod", "realestate", "retail")
PACKS_ROOT = os.path.join(REPO, "packs")
JURISDICTION = os.environ.get("RADAR_JURISDICTION", "ro")

Z95 = NormalDist().inv_cdf(0.975)


def wilson(hits: int, n: int) -> Tuple[Optional[float], Optional[float]]:
    """95% Wilson score interval for a proportion; (None, None) on n=0."""
    if n <= 0:
        return (None, None)
    p = hits / float(n)
    z2 = Z95 * Z95
    denom = 1.0 + z2 / n
    centre = (p + z2 / (2.0 * n)) / denom
    half = Z95 * math.sqrt(p * (1.0 - p) / n + z2 / (4.0 * n * n)) / denom
    low = 0.0 if hits == 0 else max(0.0, centre - half)
    high = 1.0 if hits == n else min(1.0, centre + half)
    return (low, high)


def interval_useful(n: int, max_width: float = 0.40) -> bool:
    """Is N large enough for an interval to say anything? The widest a
    Wilson interval gets is at p=0.5; below this N even a perfect result
    spans most of the range, and printing it would dress a guess as a
    measurement."""
    low, high = wilson(int(round(n / 2.0)), n)
    if low is None or high is None:
        return False
    return (high - low) <= max_width


def load_case(name: str) -> Tuple["PeriodBook", Any, Dict[str, Any]]:
    fixture = os.path.join(REPO, "tests", "engine", "fixtures", "firm",
                           "saga_10_col_%s.json" % name)
    with open(fixture, encoding="utf-8") as fh:
        captured = json.load(fh)
    statements = captured["statements"]
    source = os.path.join(REPO, "corpus", "saga_10_col_%s" % name, "input.xlsx")
    with open(source, "rb") as fh:
        doc, _notes = Saga10FrontEnd().parse(fh.read())
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    basis = BasisTotals(
        total_assets=bs.get("total_assets"), revenue=pl.get("revenue"),
        source="the engine-assembled statements captured in %s"
               % os.path.relpath(fixture, REPO))
    # The closing balances are FY2025 year-end; the movement column this
    # front end fills is the rulaj — December alone on these books — so the
    # window handed to the detectors is 31 days and the label says which
    # window the movements belong to.
    book = PeriodBook.from_ledger_doc(
        doc, period_id="%s-fy2025" % name,
        label="FY2025 close (movements: December 2025)", ordinal=0,
        year=2025, month=12, basis=basis, days_covered=31)
    profile = CP.build_company_profile(statements, period_id=book.period_id)
    return book, profile, captured


# ── the independent oracle ───────────────────────────────────────────────

def oracle_shares(captured: Dict[str, Any]) -> Dict[str, Optional[float]]:
    """Recompute three of the claims from a SECOND data path: the engine's
    own assembled ``line_items`` in the captured fixture, not the parsed
    source document the detectors read. Agreement is evidence that the
    claim is a property of the book rather than of one reader."""
    items = captured.get("line_items") or []
    totals = {}  # type: Dict[str, float]
    for item in items:
        code = str(item.get("ro_account_code") or "")
        amount = abs(float(item.get("amount") or 0.0))
        # SIDE COMES FROM THE ENGINE'S OWN BUCKET. A related-party payable
        # and a related-party receivable share the 45x prefix and are
        # opposite exposures; the detector reads the debit side and the
        # oracle has to read the same side or it is comparing two
        # different claims and calling the difference a disagreement.
        if "liab" in str(item.get("bucket") or "").lower():
            continue
        for prefix in ("411", "451", "452", "455", "461", "21", "281"):
            if code.startswith(prefix):
                totals[prefix] = totals.get(prefix, 0.0) + amount
    top_411 = 0.0
    for item in items:
        code = str(item.get("ro_account_code") or "")
        if code.startswith("411"):
            top_411 = max(top_411, abs(float(item.get("amount") or 0.0)))
    receivables = totals.get("411", 0.0)
    gross = totals.get("21", 0.0)
    accum = totals.get("281", 0.0)
    interco = sum(totals.get(p, 0.0) for p in ("451", "452", "455", "461"))
    bs = (captured.get("statements") or {}).get("assembled_bs") or {}
    total_assets = bs.get("total_assets")
    return {
        "ro_receivable_concentration": (top_411 / receivables) if receivables else None,
        "ro_related_party_exposure": (interco / total_assets) if total_assets else None,
        "ro_asset_age": (accum / gross) if gross else None,
    }


def _fmt(value: Optional[float], unit: str) -> str:
    if value is None:
        return "absent"
    if unit == "percent":
        return "%.1f%%" % (value * 100.0)
    if unit == "ratio":
        return "%.2fx" % value
    if unit == "days":
        return "%.0f days" % value
    if unit == "count":
        return "%.0f" % value
    return "%.4f" % value


def run() -> Dict[str, Any]:
    pack = load_pack(JURISDICTION, PACKS_ROOT)
    report = {"pack": os.path.relpath(pack.path, REPO), "books": [],
              "families": {}}  # type: Dict[str, Any]
    tally = {}  # type: Dict[str, Dict[str, int]]
    for spec in pack.detectors:
        tally[spec.family] = {"evaluated": 0, "fired": 0, "clear": 0,
                              "not_applicable": 0, "waiting": 0,
                              "checked": 0, "agreed": 0}

    for case in sorted(CASES):
        book, profile, captured = load_case(case)
        series = BookSeries.of([book])
        detector_run = run_detectors(pack, series, profile)
        oracle = oracle_shares(captured)
        entry = {"case": case, "atoms": len(book.rows),
                 "total_assets": book.basis.total_assets,
                 "revenue": book.basis.revenue,
                 "profile": profile.profile_id,
                 "statement": detector_run.statement(),
                 "rows": []}  # type: Dict[str, Any]
        by_id = dict((r.detector_id, r) for r in detector_run.results)
        for check in detector_run.checks:
            spec = pack.get(check.detector_id)
            counters = tally[spec.family]
            if check.status == "waiting_on_history":
                counters["waiting"] += 1
                continue
            counters["evaluated"] += 1
            if check.status == "not_applicable":
                counters["not_applicable"] += 1
            elif check.status == "fired":
                counters["fired"] += 1
            elif check.status == "clear":
                counters["clear"] += 1
            result = by_id.get(check.detector_id)
            row = {"detector": check.detector_id, "family": spec.family,
                   "status": check.status, "reason": check.reason,
                   "accounts": list(check.accounts),
                   "atom_ids": list(result.atom_ids[:6]) if result else []}
            if result is not None and result.applicable:
                row["observed"] = _fmt(result.observed, _unit(result.observed_unit))
                row["expected"] = "%s %s" % (
                    result.comparator, _fmt(result.limit, _unit(result.observed_unit)))
                row["parameter_source"] = result.parameter_source
                if result.impact is not None:
                    row["impact"] = ("%s: %s -> %s"
                                     % (result.impact.metric_label,
                                        _fmt(result.impact.baseline,
                                             _unit(result.impact.unit)),
                                        _fmt(result.impact.adjusted,
                                             _unit(result.impact.unit))))
            expected = oracle.get(check.detector_id)
            if expected is not None and result is not None and result.applicable:
                counters["checked"] += 1
                agreed = abs(expected - result.observed) <= 0.02
                counters["agreed"] += 1 if agreed else 0
                row["oracle"] = _fmt(expected, "percent")
                row["oracle_agrees"] = agreed
            entry["rows"].append(row)
        report["books"].append(entry)

    for family in sorted(tally):
        counters = tally[family]
        n = counters["evaluated"]
        fired = counters["fired"]
        low, high = wilson(fired, n)
        block = {"evaluated": n, "fired": fired, "clear": counters["clear"],
                 "not_applicable": counters["not_applicable"],
                 "waiting_on_history": counters["waiting"]}
        if n and interval_useful(n):
            block["fire_rate"] = fired / float(n)
            block["fire_rate_ci95"] = [low, high]
        else:
            block["fire_rate"] = None
            block["fire_rate_ci95"] = None
            block["note"] = ("N INSUFFICIENT to certify a rate: %d evaluation(s) "
                             "on the real books in this checkout" % n)
        checked = counters["checked"]
        if checked:
            block["claims_independently_checked"] = checked
            block["claims_agreeing"] = counters["agreed"]
            if interval_useful(checked):
                clow, chigh = wilson(counters["agreed"], checked)
                block["claim_agreement_ci95"] = [clow, chigh]
            else:
                block["claim_agreement_ci95"] = None
                block["claim_note"] = (
                    "N INSUFFICIENT to certify an agreement rate: %d claim(s) "
                    "had a second data path to check against" % checked)
        report["families"][family] = block
    report["cross_period_on_derived_spines"] = cross_period(pack)
    return report


# ── the seven cross-period families, on derived spines ───────────────────

MONTHS6 = [(2025, m) for m in (7, 8, 9, 10, 11, 12)]
QUARTERS8 = [(2024, m) for m in (3, 6, 9, 12)] + [(2025, m) for m in (3, 6, 9, 12)]


def _scaler(prefix, factors, fields=("closing_debit", "closing_credit",
                                     "period_debit", "period_credit")):
    def _mutate(row, i):
        if not row.code.startswith(prefix):
            return row
        kw = dict((f, getattr(row, f) * factors[i]) for f in fields
                  if getattr(row, f) is not None)
        return replace(row, **kw)
    return _mutate


def _spine(base, periods, mutate, days=30):
    books = []
    for i, (year, month) in enumerate(periods):
        books.append(PeriodBook(
            period_id="p%d" % i, label="%04d-%02d" % (year, month), ordinal=i,
            currency=base.currency, rows=tuple(mutate(r, i) for r in base.rows),
            year=year, month=month, basis=base.basis, days_covered=days))
    return BookSeries.of(books)


def _reversal_mutate(base):
    bump = float(base.basis.total_assets or 0.0) * 0.05

    def _mutate(row, i):
        if not row.code.startswith("4111.01"):
            return row
        if i == 4:
            return replace(row, period_debit=(row.period_debit or 0.0) + bump,
                           closing_debit=(row.closing_debit or 0.0) + bump)
        if i == 5:
            return replace(row, period_credit=(row.period_credit or 0.0) + bump)
        return row
    return _mutate


def cross_period(pack) -> List[Dict[str, Any]]:
    """The seven cross-period families, driven on spines DERIVED from the
    real agras book. Each scenario moves ONE account family period to
    period and leaves every other atom byte-identical; every denominator
    is still a real number from a real book. This demonstrates the
    arithmetic and the refusals. It is NOT evidence about how often these
    families fire on real histories — no second real period of the same
    company exists in this checkout."""
    base, profile, _c = load_case("agras")
    scenarios = [
        ("ro_receivables_direction", MONTHS6,
         _scaler("411", [0.55, 0.62, 0.71, 0.80, 0.90, 1.00]),
         "411 rising every month"),
        ("ro_inventory_magnitude", MONTHS6,
         _scaler("3", [0.80, 0.81, 0.80, 0.81, 0.80, 1.00]),
         "stock flat, then one step"),
        ("ro_services_revenue_decouple", MONTHS6,
         _scaler("62", [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
         "external services rising, revenue unchanged"),
        ("ro_collection_velocity", MONTHS6,
         _scaler("411", [0.5, 0.5, 0.5, 0.5, 0.5, 3.0]),
         "receivables triple in the last month"),
        ("ro_period_end_reversal", MONTHS6, _reversal_mutate(base),
         "a period-end debit on 4111.01 reversed the month after"),
        ("ro_sundry_debtor_reactivation", MONTHS6,
         _scaler("461", [1.0, 1.0, 1.0, 1.0, 1.0, 40.0],
                 fields=("closing_debit", "closing_credit")),
         "461 quiet for five months, then a jump"),
        ("ro_revenue_cutoff", QUARTERS8,
         _scaler("70", [1.0, 1.0, 1.0, 1.2, 1.0, 1.0, 1.0, 4.0],
                 fields=("period_debit", "period_credit")),
         "the last quarter of 2025 carries four times the recognition"),
    ]
    rows = []  # type: List[Dict[str, Any]]
    for detector_id, periods, mutate, note in scenarios:
        series = _spine(base, periods, mutate)
        run = run_detectors(pack, series, profile, only=[detector_id])
        check = run.checks[0]
        result = run.results[0] if run.results else None
        row = {"detector": detector_id, "scenario": note,
               "status": check.status, "reason": check.reason,
               "periods": len(series.books),
               "surfaced": bool(run.findings and run.findings[0].verdict().surfaced)}
        if result is not None and result.applicable:
            unit = _unit(result.observed_unit)
            row["observed"] = _fmt(result.observed, unit)
            row["expected"] = "%s %s" % (result.comparator, _fmt(result.limit, unit))
            if result.impact is not None:
                row["impact"] = ("%s: %s -> %s"
                                 % (result.impact.metric_label,
                                    _fmt(result.impact.baseline, _unit(result.impact.unit)),
                                    _fmt(result.impact.adjusted, _unit(result.impact.unit))))
        rows.append(row)
    return rows


def _unit(unit: str) -> str:
    return {"money": "money", "ratio": "ratio", "percent": "percent",
            "days": "days", "count": "count", "score": "score"}.get(unit, unit)


def render(report: Dict[str, Any]) -> str:
    out = []  # type: List[str]
    out.append("RADAR DETECTORS — MEASURED ON REAL BOOKS")
    out.append("pack: %s" % report["pack"])
    out.append("")
    for book in report["books"]:
        out.append("=" * 72)
        out.append("%s — %d ledger atoms, total assets %s, revenue %s, profile %s"
                   % (book["case"], book["atoms"],
                      _money(book["total_assets"]), _money(book["revenue"]),
                      book["profile"]))
        out.append("  %s" % book["statement"])
        for row in book["rows"]:
            out.append("  [%s] %s (%s)" % (row["status"], row["detector"], row["family"]))
            out.append("      accounts: %s" % (", ".join(row["accounts"]) or "-"))
            if "observed" in row:
                out.append("      observed %s vs fires %s   [%s]"
                           % (row["observed"], row["expected"], row["parameter_source"]))
            if "impact" in row:
                out.append("      impact:   %s" % row["impact"])
            if row["atom_ids"]:
                out.append("      atoms:    %s" % ", ".join(row["atom_ids"]))
            if "oracle" in row:
                out.append("      second path: %s (%s)"
                           % (row["oracle"],
                              "agrees" if row["oracle_agrees"] else "DISAGREES"))
            out.append("      %s" % row["reason"])
    out.append("=" * 72)
    out.append("THE SEVEN CROSS-PERIOD FAMILIES, ON SPINES DERIVED FROM ONE REAL BOOK")
    out.append("  (agras, one account family moved period to period; every other")
    out.append("   atom and every denominator is the real book's own. This shows the")
    out.append("   arithmetic and the refusals, NOT a fire rate on real histories —")
    out.append("   no second real period of the same company exists in this checkout.)")
    for row in report["cross_period_on_derived_spines"]:
        out.append("  [%s] %s over %d periods — %s"
                   % (row["status"], row["detector"], row["periods"], row["scenario"]))
        if "observed" in row:
            out.append("      observed %s vs fires %s" % (row["observed"], row["expected"]))
        if "impact" in row:
            out.append("      impact:   %s" % row["impact"])
        out.append("      contract: %s" % ("surfaced" if row["surfaced"] else "no finding"))
        out.append("      %s" % row["reason"])
    out.append("=" * 72)
    out.append("PER-FAMILY TALLY (single-period run over %d real books)"
               % len(report["books"]))
    for family in sorted(report["families"]):
        block = report["families"][family]
        line = ("  %-14s evaluated %2d  fired %2d  clear %2d  n/a %2d  waiting %2d"
                % (family, block["evaluated"], block["fired"], block["clear"],
                   block["not_applicable"], block["waiting_on_history"]))
        out.append(line)
        if block.get("fire_rate") is None:
            out.append("      %s" % block.get("note", ""))
        else:
            low, high = block["fire_rate_ci95"]
            out.append("      fire rate %.1f%% (95%% Wilson %.1f%%-%.1f%%)"
                       % (block["fire_rate"] * 100.0, low * 100.0, high * 100.0))
        if "claims_independently_checked" in block:
            out.append("      %d/%d claim(s) reproduced from the engine's own "
                       "assembled line items"
                       % (block["claims_agreeing"], block["claims_independently_checked"]))
            if block.get("claim_agreement_ci95") is None:
                out.append("      %s" % block.get("claim_note", ""))
    return "\n".join(out)


def _money(value: Optional[float]) -> str:
    return "absent" if value is None else format(float(value), ",.2f")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = run()
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
