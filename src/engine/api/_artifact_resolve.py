"""THE ARTIFACT RESOLVER — where a spec becomes an artifact, and the
engine authors every digit in it.

A parsed :class:`engine.api._artifact_spec.ArtifactSpec` carries ids and
presentation. This module turns it into something a reader can look at,
and the ONE rule it exists to keep is that every numeral in the result
came out of the facts gateway with its provenance attached.

WHERE THE NUMBERS COME FROM
===========================
Through :mod:`engine.api._capsule_tools` — the read-only, allowlisted
tool layer that reads :class:`engine.serving.FactsGateway` over the
period's persisted ``assembled_canonical_v1``. This module re-implements
none of that arithmetic and reads no envelope totals itself. Two
consequences worth stating:

  · The ALIGNMENT rules come free. A cross-entity, cross-currency or
    unlabelled-period comparison is refused by ``compare_periods``
    before a delta exists, so an artifact cannot draw a bar whose height
    is the difference between two currencies.
  · A metric this surface does not serve, and a period with no attached
    file, arrive as TYPED GAPS naming what is missing and what would
    close it. They render as gap cards IN THE CELL — never as a zero,
    never as the month next door, never as an estimate (C5).

NATIVE-UNIT DERIVATION
======================
Derived series are computed on native operands, in integer minor units,
through :mod:`engine.api._ratio_units`:

  · ``delta`` — b − a, integer subtraction in minor units, only after
    the tool layer has confirmed both sides are the same entity, the
    same native currency and both labelled. The 461 law: identical unit
    AND currency AND scale, or a typed refusal.
  · ``pct_change`` — ``ratio(delta, base)``, dimensionless, so it is
    invariant under the display-currency dial. A zero base is UNDEFINED,
    which is not zero, and it refuses (the 1553% law: an undefined
    ratio reported as a number is a fabricated one).
  · ``share`` — ``ratio(metric, denominator)`` within ONE period, same
    rules.

A refusal here carries NO number. A partial number is indistinguishable
from a wrong one.

SKELETON FIRST — THE VISUAL FORM OF FACT-BEFORE-PROSE
======================================================
:func:`skeleton_for` is derivable from the spec and the period roster
ALONE — no envelope read, no gateway call — so the artifact's frame,
axes and labels can be on screen before the first value resolves.
:func:`stream_frames` emits it as frame 0, always, and every later frame
fills one cell. The skeleton carries no ``value`` and no
``amount_minor`` anywhere; ``tests/engine/test_artifact_resolve.py``
sweeps it for both.

WHO WRITES THE LABELS
=====================
The model writes the title, the subtitle and the axis names, and the
spec parser has already refused any digit in them. The engine writes
every label that CONTAINS a figure — the period captions, the series
labels for metrics the model did not name, the caption that says which
months are being compared. That division is the point: a period label is
a fact about the book, and the reader must be able to trust it the same
way they trust the bars.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import _artifact_spec as _spec
from . import _capsule_tools as _tools
from . import _ratio_units

#: Contract version of the resolved-artifact payload.
ARTIFACT_VERSION = "ar1"

FRAME_SKELETON = "skeleton"
FRAME_CELL = "cell"
FRAME_GAP = "gap"
FRAME_REFUSAL = "refusal"
FRAME_COMPLETE = "complete"

#: Refusal codes this module owns. The tool layer's own gap codes ride
#: through unchanged — a gap is the tool's word, not ours.
REFUSE_UNIT_MISMATCH = "unit_mismatch"
REFUSE_UNDEFINED_RATIO = "undefined_ratio"
REFUSE_NEEDS_TWO_PERIODS = "needs_two_periods"
REFUSE_NO_DENOMINATOR = "no_denominator"
REFUSE_NO_DELTA_FOR_UNIT = "no_delta_for_unit"


# ══════════════════════════════════════════════════════════════════════
# THE RESOLVED PIECES
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class ArtifactCell(object):
    """ONE resolved figure, at one coordinate.

    ``fact`` and ``provenance`` are not decoration: they are what makes
    the figure traceable to a source cell, and the sweep in the tests
    refuses any numeric leaf in the payload that lacks them.

    Money is carried in INTEGER MINOR UNITS, like everywhere else in
    this engine; ``value`` is the float only at the serialization
    boundary.
    """

    series_id: str
    slot_id: str
    kind: str                      # "money" | "ratio"
    fact: str
    unit: str
    provenance: Dict[str, Any]
    amount_minor: Optional[int] = None
    currency: str = ""
    value: Optional[float] = None
    numerator_minor: Optional[int] = None
    denominator_minor: Optional[int] = None
    label_key: str = ""
    #: Engine-authored context ("December 2024 minus November 2024").
    scope: str = ""

    def to_payload(self) -> Dict[str, Any]:
        out = {
            "kind": self.kind,
            "series_id": self.series_id,
            "slot_id": self.slot_id,
            "fact": self.fact,
            "unit": self.unit,
            "label_key": self.label_key,
            "scope": self.scope,
            "provenance": dict(self.provenance or {}),
        }  # type: Dict[str, Any]
        if self.kind == "money":
            out["amount_minor"] = self.amount_minor
            out["value"] = (None if self.amount_minor is None
                            else self.amount_minor / 100.0)
            out["currency"] = self.currency
        else:
            out["value"] = self.value
            out["numerator_minor"] = self.numerator_minor
            out["denominator_minor"] = self.denominator_minor
            out["operand_currency"] = self.currency
        return out


@dataclass(frozen=True)
class ArtifactGapCard(object):
    """C5 in artifact form — the honest gap, at a coordinate.

    Carries what is missing and what would close it, and NO substitute
    value. It renders where the bar would have been, so the reader sees
    an absence rather than a shorter bar.
    """

    series_id: str
    slot_id: str
    tool: str
    code: str
    missing: Tuple[str, ...]
    detail: str
    fix: str
    upsell_key: str = ""

    @property
    def refused(self) -> bool:
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "gap",
            "series_id": self.series_id,
            "slot_id": self.slot_id,
            "tool": self.tool,
            "code": self.code,
            "missing": list(self.missing),
            "detail": self.detail,
            "fix": self.fix,
            "upsell_key": self.upsell_key,
        }


@dataclass(frozen=True)
class ArtifactRefusal(object):
    """The COMPARISON would be wrong, or the arithmetic is undefined.

    Distinct from a gap on purpose, and the distinction is the same one
    the tool layer draws: a gap is "the data is not here", a refusal is
    "the data is here and this operation on it would lie". Carries no
    number, for the same reason a gap does not.
    """

    series_id: str
    slot_id: str
    code: str
    detail: str
    alternative: str = ""

    @property
    def refused(self) -> bool:
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "refusal",
            "series_id": self.series_id,
            "slot_id": self.slot_id,
            "code": self.code,
            "detail": self.detail,
            "alternative": self.alternative,
        }


@dataclass(frozen=True)
class SeriesHead(object):
    """One series' identity and label, known before any value resolves."""

    series_id: str
    label: str
    label_key: str
    emphasis: str = ""
    unit: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "series_id": self.series_id,
            "label": self.label,
            "label_key": self.label_key,
            "emphasis": self.emphasis,
            "unit": self.unit,
        }


