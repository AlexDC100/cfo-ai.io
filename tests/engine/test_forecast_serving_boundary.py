"""F2 + F4 — FACT VERSUS ASSUMPTION, at the engine serving boundary.

Every number this product has served so far is a FACT anchored to a source
cell. A forecast is an ASSUMPTION. This gate exists because the engine's
credibility depends on the reader never confusing the two, and a reader can
only avoid confusing them if the software cannot confuse them first.

F2 — STRUCTURALLY DISTINCT. A projected figure is a different TYPE, from a
     different gateway, in a different package, and the three accessors every
     actuals consumer in this repo reaches for (`amount_minor`, `to_float()`,
     `provenance`) raise on it by name.
F4 — PROVENANCE RESOLVES TO ASSUMPTIONS. A projected figure resolves to the
     drivers that produced it, their values FOR ITS OWN PERIOD, and their
     stated bases. It never carries a source cell, because it never came out
     of one.

WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11)
------------------------------------------------
  * a projected figure reachable through an actuals accessor name, or
    answering one of them with a number instead of raising;
  * a projection payload embedded anywhere inside an actuals payload — at any
    depth, INCLUDING one whose `projected` marker a serializer stripped off,
    which is the more dangerous case and not the less;
  * a source-cell affordance (`snapshot_id` / `line_id` / `source_cell` ...)
    on a projected FIGURE. The exemption is the base-book pointer, under
    EITHER producer's name for it (`contract.BASE_PERIOD_KEYS`: fp1 says
    `base_period`, the engine says `opening`);
  * the wire form failing to read back — `gateway.as_dict()` must satisfy the
    contract it claims to speak, reconstruct through `from_payload`, and
    preserve every figure, every driver id AND every driver VALUE. Wave 1
    emitted a shape neither of its own readers could parse and no gate on
    either side ever fed it back;
  * the leak guard failing to recognise the PRODUCER'S OWN shape
    (`schema: "forecast_v1"`) — measured vacuous before this repair;
  * the adapter inventing attribution the producer never stated, converting a
    major-unit float to minor units inexactly, zeroing a value it cannot
    convert, or flattening `pl`/`bs`/`cf` into one colliding namespace;
  * a driver whose `values` schedule is unreadable (a string, a bool, a NaN)
    being read as ABSENT instead of refused — while an honest `null` for a
    period the model could not derive stays legal;
  * a projected figure served with an empty basis, or naming an assumption the
    payload does not declare — that figure comes back as a refusal carrying no
    number rather than as a number carrying no reason;
  * a driver declared without a stated basis, or with an unknown unit;
  * an unbalanced projected year reported as balanced. There is no tolerance
    band: the arithmetic is integer minor units so the comparison is exact,
    and "a year that does not balance is a HARD ERROR, not a rounding note";
  * non-determinism in the served bytes — two reads of the same payload, and
    two gateways over it, must serialize identically.

MEASURED ON THE PRODUCER'S OWN BYTES, NOT ON A RESHAPE OF THEM
---------------------------------------------------------------
Two payloads. A stand-in (15 figures, breakable on demand: a figure with no
assumptions, a source cell planted on a figure, one cent of imbalance) and
`engine.forecast.Projection.as_dict()` itself — `schema: "forecast_v1"`, bare
floats, no `kind`, no `projected` marker, over all four committed books.

The wave-1 suite also said "measured on the real projection". It was not: it
reached the boundary through a TEST-ONLY adapter in
`forecast_boundary_fixture` that reshaped the producer into fp1 first, so the
gate was pointed at a mirror of itself. Measured with the reshape removed:

    _is_projection_node(Projection.as_dict())         -> False
    projection_leaks_into_actuals(envelope w/ it)     -> 0 paths
    assert_no_projection_in_actuals(envelope w/ it)   -> PASSED
    assert_no_actual_provenance(Projection.as_dict()) -> RAISED
                                        on $.opening.snapshot_id

The central invariant was vacuous against its own producer, and the one thing
it did fire on was correct code. The reshape now lives in the shipped tree as
`engine.forecast_serving.adapter.fp1_from_forecast_v1` and these gates call
THAT, so what they exercise is what ships. Its `attribute_assumptions=True`
flag — which attached all 17 drivers to all 496 figures, and which its own
docstring called "dishonest attribution" — is gone with it. A gate that has to
falsify its input to go green is measuring the falsification.

`forecast_v1` states no link between its drivers and its figures, so the
adapter states none, the contract refuses the whole payload, and NO number is
served. `test_the_adapter_serves_the_attribution_the_producer_states` is
written so it already holds the day lane M starts filling
`adapter.ATTRIBUTION_KEY` — a gate that pinned today's gap would red on the
repair (TC-11).

WHAT IT CANNOT SEE (TC-11)
--------------------------
  * whether the projection ARITHMETIC is right. It measures the boundary, not
    the forecast. A growth rate of 400% with a perfectly balanced sheet passes
    every assertion here, and should — that is lane M's gate, not this one.
  * whether a SURFACE renders the distinction. The engine-side carrier is
    proved here (`projected: True` in the wire form, basis attached to every
    figure); what a screen or an export actually paints is the frontend gate
    (`frontend/lib/__tests__/forecastFactsBoundary.test.ts`) and, in wave 2,
    the export gates.
  * a consumer that reads the raw dict off the wire and ignores the marker.
    Nothing in Python can stop that; the TypeScript side CAN, and does, by
    making the amount an opaque type — which is why the FE half of this gate
    is the load-bearing one for renderers.
  * whether the ATTRIBUTION lane M eventually states is TRUE. This gate can
    prove a figure names drivers the payload declares; it cannot prove those
    are the drivers the arithmetic actually read. That is why the adapter
    refuses to invent them rather than guessing well.
  * an inexact unit conversion on real data — there is none to see. All four
    books, every period, every line: 3,136 values, 0 inexact. The refusal path
    is therefore gated DIRECTLY on `exact_minor`, because a plant that made it
    return 0 instead of None passed every payload-level test in this file.
  * whether a `forecast_v1` payload with a DIFFERENT schema stamp is a
    projection. The recognition is a fixed roster (`contract.PRODUCER_SCHEMAS`),
    not a shape heuristic, so a producer that renames its stamp goes unseen
    until the roster is updated — which is what
    `test_the_leak_guard_sees_the_producers_own_shape` asserting on the
    literal `"forecast_v1"` exists to make loud.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))

from engine.forecast_serving import (  # noqa: E402
    ACTUAL_FIGURE_CONTAINERS,
    ATTRIBUTION_KEY,
    BoundaryViolation,
    ForecastAdapterError,
    ProjectedFigure,
    ProjectedFigureMisuse,
    ProjectionContractError,
    ProjectionGateway,
    ProjectionRefusal,
    actual_provenance_on_projection,
    assert_no_actual_provenance,
    assert_no_projection_in_actuals,
    clause_violations,
    exact_minor,
    fp1_from_forecast_v1,
    projection_leaks_into_actuals,
)
from engine.serving.facts import Fact  # noqa: E402
from forecast_boundary_fixture import projection_payload  # noqa: E402

FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"


def _gateway(**kwargs):
    return ProjectionGateway.from_payload(projection_payload(**kwargs))


def _actual_book(name: str = "agras"):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


# ── F2: the namespace is structural, not nominal ─────────────────────────


def test_a_projected_figure_is_not_the_type_an_actual_is_served_as():
    figure = _gateway().figure("revenue", "FY+1")
    assert isinstance(figure, ProjectedFigure)
    assert not isinstance(figure, Fact)
    assert figure.kind == "projection"


@pytest.mark.parametrize(
    "accessor,instead",
    [("amount_minor", "projected_minor"), ("provenance", "basis")],
)
def test_the_actuals_property_names_refuse_by_name(accessor, instead):
    """`Fact.amount_minor` and `Fact.provenance` are what every actuals
    consumer reaches for. On a projection they raise, and the message says
    what to ask instead — an AttributeError would be structurally correct and
    would teach nobody."""
    figure = _gateway().figure("revenue", "FY+1")
    with pytest.raises(ProjectedFigureMisuse) as excinfo:
        getattr(figure, accessor)
    assert instead in str(excinfo.value)
    assert "projection" in str(excinfo.value)


def test_to_float_the_method_every_actuals_consumer_calls_refuses():
    figure = _gateway().figure("revenue", "FY+1")
    with pytest.raises(ProjectedFigureMisuse) as excinfo:
        figure.to_float()
    assert "to_display()" in str(excinfo.value)


def test_the_projections_own_accessors_work_and_carry_the_real_number():
    """Measured on the agras book: revenue 118,576,819.64 grown 8% is
    128,062,965.21 — carried as integer minor units and divided exactly once,
    at the display boundary."""
    figure = _gateway().figure("revenue", "FY+1")
    assert figure.projected_minor == 12806296521
    assert figure.to_display() == 128062965.21


def test_the_gateway_refuses_a_payload_that_also_carries_actual_figures():
    """One object both gateways accept is the confusion this lane exists to
    prevent, so the projection gateway will not construct from one."""
    for container in ACTUAL_FIGURE_CONTAINERS:
        payload = projection_payload()
        payload[container] = {"total_assets": 39319114.09}
        with pytest.raises(ProjectionContractError) as excinfo:
            ProjectionGateway.from_payload(payload)
        assert "actual_figure_container_in_projection" in str(excinfo.value)
        assert container in str(excinfo.value)


def test_a_payload_that_never_claimed_to_be_a_projection_is_none_not_a_raise():
    """A caller sweeping mixed objects should not have to catch anything."""
    assert ProjectionGateway.from_payload(_actual_book()) is None
    assert ProjectionGateway.from_payload(None) is None
    assert ProjectionGateway.from_payload({"kind": "period"}) is None


# ── F2: THE PLANT — a projection rendered as an actual ───────────────────


def test_plant_a_projected_figure_into_the_actuals_payload_and_the_guard_reds():
    """THE PLANT this gate exists for. A real served book, with one projected
    figure dropped into it the way a careless assembly step would."""
    book = _actual_book()
    assert projection_leaks_into_actuals(book) == [], (
        "the committed book already trips the guard; the plant would prove "
        "nothing"
    )
    assert_no_projection_in_actuals(book)  # green before

    projected = _gateway().figure("revenue", "FY+1").as_dict()
    planted = copy.deepcopy(book)
    planted["statements"]["assembled_pl"]["revenue_next_year"] = projected

    leaks = projection_leaks_into_actuals(planted)
    assert leaks, "a projection sitting in an actuals payload was not seen"
    assert leaks == ["$.statements.assembled_pl.revenue_next_year"], leaks
    with pytest.raises(BoundaryViolation) as excinfo:
        assert_no_projection_in_actuals(planted)
    assert "ACTUALS payload" in str(excinfo.value)
    assert "assembled_pl.revenue_next_year" in str(excinfo.value)


def test_a_projection_stripped_of_its_marker_is_still_caught():
    """The dangerous case is not the projection that kept its marker; it is
    the one a serializer flattened. A figure that names assumptions and an
    amount is a projection whatever the marker says."""
    book = _actual_book()
    stripped = {
        "line": "revenue",
        "period": "FY+1",
        "amount_minor": 12806296521,
        "assumption_ids": ["revenue_growth"],
    }
    planted = copy.deepcopy(book)
    planted["line_items"].append(stripped)
    leaks = projection_leaks_into_actuals(planted)
    assert leaks, "a marker-stripped projection walked past the guard"


def test_the_guard_is_silent_on_all_four_committed_books():
    """A guard that reds on real data is a guard nobody can leave switched on
    (TC-11: what it reds on AFTER the repair)."""
    for name in ("agras", "carniprod", "realestate", "retail"):
        book = _actual_book(name)
        assert projection_leaks_into_actuals(book) == [], name


# ── F4: provenance resolves to assumptions, never to a cell ──────────────


def test_every_served_figure_resolves_to_its_drivers_valued_for_its_period():
    gateway = _gateway()
    for figure in gateway.figures():
        assert isinstance(figure, ProjectedFigure), figure
        assert figure.basis, "%s/%s served with no basis" % (
            figure.line, figure.period,
        )
        for assumption in figure.basis:
            assert assumption.id
            assert assumption.basis.strip(), (
                "driver %r states no basis — a driver a reader cannot "
                "interrogate is a number with an opinion attached"
                % assumption.id
            )
            assert assumption.unit
            # The driver's value is the one for THIS figure's year, not a
            # schedule the reader has to index themselves.
            assert assumption.value is not None, (
                figure.line, figure.period, assumption.id,
            )


def test_the_driver_value_tracks_the_period_and_is_not_the_first_year_twice():
    gateway = _gateway()
    y1 = gateway.figure("revenue", "FY+1")
    y2 = gateway.figure("revenue", "FY+2")
    growth1 = [a for a in y1.basis if a.id == "revenue_growth"][0]
    growth2 = [a for a in y2.basis if a.id == "revenue_growth"][0]
    assert growth1.value == 0.08
    assert growth2.value == 0.06


def test_a_figure_naming_an_assumption_the_payload_does_not_declare_is_refused():
    payload = projection_payload()
    payload["figures"][0]["assumption_ids"] = ["a_driver_nobody_declared"]
    with pytest.raises(ProjectionContractError) as excinfo:
        ProjectionGateway.from_payload(payload)
    assert "figure_names_unknown_assumption" in str(excinfo.value)


def test_a_figure_with_no_assumptions_is_not_served_as_a_number():
    """The LACKS_SHOWS bucket, refused at construction: a projected figure
    with nothing behind it is a refusal, not a number."""
    payload = projection_payload()
    payload["figures"][0]["assumption_ids"] = []
    with pytest.raises(ProjectionContractError) as excinfo:
        ProjectionGateway.from_payload(payload)
    assert "figure_names_no_assumption" in str(excinfo.value)


def test_constructing_a_projected_figure_with_no_basis_raises():
    with pytest.raises(ProjectedFigureMisuse) as excinfo:
        ProjectedFigure("revenue", "FY+1", 1, "RON", basis=())
    assert "resolves to the assumptions" in str(excinfo.value)


def test_a_driver_without_a_stated_basis_is_refused():
    payload = projection_payload()
    payload["assumptions"][0]["basis"] = "   "
    codes = [code for code, _ in clause_violations(payload)]
    assert "assumption_without_stated_basis" in codes


def test_a_driver_with_an_unknown_unit_is_refused():
    payload = projection_payload()
    payload["assumptions"][0]["unit"] = "vibes"
    codes = [code for code, _ in clause_violations(payload)]
    assert "assumption_unit_unknown" in codes


# ── F4: THE PLANT — a source cell on a projected figure ──────────────────


def test_plant_a_source_cell_onto_a_projected_figure_and_the_guard_reds():
    """A projected figure carrying `line_id` offers the reader a jump to a
    cell that does not exist for it. That is the LACKS_SHOWS bucket exactly:
    an affordance over a payload with nothing behind it."""
    payload = projection_payload()
    assert actual_provenance_on_projection(payload["figures"]) == []
    assert_no_actual_provenance(payload["figures"])  # green before

    payload["figures"][0]["provenance"] = {
        "snapshot_id": "saga_10_col_agras",
        "line_id": "pl_revenue",
    }
    found = actual_provenance_on_projection(payload["figures"])
    assert found == ["$[0].provenance.snapshot_id",
                     "$[0].provenance.line_id"], found
    with pytest.raises(BoundaryViolation) as excinfo:
        assert_no_actual_provenance(payload["figures"])
    assert "has no source cell" in str(excinfo.value)

    # And the gateway refuses to construct at all.
    with pytest.raises(ProjectionContractError) as excinfo:
        ProjectionGateway.from_payload(payload)
    assert "figure_carries_actual_provenance" in str(excinfo.value)


def test_the_base_period_snapshot_is_the_one_permitted_source_reference():
    """The projection as a whole stands on one book and the reader has to be
    able to see which. What is forbidden is the claim that a projected NUMBER
    came out of a cell."""
    payload = projection_payload()
    assert payload["base_period"]["snapshot_id"] == "saga_10_col_agras"
    assert actual_provenance_on_projection(payload) == []
    gateway = ProjectionGateway.from_payload(payload)
    assert gateway.base_snapshot_id == "saga_10_col_agras"
    # ...and it is nowhere on a figure.
    for figure in gateway.as_dict()["figures"]:
        assert "snapshot_id" not in json.dumps(figure)
        assert "line_id" not in json.dumps(figure)


# ── B3: the data-level carrier every renderer must consume ───────────────


def test_every_serialized_figure_carries_the_projected_marker():
    served = _gateway().as_dict()
    assert served["kind"] == "projection"
    for figure in served["figures"]:
        assert figure["projected"] is True, figure
        assert figure["kind"] == "projection", figure
        assert figure["basis"], figure
        # The unmistakable name is present, and so is the contract's own —
        # see `test_the_wire_form_reads_back_through_its_own_gateway` for
        # why both, and what it cost when only one was emitted. They carry
        # the identical integer, from the one attribute.
        assert "amount_minor_projected" in figure
        assert "amount_minor" in figure
        assert figure["amount_minor"] == figure["amount_minor_projected"]
        assert figure["assumption_ids"] == [a["id"] for a in figure["basis"]]


# ── W1: THE WIRE FORM READS BACK ─────────────────────────────────────────
#
# THIS BLOCK EXISTS BECAUSE THE ONE BEFORE IT USED TO SAY THE OPPOSITE.
#
# Until this repair, the assertion above read `assert "amount_minor" not in
# figure` — a green gate pinning a defect as its law. What it pinned:
# `as_dict()` renamed the amount to `amount_minor_projected` and replaced
# `assumption_ids` with an expanded `basis`, and BOTH readers of the wire
# form want the contract's input names. `contract.py:294` requires
# `amount_minor`, `:299` requires `assumption_ids`, and
# `forecastFacts.ts` resolves a basis from `assumption_ids` alone.
#
# MEASURED before the repair, on the committed agras fixture:
#   clause_violations(gateway.as_dict())  -> 30 violations
#       figure_amount_not_integer_minor x15, figure_names_no_assumption x15
#   ProjectionGateway.from_payload(...)   -> ProjectionContractError
#   readProjection(...) (the real shipped reader, real bytes)
#       -> 15 figures, 0 served, 15 refused, all no_assumptions_behind_it
#   ProjectedAmount paints that refusal as an em-dash.
# So every projected figure on every surface would have rendered "—" while
# the engine held the number and considered it served.
#
# Neither suite could see it. This one called `as_dict()` seven times and
# never fed it back; the TypeScript one only ever handed `readProjection` a
# hand-written INPUT-shaped payload. A shape nobody feeds back is a shape
# nobody has read, so the round trip is now asserted on BOTH sides.


def test_the_wire_form_reads_back_through_its_own_gateway():
    """The served bytes satisfy the contract they claim to speak."""
    served = _gateway().as_dict()
    assert clause_violations(served) == [], (
        "the gateway emits a payload its own contract refuses"
    )
    again = ProjectionGateway.from_payload(served)
    assert again is not None
    assert [f.line for f in again.figures()] == [
        f.line for f in _gateway().figures()
    ]


def test_the_round_trip_preserves_every_figure_and_its_resolved_basis():
    """Not just "it parses" — the same numbers and the same drivers."""
    first = _gateway()
    second = ProjectionGateway.from_payload(first.as_dict())
    for original, reread in zip(first.figures(), second.figures()):
        assert isinstance(reread, ProjectedFigure), reread
        assert reread.line == original.line
        assert reread.period == original.period
        assert reread.projected_minor == original.projected_minor
        assert [a.id for a in reread.basis] == [a.id for a in original.basis]
        # The driver VALUES survive too. They did not before: the wire form
        # emitted a period-less AssumptionRef and dropped the `values`
        # schedule, so a re-read gave value=None for every driver in every
        # year while the payload it came from stated 0.08. A schedule
        # serialized away reads as ABSENT and is not.
        assert [a.value for a in reread.basis] == [
            a.value for a in original.basis
        ]


def test_the_wire_form_is_a_fixed_point_two_round_trips_are_identical():
    once = _gateway().as_dict()
    twice = ProjectionGateway.from_payload(once).as_dict()
    assert json.dumps(twice, sort_keys=True) == json.dumps(once, sort_keys=True)


def test_the_served_driver_schedule_is_the_declared_one():
    served = _gateway().as_dict()
    declared = {a["id"]: a for a in projection_payload()["assumptions"]}
    for assumption in served["assumptions"]:
        assert assumption["values"] == declared[assumption["id"]]["values"], (
            assumption["id"]
        )
        assert assumption["basis"] == declared[assumption["id"]]["basis"]


def test_a_refusal_carries_the_marker_and_no_number():
    refusal = _gateway().figure("goodwill", "FY+1")
    assert isinstance(refusal, ProjectionRefusal)
    blob = refusal.as_dict()
    assert blob["projected"] is True
    assert blob["refused"] is True
    assert blob["code"] == "not_projected"
    for key, value in blob.items():
        assert not isinstance(value, (int, float)) or isinstance(value, bool), (
            "a refusal leaked a number: %s=%r" % (key, value)
        )


def test_a_period_outside_the_horizon_is_refused_not_extrapolated():
    refusal = _gateway().figure("revenue", "FY+9")
    assert isinstance(refusal, ProjectionRefusal)
    assert refusal.code == "outside_horizon"
    assert "FY+1, FY+2, FY+3" in refusal.detail


# ── the balance check: a hard error, not a rounding note ─────────────────


def test_the_projected_balance_sheet_closes_to_the_cent_on_the_real_book():
    gateway = _gateway()
    rows = gateway.balance_check()
    assert [r["period"] for r in rows] == ["FY+1", "FY+2", "FY+3"]
    for row in rows:
        assert row["difference_minor"] == 0, row
        assert row["balances"] is True, row
    assert gateway.unbalanced_periods() == ()


def test_one_cent_of_imbalance_is_reported_as_an_unbalanced_year():
    """No tolerance band. The arithmetic is integer minor units precisely so
    that this comparison is exact."""
    gateway = _gateway(unbalance_minor=1)
    assert gateway.unbalanced_periods() == ("FY+3",)
    failing = [r for r in gateway.balance_check() if not r["balances"]]
    assert len(failing) == 1
    assert failing[0]["difference_minor"] == 1


def test_unbalanced_periods_come_back_in_horizon_order_not_set_order():
    payload = projection_payload()
    for row in payload["balance_check"]:
        row["difference_minor"] = 7
    gateway = ProjectionGateway.from_payload(payload)
    assert gateway.unbalanced_periods() == ("FY+1", "FY+2", "FY+3")


# ── determinism: same input, same bytes ──────────────────────────────────


def test_two_gateways_over_the_same_payload_serialize_identically():
    a = json.dumps(_gateway().as_dict(), sort_keys=False)
    b = json.dumps(_gateway().as_dict(), sort_keys=False)
    assert a == b
    assert len(a) > 2000, "the serialized projection is suspiciously small"


def test_the_declared_order_is_the_served_order():
    gateway = _gateway()
    served = gateway.as_dict()
    assert [f["line"] for f in served["figures"][:5]] == [
        "revenue", "ebitda", "total_assets", "total_equity",
        "total_liabilities",
    ]
    assert gateway.lines() == (
        "ebitda", "revenue", "total_assets", "total_equity",
        "total_liabilities",
    )


# ── the contract itself ──────────────────────────────────────────────────


def test_a_float_amount_is_refused_even_when_it_is_whole():
    """A payload carrying 12.0 has done float arithmetic somewhere, and a
    projected balance sheet has to close to the cent."""
    payload = projection_payload()
    payload["figures"][0]["amount_minor"] = float(
        payload["figures"][0]["amount_minor"]
    )
    codes = [code for code, _ in clause_violations(payload)]
    assert "figure_amount_not_integer_minor" in codes


def test_a_figure_outside_the_declared_horizon_is_a_contract_break():
    payload = projection_payload()
    payload["figures"][0]["period"] = "FY+7"
    codes = [code for code, _ in clause_violations(payload)]
    assert "figure_period_outside_horizon" in codes


def test_one_concept_one_value_a_duplicated_figure_is_a_contract_break():
    payload = projection_payload()
    payload["figures"].append(dict(payload["figures"][0]))
    codes = [code for code, _ in clause_violations(payload)]
    assert "figure_declared_twice" in codes


def test_the_committed_fixture_payload_is_clean_under_every_clause():
    assert clause_violations(projection_payload()) == []


# ── the committed fixture the FE gate reads, kept honest ─────────────────

FP1_FIXTURE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "fp1_agras.json"


def test_the_committed_fp1_fixture_is_exactly_what_the_builder_produces():
    """The frontend gate reads this same file, so engine and FE are measured
    on IDENTICAL BYTES rather than on two hand-kept copies that drift. If the
    builder changes, this reds and the fixture is regenerated deliberately."""
    on_disk = json.loads(FP1_FIXTURE.read_text())
    assert on_disk == projection_payload(), (
        "tests/engine/fixtures/forecast/fp1_agras.json is stale; regenerate "
        "it from forecast_boundary_fixture.projection_payload()"
    )


def test_the_committed_fixture_loads_through_the_gateway_unchanged():
    gateway = ProjectionGateway.from_payload(json.loads(FP1_FIXTURE.read_text()))
    assert gateway.figure("revenue", "FY+1").projected_minor == 12806296521
    assert gateway.unbalanced_periods() == ()


# ── W3: the driver SCHEDULE, which the contract used never to look at ────
#
# The contract validated a driver's id, its unit and its stated basis, and
# never once looked at the numbers it actually carries. MEASURED before the
# repair, every one of these produced ZERO violations and resolved to
# value=None for FY+1:
#
#   values: {"FY+1": None}          values: "eight percent"
#   values: {"FY+1": "nan"}         values: {"FY+1": True}
#   values key absent entirely      values: {"FY+9": 0.08}
#
# The first is LEGITIMATE and stays legitimate — see below. The rest are
# producer defects the read side silently turned into ABSENT, so "the model
# could not derive it" and "the producer emitted the wrong type" became the
# same fact to every consumer downstream, and the next one to coerce that
# absent to 0 is the next absent-as-zero.


def test_a_driver_may_state_null_for_a_period_it_could_not_derive():
    """ABSENT is a legitimate driver value and MUST NOT be refused.

    Not a judgement call — measured. On the committed `realestate` book the
    real projection engine emits 32 null entries across `dio_days` and
    `dpo_days` (a book with no inventory and no payables states no days).
    A clause that refused null would red this gate on correct output, which
    is the gate being wrong and not the product (TC-11).
    """
    payload = projection_payload()
    payload["assumptions"] = [dict(a) for a in payload["assumptions"]]
    payload["assumptions"][0]["values"] = {"FY+1": None, "FY+2": 0.06,
                                           "FY+3": 0.05}
    assert clause_violations(payload) == []
    gateway = ProjectionGateway.from_payload(payload)
    figure = gateway.figure("revenue", "FY+1")
    assert isinstance(figure, ProjectedFigure)
    # The driver is shown to exist and its value for this year is shown as
    # not stated. That is a different fact from "the driver is 0%".
    assert figure.basis[0].value is None
    assert figure.basis[0].basis.strip()


@pytest.mark.parametrize(
    "values,code",
    [
        ("eight percent", "assumption_values_not_a_schedule"),
        (None, "assumption_values_not_a_schedule"),
        ([0.08, 0.06], "assumption_values_not_a_schedule"),
        ({"FY+1": "0.08"}, "assumption_value_neither_number_nor_absent"),
        ({"FY+1": True}, "assumption_value_neither_number_nor_absent"),
        ({"FY+1": float("nan")}, "assumption_value_neither_number_nor_absent"),
        ({"FY+1": float("inf")}, "assumption_value_neither_number_nor_absent"),
    ],
)
def test_a_driver_whose_schedule_is_unreadable_is_refused_not_read_as_absent(
        values, code):
    payload = projection_payload()
    payload["assumptions"] = [dict(a) for a in payload["assumptions"]]
    if values is None:
        payload["assumptions"][0].pop("values", None)
    else:
        payload["assumptions"][0]["values"] = values
    violations = clause_violations(payload)
    assert code in [c for c, _ in violations], violations
    with pytest.raises(ProjectionContractError) as excinfo:
        ProjectionGateway.from_payload(payload)
    assert code in str(excinfo.value)


def test_the_schedule_clause_names_the_driver_and_the_period():
    """A refusal a reader cannot act on is a refusal nobody acts on."""
    payload = projection_payload()
    payload["assumptions"] = [dict(a) for a in payload["assumptions"]]
    payload["assumptions"][0]["values"] = {"FY+2": "0.06"}
    message = "; ".join(why for _, why in clause_violations(payload))
    assert "revenue_growth" in message
    assert "FY+2" in message


# ═════════════════════════════════════════════════════════════════════════
# THE SAME BOUNDARY, OVER THE BYTES THE PRODUCER ACTUALLY EMITS
# ═════════════════════════════════════════════════════════════════════════
#
# Everything above is measured on a stand-in. Everything below is measured on
# `engine.forecast.Projection.as_dict()` — the producer's OWN serialized form,
# `schema: "forecast_v1"`, bare floats, no `kind`, no `projected` marker.
#
# WHY THAT DISTINCTION IS THE WHOLE POINT OF THIS BLOCK
# -----------------------------------------------------
# The wave-1 suite also claimed to measure "the real projection". It did not.
# It reached the boundary through `forecast_boundary_fixture
# .engine_projection_payload()` — a TEST-ONLY adapter that reshaped the
# producer into fp1 first, so the gate was pointed at a mirror of itself. No
# non-test adapter existed anywhere in the repo.
#
# MEASURED with the reshape removed, on the real agras book:
#   _is_projection_node(Projection.as_dict())            -> False
#   projection_leaks_into_actuals(envelope w/ it)        -> 0 paths
#   assert_no_projection_in_actuals(envelope w/ it)      -> PASSED
#   assert_no_actual_provenance(Projection.as_dict())    -> RAISED
#                                          on $.opening.snapshot_id
# The central invariant of this feature was vacuous against its own producer,
# and the one thing it did fire on was correct code.
#
# The reshape is now `engine.forecast_serving.adapter.fp1_from_forecast_v1`,
# in the shipped tree, and these gates call THAT. What they exercise is what
# ships.


def _forecast_v1(name="agras", **overrides):
    """The producer's own bytes. No reshape, no fixture, no double."""
    from engine.forecast import project_payload
    overrides.setdefault("revenue_growth", 0.08)
    return project_payload(_actual_book(name), **overrides).as_dict()


