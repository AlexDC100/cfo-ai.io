"""THE SINGLE-PERIOD-VALID FAMILIES.

Five of the twelve. Each is a claim about the SHAPE of one book, so each
one is answerable on the first upload — which is what makes cold start a
real product state rather than an apology:

    round         round-number concentration against a baseline frequency
    benford       first-digit deviation, reported as a STATISTICAL SIGNAL
    concentration one counterparty's share of a family, with the ratios
                  RECOMPUTED WITHOUT IT
    interco       related-party balance, share and LENDER HAIRCUT
    assetage      accumulated depreciation over gross PP&E, and net book
                  value over the annual charge — remaining book life

TWO OF THEM ARE SIGNALS, NOT ACCUSATIONS. ``round`` and ``benford``
measure the distribution of amounts. A distribution is evidence about a
POPULATION and says nothing about any person: the pack marks them
``signal_only``, their severity is low, and :data:`SIGNAL_SENTENCE` is
appended to their reason and carried into the copy. The wording is part
of the deliverable, not decoration — a first-digit test presented as a
finding of fraud is defamatory and wrong, and the same test presented as
"this population does not follow the expected distribution; here is what
to reconcile" is useful.

BASELINE FIRST, PACK SECOND. Where the spine carries earlier periods, a
distribution is judged against THIS company's own earlier distribution
and the finding says so. The pack's expected share is the cold-start
baseline, and the finding says that instead.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.api import _finding as F
from engine.api import _ratio_units
from engine.api.findings import m_stats as ST

from . import book as B
from . import support as SUP
from .pack import DetectorSpec
from .registry import register
from .result import DetectorResult, MeasuredFigure, na

#: Appended to the reason of every ``signal_only`` detector. One string,
#: so a gate can assert it and a reader can recognise it.
SIGNAL_SENTENCE = ("This is a statistical property of the population of "
                   "amounts, not a finding about any person or transaction.")

#: Benford's first-digit expectation, computed rather than tabulated so
#: the constant cannot drift from its own definition.
BENFORD = dict((d, math.log10(1.0 + 1.0 / d)) for d in range(1, 10))

BASIS_PRIOR = "prior_period"
BASIS_SELF = "self_total"
BASIS_THRESHOLD = "profile_threshold"


def _amounts(book: "B.PeriodBook", prefixes: Sequence[str], measure: str,
             min_amount: float) -> Tuple[List[float], List["B.AccountRow"]]:
    """The population an amount-distribution family reads: absolute
    figures above the floor the pack declares. Zero and ABSENT are both
    excluded — neither is an amount somebody booked.

    ``sides`` (the default for both distribution families) takes the
    period DEBIT total and the period CREDIT total of each account as two
    separate amounts, because that is what the document states. The
    alternative — a NET movement — silently deletes every closed class 6
    and class 7 account, whose debit and credit sides cancel at year end,
    which is most of the amounts in the book.

    LEAVES ONLY, and this one is a statistical requirement rather than a
    tidiness preference. A synthetic account's figure is the SUM of its
    analytics, so a population containing both carries the same money
    twice and the parent's leading digit is not independent of its
    children's — which is precisely the assumption a Benford test rests
    on. Measured: reading every row instead of the leaves flipped the
    realestate book from clear to FIRED, on a population inflated by 74
    synthetic parents that restate money already counted. Romanian trial
    balances routinely list a synthetic beside its own analytics, so this
    is not an artefact of one construction path.
    """
    group = book.select(prefixes) if prefixes else B.Group(prefixes=(), rows=book.rows)
    rows = group.leaves()
    values = []  # type: List[float]
    kept = []  # type: List[B.AccountRow]
    for row in rows:
        if measure == "closing":
            raws = [row.closing_signed()]
        elif measure == "movement":
            raws = [row.movement_signed()]
        elif measure == "debit":
            raws = [row.movement_debit()]
        elif measure == "credit":
            raws = [row.movement_credit()]
        else:
            raws = [row.movement_debit(), row.movement_credit()]
        hit = False
        for raw in raws:
            if raw is None:
                continue
            value = abs(float(raw))
            if value < min_amount or value == 0.0:
                continue
            values.append(value)
            hit = True
        if hit:
            kept.append(row)
    return values, kept


def expected_null_mad(n: int) -> float:
    """The mean absolute deviation a PERFECTLY Benford population of this
    size produces by sampling alone.

    Each digit's observed share is a binomial proportion, whose mean
    absolute deviation from its own expectation is
    ``sqrt(2 p (1-p) / (pi n))``. Averaged over the nine digits, that is
    the noise floor: below it a deviation is the sample size talking.
    Computing it is what lets one band serve a 250-row trial balance and a
    million-row journal — a fixed cutoff calibrated on large populations
    calls every small book non-conformant, which is the false-positive
    machine this whole feature exists to avoid.
    """
    if n <= 0:
        raise ValueError("a null band for a population of %d is undefined" % n)
    total = 0.0
    for digit in range(1, 10):
        p = BENFORD[digit]
        total += math.sqrt(2.0 * p * (1.0 - p) / (math.pi * float(n)))
    return total / 9.0


def _rows_matching(rows: Sequence["B.AccountRow"], measure: str,
                   min_amount: float, predicate) -> List["B.AccountRow"]:
    """The rows whose own stated amounts satisfy ``predicate``.

    A distribution family reads the WHOLE book, so naming "the three
    largest accounts" as its subject would put arbitrary accounts in a
    sentence whose action step says to reconcile the CONTRIBUTING ones.
    The subject is therefore the rows that actually carry the amounts the
    test selected.
    """
    hits = []  # type: List[B.AccountRow]
    for row in rows:
        if measure == "closing":
            raws = [row.closing_signed()]
        elif measure == "movement":
            raws = [row.movement_signed()]
        elif measure == "debit":
            raws = [row.movement_debit()]
        elif measure == "credit":
            raws = [row.movement_credit()]
        else:
            raws = [row.movement_debit(), row.movement_credit()]
        for raw in raws:
            if raw is None:
                continue
            value = abs(float(raw))
            if value < min_amount or value == 0.0:
                continue
            if predicate(value):
                hits.append(row)
                break
    return hits


def _sum_abs_present(rows: Sequence["B.AccountRow"], measure: str
                     ) -> Optional[float]:
    """Sum |measure| across rows, or ABSENT if any single row cannot say.

    The `or 0.0` shape this replaces reads "treat what we do not know as
    nothing", which is the one substitution a balance-sheet reader can
    never make: a related-party movement of zero is a strong claim about
    governance, and a movement we cannot see is no claim at all."""
    total = 0.0
    for row in rows:
        value = getattr(row, measure)()
        if value is None:
            return None
        total += abs(float(value))
    return total


def first_digit(value: float) -> Optional[int]:
    digits = ("%.10f" % abs(float(value))).replace(".", "").lstrip("0")
    if not digits:
        return None
    head = int(digits[0])
    return head if 1 <= head <= 9 else None


def _round_share(values: Sequence[float], unit: float) -> Tuple[int, float]:
    """How many amounts are an exact multiple of ``unit``. Compared in
    MINOR units so 1,000.00 and 999.999999 cannot both pass a float test."""
    if unit <= 0:
        raise ValueError("round unit must be positive")
    step = int(round(unit * 100.0))
    hits = 0
    for value in values:
        minor = int(round(float(value) * 100.0))
        if step and minor % step == 0:
            hits += 1
    return hits, (float(hits) / float(len(values)) if values else 0.0)


# ── D-ROUND ──────────────────────────────────────────────────────────────


@register("round")
def round_numbers(spec: "DetectorSpec", series: "B.BookSeries",
                  profile: Any) -> List["DetectorResult"]:
    latest = series.latest()
    if latest is None:
        return [na(spec.id, "round", "the series carries no period")]
    prefixes = spec.prefixes("subject")
    measure = str(spec.params.get("measure", "movement"))
    min_amount = spec.number("min_amount")
    unit = spec.number("round_unit")
    min_population = int(spec.number("min_population"))
    values, rows = _amounts(latest, prefixes, measure, min_amount)
    if len(values) < min_population:
        return [na(spec.id, "round",
                   "%d amount(s) at or above %s are available and the test "
                   "needs %d; a share computed on fewer is not a measurement"
                   % (len(values), SUP.num(min_amount, 0), min_population),
                   periods=(latest.label,))]
    hits, observed = _round_share(values, unit)

    # Baseline: this company's own earlier books where the spine has them,
    # the pack's expected frequency where it does not.
    history = []  # type: List[float]
    for book in series.books[:-1]:
        prior_values, _r = _amounts(book, prefixes, measure, min_amount)
        if len(prior_values) >= min_population:
            history.append(_round_share(prior_values, unit)[1])
    if history:
        expected = ST.median(history)
        basis_kind = BASIS_PRIOR
        basis_description = ("this company's own round-number frequency in %s"
                             % ", ".join(b.label for b in series.books[:-1]))
        basis_source = "the company's own earlier books"
    else:
        expected = spec.number("expected_share")
        basis_kind = BASIS_THRESHOLD
        basis_description = ("the expected round-number frequency declared at %s"
                             % spec.address("expected_share"))
        basis_source = spec.address("expected_share")
    lift = observed - expected
    limit = spec.number("min_share_lift")
    fired = lift >= limit and observed >= spec.number("min_share")

    step = int(round(unit * 100.0))
    carriers = _rows_matching(
        rows, measure, min_amount,
        lambda v: step and int(round(v * 100.0)) % step == 0)
    accounts = SUP.accounts_of(carriers or rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("%d of %d amounts on %s are exact multiples of %s (%s), against "
              "%s from %s. %s"
              % (hits, len(values), codes or "the book", SUP.num(unit, 0),
                 SUP.pct(observed), SUP.pct(expected), basis_source,
                 SIGNAL_SENTENCE))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="round", fired=False,
            observed=float(lift), observed_unit=F.UNIT_PERCENT,
            parameter="min_share_lift",
            parameter_label="round-number frequency above the baseline",
            parameter_source=spec.address("min_share_lift"), comparator=">=",
            limit=limit, accounts=accounts, periods=(latest.label,),
            atom_ids=tuple(sorted(r.atom_id for r in (carriers or rows))),
            reason=reason)]

    figures, facts = SUP.figures_of([
        ("round_amount_share", observed, F.UNIT_PERCENT,
         "amounts that are exact multiples of %s" % SUP.num(unit, 0)),
        ("baseline_round_amount_share", expected, F.UNIT_PERCENT,
         "the baseline frequency this is judged against"),
        ("round_amount_count", float(hits), F.UNIT_COUNT,
         "round amounts in the population"),
        ("amount_population_count", float(len(values)), F.UNIT_COUNT,
         "amounts examined"),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.count_share_impact(
        "round_amount_share", "share of amounts that are exact multiples of %s"
        % SUP.num(unit, 0), expected * len(values), float(hits), float(len(values)))
    return [DetectorResult(
        detector_id=spec.id, family="round", fired=True,
        observed=float(lift), observed_unit=F.UNIT_PERCENT,
        parameter="min_share_lift",
        parameter_label="round-number frequency above the baseline",
        parameter_source=spec.address("min_share_lift"), comparator=">=",
        limit=limit, accounts=accounts, periods=(latest.label,),
        atom_ids=tuple(sorted(r.atom_id for r in (carriers or rows))),
        figures=figures, facts=facts, impact=impact, basis_kind=basis_kind,
        basis_description=basis_description, basis_value=float(expected),
        basis_unit=F.UNIT_PERCENT, reason=reason,
        tokens={"codes": codes, "observed": SUP.pct(observed),
                "expected": SUP.pct(expected), "hits": str(hits),
                "population": str(len(values)), "unit": SUP.num(unit, 0),
                "signal_sentence": SIGNAL_SENTENCE})]


# ── D-BENFORD ────────────────────────────────────────────────────────────


def benford_mad(values: Sequence[float]) -> Tuple[float, Dict[int, float], Dict[int, int]]:
    """Nigrini's mean absolute deviation of the first-digit distribution,
    with the observed shares and counts. Dimensionless in, dimensionless
    out — every share is a count over the same count."""
    counts = dict((d, 0) for d in range(1, 10))
    total = 0
    for value in values:
        digits = ("%.10f" % abs(float(value))).replace(".", "").lstrip("0")
        if not digits:
            continue
        first = int(digits[0])
        if first < 1 or first > 9:
            continue
        counts[first] += 1
        total += 1
    if total == 0:
        return 0.0, {}, counts
    shares = dict((d, counts[d] / float(total)) for d in range(1, 10))
    mad = sum(abs(shares[d] - BENFORD[d]) for d in range(1, 10)) / 9.0
    return mad, shares, counts


@register("benford")
def benford(spec: "DetectorSpec", series: "B.BookSeries",
            profile: Any) -> List["DetectorResult"]:
    latest = series.latest()
    if latest is None:
        return [na(spec.id, "benford", "the series carries no period")]
    prefixes = spec.prefixes("subject")
    measure = str(spec.params.get("measure", "movement"))
    min_amount = spec.number("min_amount")
    min_n = int(spec.number("min_population"))
    values, rows = _amounts(latest, prefixes, measure, min_amount)
    if len(values) < min_n:
        return [na(spec.id, "benford",
                   "the first-digit test needs %d amounts at or above %s and "
                   "this book carries %d; a conformity statistic on a smaller "
                   "population is not a measurement"
                   % (min_n, SUP.num(min_amount, 0), len(values)),
                   periods=(latest.label,))]
    mad, shares, counts = benford_mad(values)
    null_band = expected_null_mad(len(values))
    multiple = mad / null_band
    limit = spec.number("min_mad_multiple")
    fired = multiple >= limit

    excess = sorted(range(1, 10),
                    key=lambda d: (-(shares.get(d, 0.0) - BENFORD[d]), d))[0]
    carriers = _rows_matching(rows, measure, min_amount,
                              lambda v: first_digit(v) == excess)
    accounts = SUP.accounts_of(carriers or rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("the first-digit distribution of %d amounts deviates from the "
              "Benford expectation by a mean absolute deviation of %s, which "
              "is %s times the %s a perfectly Benford population of this size "
              "produces by sampling alone; leading 1s are %s where %s is "
              "expected. %s"
              % (len(values), SUP.num(mad, 4), SUP.num(multiple),
                 SUP.num(null_band, 4), SUP.pct(shares.get(1, 0.0)),
                 SUP.pct(BENFORD[1]), SIGNAL_SENTENCE))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="benford", fired=False,
            observed=float(multiple), observed_unit=F.UNIT_RATIO,
            parameter="min_mad_multiple",
            parameter_label="first-digit deviation against this population's "
                            "own sampling floor",
            parameter_source=spec.address("min_mad_multiple"), comparator=">=",
            limit=limit, accounts=accounts, periods=(latest.label,),
            atom_ids=tuple(sorted(r.atom_id for r in (carriers or rows))),
            reason=reason)]

    figures, facts = SUP.figures_of([
        ("first_digit_mad_pct", mad, F.UNIT_PERCENT,
         "mean absolute deviation from the Benford first-digit expectation"),
        ("sampling_floor_mad_pct", null_band, F.UNIT_PERCENT,
         "the deviation a perfectly Benford population of %d amounts produces "
         "by sampling alone" % len(values)),
        ("first_digit_deviation_multiple", multiple, F.UNIT_RATIO,
         "the observed deviation against that floor"),
        ("leading_one_share", shares.get(1, 0.0), F.UNIT_PERCENT,
         "amounts whose first digit is 1"),
        ("expected_leading_one_share", BENFORD[1], F.UNIT_PERCENT,
         "the Benford expectation for a leading 1"),
        ("amount_population_count", float(len(values)), F.UNIT_COUNT,
         "amounts examined"),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.count_share_impact(
        "leading_one_share", "share of amounts whose first digit is 1",
        BENFORD[1] * len(values), float(counts.get(1, 0)), float(len(values)))
    return [DetectorResult(
        detector_id=spec.id, family="benford", fired=True,
        observed=float(multiple), observed_unit=F.UNIT_RATIO,
        parameter="min_mad_multiple",
        parameter_label="first-digit deviation against this population's own "
                        "sampling floor",
        parameter_source=spec.address("min_mad_multiple"), comparator=">=",
        limit=limit, accounts=accounts, periods=(latest.label,),
        atom_ids=tuple(sorted(r.atom_id for r in (carriers or rows))),
        figures=figures, facts=facts, impact=impact, basis_kind=BASIS_THRESHOLD,
        basis_description="the Benford first-digit expectation, and the "
                          "sampling floor this population's own size implies",
        basis_value=float(null_band), basis_unit=F.UNIT_PERCENT, reason=reason,
        tokens={"codes": codes, "mad": SUP.num(mad, 4),
                "multiple": SUP.num(multiple), "floor": SUP.num(null_band, 4),
                "population": str(len(values)),
                "leading_one": SUP.pct(shares.get(1, 0.0)),
                "leading_one_expected": SUP.pct(BENFORD[1]),
                "excess_digit": str(excess),
                "signal_sentence": SIGNAL_SENTENCE})]


# ── D-CONCENTRA ──────────────────────────────────────────────────────────


@register("concentration")
def concentration(spec: "DetectorSpec", series: "B.BookSeries",
                  profile: Any) -> List["DetectorResult"]:
    """One counterparty's share of a family — and the family's share of
    the company total RECOMPUTED WITHOUT IT, which is the number that says
    whether the concentration matters."""
    latest = series.latest()
    if latest is None:
        return [na(spec.id, "concentration", "the series carries no period")]
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return [na(spec.id, "concentration", "detector declares no accounts.subject")]
    group = latest.select(prefixes)
    if not group.present():
        return [na(spec.id, "concentration",
                   "this book carries no account under %s" % ", ".join(prefixes),
                   periods=(latest.label,))]
    leaves = group.leaves()
    min_leaves = int(spec.number("min_counterparties"))
    if len(leaves) < min_leaves:
        return [na(spec.id, "concentration",
                   "%s resolves to %d analytic account(s); a concentration "
                   "share needs at least %d to be a share OF something"
                   % (", ".join(prefixes), len(leaves), min_leaves),
                   periods=(latest.label,))]
    total = sum(abs(r.closing_signed() or 0.0) for r in leaves)
    if total <= 0:
        return [na(spec.id, "concentration",
                   "%s carries no balance in this book" % ", ".join(prefixes),
                   periods=(latest.label,))]
    ranked = sorted(leaves, key=lambda r: (-abs(r.closing_signed() or 0.0), r.code))
    top = ranked[0]
    top_value = abs(top.closing_signed() or 0.0)
    share = top_value / total
    limit = spec.number("min_share")

    basis = SUP.basis_of(spec, latest)
    accounts = ((top.code, top.name),) + SUP.accounts_of(ranked[1:], limit=2)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("%s carries %s of the %s balance across %d analytic accounts"
              % (top.code, SUP.pct(share), spec.scope, len(leaves)))
    if basis is None:
        return [na(spec.id, "concentration", SUP.basis_missing_reason(spec),
                   accounts=accounts, periods=(latest.label,))]

    family_share = total / basis.value
    family_share_ex_top = (total - top_value) / basis.value

    # A CONCENTRATION INSIDE AN IMMATERIAL BALANCE IS NOT A FINDING.
    #
    # The share is a true ratio at any size — one counterparty can hold
    # 57% of a receivable book that is itself 0.03% of total assets, and
    # on the realestate book it does. Surfaced as HIGH, that sentence
    # spends a reader's attention on a number whose own consequence line
    # reads "moves from 0.0% to 0.0%", because removing the counterparty
    # entirely does not move the balance sheet at the precision the
    # statement is printed to. The floor is pack data, not a number in
    # this module: how large a line must be before it can matter is a
    # policy about the reader's book, and the detector only enforces it.
    min_subject = spec.number("min_subject_share_of_basis")
    material = family_share >= min_subject
    fired = share >= limit and material

    if not fired:
        if share >= limit:
            # The concentration is real and the balance is too small for
            # it to mean anything. Record what actually decided it —
            # reporting `min_share` here would say the share fell short
            # when it did not.
            return [DetectorResult(
                detector_id=spec.id, family="concentration", fired=False,
                observed=float(family_share), observed_unit=F.UNIT_PERCENT,
                parameter="min_subject_share_of_basis",
                parameter_label="%s as a share of %s" % (spec.scope, basis.label),
                parameter_source=spec.address("min_subject_share_of_basis"),
                comparator=">=", limit=min_subject, accounts=accounts,
                periods=(latest.label,), atom_ids=group.atom_ids(),
                reason=("%s, but %s is %s of %s — removing that counterparty "
                        "outright would not move the balance sheet"
                        % (reason, spec.scope, SUP.pct(family_share),
                           basis.label)))]
        return [DetectorResult(
            detector_id=spec.id, family="concentration", fired=False,
            observed=float(share), observed_unit=F.UNIT_PERCENT,
            parameter="min_share",
            parameter_label="largest counterparty share of %s" % spec.scope,
            parameter_source=spec.address("min_share"), comparator=">=",
            limit=limit, accounts=accounts, periods=(latest.label,),
            atom_ids=group.atom_ids(), reason=reason)]
    figures, facts = SUP.figures_of([
        ("top_counterparty_share", share, F.UNIT_PERCENT,
         "%s share of the %s balance" % (top.code, spec.scope)),
        ("subject_share", family_share, F.UNIT_PERCENT,
         "%s share of %s as reported" % (spec.scope, basis.label)),
        ("ex_top_subject_share", family_share_ex_top, F.UNIT_PERCENT,
         "the same share with %s removed" % top.code),
        ("counterparty_count", float(len(leaves)), F.UNIT_COUNT,
         "analytic accounts under %s" % ", ".join(prefixes)),
    ])
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "subject_share_of_basis",
        "%s share of %s" % (spec.scope, basis.label), series.currency,
        total, total - top_value, basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="concentration", fired=True,
        observed=float(share), observed_unit=F.UNIT_PERCENT,
        parameter="min_share",
        parameter_label="largest counterparty share of %s" % spec.scope,
        parameter_source=spec.address("min_share"), comparator=">=",
        limit=limit, accounts=accounts, periods=(latest.label,),
        atom_ids=group.atom_ids(), figures=figures, facts=facts, impact=impact,
        basis_kind=BASIS_SELF,
        basis_description="the %s balance this book carries across %d analytic "
                          "accounts" % (spec.scope, len(leaves)),
        basis_value=float(total), basis_unit=F.UNIT_MONEY, reason=reason,
        tokens={"codes": codes, "top_code": top.code, "share": SUP.pct(share),
                "count": str(len(leaves)), "basis_label": basis.label,
                "share_with": SUP.pct(family_share),
                "share_without": SUP.pct(family_share_ex_top)})]


# ── D-INTERCO ────────────────────────────────────────────────────────────


@register("interco")
def interco(spec: "DetectorSpec", series: "B.BookSeries",
            profile: Any) -> List["DetectorResult"]:
    """Related-party balances, their share of the company total, their
    movement, and the asset base that survives a LENDER HAIRCUT."""
    latest = series.latest()
    if latest is None:
        return [na(spec.id, "interco", "the series carries no period")]
    prefixes = spec.prefixes("subject")
    if not prefixes:
        return [na(spec.id, "interco", "detector declares no accounts.subject")]
    group = latest.select(prefixes)
    if not group.present():
        return [na(spec.id, "interco",
                   "this book carries no related-party account under %s"
                   % ", ".join(prefixes), periods=(latest.label,))]
    side = str(spec.params.get("side", "debit"))
    rows = [r for r in group.leaves()
            if (r.closing_signed() or 0.0) > 0] if side == "debit" else [
        r for r in group.leaves() if (r.closing_signed() or 0.0) < 0]
    balance = sum(abs(r.closing_signed() or 0.0) for r in rows)
    if balance <= 0:
        return [na(spec.id, "interco",
                   "%s carries no %s balance in this book"
                   % (", ".join(prefixes), side), periods=(latest.label,))]
    basis = SUP.basis_of(spec, latest)
    if basis is None:
        return [na(spec.id, "interco", SUP.basis_missing_reason(spec),
                   periods=(latest.label,))]
    share = balance / basis.value
    limit = spec.number("min_share")
    haircut_rate = spec.number("lender_haircut")
    fired = share >= limit

    # ABSENT IS NOT ZERO, and on this line it was the difference between a
    # measured fact and a fabricated one. `canonical_bs` serves no movement
    # column on any persisted period (its producer says so: "prior-period
    # column not plumbed yet"), so `or 0.0` made EVERY served book report
    # "related-party movement 0.0% of total assets" — a confident,
    # printable, false zero, on agras where the ledger tier measures 2.12%.
    # A row whose movement is absent makes the GROUP's movement absent, and
    # an absent movement is simply not among the figures.
    movement = _sum_abs_present(rows, "movement_signed")
    accounts = SUP.accounts_of(rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    reason = ("related-party balances on %s stand at %s of %s; a lender "
              "haircutting them at %s underwrites %s of the reported asset base"
              % (codes, SUP.pct(share), basis.label, SUP.pct(haircut_rate),
                 SUP.pct(1.0 - share * haircut_rate)))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="interco", fired=False,
            observed=float(share), observed_unit=F.UNIT_PERCENT,
            parameter="min_share",
            parameter_label="related-party share of %s" % basis.label,
            parameter_source=spec.address("min_share"), comparator=">=",
            limit=limit, accounts=accounts, periods=(latest.label,),
            atom_ids=group.atom_ids(), reason=reason)]

    haircut = balance * haircut_rate
    measured = [
        ("interco_share", share, F.UNIT_PERCENT,
         "related-party balances as a share of %s" % basis.label),
    ]
    if movement is not None:
        measured.append(
            ("interco_movement_share", movement / basis.value, F.UNIT_PERCENT,
             "movement on those accounts this period, against %s" % basis.label))
    measured.append(
        ("underwritable_asset_share", 1.0 - share * haircut_rate, F.UNIT_PERCENT,
         "share of the reported asset base left after a %s haircut"
         % SUP.pct(haircut_rate)))
    figures, facts = SUP.figures_of(measured)
    SUP.assert_units_declared(figures)
    impact = SUP.share_impact(
        "underwritable_asset_share",
        "asset base a lender underwrites after a %s related-party haircut"
        % SUP.pct(haircut_rate), series.currency,
        basis.value, basis.value - haircut, basis.value, basis.name)
    return [DetectorResult(
        detector_id=spec.id, family="interco", fired=True,
        observed=float(share), observed_unit=F.UNIT_PERCENT,
        parameter="min_share",
        parameter_label="related-party share of %s" % basis.label,
        parameter_source=spec.address("min_share"), comparator=">=", limit=limit,
        accounts=accounts, periods=(latest.label,), atom_ids=group.atom_ids(),
        figures=figures, facts=facts, impact=impact, basis_kind=BASIS_SELF,
        basis_description="%s as served for this period, against which the "
                          "related-party position is measured" % basis.label,
        basis_value=float(basis.value), basis_unit=F.UNIT_MONEY, reason=reason,
        tokens={"codes": codes, "share": SUP.pct(share),
                "haircut": SUP.pct(haircut_rate), "basis_label": basis.label,
                "underwritable": SUP.pct(1.0 - share * haircut_rate)})]


# ── D-ASSETAGE ───────────────────────────────────────────────────────────


@register("assetage")
def assetage(spec: "DetectorSpec", series: "B.BookSeries",
             profile: Any) -> List["DetectorResult"]:
    """Accumulated depreciation over gross PP&E, and net book value over
    the annual charge — REMAINING BOOK LIFE, which is the capex cliff
    stated as a number of years instead of as a worry."""
    latest = series.latest()
    if latest is None:
        return [na(spec.id, "assetage", "the series carries no period")]
    gross_group = latest.select(spec.prefixes("gross"))
    accum_group = latest.select(spec.prefixes("accumulated"))
    if not gross_group.present():
        return [na(spec.id, "assetage",
                   "this book carries no gross asset account under %s"
                   % ", ".join(spec.prefixes("gross")), periods=(latest.label,))]
    gross = sum(abs(r.closing_signed() or 0.0) for r in gross_group.rows)
    accum = sum(abs(r.closing_signed() or 0.0) for r in accum_group.rows)
    if gross <= 0:
        return [na(spec.id, "assetage",
                   "gross assets under %s total zero in this book"
                   % ", ".join(spec.prefixes("gross")), periods=(latest.label,))]
    depreciated = accum / gross
    limit = spec.number("min_depreciated_share")
    fired = depreciated >= limit

    charge_group = latest.select(spec.prefixes("charge"))
    # The DEBIT side, not the net movement: an expense account is closed
    # to the result account at year end, so its net movement is zero and
    # reading it that way would report "no annual charge" on every book
    # that has one.
    charge = sum(abs(r.movement_debit() or 0.0) for r in charge_group.rows)
    nbv = max(gross - accum, 0.0)
    accounts = SUP.accounts_of(gross_group.rows, limit=3)
    codes = ", ".join(c for c, _n in accounts)
    caveats = ()  # type: Tuple[str, ...]
    life = None  # type: Optional[float]
    if charge > 0:
        life = nbv / charge
        # CHARGE PERIODS, never "years". The movement column of a trial
        # balance covers whatever period the document covers — on the four
        # real books in tests/engine/fixtures/firm it is one MONTH, about
        # 8% of the annual figure — and calling that an annual charge
        # divides the remaining life by twelve without saying so.
        reason = ("%s of the gross asset base on %s is already depreciated; the "
                  "remaining net book value carries %s charge periods of life "
                  "at the charge this book states for %s"
                  % (SUP.pct(depreciated), codes, SUP.num(life, 1), latest.label))
    else:
        caveats = ("this book states no depreciation charge under %s, so "
                   "remaining book life is not computed"
                   % ", ".join(spec.prefixes("charge")),)
        reason = ("%s of the gross asset base on %s is already depreciated"
                  % (SUP.pct(depreciated), codes))
    if not fired:
        return [DetectorResult(
            detector_id=spec.id, family="assetage", fired=False,
            observed=float(depreciated), observed_unit=F.UNIT_PERCENT,
            parameter="min_depreciated_share",
            parameter_label="share of gross assets already depreciated",
            parameter_source=spec.address("min_depreciated_share"),
            comparator=">=", limit=limit, accounts=accounts,
            periods=(latest.label,), atom_ids=gross_group.atom_ids(),
            reason=reason, caveats=caveats)]

    pairs = [("depreciated_share", depreciated, F.UNIT_PERCENT,
              "share of gross assets already depreciated"),
             ("net_book_value_share", nbv / gross, F.UNIT_PERCENT,
              "share of the gross base still carried")]
    if life is not None:
        pairs.append(("remaining_book_life_multiple", life, F.UNIT_RATIO,
                      "remaining book life, in charge periods of the size %s "
                      "states" % latest.label))
    figures, facts = SUP.figures_of(pairs)
    SUP.assert_units_declared(figures)
    if life is not None:
        impact = F.ratio_impact(
            metric="book_life_multiple",
            metric_label="book life on %s, in charge periods" % codes,
            numerator=SUP.money_q(gross, series.currency, "gross_asset_base"),
            denominator=SUP.money_q(charge, series.currency, "period_charge"),
            adjusted_numerator=SUP.money_q(nbv, series.currency, "net_book_value"),
            unit=F.UNIT_RATIO)
    else:
        impact = F.headroom_impact(
            metric="depreciated_share",
            metric_label="share of gross assets already depreciated",
            observed=_ratio_units.percent_q(depreciated, "depreciated_share"),
            limit=_ratio_units.percent_q(limit, "depreciated_share_band"))
    return [DetectorResult(
        detector_id=spec.id, family="assetage", fired=True,
        observed=float(depreciated), observed_unit=F.UNIT_PERCENT,
        parameter="min_depreciated_share",
        parameter_label="share of gross assets already depreciated",
        parameter_source=spec.address("min_depreciated_share"), comparator=">=",
        limit=limit, accounts=accounts, periods=(latest.label,),
        atom_ids=gross_group.atom_ids() + accum_group.atom_ids(),
        figures=figures, facts=facts, impact=impact, basis_kind=BASIS_SELF,
        basis_description="the gross asset base this book carries under %s"
                          % ", ".join(spec.prefixes("gross")),
        basis_value=float(gross), basis_unit=F.UNIT_MONEY, reason=reason,
        caveats=caveats,
        tokens={"codes": codes, "depreciated": SUP.pct(depreciated),
                "life": (SUP.num(life, 1) if life is not None else "not computed"),
                "nbv_share": SUP.pct(nbv / gross)})]


__all__ = ["BENFORD", "SIGNAL_SENTENCE", "assetage", "benford", "benford_mad",
           "concentration", "expected_null_mad", "first_digit", "interco",
           "round_numbers"]