@dataclass(frozen=True)
class SlotHead(object):
    """One slot (a period column, a delta step) — its id and its
    ENGINE-AUTHORED label."""

    slot_id: str
    label: str
    currency: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {"slot_id": self.slot_id, "label": self.label,
                "currency": self.currency}


@dataclass(frozen=True)
class Skeleton(object):
    """Frame 0. Everything a reader needs to see the SHAPE of the answer,
    and not one figure."""

    artifact_id: str
    kind: str
    title: str
    subtitle: str
    note: str
    x_label: str
    y_label: str
    #: Engine-authored, from the period roster. The model never writes a
    #: period label, because a period label carries digits.
    caption: str
    series: Tuple[SeriesHead, ...]
    slots: Tuple[SlotHead, ...]
    group_by: str
    derive: str
    decimals: int

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": ARTIFACT_VERSION,
            "type": FRAME_SKELETON,
            "artifact_id": self.artifact_id,
            "kind": self.kind,
            "title": self.title,
            "subtitle": self.subtitle,
            "note": self.note,
            "x_label": self.x_label,
            "y_label": self.y_label,
            "caption": self.caption,
            "group_by": self.group_by,
            "derive": self.derive,
            "decimals": self.decimals,
            "series": [s.to_payload() for s in self.series],
            "slots": [s.to_payload() for s in self.slots],
        }