def _all_books():
    return ("agras", "carniprod", "realestate", "retail")


def test_the_leak_guard_sees_the_producers_own_shape():
    """THE W2 GATE. A real projection, exactly as the engine serializes it,
    dropped into a real served envelope — caught, at its path.

    This is the one that was vacuous. It asserts on the producer's bytes, so
    a rename of the `schema` stamp on either side reds here rather than in
    production; and it does NOT go through the adapter, because going through
    the adapter is precisely what made the old version meaningless.
    """
    for name in _all_books():
        raw = _forecast_v1(name)
        assert raw["schema"] == "forecast_v1", raw.get("schema")
        planted = copy.deepcopy(_actual_book(name))
        planted["envelope"]["forecast"] = raw
        leaks = projection_leaks_into_actuals(planted)
        assert "$.envelope.forecast" in leaks, (name, leaks[:5])
        with pytest.raises(BoundaryViolation) as excinfo:
            assert_no_projection_in_actuals(planted)
        assert "sitting inside an ACTUALS payload" in str(excinfo.value)


def test_the_leak_guard_is_still_silent_on_all_four_untouched_books():
    """The other half of the plant: the guard must not red on ACTUALS.

    Load-bearing here because the committed books DO carry a `schema` key —
    `envelope.canonical_bs.schema == "bs_v2"`. A guard keyed on the key name
    rather than on its value would red on every book in the repo.
    """
    for name in _all_books():
        book = _actual_book(name)
        assert projection_leaks_into_actuals(book) == [], name
        assert_no_projection_in_actuals(book)


