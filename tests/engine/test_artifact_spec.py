"""THE ARTIFACT SPEC under test — the model cannot return a value.

This suite's job is not to check that the parser accepts good specs. It
is to prove that the BAD ones are impossible, and to prove it the way
TC-2 requires: by planting the defect and watching the refusal name what
was planted. A red for the wrong reason is not evidence, so every plant
below asserts the CODE and the EXCERPT, not merely that something failed.

THE PLANTS, all live in this file and re-run on every CI:

  PLANT-A  a payload that returns a data series             -> numeric_series
  PLANT-B  a series hidden inside a KNOWN key               -> numeric_series
      (unknown-key alone would not have caught this one)
  PLANT-C  a float anywhere                                 -> value_float
  PLANT-D  a figure written as a string                     -> value_as_string
  PLANT-E  a correct figure written into a chart label      -> model_authored_numeral
  PLANT-F  the value scanner disabled                       -> scanner_did_not_walk
  PLANT-G  a registry role leaning on defaults for its caps -> budget_inherits_defaults

PLANT-E is the one that matters most. The figure it plants is the REAL total
assets of a REAL book in this repo, correct to the cent — and it is
still refused, because the model was never shown a value and therefore
cannot have obtained it honestly. The SAME string is then accepted once
the fact that authored it is supplied. That pair is what makes this a
test of ATTRIBUTION rather than a ban on digits.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from engine.api import _artifact_spec as AS

REPO = Path(__file__).resolve().parents[2]
FIXTURE = (REPO / "tests" / "engine" / "fixtures" / "artifacts"
           / "resolved_artifacts_REAL_engine.json")


def _fixture() -> Dict[str, Any]:
    assert FIXTURE.is_file(), (
        "the real-engine fixture is missing — regenerate it with "
        "tests/engine/fixtures/artifacts/capture.py")
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


#: The real figure this suite plants into prose. Read off the captured
#: REAL engine output rather than typed here, so it cannot drift into a
#: number that no longer exists.
def _real_total_assets() -> Tuple[int, float]:
    cells = _fixture()["cases"]["kpi_all_metrics"]["resolved"]["cells"]
    for cell in cells:
        if cell["fact"] == "total_assets":
            return int(cell["amount_minor"]), float(cell["value"])
    raise AssertionError("the fixture carries no total_assets cell — the "
                         "capture is broken, not this test")


GOOD = {
    "kind": "line",
    "metrics": [{"metric": "revenue", "label": "Revenue"},
                {"metric": "ebitda", "emphasis": "primary"}],
    "periods": ["p-scandia-fy2025"],
    "group_by": "period",
    "title": "Revenue and operating profit",
    "y_label": "Amount",
    "decimals": 0,
}


# ══════════════════════════════════════════════════════════════════════
# The baseline: a good spec parses, and the census proves the scan ran
# ══════════════════════════════════════════════════════════════════════


def test_a_reference_only_spec_parses():
    parsed = AS.parse_artifact_spec(copy.deepcopy(GOOD))
    assert parsed.ok, [r.to_payload() for r in parsed.refusals]
    assert parsed.spec.metric_ids() == ("revenue", "ebitda")
    assert parsed.spec.periods == ("p-scandia-fy2025",)
    assert parsed.spec.metrics[1].emphasis == "primary"


def test_the_scan_census_reports_work_per_component():
    """TC-3/TC-6 — a census that finds nothing is a broken gate, and a
    floor on a SUM cannot see one component collapse. So each counter is
    asserted on its own, with a canary key name the scan must have seen.
    """
    parsed = AS.parse_artifact_spec(copy.deepcopy(GOOD))
    report = parsed.report
    assert report.nodes_walked >= 12, report.to_payload()
    assert report.strings_scanned >= 8, report.to_payload()
    assert report.lists_walked >= 2, report.to_payload()
    assert report.prose_fields_checked >= 3, report.to_payload()
    assert report.prose_chars_checked >= 20, report.to_payload()
    # DISCOVERY CANARY: names the scan must have visited. A walker that
    # stopped at the top level would still report nodes, but not these.
    assert "metric" in report.keys_seen, report.keys_seen
    assert "label" in report.keys_seen, report.keys_seen
    assert "y_label" in report.keys_seen, report.keys_seen


# ══════════════════════════════════════════════════════════════════════
# PLANT-A/PLANT-B — THE PLANT: the model returns a series
# ══════════════════════════════════════════════════════════════════════


def test_plant_a_a_payload_carrying_a_data_series_is_refused_at_parse():
    """THE headline plant. A model that returns the numbers is refused,
    and the refusal names the numbers it returned."""
    plant = copy.deepcopy(GOOD)
    plant["series"] = [{"name": "Revenue",
                        "data": [4834908159, 4500000000]}]
    parsed = AS.parse_artifact_spec(plant)

    assert not parsed.ok
    assert AS.CODE_NUMERIC_SERIES in parsed.codes(), parsed.codes()
    series_refusal = [r for r in parsed.refusals
                      if r.code == AS.CODE_NUMERIC_SERIES][0]
    # RED FOR THE RIGHT REASON: the excerpt is the planted data, not a
    # downstream type error the plant also happened to cause.
    assert "4834908159" in series_refusal.excerpt, series_refusal.excerpt
    assert series_refusal.path == "series[0].data"
    # And the structural half fires too: there is no field to put it in.
    assert AS.CODE_UNKNOWN_KEY in parsed.codes()
    assert parsed.spec is None


def test_plant_b_a_series_hidden_inside_a_known_key_is_still_refused():
    """The unknown-key rule alone would have let this through: `periods`
    IS a field of the spec. The numeric-series rule is what catches it,
    which is why the two are independent checks and not one."""
    plant = copy.deepcopy(GOOD)
    plant["periods"] = [2024, 2025]
    parsed = AS.parse_artifact_spec(plant)

    assert not parsed.ok
    assert AS.CODE_NUMERIC_SERIES in parsed.codes(), parsed.codes()
    assert AS.CODE_UNKNOWN_KEY not in parsed.codes(), (
        "this plant must be caught by the SERIES rule, not by the "
        "unknown-key rule — otherwise the series rule is untested")
    refusal = [r for r in parsed.refusals
               if r.code == AS.CODE_NUMERIC_SERIES][0]
    assert refusal.path == "periods"


def test_plant_c_a_float_anywhere_is_refused():
    plant = copy.deepcopy(GOOD)
    plant["decimals"] = 2.5
    parsed = AS.parse_artifact_spec(plant)
    assert AS.CODE_VALUE_FLOAT in parsed.codes(), parsed.codes()
    assert parsed.spec is None


def test_plant_d_a_figure_written_as_a_string_is_refused():
    plant = copy.deepcopy(GOOD)
    plant["denominator"] = "4,834,908,159"
    parsed = AS.parse_artifact_spec(plant)
    assert AS.CODE_BAD_ID in parsed.codes(), parsed.codes()

    plant2 = copy.deepcopy(GOOD)
    plant2["totals"] = "4834908159"
    parsed2 = AS.parse_artifact_spec(plant2)
    assert AS.CODE_VALUE_AS_STRING in parsed2.codes(), parsed2.codes()


def test_an_integer_outside_the_two_presentation_slots_is_refused():
    plant = copy.deepcopy(GOOD)
    plant["y_label"] = "Amount"
    plant["revenue"] = 4834908159
    parsed = AS.parse_artifact_spec(plant)
    assert AS.CODE_VALUE_INT in parsed.codes(), parsed.codes()


def test_a_presentation_integer_out_of_range_is_refused():
    plant = copy.deepcopy(GOOD)
    plant["decimals"] = 9
    parsed = AS.parse_artifact_spec(plant)
    assert AS.CODE_VALUE_OUT_OF_RANGE in parsed.codes(), parsed.codes()


# ══════════════════════════════════════════════════════════════════════
# PLANT-E — ATTRIBUTION, not a ban on digits
# ══════════════════════════════════════════════════════════════════════


def test_plant_e_a_correct_figure_in_a_chart_label_is_still_refused():
    """NO EXCEPTION FOR "it is just a chart label".

    The number planted here is the REAL total assets of a REAL book in
    this repo, correct to the cent. It is refused anyway, because the
    model was never shown a value: a correct figure the model could not
    have known is a coincidence at best and a hallucination at worst,
    and neither is traceable to a source cell.
    """
    _minor, native = _real_total_assets()
    plant = copy.deepcopy(GOOD)
    plant["title"] = "Total assets RON {0:,.2f}".format(native)
    parsed = AS.parse_artifact_spec(plant)

    assert not parsed.ok
    assert AS.CODE_MODEL_AUTHORED_NUMERAL in parsed.codes(), parsed.codes()
    assert AS.CODE_LOOSE_CURRENCY in parsed.codes(), parsed.codes()
    numeral = [r for r in parsed.refusals
               if r.code == AS.CODE_MODEL_AUTHORED_NUMERAL][0]
    # RED FOR THE RIGHT REASON: the excerpt must be the planted figure
    # (or its leading run), not some other number the plant happened to
    # introduce.
    printed = "{0:,.2f}".format(native)
    assert numeral.excerpt and printed.startswith(numeral.excerpt), (
        numeral.excerpt, printed)


def test_plant_e_inverse_the_same_string_is_attributable_once_a_fact_authors_it():
    """The other half of the pair, and the reason this is attribution.

    Identical bytes. The only thing that changed is that the ENGINE now
    supplies the fact that printed them — so `templatize` lifts the
    figure into `{{money:total_assets}}` and the guard sees no numeral
    at all. A guard that merely banned digits could not tell these two
    cases apart, and would have to refuse both or accept both.
    """
    _minor, native = _real_total_assets()
    text = "Total assets RON {0:,.2f}".format(native)

    unattributed = AS.prose_violations(text, "title")
    assert unattributed, "the plant must be refused without its fact"

    attributed = AS.prose_violations(text, "title",
                                     facts={"total_assets": native},
                                     currency="RON")
    assert attributed == (), [v.to_payload() for v in attributed]

    # And the lift is byte-exact both ways, so the engine's own rendering
    # of the templated form cannot disagree with the plain text.
    lifted = AS.attributable(text, {"total_assets": native}, "RON")
    assert "{{money:total_assets" in lifted, lifted


def test_a_placeholder_in_prose_survives_the_parse():
    spec = copy.deepcopy(GOOD)
    spec["subtitle"] = "against {{money:total_assets}} of assets"
    parsed = AS.parse_artifact_spec(spec)
    assert parsed.ok, [r.to_payload() for r in parsed.refusals]
    assert "{{money:total_assets}}" in parsed.spec.subtitle


def test_a_year_in_a_label_is_refused_but_a_period_id_is_not():
    """Where the digit line falls, stated as a test.

    A YEAR in a label is a quantity the reader will read as a claim
    about which book they are looking at, and the engine — not the model
    — writes every period caption. A period ID carrying the same digits
    is fine: it is resolved, and an id that does not resolve becomes a
    gap card rather than a figure.
    """
    labelled = copy.deepcopy(GOOD)
    labelled["x_label"] = "FY2025"
    assert AS.CODE_MODEL_AUTHORED_NUMERAL in \
        AS.parse_artifact_spec(labelled).codes()

    ided = copy.deepcopy(GOOD)
    ided["periods"] = ["2025-12", "2024-12"]
    parsed = AS.parse_artifact_spec(ided)
    assert parsed.ok, [r.to_payload() for r in parsed.refusals]
    assert parsed.spec.periods == ("2025-12", "2024-12")


# ══════════════════════════════════════════════════════════════════════
# The structural argument: no field of this schema can hold a value
# ══════════════════════════════════════════════════════════════════════


def test_no_field_of_the_spec_can_express_a_quantity():
    """A census over the schema tables, not over a sample of payloads.

    Every declared slot must belong to a family that cannot carry a
    number, and the only exceptions are the two bounded presentation
    counters. A future field added without a family — or with an
    unbounded numeric one — fails here rather than in production.
    """
    families = {"enum", "id", "id_list", "metric_list", "prose", "int"}
    numeric_slots = []  # type: List[str]
    for table_name, table in (("top", AS._TOP_KEYS),
                              ("metric", AS._METRIC_KEYS)):
        assert table, "%s slot table is empty — the census is broken" % table_name
        for key, family in table.items():
            assert family in families, (table_name, key, family)
            if family == "int":
                numeric_slots.append(key)
    # PER-COMPONENT floors, so one table emptying cannot hide behind the
    # other's size (TC-6).
    assert len(AS._TOP_KEYS) >= 14, sorted(AS._TOP_KEYS)
    assert len(AS._METRIC_KEYS) >= 3, sorted(AS._METRIC_KEYS)
    assert "metrics" in AS._TOP_KEYS and "periods" in AS._TOP_KEYS
    assert "metric" in AS._METRIC_KEYS

    assert sorted(numeric_slots) == sorted(AS._INT_SLOTS), (
        "every integer slot must declare bounds", numeric_slots)
    for key, bounds in AS._INT_SLOTS.items():
        low, high = bounds
        assert 0 <= low <= high <= 50, (key, bounds)


def test_the_schema_shown_to_the_model_contains_no_example_figure():
    """An example figure inside a schema is a figure the model has seen,
    and a model that has seen one will reuse it. So the tool definition
    is swept: the only numbers in it are structural bounds."""
    schema = AS.spec_tool_schema()
    allowed_keys = {"maxItems", "maxLength", "minimum", "maximum"}
    found = []  # type: List[Tuple[str, Any]]

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k in sorted(node):
                walk(node[k], "%s.%s" % (path, k))
        elif isinstance(node, (list, tuple)):
            for i, item in enumerate(node):
                walk(item, "%s[%d]" % (path, i))
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            key = path.rsplit(".", 1)[-1]
            if key not in allowed_keys:
                found.append((path, node))

    walk(schema, "$")
    assert not found, found
    # CANARY: the sweep must actually have reached the properties, or a
    # clean result would mean "no subject" rather than "no figures".
    props = schema["input_schema"]["properties"]
    assert "metrics" in props and "periods" in props, sorted(props)
    assert schema["input_schema"]["additionalProperties"] is False
    assert props["metrics"]["items"]["additionalProperties"] is False


def test_an_unknown_key_names_the_fields_that_do_exist():
    parsed = AS.parse_artifact_spec({"kind": "table",
                                     "metrics": [{"metric": "revenue"}],
                                     "chart_data": "x"})
    refusal = [r for r in parsed.refusals
               if r.code == AS.CODE_UNKNOWN_KEY][0]
    assert "metrics" in refusal.detail and "periods" in refusal.detail


# ══════════════════════════════════════════════════════════════════════
# PLANT-F — the scanner cannot report clean without having walked
# ══════════════════════════════════════════════════════════════════════


def test_plant_f_a_disabled_value_scanner_refuses_instead_of_passing(monkeypatch):
    """TC-3, enforced in the PRODUCT and not only in a gate.

    The plant disables the walk itself. A scanner that reports "no
    violations" after visiting nothing is the exact shape of every
    vacuous gate in this project's history — so the parser treats a
    zero walk on a non-empty payload as its own refusal.
    """
    def _noop(scan, node, path, key, in_metric):
        scan.nodes += 1  # the top-level visit only

    monkeypatch.setattr(AS, "_scan_value", _noop)
    parsed = AS.parse_artifact_spec(copy.deepcopy(GOOD))
    assert AS.CODE_SCANNER_DID_NOT_WALK in parsed.codes(), parsed.codes()
    assert parsed.spec is None


def test_a_non_dict_payload_is_refused_without_pretending_to_scan():
    for payload in (None, [], "kind: line", 7):
        parsed = AS.parse_artifact_spec(payload)
        assert AS.CODE_NOT_AN_OBJECT in parsed.codes(), (payload, parsed.codes())


# ══════════════════════════════════════════════════════════════════════
# Composition — refuse, regenerate ONCE, then the deterministic fallback
# ══════════════════════════════════════════════════════════════════════


class _Composer(object):
    """Records every call so a test can assert not merely the outcome
    but how many times the paid seam was reached."""

    def __init__(self, answers: List[Any]) -> None:
        self.answers = list(answers)
        self.calls = []  # type: List[Any]

    def __call__(self, critique):
        self.calls.append(critique)
        if not self.answers:
            raise AssertionError("composer called more times than answers")
        return self.answers.pop(0)


FALLBACK = AS.ArtifactSpec(kind=AS.KIND_TABLE,
                           metrics=(AS.MetricRef(metric="total_assets"),))


def test_a_good_first_answer_costs_one_call():
    composer = _Composer([copy.deepcopy(GOOD)])
    out = AS.compose_spec(composer, FALLBACK)
    assert out.source == "model" and out.attempts == 1
    assert len(composer.calls) == 1 and composer.calls[0] is None


def test_a_refused_answer_is_regenerated_exactly_once():
    bad = copy.deepcopy(GOOD)
    bad["series"] = [{"data": [1, 2, 3]}]
    composer = _Composer([bad, copy.deepcopy(GOOD)])
    out = AS.compose_spec(composer, FALLBACK)

    assert out.source == "model_retry" and out.attempts == 2
    assert len(composer.calls) == 2
    # The critique NAMES the defect — a retry told only "try again"
    # spends a second call on the same mistake.
    assert "numeric_series" in composer.calls[1]
    assert "series[0].data" in composer.calls[1]


def test_two_refusals_fall_back_deterministically_and_stop_calling():
    bad = copy.deepcopy(GOOD)
    bad["series"] = [{"data": [1, 2, 3]}]
    composer = _Composer([copy.deepcopy(bad), copy.deepcopy(bad)])
    out = AS.compose_spec(composer, FALLBACK)

    assert out.source == "fallback"
    assert out.spec is FALLBACK
    assert len(composer.calls) == 2, "a third call would be a third bill"
    assert AS.CODE_NUMERIC_SERIES in [r.code for r in out.refusals]
    # Both attempts recorded their census, so a fallback cannot hide a
    # scan that never ran.
    assert len(out.reports) == 2
    assert all(r.nodes_walked > 1 for r in out.reports)


def test_a_composer_that_raises_degrades_rather_than_propagating():
    def _boom(critique):
        raise RuntimeError("no credits")

    out = AS.compose_spec(_boom, FALLBACK)
    assert out.source == "fallback" and out.spec is FALLBACK
    assert out.degraded and out.degraded["available"] is False


# ══════════════════════════════════════════════════════════════════════
# PLANT-G — budget: explicit caps per role, checked BEFORE the merge
# ══════════════════════════════════════════════════════════════════════


def test_a_closed_budget_means_zero_model_calls():
    """The cap is checked BEFORE the first call, not after. Checking
    after would already have spent the money the cap exists to
    protect."""
    composer = _Composer([copy.deepcopy(GOOD)])
    closed = AS.ArtifactBudget(role="artifact_compose", available=False,
                               refusals=(AS.SpecRefusal(
                                   code=AS.CODE_BUDGET_ROLE_ABSENT, path="x",
                                   detail="closed"),))
    out = AS.compose_spec(composer, FALLBACK, budget=closed)

    assert composer.calls == [], "a closed budget must not reach the model"
    assert out.source == "closed"
    assert out.spec is FALLBACK
    assert out.degraded["marker"] == "ai_advisory_unavailable"


def test_every_declared_role_carries_explicit_caps():
    """A CENSUS with its denominator, so an empty result cannot be
    mistaken for a clean one (TC-9).

    `roles_inheriting_defaults` returning {} means either "every role
    declares its own caps" or "there are no roles". `declared_roles` is
    what tells the two apart, so it is asserted first.
    """
    roles = AS.declared_roles()
    assert len(roles) >= 10, roles           # floor, measured
    assert "narrative" in roles              # canary
    assert "ai_validator" in roles           # canary
    inheriting = AS.roles_inheriting_defaults()
    assert inheriting == {}, inheriting


def test_plant_g_a_role_leaning_on_defaults_is_caught(tmp_path, monkeypatch):
    """The plant that proves the audit above is wired to anything.

    A registry where one role omits its breaker caps must be REPORTED,
    and a budget for that role must be CLOSED. Without this, the clean
    result above is an assertion about an assertion.
    """
    registry = tmp_path / "models.yaml"
    registry.write_text(
        "schema: ai_model_registry_v1\n"
        "defaults:\n"
        "  temperature: 0\n"
        "  breaker:\n"
        "    max_calls_per_day: 200\n"
        "    max_tokens_per_day: 2000000\n"
        "roles:\n"
        "  artifact_compose:\n"
        "    model_id: test-model\n"
        "    prompt_version: artifact_compose_v1\n"
        "    max_tokens: 2048\n"
        "    temperature: 0\n",
        encoding="utf-8")

    inheriting = AS.roles_inheriting_defaults(registry)
    assert "artifact_compose" in inheriting, inheriting
    assert "breaker.max_calls_per_day" in inheriting["artifact_compose"]

    budget = AS.budget_for_role(AS.ROLE_ARTIFACT_COMPOSE, registry)
    assert budget.available is False
    assert budget.refusals[0].code == AS.CODE_BUDGET_INHERITS_DEFAULTS


def test_a_fully_declared_role_opens_the_budget(tmp_path):
    registry = tmp_path / "models.yaml"
    registry.write_text(
        "schema: ai_model_registry_v1\n"
        "defaults:\n"
        "  temperature: 0\n"
        "roles:\n"
        "  artifact_compose:\n"
        "    model_id: test-model\n"
        "    prompt_version: artifact_compose_v1\n"
        "    max_tokens: 2048\n"
        "    temperature: 0\n"
        "    breaker:\n"
        "      max_calls_per_day: 120\n"
        "      max_tokens_per_day: 900000\n",
        encoding="utf-8")

    budget = AS.budget_for_role(AS.ROLE_ARTIFACT_COMPOSE, registry)
    assert budget.available is True
    assert budget.max_calls_per_day == 120
    assert budget.max_tokens_per_day == 900000
    assert budget.model_id == "test-model"
    assert AS.roles_inheriting_defaults(registry) == {}


def test_the_live_registry_state_is_measured_not_assumed():
    """THE MEASURED STATE, recorded as a test so it cannot be claimed
    without being re-checked.

    `artifact_compose` is NOT declared in src/engine/ai/models.yaml
    today, so artifact composition is CLOSED by construction: the
    deterministic artifact serves and no model call is possible. When
    the registry owner adds the role with explicit caps, this test
    fails and is updated in the same change that opens the spend.
    """
    budget = AS.budget_for_role()
    assert budget.available is False
    assert budget.refusals[0].code == AS.CODE_BUDGET_ROLE_ABSENT
    assert "models.yaml" in budget.refusals[0].fix


def test_an_unreadable_registry_closes_rather_than_guesses(tmp_path):
    missing = tmp_path / "nope.yaml"
    budget = AS.budget_for_role(AS.ROLE_ARTIFACT_COMPOSE, missing)
    assert budget.available is False
    assert budget.refusals[0].code == AS.CODE_BUDGET_UNREADABLE


# ══════════════════════════════════════════════════════════════════════
# Per-artifact cost
# ══════════════════════════════════════════════════════════════════════


def test_cost_is_tracked_per_artifact_not_per_session():
    ledger = AS.SpendLedger()
    ledger.record("a1", calls=1, input_tokens=800, output_tokens=200)
    ledger.record("a1", calls=1, input_tokens=900, output_tokens=100)
    ledger.record("a2", calls=1, input_tokens=100, output_tokens=50)

    assert ledger.artifacts() == ("a1", "a2")
    assert ledger.cost_for("a1").calls == 2
    assert ledger.cost_for("a1").tokens == 2000
    assert ledger.cost_for("a2").tokens == 150
    # An artifact nobody spent on reports zero rather than raising —
    # a missing ledger row is not a missing artifact.
    assert ledger.cost_for("a3").tokens == 0


def test_a_closed_budget_puts_every_artifact_over_cap():
    ledger = AS.SpendLedger()
    closed = AS.ArtifactBudget(role="artifact_compose", available=False)
    assert ledger.over_cap("a1", closed) is True

    open_budget = AS.ArtifactBudget(role="artifact_compose", available=True,
                                    max_tokens_per_day=1000)
    assert ledger.over_cap("a1", open_budget) is False
    ledger.record("a1", input_tokens=1200)
    assert ledger.over_cap("a1", open_budget) is True


# ══════════════════════════════════════════════════════════════════════
# Determinism
# ══════════════════════════════════════════════════════════════════════


def test_the_same_payload_parses_to_the_same_bytes_twice():
    a = AS.parse_artifact_spec(copy.deepcopy(GOOD)).to_payload()
    b = AS.parse_artifact_spec(copy.deepcopy(GOOD)).to_payload()
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