@dataclass(frozen=True)
class ResolvedArtifact(object):
    """The whole artifact: its skeleton, its resolved cells, and every
    absence and refusal it ran into, each at its coordinate."""

    skeleton: Skeleton
    cells: Tuple[ArtifactCell, ...] = ()
    gaps: Tuple[ArtifactGapCard, ...] = ()
    refusals: Tuple[ArtifactRefusal, ...] = ()
    notes: Tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return bool(self.cells)

    def currency(self) -> Optional[str]:
        """The ONE currency of this artifact's money, or None.

        Two currencies in one artifact is impossible by construction —
        every cross-period read refuses on native-units first — and the
        assertion here makes that structural rather than hoped-for. It
        is the same guard ``ToolResult.currency`` carries, at the
        surface a reader actually sees.
        """
        seen = set()
        for c in self.cells:
            if c.kind == "money" and c.currency:
                seen.add(c.currency)
        if not seen:
            return None
        if len(seen) > 1:
            raise AssertionError(
                "artifact %s carries money in %d currencies (%s) — one "
                "artifact must never straddle the conversion boundary"
                % (self.skeleton.artifact_id, len(seen), sorted(seen)))
        return sorted(seen)[0]

    def _fact_pairs(self) -> Tuple[Dict[str, float], Tuple[str, ...]]:
        """``({fact: native_value}, ambiguous)``.

        AN AMBIGUOUS FACT IS DROPPED, NOT COLLAPSED. A multi-slot
        artifact resolves the same fact name once per slot: ``revenue``
        exists at every period on the axis. Keeping the last one seen
        would let ``{{money:revenue}}`` in the caption bind to whichever
        cell happened to resolve last — a figure standing beside a label
        that belongs to a different context, which is the 461 defect in
        a new place.

        So a name whose cells disagree is removed from the map and
        recorded. A placeholder citing it then fails loudly at render
        (``render_prose`` raises) instead of printing a plausible wrong
        number. Cells that AGREE collapse harmlessly — an identical
        value at two slots is one fact.
        """
        out = {}  # type: Dict[str, float]
        ambiguous = []  # type: List[str]
        for c in self.cells:
            if c.kind == "money" and c.amount_minor is not None:
                value = c.amount_minor / 100.0
            elif c.value is not None:
                value = c.value
            else:
                continue
            if c.fact in out and out[c.fact] != value:
                if c.fact not in ambiguous:
                    ambiguous.append(c.fact)
                continue
            out[c.fact] = value
        for name in ambiguous:
            out.pop(name, None)
        return out, tuple(ambiguous)

    def facts(self) -> Dict[str, float]:
        """``{fact: native_value}`` — the map any prose on this artifact
        binds ``{{money:<fact>}}`` placeholders against. Ambiguous names
        are absent by design; see :meth:`ambiguous_facts`."""
        return self._fact_pairs()[0]

    def ambiguous_facts(self) -> Tuple[str, ...]:
        """Fact names this artifact resolved to more than one value.
        Surfaced rather than silent: a caller that wanted to cite one of
        these must name the slot instead."""
        return self._fact_pairs()[1]

    def fact_units(self) -> Dict[str, str]:
        return dict((c.fact, c.unit) for c in self.cells)

    def to_payload(self) -> Dict[str, Any]:
        facts, ambiguous = self._fact_pairs()
        return {
            "version": ARTIFACT_VERSION,
            "artifact_id": self.skeleton.artifact_id,
            "ok": self.ok,
            "skeleton": self.skeleton.to_payload(),
            "cells": [c.to_payload() for c in self.cells],
            "gaps": [g.to_payload() for g in self.gaps],
            "refusals": [r.to_payload() for r in self.refusals],
            "notes": list(self.notes),
            "facts": facts,
            "ambiguous_facts": list(ambiguous),
            "fact_units": self.fact_units(),
            "currency": self.currency(),
        }


# ══════════════════════════════════════════════════════════════════════
# THE FACT INDEX SUMMARY — names and SHAPES, never values
# ══════════════════════════════════════════════════════════════════════


def summarize_fact_index(ctx: "_tools.CapsuleContext") -> Dict[str, Any]:
    """What the model is shown before it composes.

    Names, units, ids, and whether a period has a file. NOT ONE FIGURE:
    a model that has been shown "4,834,908,159" will retype it, and no
    placeholder discipline downstream can undo that. This function
    therefore reads NOTHING from any envelope — it never constructs a
    gateway — so there is no path by which a value could reach it.

    Period LABELS are included, because the model must be able to pick
    a period, and they are ENGINE-AUTHORED strings. They are also why
    the spec's prose guard refuses digits: a label may be shown to the
    model without becoming something the model may retype into a title.
    """
    metrics = []  # type: List[Dict[str, Any]]
    for name in sorted(_tools.METRICS):
        spec = _tools.METRICS[name]
        row = {
            "metric": spec.metric,
            "unit": spec.unit,
            "label_key": spec.label_key,
        }  # type: Dict[str, Any]
        if spec.numerator:
            row["derived_from"] = [spec.numerator, spec.denominator]
        metrics.append(row)

    periods = []  # type: List[Dict[str, Any]]
    for p in ctx.periods:
        periods.append({
            "period_id": p.period_id,
            "label": p.label,
            "currency": p.currency,
            "entity_id": p.entity_id,
            "period_end": p.period_end,
            "has_source_file": bool(p.has_source_file),
            "has_account_detail": bool(p.accounts),
        })

    return {
        "version": _spec.ARTIFACT_SPEC_VERSION,
        "entity_id": ctx.entity_id,
        "metrics": metrics,
        "periods": periods,
        "kinds": list(_spec.ARTIFACT_KINDS),
        "derivations": list(_spec.DERIVATIONS),
        "group_by": list(_spec.GROUP_BY),
        "rule": ("Name ids only. Every figure is resolved by the engine "
                 "from the served statements; a digit anywhere in your "
                 "answer is rejected."),
    }


def build_model_input(question: Any,
                      ctx: "_tools.CapsuleContext") -> Dict[str, Any]:
    """EVERYTHING the model is given, in one auditable object.

    Three things and no fourth: the question, the fact index summary,
    and the artifact tool schema. Assembling it here — rather than
    letting each call site compose its own prompt — is what makes the
    C1 sweep possible: a test can walk THIS object and prove no served
    figure is inside it, and a new call site cannot quietly add a
    fourth ingredient without changing this function.

    ``question`` is the USER's own words and is passed through verbatim.
    A digit in it is the user's, not the engine's, and it is not a
    served figure — but it is also not something the model may echo into
    a label, because the spec parser refuses digits in prose regardless
    of where they came from.
    """
    return {
        "version": _spec.ARTIFACT_SPEC_VERSION,
        "question": "" if question is None else str(question),
        "fact_index": summarize_fact_index(ctx),
        "tool": _spec.spec_tool_schema(),
    }


# ══════════════════════════════════════════════════════════════════════
# SKELETON — derivable from the spec and the roster, nothing else
# ══════════════════════════════════════════════════════════════════════