def test_the_producers_base_book_pointer_is_not_read_as_a_source_cell():
    """`opening.snapshot_id` is the same pointer fp1 calls
    `base_period.snapshot_id`, under the producer's own word for it.

    MEASURED before `contract.BASE_PERIOD_KEYS` existed: this RAISED on
    `$.opening.snapshot_id` for every real projection the engine has ever
    produced. One concept, one value, across BOTH producers.
    """
    for name in _all_books():
        raw = _forecast_v1(name)
        assert raw["opening"]["snapshot_id"], name
        assert actual_provenance_on_projection(raw) == [], name
        assert_no_actual_provenance(raw)


def test_a_source_cell_on_a_producer_FIGURE_is_still_caught():
    """The exemption is the base pointer, not the whole payload. Plant a
    source cell where a projected figure lives and the guard still reds."""
    raw = _forecast_v1()
    assert_no_actual_provenance(raw)  # green before
    raw["periods"][0]["line_id"] = "pl_revenue"
    found = actual_provenance_on_projection(raw)
    assert found == ["$.periods[0].line_id"], found
    with pytest.raises(BoundaryViolation):
        assert_no_actual_provenance(raw)


# ── the shipped adapter: forecast_v1 -> fp1 ──────────────────────────────


def test_the_adapter_reads_the_producer_on_every_committed_book():
    for name in _all_books():
        fp1 = fp1_from_forecast_v1(_forecast_v1(name))
        assert fp1["kind"] == "projection"
        assert fp1["contract"] == "fp1"
        assert fp1["currency"], name
        assert fp1["horizon"], name
        assert fp1["figures"], name
        assert fp1["assumptions"], name
        assert len(fp1["balance_check"]) == len(fp1["horizon"]), name


