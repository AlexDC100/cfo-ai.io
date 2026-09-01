"""THE ARTIFACT RESOLVER under test — on REAL ENGINE OUTPUT (TC-1).

Every fixture this suite reads was produced by running the REAL
deterministic chain over REAL trial balances committed to this repo
(``files/scandia_frozen_tb_2025.xlsx``, 382 rows;
``files/carniprod_tb_2025.xlsx``, 367 rows) and capturing what
``_artifact_resolve`` actually returned. Nothing here hand-writes an
envelope, a cell, a total or a gap. The capture script is
``tests/engine/fixtures/artifacts/capture.py`` and the first test in
this file re-runs the chain and compares, so a stale fixture goes RED
rather than freezing a stale belief.

TWO DEFECTS THIS FIXTURE FOUND, BOTH BEFORE ANY TEST WAS WRITTEN

  1. ``ResolvedArtifact.facts()`` collapsed a fact name that resolves
     once per slot, so ``{{money:revenue}}`` in a caption would bind to
     whichever cell resolved last. Fixed by DROPPING ambiguous names
     rather than picking one; ``test_an_ambiguous_fact_is_dropped``
     pins it.
  2. A multi-slot artifact was drawing bars from two different entities
     side by side. ``compare_periods`` refuses a cross-entity DELTA, but
     two bars make the same claim without ever calling it one — the
     reader subtracts them by eye. Fixed by applying the alignment rules
     to the ARTIFACT; ``test_a_cross_entity_artifact_refuses_before_any
     _figure_is_read`` pins it, and the inverse test proves the guard is
     load-bearing.

WHAT THE FIXTURE DELIBERATELY DOES NOT PROVE. This repo carries no two
consecutive periods of one company, so there is no real month-over-month
movement to capture. Rather than dress two companies' books up as one
company's two months — the exact dishonest fixture TC-1 exists to
prevent — the multi-period cases use the IDENTITY property: the same
real book filed twice must produce a delta of EXACTLY zero minor units.
That catches every rounding, float detour and re-derivation in the delta
path, and it claims nothing it has not measured.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from engine.api import _artifact_resolve as AR
from engine.api import _artifact_spec as AS
from engine.api import _capsule_tools as CT
from engine.api import _ratio_units

REPO = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO / "tests" / "engine" / "fixtures" / "artifacts"
FIXTURE = FIXTURE_DIR / "resolved_artifacts_REAL_engine.json"


def _load_capture():
    """The capture script, loaded as a module so the tests rebuild the
    context through the SAME code that produced the fixture. Two copies
    of "how a period is built" is how a fixture and its subject drift."""
    name = "artifact_fixture_capture"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name,
                                                  str(FIXTURE_DIR / "capture.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def captured() -> Dict[str, Any]:
    assert FIXTURE.is_file(), (
        "regenerate with tests/engine/fixtures/artifacts/capture.py")
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def ctx():
    """The REAL context: real xlsx -> real pack -> real envelopes."""
    return _load_capture().build_context()[0]


def _spec_for(captured: Dict[str, Any], case: str) -> "AS.ArtifactSpec":
    parsed = AS.parse_artifact_spec(captured["cases"][case]["payload"])
    assert parsed.ok, [r.to_payload() for r in parsed.refusals]
    return parsed.spec


def _numeric_leaves(node: Any, path: str = "$",
                    out: List[Tuple[str, Any]] = None) -> List[Tuple[str, Any]]:
    """Every int/float in a payload, with its path. Bools excluded — a
    flag is not a figure."""
    if out is None:
        out = []
    if isinstance(node, dict):
        for k in sorted(node):
            _numeric_leaves(node[k], "%s.%s" % (path, k), out)
    elif isinstance(node, (list, tuple)):
        for i, item in enumerate(node):
            _numeric_leaves(item, "%s[%d]" % (path, i), out)
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        out.append((path, node))
    return out


# ══════════════════════════════════════════════════════════════════════
# TC-1 — the fixture IS real engine output, and it is current
# ══════════════════════════════════════════════════════════════════════


def test_the_fixture_is_real_engine_output_and_is_not_stale(captured, ctx):
    """Re-runs the REAL chain and compares against the committed bytes.

    This is the test that makes every other test in this file mean
    something: without it, the fixture is a hand-built object that has
    merely been generated once.
    """
    meta = captured["_meta"]
    # CANARY — names the source files, so a capture that quietly stopped
    # reading one of them cannot report clean.
    sources = dict((s["period_id"], s) for s in meta["sources"])
    assert "p-scandia-fy2025" in sources and "p-carniprod-fy2025" in sources
    assert sources["p-scandia-fy2025"]["file"].endswith(
        "scandia_frozen_tb_2025.xlsx")
    # FLOOR — a parser that stopped parsing would report far fewer rows.
    assert sources["p-scandia-fy2025"]["tb_rows"] >= 300, sources
    assert sources["p-carniprod-fy2025"]["tb_rows"] >= 300, sources

    stale = []  # type: List[str]
    for case in sorted(captured["cases"]):
        spec = _spec_for(captured, case)
        fresh = AR.resolve_artifact(ctx, spec, artifact_id=case).to_payload()
        if json.dumps(fresh, sort_keys=True) != json.dumps(
                captured["cases"][case]["resolved"], sort_keys=True):
            stale.append(case)
    assert not stale, (
        "the committed fixture no longer matches real engine output for "
        "%s — re-run tests/engine/fixtures/artifacts/capture.py and read "
        "the diff before committing it" % ", ".join(stale))


def test_the_capture_covers_every_behaviour_this_suite_relies_on(captured):
    """TC-3/TC-6 — a per-CASE roster, not a count. A capture that lost
    five of nine cases would still have "cases", and a floor on the
    total would still clear."""
    cases = set(captured["cases"])
    required = {
        "kpi_all_metrics", "ratios_one_period", "cross_entity_refused",
        "absent_period_gap", "unknown_metric_gap",
        "self_delta_is_exactly_zero", "self_pct_change_is_exactly_zero",
        "ratio_delta_is_refused", "share_of_assets",
        "delta_with_an_absent_period",
    }
    assert required <= cases, sorted(required - cases)


# ══════════════════════════════════════════════════════════════════════
# THE LAW — every numeral is a resolved fact with provenance
# ══════════════════════════════════════════════════════════════════════

#: Payload keys that legitimately carry a presentation integer rather
#: than a figure. Everything else numeric must be inside a cell.
_PRESENTATION_KEYS = ("decimals", "cells", "gaps", "refusals")


def test_every_numeral_in_every_artifact_is_a_resolved_fact(captured):
    """The sweep, PER CASE with its own floor (TC-6).

    A single global count of "numerals checked" would stay high while
    one case collapsed to zero cells, so each case asserts the number it
    is supposed to produce.
    """
    checked_per_case = {}  # type: Dict[str, int]
    for case in sorted(captured["cases"]):
        payload = captured["cases"][case]["resolved"]
        checked = 0
        for cell in payload["cells"]:
            assert cell["fact"], (case, cell)
            prov = cell["provenance"]
            assert prov.get("period_id"), (case, cell)
            assert prov.get("snapshot_id"), (case, cell)
            assert prov.get("source"), (case, cell)
            for key in ("amount_minor", "value", "numerator_minor",
                        "denominator_minor"):
                if isinstance(cell.get(key), (int, float)):
                    checked += 1
        checked_per_case[case] = checked

        # Nothing numeric may live outside a cell except the declared
        # presentation counters and the facts map (which is derived FROM
        # the cells).
        outside = []  # type: List[Tuple[str, Any]]
        for path, value in _numeric_leaves(payload):
            if path.startswith("$.cells"):
                continue
            if path.startswith("$.facts."):
                continue
            if path.endswith(".decimals"):
                continue
            outside.append((path, value))
        assert not outside, (case, outside)

    # PER-CASE FLOORS, measured from the real capture.
    assert checked_per_case["kpi_all_metrics"] >= 24, checked_per_case
    assert checked_per_case["ratios_one_period"] >= 9, checked_per_case
    assert checked_per_case["self_delta_is_exactly_zero"] >= 4, checked_per_case
    assert checked_per_case["share_of_assets"] >= 6, checked_per_case
    assert checked_per_case["cross_entity_refused"] == 0, checked_per_case


def test_every_fact_in_the_facts_map_came_from_a_cell(captured):
    for case in sorted(captured["cases"]):
        payload = captured["cases"][case]["resolved"]
        cell_facts = set(c["fact"] for c in payload["cells"])
        assert set(payload["facts"]) <= cell_facts, case
        assert set(payload["fact_units"]) <= cell_facts, case


# ══════════════════════════════════════════════════════════════════════
# SKELETON FIRST — the visual form of fact-before-prose
# ══════════════════════════════════════════════════════════════════════


def test_the_skeleton_is_always_the_first_frame(captured, ctx):
    for case in sorted(captured["cases"]):
        spec = _spec_for(captured, case)
        frames = list(AR.stream_frames(ctx, spec, artifact_id=case))
        assert frames, case
        assert frames[0]["type"] == AR.FRAME_SKELETON, (case, frames[0])
        assert frames[-1]["type"] == AR.FRAME_COMPLETE, (case, frames[-1])
        # The recorded frame roster, per case — a stream that stopped
        # emitting cells would still start with a skeleton.
        assert [f.get("type") for f in frames] == \
            captured["cases"][case]["frame_types"], case


def test_the_skeleton_carries_axes_and_labels_and_not_one_figure(captured, ctx):
    """Frame 0 must be renderable and empty of values.

    Swept per case with a floor on what it DOES carry, so a skeleton
    that had quietly stopped emitting series would not pass this by
    being trivially figure-free (TC-9).
    """
    for case in sorted(captured["cases"]):
        spec = _spec_for(captured, case)
        skeleton = AR.skeleton_for(ctx, spec, artifact_id=case).to_payload()

        assert skeleton["series"], case            # floor: it has content
        assert skeleton["kind"] in AS.ARTIFACT_KINDS, case
        for head in skeleton["series"]:
            assert head["series_id"], case

        assert "value" not in json.dumps(skeleton), case
        assert "amount_minor" not in json.dumps(skeleton), case
        numeric = [(p, v) for p, v in _numeric_leaves(skeleton)
                   if not p.endswith(".decimals")]
        assert not numeric, (case, numeric)


def _seal_the_gateway(monkeypatch) -> List[str]:
    """Make EVERY route to a served figure raise.

    A first draft of the two tests below handed the periods a non-dict
    "exploding envelope" and passed — vacuously. ``_gateway_for``
    type-checks the envelope and returns None for anything that is not a
    dict, so a path that DID try to read would have got a quiet None
    rather than the assertion the test was relying on. That is TC-9
    exactly: a clean result indistinguishable from no subject.

    Sealing the SEAM instead cannot be silent. Returns the list the
    seams append to, so a caller can also assert the seal was reachable.
    """
    touched = []  # type: List[str]

    def _boom(*args, **kwargs):
        touched.append("read")
        raise AssertionError("a served figure was read on a path that "
                             "claims not to read one")

    monkeypatch.setattr(CT, "_gateway_for", _boom)
    monkeypatch.setattr(CT, "get_facts", _boom)
    monkeypatch.setattr(CT, "compare_periods", _boom)
    return touched


def test_the_skeleton_needs_no_gateway_read_at_all(ctx, monkeypatch):
    """WHY THE SKELETON CAN ARRIVE FIRST, proven structurally.

    Every route to a served figure is sealed. If the skeleton path
    touched one, this fails — so "frame 0 is cheap" is a property of the
    code rather than a claim about it.
    """
    touched = _seal_the_gateway(monkeypatch)
    spec = AS.ArtifactSpec(
        kind=AS.KIND_LINE,
        metrics=(AS.MetricRef(metric="revenue"),),
        periods=("p-scandia-fy2025",),
        title="Revenue")
    skeleton = AR.skeleton_for(ctx, spec, artifact_id="blind")

    assert touched == [], touched
    assert skeleton.slots[0].label == "December 2025"
    assert skeleton.series[0].label_key == "capsule.metric.revenue"


def test_the_seal_itself_is_load_bearing(ctx, monkeypatch):
    """The inverse of the two seal tests: RESOLUTION must trip the seal.

    Without this, "the skeleton did not read" would be evidence about
    the seal rather than about the skeleton — a seal that catches
    nothing would let both tests above pass on any code at all.
    """
    _seal_the_gateway(monkeypatch)
    spec = AS.ArtifactSpec(kind=AS.KIND_LINE,
                           metrics=(AS.MetricRef(metric="revenue"),),
                           periods=("p-scandia-fy2025",))
    with pytest.raises(AssertionError) as exc:
        AR.resolve_artifact(ctx, spec)
    assert "a served figure was read" in str(exc.value)


def test_the_period_caption_is_engine_authored(captured, ctx):
    """The one label that legitimately carries digits is written by the
    ENGINE, from the period roster — which is why the model is refused a
    digit in its own prose and does not need one."""
    spec = _spec_for(captured, "absent_period_gap")
    skeleton = AR.skeleton_for(ctx, spec)
    assert skeleton.caption == "December 2025 vs November 2025"
    assert skeleton.title == ""  # the model wrote none for this case


# ══════════════════════════════════════════════════════════════════════
# C5 — a gap card, never an estimate
# ══════════════════════════════════════════════════════════════════════


def test_an_absent_period_is_a_gap_card_and_never_a_zero(captured):
    payload = captured["cases"]["absent_period_gap"]["resolved"]
    assert len(payload["gaps"]) == 1
    gap = payload["gaps"][0]
    assert gap["code"] == "no_source_file"
    assert gap["missing"] == ["November 2025"]
    assert "Upload the trial balance" in gap["fix"]
    # No cell at the absent slot, and no zero standing in for one.
    slots = set(c["slot_id"] for c in payload["cells"])
    assert "p-scandia-nofile" not in slots
    # The gap itself carries no figure — a refusal with a number in it is
    # a partial answer, and a partial answer here is a wrong one.
    assert not _numeric_leaves(gap)


def test_an_unknown_metric_lists_the_ones_that_exist(captured):
    payload = captured["cases"]["unknown_metric_gap"]["resolved"]
    gap = payload["gaps"][0]
    assert gap["code"] == "unknown_metric"
    assert gap["missing"] == ["ebitda_margin"]
    assert "total_assets" in gap["fix"] and "revenue" in gap["fix"]
    assert not _numeric_leaves(gap)
    # The metrics that DO resolve are unaffected — one absent series does
    # not poison the artifact.
    assert [c["series_id"] for c in payload["cells"]] == ["revenue"]


def test_a_gap_never_carries_a_number_in_any_case(captured):
    swept = 0
    for case in sorted(captured["cases"]):
        for gap in captured["cases"][case]["resolved"]["gaps"]:
            swept += 1
            assert not _numeric_leaves(gap), (case, gap)
        for refusal in captured["cases"][case]["resolved"]["refusals"]:
            swept += 1
            assert not _numeric_leaves(refusal), (case, refusal)
    # TC-3: a sweep that found no subject is not a passing sweep.
    assert swept >= 4, "the capture carries no gaps or refusals to sweep"


# ══════════════════════════════════════════════════════════════════════
# ALIGNMENT — a multi-slot artifact is a comparison
# ══════════════════════════════════════════════════════════════════════


def test_a_cross_entity_artifact_refuses_before_any_figure_is_read(captured):
    payload = captured["cases"]["cross_entity_refused"]["resolved"]
    assert payload["cells"] == []
    assert len(payload["refusals"]) == 1
    refusal = payload["refusals"][0]
    assert refusal["code"] == CT.LIMIT_SAME_ENTITY
    assert "org-scandia" in refusal["detail"]
    assert "org-carniprod" in refusal["detail"]
    assert not _numeric_leaves(refusal)


def test_the_alignment_guard_is_load_bearing(ctx, captured, monkeypatch):
    """THE INVERSE TEST. With the guard disabled, the two books' figures
    DO appear side by side — which is the defect, and the proof this
    gate is wired to something rather than describing behaviour that
    would happen anyway."""
    spec = AS.ArtifactSpec(
        kind=AS.KIND_BAR,
        metrics=(AS.MetricRef(metric="revenue"),),
        periods=("p-scandia-fy2025", "p-carniprod-fy2025"))

    guarded = AR.resolve_artifact(ctx, spec, artifact_id="guarded")
    assert guarded.cells == ()

    monkeypatch.setattr(AR, "_alignment_refusals", lambda *a, **k: [])
    unguarded = AR.resolve_artifact(ctx, spec, artifact_id="unguarded")
    entities = set(c.provenance.get("entity_id") for c in unguarded.cells)
    assert len(unguarded.cells) == 2, unguarded.cells
    assert entities == {"org-scandia", "org-carniprod"}, entities


def test_a_single_slot_artifact_is_never_refused_for_alignment(ctx):
    """A one-period artifact is not a comparison, so the rule must not
    fire on it. A guard that refuses everything is as useless as one
    that refuses nothing."""
    for pid in ("p-scandia-fy2025", "p-carniprod-fy2025"):
        spec = AS.ArtifactSpec(kind=AS.KIND_KPI_GRID,
                               metrics=(AS.MetricRef(metric="revenue"),),
                               periods=(pid,))
        resolved = AR.resolve_artifact(ctx, spec)
        assert len(resolved.cells) == 1, pid
        assert resolved.refusals == (), pid


def test_a_cross_currency_axis_is_refused_without_converting(ctx):
    twin = None
    for p in ctx.periods:
        if p.period_id == "p-scandia-fy2025":
            twin = CT.PeriodRef(
                period_id="p-scandia-eur", label="December 2025 (EUR book)",
                entity_id=p.entity_id, currency="EUR",
                period_end=p.period_end, envelope=p.envelope,
                statements=p.statements, accounts=p.accounts,
                snapshot_id=p.snapshot_id)
    assert twin is not None
    mixed = CT.CapsuleContext(entity_id=ctx.entity_id,
                              periods=tuple(ctx.periods) + (twin,))
    spec = AS.ArtifactSpec(kind=AS.KIND_BAR,
                           metrics=(AS.MetricRef(metric="revenue"),),
                           periods=("p-scandia-fy2025", "p-scandia-eur"))
    resolved = AR.resolve_artifact(mixed, spec)
    assert resolved.cells == ()
    assert resolved.refusals[0].code == CT.LIMIT_NATIVE_UNITS
    assert "RON" in resolved.refusals[0].detail
    assert "EUR" in resolved.refusals[0].detail


def test_an_unlabelled_period_cannot_join_an_axis(ctx):
    blank = CT.PeriodRef(period_id="p-blank", label="",
                         entity_id="org-scandia", currency="RON")
    mixed = CT.CapsuleContext(entity_id=ctx.entity_id,
                              periods=tuple(ctx.periods) + (blank,))
    spec = AS.ArtifactSpec(kind=AS.KIND_LINE,
                           metrics=(AS.MetricRef(metric="revenue"),),
                           periods=("p-scandia-fy2025", "p-blank"))
    resolved = AR.resolve_artifact(mixed, spec)
    assert resolved.cells == ()
    assert resolved.refusals[0].code == CT.LIMIT_LABELLED_PERIOD


def test_an_unnamed_period_list_does_not_sweep_across_entities(ctx):
    """The default must not be a cross-entity sweep. A spec that names no
    period gets THIS workspace's entity, not every book in the
    context."""
    spec = AS.ArtifactSpec(kind=AS.KIND_TABLE,
                           metrics=(AS.MetricRef(metric="revenue"),))
    slots = AR._default_slots(ctx, spec)
    assert "p-carniprod-fy2025" not in slots, slots
    assert "p-scandia-fy2025" in slots, slots


# ══════════════════════════════════════════════════════════════════════
# NATIVE-UNIT DERIVATION — the 461 and 1553% laws
# ══════════════════════════════════════════════════════════════════════


def test_a_book_compared_with_itself_deltas_to_exactly_zero(captured):
    """The identity property, in INTEGER minor units.

    Not "close to zero", not "rounds to zero": exactly 0. A float detour
    anywhere in the delta path shows up here as 1e-8 and fails.
    """
    payload = captured["cases"]["self_delta_is_exactly_zero"]["resolved"]
    assert len(payload["cells"]) == 4
    for cell in payload["cells"]:
        assert cell["kind"] == "money"
        assert cell["amount_minor"] == 0, cell
        assert isinstance(cell["amount_minor"], int), cell
        assert cell["currency"] == "RON", cell


def test_a_self_pct_change_is_exactly_zero_and_dimensionless(captured):
    payload = captured["cases"]["self_pct_change_is_exactly_zero"]["resolved"]
    cell = payload["cells"][0]
    assert cell["kind"] == "ratio"
    assert cell["value"] == 0.0
    assert cell["unit"] == _ratio_units.UNIT_PERCENT
    # The operand pair rides along so a reader can re-derive it.
    assert cell["numerator_minor"] == 0
    assert cell["denominator_minor"] > 0
    # A dimensionless figure must never be handed to a money formatter.
    assert "amount_minor" not in cell


def test_a_zero_denominator_refuses_rather_than_reporting_zero(ctx):
    """ABSENT != ZERO, and UNDEFINED != ZERO.

    ``difference`` is exactly 0 on a balanced real book, which makes it
    the honest way to reach the undefined-ratio branch without inventing
    data: a share OF zero has no answer, and the resolver says so
    instead of drawing a 0% bar.
    """
    spec = AS.ArtifactSpec(
        kind=AS.KIND_BAR,
        metrics=(AS.MetricRef(metric="revenue"),),
        periods=("p-scandia-fy2025",),
        derive=AS.DERIVE_SHARE, denominator="difference")
    resolved = AR.resolve_artifact(ctx, spec)
    assert resolved.cells == ()
    assert resolved.refusals[0].code == AR.REFUSE_UNDEFINED_RATIO
    assert "undefined" in resolved.refusals[0].detail.lower()
    assert not _numeric_leaves(resolved.refusals[0].to_payload())


def test_a_delta_against_an_absent_period_is_a_gap_not_a_unit_refusal(captured):
    """A refusal must name the RIGHT reason.

    An early draft emitted "this metric is not money" whenever a delta
    failed to appear, including when one side simply had no file. A
    reader acting on that would go looking for a unit problem that does
    not exist, while the real fix — upload the trial balance — went
    unsaid. The gap says the true thing; no unit refusal rides along.
    """
    payload = captured["cases"]["delta_with_an_absent_period"]["resolved"]
    assert payload["cells"] == []
    codes = [g["code"] for g in payload["gaps"]]
    assert codes == ["no_source_file"], payload["gaps"]
    assert "Upload the trial balance" in payload["gaps"][0]["fix"]
    assert [r["code"] for r in payload["refusals"]] == [], payload["refusals"]


def test_a_ratio_delta_is_refused_rather_than_subtracted(captured):
    """Two dimensionless figures across periods are not subtracted here.

    The tool layer computes no delta for them, and inventing one at this
    layer would be a second arithmetic authority that can disagree with
    the first. The refusal says which metric and offers the alternative.
    """
    payload = captured["cases"]["ratio_delta_is_refused"]["resolved"]
    assert payload["cells"] == []
    refusal = payload["refusals"][0]
    assert refusal["code"] == AR.REFUSE_NO_DELTA_FOR_UNIT
    assert "current_ratio" in refusal["detail"]


def test_a_share_is_invariant_under_the_display_currency_dial(ctx):
    """C6 — the ratio is computed on NATIVE operands, so relabelling the
    book's currency changes the money label and NOTHING about the
    quotient. Byte-identical, not approximately equal."""
    ron_spec = AS.ArtifactSpec(
        kind=AS.KIND_BAR,
        metrics=(AS.MetricRef(metric="current_assets"),),
        periods=("p-scandia-fy2025",),
        derive=AS.DERIVE_SHARE, denominator="total_assets")
    ron = AR.resolve_artifact(ctx, ron_spec)

    twin_periods = []  # type: List[CT.PeriodRef]
    for p in ctx.periods:
        twin_periods.append(CT.PeriodRef(
            period_id=p.period_id, label=p.label, entity_id=p.entity_id,
            currency="EUR", period_end=p.period_end, envelope=p.envelope,
            statements=p.statements, accounts=p.accounts,
            snapshot_id=p.snapshot_id))
    eur = AR.resolve_artifact(
        CT.CapsuleContext(entity_id=ctx.entity_id,
                          periods=tuple(twin_periods)), ron_spec)

    assert ron.cells[0].value == eur.cells[0].value
    assert ron.cells[0].numerator_minor == eur.cells[0].numerator_minor
    assert ron.cells[0].currency == "RON"
    assert eur.cells[0].currency == "EUR"


def test_one_artifact_never_straddles_two_currencies(ctx):
    """Structural, like ``ToolResult.currency``: two currencies in one
    artifact raise rather than render."""
    mixed_cells = (
        AR.ArtifactCell(series_id="revenue", slot_id="a", kind="money",
                        fact="revenue", unit="money",
                        provenance={"period_id": "a"},
                        amount_minor=1, currency="RON"),
        AR.ArtifactCell(series_id="revenue", slot_id="b", kind="money",
                        fact="revenue_b", unit="money",
                        provenance={"period_id": "b"},
                        amount_minor=2, currency="EUR"),
    )
    spec = AS.ArtifactSpec(kind=AS.KIND_BAR,
                           metrics=(AS.MetricRef(metric="revenue"),))
    artifact = AR.ResolvedArtifact(
        skeleton=AR.skeleton_for(ctx, spec, "mixed"), cells=mixed_cells)
    with pytest.raises(AssertionError) as exc:
        artifact.currency()
    assert "straddle" in str(exc.value)


# ══════════════════════════════════════════════════════════════════════
# The ambiguity defect the real fixture surfaced
# ══════════════════════════════════════════════════════════════════════


def _real_cell(captured, case: str, fact: str) -> "AR.ArtifactCell":
    """A cell lifted from the REAL capture — so the arrangement under
    test is a hypothesis, but the numbers in it are not."""
    for cell in captured["cases"][case]["resolved"]["cells"]:
        if cell["fact"] == fact:
            return AR.ArtifactCell(
                series_id=cell["series_id"], slot_id=cell["slot_id"],
                kind=cell["kind"], fact=cell["fact"], unit=cell["unit"],
                provenance=cell["provenance"],
                amount_minor=cell.get("amount_minor"),
                currency=cell.get("currency", ""))
    raise AssertionError("no %s cell in %s" % (fact, case))


def test_an_ambiguous_fact_is_dropped_not_collapsed(captured, ctx):
    """THE DEFECT THE REAL FIXTURE FOUND.

    ``revenue`` resolves once per slot on a multi-period artifact. The
    first implementation kept the last one seen, so a caption citing
    ``{{money:revenue}}`` would print whichever cell happened to resolve
    last, beside a label describing a different period — the 461 defect
    in a new place. Now the name is DROPPED and recorded.
    """
    a = _real_cell(captured, "kpi_all_metrics", "revenue")
    b = AR.ArtifactCell(
        series_id="revenue", slot_id="p-other", kind="money", fact="revenue",
        unit="money", provenance={"period_id": "p-other",
                                  "snapshot_id": "s", "source": "x"},
        amount_minor=a.amount_minor + 100, currency="RON")
    spec = AS.ArtifactSpec(kind=AS.KIND_LINE,
                           metrics=(AS.MetricRef(metric="revenue"),))
    artifact = AR.ResolvedArtifact(
        skeleton=AR.skeleton_for(ctx, spec, "amb"), cells=(a, b))

    assert "revenue" not in artifact.facts()
    assert artifact.ambiguous_facts() == ("revenue",)
    # And the payload SAYS so, rather than being quietly short a fact.
    assert artifact.to_payload()["ambiguous_facts"] == ["revenue"]


def test_identical_values_at_two_slots_collapse_harmlessly(captured, ctx):
    a = _real_cell(captured, "kpi_all_metrics", "revenue")
    b = AR.ArtifactCell(
        series_id=a.series_id, slot_id="p-copy", kind="money", fact="revenue",
        unit="money", provenance=dict(a.provenance),
        amount_minor=a.amount_minor, currency="RON")
    spec = AS.ArtifactSpec(kind=AS.KIND_LINE,
                           metrics=(AS.MetricRef(metric="revenue"),))
    artifact = AR.ResolvedArtifact(
        skeleton=AR.skeleton_for(ctx, spec, "same"), cells=(a, b))
    assert artifact.facts()["revenue"] == a.amount_minor / 100.0
    assert artifact.ambiguous_facts() == ()


# ══════════════════════════════════════════════════════════════════════
# Prose rendering at the artifact boundary
# ══════════════════════════════════════════════════════════════════════


def test_prose_renders_only_through_resolved_facts(captured, ctx):
    spec = _spec_for(captured, "kpi_all_metrics")
    resolved = AR.resolve_artifact(ctx, spec, artifact_id="kpi_all_metrics")
    rendered = AR.render_prose(
        "Assets stand at {{money:total_assets}}.", resolved)
    assert rendered.startswith("Assets stand at RON ")
    # The rendered figure IS the resolved one, to the cent.
    minor = [c.amount_minor for c in resolved.cells
             if c.fact == "total_assets"][0]
    assert "{0:,.0f}".format(minor / 100.0) in rendered


def test_prose_citing_a_fact_the_artifact_does_not_carry_refuses(captured, ctx):
    spec = _spec_for(captured, "ratios_one_period")
    resolved = AR.resolve_artifact(ctx, spec, artifact_id="ratios_one_period")
    with pytest.raises(_ratio_units.MissingFactError):
        AR.render_prose("Assets stand at {{money:total_assets}}.", resolved)


def test_prose_citing_an_ambiguous_fact_refuses(captured, ctx):
    a = _real_cell(captured, "kpi_all_metrics", "revenue")
    b = AR.ArtifactCell(
        series_id="revenue", slot_id="p-other", kind="money", fact="revenue",
        unit="money", provenance={"period_id": "p-other"},
        amount_minor=a.amount_minor + 100, currency="RON")
    spec = AS.ArtifactSpec(kind=AS.KIND_LINE,
                           metrics=(AS.MetricRef(metric="revenue"),))
    artifact = AR.ResolvedArtifact(
        skeleton=AR.skeleton_for(ctx, spec, "amb"), cells=(a, b))
    with pytest.raises(_ratio_units.MissingFactError):
        AR.render_prose("Revenue was {{money:revenue}}.", artifact)


# ══════════════════════════════════════════════════════════════════════
# The fact index summary the model is shown
# ══════════════════════════════════════════════════════════════════════


def test_the_fact_index_summary_carries_names_and_shapes_and_no_value(ctx,
                                                                     captured):
    """C1 at the composition boundary.

    A model that has been shown a figure will retype it, and no
    placeholder discipline downstream can undo that. So the summary is
    swept for EVERY value the artifacts actually resolved — not for
    "numbers in general", which a bounds constant would trip.
    """
    summary = AR.summarize_fact_index(ctx)
    text = json.dumps(summary, sort_keys=True)

    resolved_values = set()  # type: set
    for case in captured["cases"]:
        for cell in captured["cases"][case]["resolved"]["cells"]:
            for key in ("amount_minor", "numerator_minor",
                        "denominator_minor"):
                if isinstance(cell.get(key), int):
                    resolved_values.add(abs(cell[key]))
    leaked = [v for v in resolved_values if v and str(v) in text]
    assert not leaked, leaked

    # And no numeric leaf at all — the summary is names and shapes.
    assert not _numeric_leaves(summary), _numeric_leaves(summary)

    # CANARY + FLOOR, per component (TC-3/TC-6): a summary that stopped
    # listing metrics, or stopped listing periods, must not read as a
    # clean sweep.
    metric_ids = [m["metric"] for m in summary["metrics"]]
    assert len(metric_ids) >= 15, metric_ids
    assert "total_assets" in metric_ids and "current_ratio" in metric_ids
    period_ids = [p["period_id"] for p in summary["periods"]]
    assert len(period_ids) >= 4, period_ids
    assert "p-scandia-fy2025" in period_ids
    assert summary["kinds"] == list(AS.ARTIFACT_KINDS)


def test_the_whole_model_input_carries_no_served_figure(ctx, captured):
    """C1 over EVERYTHING the model is handed, not just the summary.

    The question, the fact index and the tool schema, swept as one
    object — because the leak that matters is "did a figure reach the
    model", and a per-ingredient test cannot answer that once a fourth
    ingredient is added somewhere else.
    """
    model_input = AR.build_model_input(
        "how did revenue move, and what is total assets?", ctx)
    text = json.dumps(model_input, sort_keys=True)

    resolved_values = set()  # type: set
    for case in captured["cases"]:
        for cell in captured["cases"][case]["resolved"]["cells"]:
            for key in ("amount_minor", "numerator_minor",
                        "denominator_minor"):
                if isinstance(cell.get(key), int) and abs(cell[key]) >= 1000:
                    resolved_values.add(abs(cell[key]))
    assert len(resolved_values) >= 10, "nothing to sweep for"
    leaked = [v for v in resolved_values if str(v) in text]
    assert not leaked, leaked

    # THREE INGREDIENTS AND NO FOURTH — a new one has to change this
    # test, which is the point.
    assert sorted(model_input) == ["fact_index", "question", "tool",
                                   "version"]
    assert model_input["tool"]["name"] == "compose_artifact"
    assert model_input["question"].startswith("how did revenue move")


def test_the_summary_never_builds_a_gateway(ctx, monkeypatch):
    """Structural: with every route to a served figure sealed, the
    summary still builds. There is therefore no path by which a value
    could reach the model's input."""
    touched = _seal_the_gateway(monkeypatch)
    summary = AR.summarize_fact_index(ctx)
    assert touched == [], touched
    assert len(summary["periods"]) == len(ctx.periods)
    assert summary["periods"][0]["has_source_file"] is True


# ══════════════════════════════════════════════════════════════════════
# Determinism
# ══════════════════════════════════════════════════════════════════════


def test_the_same_context_and_spec_resolve_to_the_same_bytes(captured, ctx):
    for case in sorted(captured["cases"]):
        spec = _spec_for(captured, case)
        a = AR.resolve_artifact(ctx, spec, artifact_id=case).to_payload()
        b = AR.resolve_artifact(ctx, spec, artifact_id=case).to_payload()
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True), case


def test_the_deterministic_fallback_is_a_real_artifact_not_an_apology(ctx):
    spec = AR.deterministic_spec(ctx)
    resolved = AR.resolve_artifact(ctx, spec, artifact_id="fallback")
    assert resolved.ok
    assert set(c.series_id for c in resolved.cells) == {
        "total_assets", "revenue", "net_result"}
    for cell in resolved.cells:
        assert cell.provenance.get("snapshot_id")