def _period_map(ctx: "_tools.CapsuleContext") -> Dict[str, "_tools.PeriodRef"]:
    return dict((p.period_id, p) for p in ctx.periods)


def _default_slots(ctx: "_tools.CapsuleContext",
                   spec: "_spec.ArtifactSpec") -> Tuple[str, ...]:
    """Which periods this artifact spans.

    An empty ``periods`` list means "the ones that exist FOR THIS
    WORKSPACE'S ENTITY", in roster order — never an invented range, and
    never a silent sweep across every entity the context happens to
    carry. The roster's order is the caller's; this module does not sort
    by a parsed date, because a label is free text.
    """
    if spec.periods:
        return spec.periods
    entity = ctx.entity_id
    ids = [p.period_id for p in ctx.periods
           if not entity or p.entity_id == entity]
    if not ids:
        ids = [p.period_id for p in ctx.periods]
    return tuple(ids)


def _alignment_refusals(ctx: "_tools.CapsuleContext",
                        spec: "_spec.ArtifactSpec",
                        slot_ids: Tuple[str, ...]) -> List[ArtifactRefusal]:
    """A MULTI-SLOT ARTIFACT IS A COMPARISON, AND THE ALIGNMENT RULES
    APPLY TO IT.

    ``compare_periods`` refuses a cross-entity or cross-currency DELTA.
    Two bars side by side make exactly the same claim without ever
    calling it a delta — the reader subtracts them by eye. So the same
    two rules are checked here, before any figure is read, and a
    misaligned artifact refuses instead of drawing.

    A SINGLE-slot artifact is not a comparison and is never refused by
    this function.
    """
    if len(slot_ids) < 2:
        return []
    known = _period_map(ctx)
    present = [known[pid] for pid in slot_ids if pid in known]
    if len(present) < 2:
        return []

    entities = sorted(set(p.entity_id for p in present))
    if len(entities) > 1:
        return [ArtifactRefusal(
            series_id="", slot_id="",
            code=_tools.LIMIT_SAME_ENTITY,
            detail=("this artifact would put %s side by side; bars the "
                    "reader subtracts by eye are a comparison, and a "
                    "comparison across entities does not describe one "
                    "business" % " and ".join(entities)),
            alternative="Plot one entity, or ask for each on its own.")]

    currencies = sorted(set((p.currency or "").upper() for p in present))
    if len(currencies) > 1:
        return [ArtifactRefusal(
            series_id="", slot_id="",
            code=_tools.LIMIT_NATIVE_UNITS,
            detail=("the periods on this axis are in %s; nothing here "
                    "converts, so their heights are not comparable"
                    % " and ".join(c or "?" for c in currencies)),
            alternative="Ask for each period's figure on its own.")]

    unlabelled = [p.period_id for p in present if not p.label]
    if unlabelled:
        return [ArtifactRefusal(
            series_id="", slot_id="",
            code=_tools.LIMIT_LABELLED_PERIOD,
            detail=("period %s carries no fiscal-period label, so a reader "
                    "could not tell which months this axis spans"
                    % ", ".join(unlabelled)),
            alternative="Set the period label, then plot it.")]
    return []


def _series_label(spec_metric: "_spec.MetricRef") -> Tuple[str, str]:
    """(label, label_key) for one series.

    The model's label wins when it gave one — it already survived the
    prose guard. Otherwise the engine's own i18n key carries it, and the
    surface resolves it. A metric this engine does not serve still gets
    a head, so its gap card has somewhere to land.
    """
    known = _tools.METRICS.get(spec_metric.metric)
    label_key = known.label_key if known is not None else ""
    return (spec_metric.label or "", label_key)


def _caption_for(ctx: "_tools.CapsuleContext",
                 slot_ids: Tuple[str, ...]) -> str:
    """ENGINE-AUTHORED period caption.

    This is the string that legitimately carries digits, and the reason
    the model is never asked to write one. Unknown ids are named as
    given so the caption cannot silently describe a different range than
    the artifact plots.
    """
    known = _period_map(ctx)
    labels = []  # type: List[str]
    for pid in slot_ids:
        period = known.get(pid)
        labels.append(period.label or period.period_id if period else pid)
    if not labels:
        return ""
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return "%s vs %s" % (labels[0], labels[1])
    return "%s — %s" % (labels[0], labels[-1])


def skeleton_for(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                 artifact_id: str = "") -> Skeleton:
    """The frame, the axes and the labels — with no gateway read.

    Everything here comes from the spec (already parsed and guarded) and
    the in-memory period roster. Nothing opens an envelope, so this is
    cheap enough to emit before the first value resolves, which is the
    whole point: the reader sees the shape of the answer immediately and
    watches it fill.
    """
    slot_ids = _default_slots(ctx, spec)
    known = _period_map(ctx)
    slots = []  # type: List[SlotHead]
    for pid in slot_ids:
        period = known.get(pid)
        slots.append(SlotHead(
            slot_id=pid,
            label=(period.label or period.period_id) if period else pid,
            currency=period.currency if period else ""))

    series = []  # type: List[SeriesHead]
    for ref in spec.metrics:
        label, label_key = _series_label(ref)
        known_metric = _tools.METRICS.get(ref.metric)
        series.append(SeriesHead(
            series_id=ref.metric, label=label, label_key=label_key,
            emphasis=ref.emphasis,
            unit=known_metric.unit if known_metric is not None else ""))

    return Skeleton(
        artifact_id=artifact_id or "artifact",
        kind=spec.kind,
        title=spec.title,
        subtitle=spec.subtitle,
        note=spec.note,
        x_label=spec.x_label,
        y_label=spec.y_label,
        caption=_caption_for(ctx, slot_ids),
        series=tuple(series),
        slots=tuple(slots),
        group_by=spec.group_by,
        derive=spec.derive,
        decimals=spec.decimals,
    )