def test_the_adapter_refuses_anything_that_is_not_the_producers_schema():
    with pytest.raises(ForecastAdapterError):
        fp1_from_forecast_v1(_actual_book())
    with pytest.raises(ForecastAdapterError):
        fp1_from_forecast_v1({"schema": "bs_v2"})
    with pytest.raises(ForecastAdapterError):
        fp1_from_forecast_v1(projection_payload())


def test_the_adapter_converts_every_value_exactly_or_not_at_all():
    """The unit hop is the risk: the producer emits major-unit floats and fp1
    carries integer minor units. Measured across all four books, every period,
    every line — the conversion is exact or the figure is not emitted."""
    checked = 0
    for name in _all_books():
        raw = _forecast_v1(name)
        fp1 = fp1_from_forecast_v1(raw)
        by_key = {(f["line"], f["period"]): f["amount_minor"]
                  for f in fp1["figures"]}
        for period in raw["periods"]:
            label = period["period"]["label"]
            for section in ("pl", "bs", "cf"):
                for line, value in period[section].items():
                    key = ("%s.%s" % (section, line), label)
                    if key not in by_key:
                        # Refused, not zeroed — the only honest omission.
                        assert exact_minor(value) is None, (name, key, value)
                        continue
                    assert by_key[key] / 100.0 == value, (name, key)
                    checked += 1
    assert checked > 2000, (
        "only %d values checked; the adapter is not seeing the real "
        "projection" % checked
    )


