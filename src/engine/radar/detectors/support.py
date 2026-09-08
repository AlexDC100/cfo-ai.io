"""SHARED MACHINERY FOR THE FAMILIES — and the one place a
:class:`DetectorResult` becomes a ``_finding.Finding``.

Three jobs:

  BASIS       resolve the company total a detector compares against, from
              the figures the CALLER supplied (gateway-served). Absent is
              absent: the detector reports NOT APPLICABLE with the reason
              instead of dividing by a number nobody served.
  IMPACT      every quotient goes through ``_ratio_units`` via the three
              sanctioned impact constructors, so a ratio cannot be built
              across a currency or scale boundary and is invariant under a
              display-currency switch.
  ASSEMBLY    the seven contract elements, each from a typed source — the
              measurement, the pack row, or the company profile. There is
              no place here for a hand-written sentence.

THE COPY IS PACK DATA. ``why`` and every action step come from the
detector's own row, rendered against tokens the measurement produced, so
a fictional detector added through YAML alone arrives with complete copy
and passes the seven-element contract without an engine edit.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _ratio_units

from . import book as B
from . import pack as PK
from .result import DetectorResult, MeasuredFigure

#: How many atom ids travel into the finding's own provenance line. The
#: FULL set stays on ``DetectorResult.atom_ids`` for the payload; the
#: prose carries a bounded, sorted head so a 300-account group does not
#: render a paragraph of identifiers. Deterministic by construction.
MAX_LINE_REFS = 6

#: The source label a Radar detector stamps on its provenance. It is not
#: ``assembled_canonical_v1`` — these figures are read from the parsed
#: source document's atoms, and saying otherwise would claim a
#: reconciliation that did not happen.
PROVENANCE_SOURCE = "ledger_atoms_v1"

_TOKEN_RX = re.compile(r"\{([a-z_][a-z0-9_]*)\}")


def render_tokens(template: str, tokens: Dict[str, str]) -> str:
    """``{token}`` substitution with no formatting language and no eval.
    An unknown token is left in place rather than raising — the finding's
    own validators then reject the sentence, which is a louder failure
    than a KeyError inside a detector."""
    def _sub(match):
        return tokens.get(match.group(1), match.group(0))
    return _TOKEN_RX.sub(_sub, template or "")


def pct(value: float) -> str:
    return "%.1f%%" % (float(value) * 100.0)


def num(value: float, places: int = 2) -> str:
    return ("%%.%df" % places) % float(value)


def money_q(value: float, currency: str, name: str) -> "_ratio_units.Quantity":
    return _ratio_units.money(float(value), currency, 1, name)


def count_q(value: float, name: str) -> "_ratio_units.Quantity":
    return _ratio_units.count(float(value), name)


@dataclass(frozen=True)
class ResolvedBasis:
    name: str
    value: float
    label: str
    source: str

    def describe(self) -> str:
        return "%s as served for this period (%s)" % (self.label, self.source)


def basis_of(spec: "PK.DetectorSpec", book: "B.PeriodBook"
             ) -> Optional[ResolvedBasis]:
    """The company total this detector's share is taken of. ``None`` when
    the pack asks for one the caller did not serve."""
    if not spec.basis:
        return None
    value = book.basis.get(spec.basis)
    if value is None or value <= 0:
        return None
    return ResolvedBasis(name=spec.basis, value=float(value),
                         label=book.basis.label(spec.basis),
                         source=book.basis.source)


def basis_missing_reason(spec: "PK.DetectorSpec") -> str:
    return ("%s is not served for this period, so a share of it cannot be "
            "computed; the detector reports no reading rather than dividing "
            "by an assumed total" % (spec.basis or "the comparison basis"))


def accounts_of(rows: Sequence["B.AccountRow"], limit: int = 4
                ) -> Tuple[Tuple[str, str], ...]:
    """The subject accounts, largest closing balance first, capped. The
    cap is deterministic (value then code) so two runs name the same
    accounts in the same order."""
    ranked = sorted(
        rows,
        key=lambda r: (-abs(r.closing_signed() or r.movement_gross() or 0.0), r.code))
    out = []  # type: List[Tuple[str, str]]
    for row in ranked:
        if row.code in [c for c, _ in out]:
            continue
        out.append((row.code, row.name))
        if len(out) >= limit:
            break
    return tuple(out)


def share_impact(metric: str, label: str, currency: str,
                 baseline_part: float, adjusted_part: float,
                 whole: float, whole_name: str,
                 adjusted_whole: Optional[float] = None) -> "F.Impact":
    """A recomputed share: the metric as reported and the metric restated.
    Both quotients are money over money, so both go through
    ``_ratio_units.ratio`` and neither can cross a currency."""
    return F.ratio_impact(
        metric=metric, metric_label=label,
        numerator=money_q(baseline_part, currency, metric + "_baseline_part"),
        denominator=money_q(whole, currency, whole_name),
        adjusted_numerator=money_q(adjusted_part, currency, metric + "_adjusted_part"),
        adjusted_denominator=(
            money_q(adjusted_whole, currency, whole_name + "_adjusted")
            if adjusted_whole is not None else None),
        unit=F.UNIT_PERCENT)


def count_share_impact(metric: str, label: str,
                       baseline_count: float, adjusted_count: float,
                       population: float) -> "F.Impact":
    """The same shape for a share of a COUNT — how many amounts, not how
    much money. Count over count is dimensionless and currency-free."""
    return F.ratio_impact(
        metric=metric, metric_label=label,
        numerator=count_q(baseline_count, metric + "_expected"),
        denominator=count_q(population, metric + "_population"),
        adjusted_numerator=count_q(adjusted_count, metric + "_observed"),
        unit=F.UNIT_PERCENT)


def figures_of(pairs: Sequence[Tuple[str, float, str, str]]
               ) -> Tuple[Tuple["MeasuredFigure", ...], Dict[str, float]]:
    """Build the evidence figures and the ``facts_cited`` map together, so
    the two can never disagree — which is a demotion reason in
    ``_finding._check_evidence``."""
    figures = tuple(MeasuredFigure(fact=f, value=float(v), unit=u, label=l)
                    for f, v, u, l in pairs)
    facts = dict((f.fact, float(f.value)) for f in figures)
    return figures, facts


def assert_units_declared(figures: Sequence["MeasuredFigure"]) -> None:
    """Refuse a figure whose fact name the unit registry cannot type. The
    finding validator would demote it; failing here names the detector."""
    for fig in figures:
        declared = _ratio_units.unit_for_fact(fig.fact)
        if declared == _ratio_units.UNIT_UNKNOWN:
            raise ValueError(
                "fact %r has no unit in _ratio_units. Radar detectors cite "
                "dimensionless facts whose names follow the house suffixes "
                "(_share, _pct, _ratio, _multiple, _days, _count) or a money "
                "name the registry declares; a new money name is a deliberate "
                "registry edit, not a detector's to make." % fig.fact)
        if declared != fig.unit:
            raise ValueError(
                "fact %r is declared %s but cited as %s"
                % (fig.fact, declared, fig.unit))


def head_line_refs(atom_ids: Sequence[str], subject_codes: Sequence[str]
                   ) -> Tuple[str, ...]:
    """The atom ids that travel into the finding's own provenance line.

    THE SUBJECT'S ATOMS COME FIRST. An id is ``<row>:<account code>``, so
    the ones whose code the finding actually names are put ahead of the
    rest before the head is taken — a provenance line listing six atoms
    from accounts the sentence never mentions is technically traceable
    and practically useless. Ties break on the id, so the order is
    deterministic.
    """
    wanted = set(subject_codes)

    def _key(atom_id):
        code = atom_id.split(":", 1)[1] if ":" in atom_id else atom_id
        return (0 if code in wanted else 1, atom_id)

    return tuple(sorted(atom_ids, key=_key)[:MAX_LINE_REFS])


def build_finding(spec: "PK.DetectorSpec", result: "DetectorResult",
                  profile: "CP.CompanyProfile", currency: str,
                  period_id: str, snapshot_id: Optional[str] = None
                  ) -> "F.Finding":
    """The seven elements, assembled from typed sources."""
    figures = tuple(F.Figure(fact=f.fact, value=f.value, unit=f.unit,
                             label=f.label) for f in result.figures)
    provenance = F.Provenance(
        period_id=period_id, snapshot_id=snapshot_id,
        line_refs=head_line_refs(result.atom_ids, result.scope_codes()),
        source=PROVENANCE_SOURCE)
    evidence = F.Evidence(
        figures=figures, provenance=provenance,
        comparison_basis=F.ComparisonBasis(
            kind=result.basis_kind, description=result.basis_description,
            basis_value=result.basis_value, basis_unit=result.basis_unit))

    threshold = F.Threshold(
        rule_id=result.detector_id, parameter=result.parameter,
        parameter_label=result.parameter_label, comparator=result.comparator,
        limit=result.limit, observed=result.observed,
        unit=result.observed_unit, source=result.parameter_source)

    tokens = dict(result.tokens)
    tokens.update({
        "profile_label": profile.profile_label,
        "size_label": profile.size_band.label,
        "sector_label": profile.sector_label,
        "financing_label": profile.financing.label,
        "signal_labels": (", ".join(s.label for s in profile.present_signals())
                          or "no structural signals"),
        "scope": spec.scope,
        "codes": ", ".join(result.scope_codes()),
        "citation": spec.citation,
    })

    rationale = render_tokens(spec.why, tokens)
    why_here = F.WhyHere(
        profile_id=profile.profile_id, profile_label=profile.profile_label,
        rationale=rationale,
        signals=(tuple(s.id for s in profile.present_signals())
                 or (profile.financing.id,)),
        anchors=profile.anchors())

    action = F.Action(steps=tuple(
        F.ActionStep(imperative=render_tokens(step.imperative, tokens),
                     artefact=render_tokens(step.artefact, tokens),
                     provider=step.provider,
                     horizon=(render_tokens(step.horizon, tokens)
                              if step.horizon else None))
        for step in spec.actions))

    if spec.confidence_basis:
        confidence = F.Confidence(
            level=spec.confidence_level, basis=spec.confidence_basis,
            caveat=spec.confidence_caveat)
    else:
        confidence = profile.confidence(None, extra_caveats=result.caveats)

    return F.Finding(
        rule_id=result.detector_id, severity=spec.severity,
        category=spec.category, currency=currency,
        subject=F.Subject(
            accounts=tuple(F.Account(code=c, name=n) for c, n in result.accounts),
            scope=spec.scope),
        evidence=evidence, threshold=threshold, impact=result.impact,
        why_here=why_here, action=action, confidence=confidence,
        profile_id=profile.profile_id,
        profile_fingerprint=profile.fingerprint(),
        facts_cited=dict(result.facts))


__all__ = [
    "MAX_LINE_REFS", "PROVENANCE_SOURCE", "ResolvedBasis", "accounts_of",
    "head_line_refs",
    "assert_units_declared", "basis_missing_reason", "basis_of",
    "build_finding", "count_q", "count_share_impact", "figures_of", "money_q",
    "num", "pct", "render_tokens", "share_impact",
]