# ══════════════════════════════════════════════════════════════════════
# RESOLUTION
# ══════════════════════════════════════════════════════════════════════


def _gap_card(series_id: str, slot_id: str,
              gap: "_tools.ToolGap") -> ArtifactGapCard:
    return ArtifactGapCard(
        series_id=series_id, slot_id=slot_id, tool=gap.tool, code=gap.code,
        missing=tuple(gap.missing), detail=gap.detail, fix=gap.fix,
        upsell_key=gap.upsell_key)


def _limitation_refusal(series_id: str, slot_id: str,
                        limitation: "_tools.ToolLimitation") -> ArtifactRefusal:
    return ArtifactRefusal(
        series_id=series_id, slot_id=slot_id, code=limitation.rule,
        detail=limitation.detail, alternative=limitation.alternative)


def _cell_from_value(series_id: str, slot_id: str, value: Any
                     ) -> Optional[ArtifactCell]:
    if isinstance(value, _tools.ToolMoney):
        return ArtifactCell(
            series_id=series_id, slot_id=slot_id, kind="money",
            fact=value.fact, unit=value.unit,
            provenance=dict(value.provenance or {}),
            amount_minor=value.amount_minor, currency=value.currency,
            label_key=value.label_key, scope=value.scope)
    if isinstance(value, _tools.ToolRatio):
        return ArtifactCell(
            series_id=series_id, slot_id=slot_id, kind="ratio",
            fact=value.fact, unit=value.unit,
            provenance=dict(value.provenance or {}),
            value=value.value, numerator_minor=value.numerator_minor,
            denominator_minor=value.denominator_minor,
            currency=value.currency, label_key=value.label_key,
            scope=value.scope)
    return None


def _resolve_plain(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                   slot_ids: Tuple[str, ...]
                   ) -> Tuple[List[ArtifactCell], List[ArtifactGapCard],
                              List[ArtifactRefusal]]:
    """One value per (metric, period), straight off the tool layer."""
    cells = []  # type: List[ArtifactCell]
    gaps = []  # type: List[ArtifactGapCard]
    refusals = []  # type: List[ArtifactRefusal]
    for ref in spec.metrics:
        for pid in slot_ids:
            result = _tools.get_facts(ctx, metric=ref.metric, period=pid)
            for value in result.values:
                cell = _cell_from_value(ref.metric, pid, value)
                if cell is not None:
                    cells.append(cell)
            for gap in result.gaps:
                gaps.append(_gap_card(ref.metric, pid, gap))
            for limitation in result.limitations:
                refusals.append(_limitation_refusal(ref.metric, pid,
                                                    limitation))
    return cells, gaps, refusals


def _delta_slot_id(a: str, b: str) -> str:
    return "%s->%s" % (a, b)