def test_the_adapter_never_invents_attribution():
    """THE REFUSAL THAT MATTERS. `forecast_v1` states no link between its
    drivers and its figures, so the adapter emits none, the contract refuses
    the whole payload, and NO number is served.

    The test fixture used to have a flag that attached all 17 drivers to all
    496 figures so this path could go green; its own docstring called that
    "dishonest attribution". A figure claiming seventeen drivers the model
    never named is a false provenance, and a false provenance is worse than a
    refusal — the refusal is legible and the false one is not.
    """
    raw = _forecast_v1()
    assert ATTRIBUTION_KEY not in raw, (
        "the producer now states attribution — delete this assertion and "
        "keep the served-path test below, which already covers it"
    )
    fp1 = fp1_from_forecast_v1(raw)
    invented = [(f["line"], f["period"], f["assumption_ids"])
                for f in fp1["figures"] if f["assumption_ids"]]
    assert invented == [], (
        "the adapter attached %d driver(s) to %r that the producer never "
        "named — e.g. %r. A figure claiming drivers the model did not state "
        "is a FALSE provenance, which is worse than a refusal: the refusal "
        "is legible and the false one is not."
        % (len(invented[0][2]), invented[0][0], invented[0])
    )
    codes = sorted(set(code for code, _ in clause_violations(fp1)))
    assert codes == ["figure_names_no_assumption"], codes
    with pytest.raises(ProjectionContractError):
        ProjectionGateway.from_payload(fp1)