def _resolve_delta(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                   slot_ids: Tuple[str, ...], pct: bool
                   ) -> Tuple[List[ArtifactCell], List[ArtifactGapCard],
                              List[ArtifactRefusal]]:
    """Consecutive-period deltas, through ``compare_periods``.

    The alignment rules (same entity, same native currency, both
    periods labelled) are not re-checked here — they are enforced by the
    tool layer BEFORE it computes a delta, and re-implementing them
    would be a second opinion that could disagree with the first.
    """
    cells = []  # type: List[ArtifactCell]
    gaps = []  # type: List[ArtifactGapCard]
    refusals = []  # type: List[ArtifactRefusal]
    metric_ids = list(spec.metric_ids())

    if len(slot_ids) < 2:
        for metric in metric_ids:
            refusals.append(ArtifactRefusal(
                series_id=metric, slot_id=slot_ids[0] if slot_ids else "",
                code=REFUSE_NEEDS_TWO_PERIODS,
                detail=("a change needs two periods; this artifact spans "
                        "%d" % len(slot_ids)),
                alternative="Name a second period."))
        return cells, gaps, refusals

    for i in range(len(slot_ids) - 1):
        a, b = slot_ids[i], slot_ids[i + 1]
        slot_id = _delta_slot_id(a, b)
        result = _tools.compare_periods(ctx, metrics=metric_ids, p1=a, p2=b)
        for gap in result.gaps:
            gaps.append(_gap_card(_series_for_fact(gap.missing, metric_ids),
                                  slot_id, gap))
        for limitation in result.limitations:
            refusals.append(_limitation_refusal(
                metric_ids[0] if len(metric_ids) == 1 else "", slot_id,
                limitation))

        # Route by METRIC NAME, and within a metric by arrival order —
        # `compare_periods` appends (a, b, delta) per metric and marks
        # the delta with a `.delta` metric name. Reading the fact-name
        # suffix instead would couple this to a naming convention the
        # tool layer is free to change.
        by_metric = {}  # type: Dict[str, Dict[str, Any]]
        for value in result.values:
            name = str(getattr(value, "metric", ""))
            is_delta = name.endswith(".delta")
            base_metric = name[:-len(".delta")] if is_delta else name
            bucket = by_metric.setdefault(base_metric, {})
            if is_delta:
                bucket["delta"] = value
            elif "a" not in bucket:
                bucket["a"] = value
            else:
                bucket.setdefault("b", value)

        for metric in metric_ids:
            bucket = by_metric.get(metric) or {}
            delta = bucket.get("delta")
            base = bucket.get("a")
            if delta is None:
                # ONLY when BOTH sides resolved. A metric present on one
                # side and absent on the other already has a gap card
                # naming the absence — adding "this is not money" on top
                # of it would be a refusal that names the wrong reason,
                # and a reader acting on it would go looking for a unit
                # problem that does not exist.
                if "a" in bucket and "b" in bucket:
                    # Both sides resolved but the tool layer computes no
                    # delta for this unit. Saying so is the honest move;
                    # subtracting two dimensionless figures here would be
                    # a second arithmetic authority disagreeing with the
                    # first.
                    refusals.append(ArtifactRefusal(
                        series_id=metric, slot_id=slot_id,
                        code=REFUSE_NO_DELTA_FOR_UNIT,
                        detail=("%s is not money, and this surface does not "
                                "subtract dimensionless figures across "
                                "periods" % metric),
                        alternative=("Plot %s per period instead of its "
                                     "change." % metric)))
                continue
            if not isinstance(delta, _tools.ToolMoney):  # pragma: no cover
                continue
            step_provenance = _delta_provenance(ctx, delta, a, b)
            if not pct:
                cells.append(ArtifactCell(
                    series_id=metric, slot_id=slot_id, kind="money",
                    fact=delta.fact, unit=delta.unit,
                    provenance=step_provenance,
                    amount_minor=delta.amount_minor, currency=delta.currency,
                    label_key=delta.label_key, scope=delta.scope))
                continue
            if not isinstance(base, _tools.ToolMoney):
                continue
            try:
                fraction = _ratio_units.ratio(delta.quantity(),
                                              base.quantity())
            except _ratio_units.UnitMismatchError as exc:
                refusals.append(ArtifactRefusal(
                    series_id=metric, slot_id=slot_id,
                    code=REFUSE_UNIT_MISMATCH, detail=str(exc),
                    alternative="Ask for each period's figure on its own."))
                continue
            except _ratio_units.UndefinedRatioError as exc:
                refusals.append(ArtifactRefusal(
                    series_id=metric, slot_id=slot_id,
                    code=REFUSE_UNDEFINED_RATIO, detail=str(exc),
                    alternative=("Ask for the change in %s instead of the "
                                 "percentage." % metric)))
                continue
            cells.append(ArtifactCell(
                series_id=metric, slot_id=slot_id, kind="ratio",
                fact=metric + "_pct_change",
                unit=_ratio_units.UNIT_PERCENT,
                provenance=step_provenance,
                value=fraction,
                numerator_minor=delta.amount_minor,
                denominator_minor=base.amount_minor,
                currency=delta.currency,
                label_key="capsule.metric.%s.pct_change" % metric,
                scope=delta.scope))
    return cells, gaps, refusals


def _delta_provenance(ctx: "_tools.CapsuleContext", delta: Any,
                      a: str, b: str) -> Dict[str, Any]:
    """A DERIVED figure must be traceable to BOTH sources.

    ``compare_periods`` stamps a delta with the two period ids and the
    basis sentence, but not with the SNAPSHOTS — the delta belongs to no
    single one, so the tool layer leaves the field off rather than
    picking a side. That is right for a tool result and wrong for a
    rendered artifact: a bar on a chart must be traceable to a source
    cell, and "which two books produced this height" is that trace.

    So this layer adds the pair, from the period roster it already holds.
    It ADDS ONLY — the tool layer's own keys ride through untouched, so
    nothing that reads the original provenance sees a different value.
    """
    out = dict(getattr(delta, "provenance", None) or {})
    known = _period_map(ctx)
    for role, pid in (("from", a), ("to", b)):
        period = known.get(pid)
        if period is None:
            continue
        out.setdefault("%s_period_id" % role, period.period_id)
        if period.snapshot_id:
            out["%s_snapshot_id" % role] = period.snapshot_id
    # The pair IS the provenance of a derived figure; ``period_id`` and
    # ``snapshot_id`` name the period the change LANDS IN, so a consumer
    # with one provenance reader still gets a real, checkable answer.
    to_period = known.get(b)
    if to_period is not None:
        out.setdefault("period_id", to_period.period_id)
        if to_period.snapshot_id:
            out.setdefault("snapshot_id", to_period.snapshot_id)
        out.setdefault("period_label", to_period.label)
    out.setdefault("derived", "delta")
    return out


def _series_for_fact(missing: Tuple[str, ...],
                     metric_ids: List[str]) -> str:
    """Which series a comparison-level gap belongs to.

    A gap naming a metric lands on that series; a gap about the PERIOD
    belongs to no single series and lands on "" — the surface renders it
    across the slot. Guessing a series for a period-level gap would put
    an absence on a row that is fine.
    """
    for name in missing:
        if name in metric_ids:
            return name
    return ""


def _resolve_share(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                   slot_ids: Tuple[str, ...]
                   ) -> Tuple[List[ArtifactCell], List[ArtifactGapCard],
                              List[ArtifactRefusal]]:
    """metric / denominator within ONE period, through the ratio law."""
    cells = []  # type: List[ArtifactCell]
    gaps = []  # type: List[ArtifactGapCard]
    refusals = []  # type: List[ArtifactRefusal]
    if not spec.denominator:
        for metric in spec.metric_ids():
            refusals.append(ArtifactRefusal(
                series_id=metric, slot_id="", code=REFUSE_NO_DENOMINATOR,
                detail="a share needs the metric it is a share OF",
                alternative="Name a denominator metric id."))
        return cells, gaps, refusals

    for pid in slot_ids:
        den_result = _tools.get_facts(ctx, metric=spec.denominator,
                                      period=pid)
        den_money = None  # type: Optional[_tools.ToolMoney]
        for value in den_result.values:
            if isinstance(value, _tools.ToolMoney):
                den_money = value
        if den_money is None:
            for gap in den_result.gaps:
                gaps.append(_gap_card(spec.denominator, pid, gap))
            for limitation in den_result.limitations:
                refusals.append(_limitation_refusal(spec.denominator, pid,
                                                    limitation))
            continue
        for ref in spec.metrics:
            result = _tools.get_facts(ctx, metric=ref.metric, period=pid)
            num_money = None  # type: Optional[_tools.ToolMoney]
            for value in result.values:
                if isinstance(value, _tools.ToolMoney):
                    num_money = value
            if num_money is None:
                for gap in result.gaps:
                    gaps.append(_gap_card(ref.metric, pid, gap))
                for limitation in result.limitations:
                    refusals.append(_limitation_refusal(ref.metric, pid,
                                                        limitation))
                continue
            try:
                fraction = _ratio_units.ratio(num_money.quantity(),
                                              den_money.quantity())
            except _ratio_units.UnitMismatchError as exc:
                refusals.append(ArtifactRefusal(
                    series_id=ref.metric, slot_id=pid,
                    code=REFUSE_UNIT_MISMATCH, detail=str(exc),
                    alternative="Ask for each figure on its own."))
                continue
            except _ratio_units.UndefinedRatioError as exc:
                refusals.append(ArtifactRefusal(
                    series_id=ref.metric, slot_id=pid,
                    code=REFUSE_UNDEFINED_RATIO, detail=str(exc),
                    alternative=("%s is zero or absent in this period, so "
                                 "the share is undefined — which is not "
                                 "zero." % spec.denominator)))
                continue
            cells.append(ArtifactCell(
                series_id=ref.metric, slot_id=pid, kind="ratio",
                fact="%s_share_of_%s" % (ref.metric, spec.denominator),
                unit=_ratio_units.UNIT_PERCENT,
                provenance=dict(num_money.provenance or {}),
                value=fraction,
                numerator_minor=num_money.amount_minor,
                denominator_minor=den_money.amount_minor,
                currency=num_money.currency,
                label_key="capsule.metric.%s.share" % ref.metric,
                scope=""))
    return cells, gaps, refusals


def resolve_artifact(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                     artifact_id: str = "") -> ResolvedArtifact:
    """Resolve every id in ``spec`` and return the artifact.

    Pure over ``(ctx, spec)`` — no clock, no randomness, no network — so
    the same context and spec always produce the same bytes. The
    determinism test depends on that and so does every cache above this.
    """
    skeleton = skeleton_for(ctx, spec, artifact_id)
    slot_ids = _default_slots(ctx, spec)

    misaligned = _alignment_refusals(ctx, spec, slot_ids)
    if misaligned:
        # Refuse BEFORE reading a figure. Resolving the cells and then
        # declining to draw them would put the numbers on the wire, and
        # a number on the wire is a number that renders somewhere.
        return ResolvedArtifact(
            skeleton=skeleton, cells=(), gaps=(),
            refusals=tuple(misaligned),
            notes=("This artifact was refused rather than drawn.",))

    if spec.derive == _spec.DERIVE_DELTA:
        cells, gaps, refusals = _resolve_delta(ctx, spec, slot_ids, False)
    elif spec.derive == _spec.DERIVE_PCT_CHANGE:
        cells, gaps, refusals = _resolve_delta(ctx, spec, slot_ids, True)
    elif spec.derive == _spec.DERIVE_SHARE:
        cells, gaps, refusals = _resolve_share(ctx, spec, slot_ids)
    else:
        cells, gaps, refusals = _resolve_plain(ctx, spec, slot_ids)

    if spec.derive in (_spec.DERIVE_DELTA, _spec.DERIVE_PCT_CHANGE):
        # The slot heads for a derived artifact are the STEPS, not the
        # periods: a delta belongs between two columns, and labelling it
        # with one of them would attribute the change to a single month.
        known = _period_map(ctx)

        def _label(pid):
            period = known.get(pid)
            return (period.label or period.period_id) if period else pid

        steps = []  # type: List[SlotHead]
        for i in range(len(slot_ids) - 1):
            a, b = slot_ids[i], slot_ids[i + 1]
            period_b = known.get(b)
            steps.append(SlotHead(
                slot_id=_delta_slot_id(a, b),
                label="%s → %s" % (_label(a), _label(b)),
                currency=period_b.currency if period_b else ""))
        skeleton = Skeleton(
            artifact_id=skeleton.artifact_id, kind=skeleton.kind,
            title=skeleton.title, subtitle=skeleton.subtitle,
            note=skeleton.note, x_label=skeleton.x_label,
            y_label=skeleton.y_label, caption=skeleton.caption,
            series=skeleton.series, slots=tuple(steps),
            group_by=skeleton.group_by, derive=skeleton.derive,
            decimals=skeleton.decimals)

    notes = []  # type: List[str]
    if gaps:
        notes.append("Some cells could not be resolved; each one says what "
                     "is missing.")
    if refusals:
        notes.append("Some comparisons were refused rather than performed.")

    return ResolvedArtifact(skeleton=skeleton, cells=tuple(cells),
                            gaps=tuple(gaps), refusals=tuple(refusals),
                            notes=tuple(notes))