def test_the_adapter_serves_the_attribution_the_producer_states():
    """Written so it holds the day lane M starts stating attribution: the
    adapter reads `line_assumptions` and nothing changes here (TC-11 — a gate
    that pins today's gap reds on the repair)."""
    raw = _forecast_v1()
    declared = [a["id"] for a in raw["fp1_assumptions"]]
    assert "revenue_growth" in declared
    lines = sorted(set(f["line"]
                       for f in fp1_from_forecast_v1(raw)["figures"]))
    raw[ATTRIBUTION_KEY] = {line: ["revenue_growth"] for line in lines}

    fp1 = fp1_from_forecast_v1(raw)
    assert clause_violations(fp1) == []
    gateway = ProjectionGateway.from_payload(fp1)
    served = gateway.figures()
    assert len(served) > 500, len(served)
    for figure in served:
        assert isinstance(figure, ProjectedFigure), figure
        assert figure.basis, (figure.line, figure.period)
        for assumption in figure.basis:
            assert assumption.basis.strip(), assumption.id

    revenue = gateway.figure("pl.revenue", gateway.horizon[0])
    assert isinstance(revenue, ProjectedFigure)
    assert revenue.projected_minor == int(
        round(raw["periods"][0]["pl"]["revenue"] * 100.0))
    assert [a.id for a in revenue.basis] == ["revenue_growth"]


def test_the_adapter_output_round_trips_through_the_wire_form():
    """W1 over the real producer, not the stand-in."""
    raw = _forecast_v1()
    lines = sorted(set(f["line"] for f in fp1_from_forecast_v1(raw)["figures"]))
    raw[ATTRIBUTION_KEY] = {line: ["revenue_growth"] for line in lines}
    gateway = ProjectionGateway.from_payload(fp1_from_forecast_v1(raw))
    served = gateway.as_dict()
    assert clause_violations(served) == []
    again = ProjectionGateway.from_payload(served)
    assert [f.projected_minor for f in again.figures()] == [
        f.projected_minor for f in gateway.figures()
    ]
    assert json.dumps(again.as_dict(), sort_keys=True) == json.dumps(
        served, sort_keys=True)


def test_a_statement_line_appearing_in_two_bags_does_not_collide():
    """`net_income` and `depreciation` live in BOTH `pl` and `cf`. Flattened
    into one namespace they are two different figures answering to one line
    id, which fp1 refuses as `figure_declared_twice` — correctly, because
    "one concept, one value" is exactly what a collision breaks."""
    raw = _forecast_v1()
    period = raw["periods"][0]
    both = set(period["pl"]) & set(period["cf"])
    assert both, "the collision this prefixing exists for is gone; simplify"
    fp1 = fp1_from_forecast_v1(raw)
    keys = [(f["line"], f["period"]) for f in fp1["figures"]]
    assert len(keys) == len(set(keys)), "the adapter emitted a duplicate figure"
    for line in sorted(both):
        assert ("pl.%s" % line, period["period"]["label"]) in keys
        assert ("cf.%s" % line, period["period"]["label"]) in keys