# ══════════════════════════════════════════════════════════════════════
# STREAMING — the skeleton FIRST, always
# ══════════════════════════════════════════════════════════════════════


def stream_frames(ctx: "_tools.CapsuleContext", spec: "_spec.ArtifactSpec",
                  artifact_id: str = "") -> Iterator[Dict[str, Any]]:
    """Frames in the order a reader should receive them.

    Frame 0 is ALWAYS the skeleton, and it is built without a single
    gateway read, so it can be on screen before any value exists. Then
    one frame per cell, gap and refusal, then a ``complete`` frame
    carrying the facts map for any prose that binds against it.

    The generator resolves everything up front rather than lazily: the
    currency-unity assertion is a property of the WHOLE artifact, and a
    stream that emitted three cells before discovering a fourth in
    another currency would have already shown the reader a lie.
    """
    resolved = resolve_artifact(ctx, spec, artifact_id)
    # Reads the assertion before the first frame leaves the building.
    currency = resolved.currency()

    yield resolved.skeleton.to_payload()
    for cell in resolved.cells:
        frame = cell.to_payload()
        frame["type"] = FRAME_CELL
        frame["artifact_id"] = resolved.skeleton.artifact_id
        yield frame
    for gap in resolved.gaps:
        frame = gap.to_payload()
        frame["type"] = FRAME_GAP
        frame["artifact_id"] = resolved.skeleton.artifact_id
        yield frame
    for refusal in resolved.refusals:
        frame = refusal.to_payload()
        frame["type"] = FRAME_REFUSAL
        frame["artifact_id"] = resolved.skeleton.artifact_id
        yield frame
    yield {
        "type": FRAME_COMPLETE,
        "version": ARTIFACT_VERSION,
        "artifact_id": resolved.skeleton.artifact_id,
        "cells": len(resolved.cells),
        "gaps": len(resolved.gaps),
        "refusals": len(resolved.refusals),
        "currency": currency,
        "facts": resolved.facts(),
        "fact_units": resolved.fact_units(),
        "notes": list(resolved.notes),
    }


# ══════════════════════════════════════════════════════════════════════
# THE DETERMINISTIC FALLBACK
# ══════════════════════════════════════════════════════════════════════


def deterministic_spec(ctx: "_tools.CapsuleContext",
                       metrics: Optional[Tuple[str, ...]] = None,
                       kind: str = _spec.KIND_TABLE) -> "_spec.ArtifactSpec":
    """The artifact served when the model cannot be asked, or answered
    badly twice.

    It is a real artifact, not an apology: served metrics over the
    periods that exist, with engine labels. Every figure in it is
    resolved the same way as in a composed one — the fallback path and
    the model path share the resolver, so there is no second rendering
    to drift.
    """
    wanted = metrics or ("total_assets", "revenue", "net_result")
    refs = tuple(_spec.MetricRef(metric=m) for m in wanted
                 if m in _tools.METRICS)
    empty = _spec.ArtifactSpec(kind=kind, metrics=refs)
    return _spec.ArtifactSpec(
        kind=kind,
        metrics=refs,
        # THE SAME period-scoping rule the composed path uses. A first
        # draft listed every period in the context, which swept across
        # entities and made the FALLBACK — the artifact served when the
        # model cannot be asked — refuse itself on alignment.
        periods=_default_slots(ctx, empty),
        group_by=_spec.GROUP_BY_PERIOD,
        title="",
        subtitle="",
    )


def render_prose(text: str, resolved: ResolvedArtifact,
                 currency: str = "") -> str:
    """Resolve ``{{money:<fact>}}`` placeholders in artifact prose
    against the facts this artifact actually resolved.

    Refuses (raises) rather than rendering a hole: a placeholder naming
    a fact the artifact does not carry is a claim about a figure that
    was never computed, and a blank where a number should be reads as a
    rendering bug rather than as the refusal it is.
    """
    facts = resolved.facts()
    cur = (currency or resolved.currency() or "RON").upper()
    out = _ratio_units.render_native(text or "", facts, cur)
    _spec.assert_prose_attributable(out, facts, cur, "prose")
    return out