def test_the_adapters_balance_check_is_independent_of_the_producers_own():
    """It is computed from the two served totals, not copied from the
    producer's `checks.balance_delta`. A check that repeats the producer's
    opinion of itself proves nothing — so this asserts the two AGREE, which
    only means something because they were arrived at separately."""
    for name in _all_books():
        raw = _forecast_v1(name)
        fp1 = fp1_from_forecast_v1(raw)
        for period, row in zip(raw["periods"], fp1["balance_check"]):
            assert row["period"] == period["period"]["label"]
            assert row["difference_minor"] == 0, (name, row)
            assert period["checks"]["balance_delta"] == 0.0, (name, row)


def test_the_adapter_is_deterministic_across_books_and_repeats():
    for name in _all_books():
        raw = _forecast_v1(name)
        first = json.dumps(fp1_from_forecast_v1(raw), sort_keys=True)
        second = json.dumps(fp1_from_forecast_v1(copy.deepcopy(raw)),
                            sort_keys=True)
        assert first == second, name


def test_the_adapter_emits_no_source_cell_on_any_figure():
    for name in _all_books():
        fp1 = fp1_from_forecast_v1(_forecast_v1(name))
        assert actual_provenance_on_projection(fp1["figures"]) == [], name
        assert fp1["base_period"]["snapshot_id"], name


def test_exact_minor_refuses_rather_than_rounds_and_never_returns_zero():
    """DIRECTLY, because no committed book exercises the refusal path.

    Measured: all four books, every period, every line — 3,136 values, zero
    inexact conversions. So a plant that makes `exact_minor` return 0 instead
    of None passes every payload-level test in this file. That is the gate
    being blind, and this is the gate that is not: it hands `exact_minor` the
    values a real payload never carries and pins that each one REFUSES.

    A zero here would be the purest form of the defect this whole lane is
    about — a figure the reader is shown as 0.00 when the truth is that the
    conversion could not be made.
    """
    for value in (0.1 + 0.2, float("nan"), float("inf"), float("-inf"),
                  True, False, "12.30", None, [1], {"a": 1}):
        assert exact_minor(value) is None, (
            "exact_minor(%r) returned %r; ABSENT is None, never 0 — a "
            "reader shown 0.00 for a value that could not be converted has "
            "been told something false"
            % (value, exact_minor(value))
        )
    # And the ordinary path is exact, in both directions of sign.
    assert exact_minor(10876580.61) == 1087658061
    assert exact_minor(-1.05) == -105
    assert exact_minor(0.0) == 0
    assert exact_minor(7) == 700


def test_a_value_the_adapter_cannot_convert_is_omitted_not_zeroed():
    """The payload-level half of the same rule, on a planted inexact value."""
    raw = _forecast_v1()
    label = raw["periods"][0]["period"]["label"]
    raw["periods"][0]["pl"]["revenue"] = 0.1 + 0.2
    fp1 = fp1_from_forecast_v1(raw)
    emitted = {(f["line"], f["period"]) for f in fp1["figures"]}
    assert ("pl.revenue", label) not in emitted, (
        "the adapter emitted a figure for a value it could not convert "
        "exactly; the reader gets a number instead of 'not projected'"
    )
    # ...and the reader is told so, without a number.
    raw[ATTRIBUTION_KEY] = {line: ["revenue_growth"]
                            for line in sorted(set(f["line"]
                                                   for f in fp1["figures"]))}
    gateway = ProjectionGateway.from_payload(fp1_from_forecast_v1(raw))
    refusal = gateway.figure("pl.revenue", label)
    assert isinstance(refusal, ProjectionRefusal)
    assert refusal.code == "not_projected"
    for value in refusal.as_dict().values():
        assert not isinstance(value, (int, float)) or isinstance(value, bool)


# ── the committed SERVED bytes the FE gate reads, kept honest ────────────

FP1_SERVED = (REPO / "tests" / "engine" / "fixtures" / "forecast"
              / "fp1_agras_served.json")


def test_the_committed_served_fixture_is_exactly_what_the_gateway_emits():
    """The frontend gate reads THIS file — the wire form, not the input form.

    Wave 1 gave the FE only the input-shaped payload, so the shape a browser
    would really receive was never exercised on either side of the boundary.
    Committing the served bytes and pinning them here is what makes the two
    halves measure the same thing.
    """
    from forecast_boundary_fixture import served_wire_payload
    on_disk = json.loads(FP1_SERVED.read_text())
    assert on_disk == served_wire_payload(), (
        "tests/engine/fixtures/forecast/fp1_agras_served.json is stale; "
        "regenerate it from forecast_boundary_fixture.served_wire_payload()"
    )


def test_the_committed_served_fixture_reads_back_through_the_gateway():
    gateway = ProjectionGateway.from_payload(json.loads(FP1_SERVED.read_text()))
    assert gateway is not None
    figure = gateway.figure("revenue", "FY+1")
    assert isinstance(figure, ProjectedFigure)
    assert figure.projected_minor == 12806296521
    assert [(a.id, a.value) for a in figure.basis] == [("revenue_growth", 0.08)]
    assert gateway.unbalanced_periods() == ()
