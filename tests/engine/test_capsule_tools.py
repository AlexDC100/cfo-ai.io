"""THE CAPSULE TOOL LAYER under test — on real envelopes, not doubles.

The context these tests inject is built by the REAL composition chain
(``test_reconciliation``'s TB-rows → parse → assemble → provenance-stamp
builders, the same ones ``test_facts_gateway`` reuses). Nothing here
mirrors a store, re-implements a total, or hand-writes an envelope: the
lesson from the FakeStore outages is that a double will happily keep a
whole subsystem green while it produces nothing.

The gates, in the order they matter:

  C2  NO WRITE TOOL EXISTS — proven by PLANTING one at each of the three
      seams (register, mutate the live registry, dispatch by name) and
      showing all three refuse, with the planted callable never invoked.
  C5  MISSING DATA IS NAMED — a period with no file, a metric the tier
      does not carry, an account that is not there, a benchmark with no
      sample: each returns a typed gap naming the thing and the fix, and
      NEVER a zero, an estimate or a neighbouring period's number.
  A   ALIGNMENT — cross-entity, cross-currency and unlabelled-period
      comparisons are refused with a stated limitation rather than
      performed.
  U   UNITS — money stays in integer minor units end to end; ratios are
      computed through the ratio law on native operands and are
      invariant; every value carries provenance; a result never
      straddles two currencies.
  D   DETERMINISM — same context, same bytes, twice.

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

from engine.api import _capsule_tools as CT
from engine.api import _ratio_units

REPO = Path(__file__).resolve().parents[2]


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# The REAL fixture builders — one source of truth for how a production
# envelope is made (TB rows → parse shape → assemble → provenance stamp).
_trec = _load_by_path(
    "reconciliation_fixture_builders",
    Path(__file__).resolve().parent / "test_reconciliation.py",
)
_row = _trec._row
_assembled_for = _trec._assembled_for

# The ps1 (public open-data) envelope builder, reused rather than
# re-typed: the summary tier's indicator layout is a verified fact about
# data.gov.ro, and a second copy of it would drift.
_tps = _load_by_path(
    "public_summary_fixture_builders",
    Path(__file__).resolve().parent / "test_public_summary_serving.py",
)
_ps_envelope = _tps._ps_envelope


# ── Fixture books ──────────────────────────────────────────────────────

DEC_ROWS = [
    _row("212", sf_d=2500.00),                     # buildings
    _row("5121", sf_d=1000.00),                    # bank
    _row("461", sf_d=400.00),                      # sundry debtors
    _row("1012", sf_c=3400.00),                    # share capital
    _row("401", sf_c=500.00),                      # trade payables
    _row("707", r_c=9000.00, st_c=9000.00),        # merchandise sales
    _row("607", r_d=6000.00, st_d=6000.00),        # cost of goods sold
]

NOV_ROWS = [
    _row("212", sf_d=2500.00),
    _row("5121", sf_d=800.00),
    _row("461", sf_d=400.00),
    _row("1012", sf_c=3200.00),
    _row("401", sf_c=500.00),
    _row("707", r_c=7000.00, st_c=7000.00),
    _row("607", r_d=5000.00, st_d=5000.00),
]


def _period(pack, rows: List[Dict[str, float]], *, period_id: str,
            label: str, entity_id: str = "org-1", currency: str = "RON",
            with_detail: bool = True) -> "CT.PeriodRef":
    assembled = _assembled_for(pack, rows)
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-%s" % period_id,
        "content_hash": "sha256-%s" % period_id,
        "written_at": "2026-08-30T00:00:00+00:00",
    }
    accounts = ()  # type: Tuple[CT.AccountRow, ...]
    statements = None
    if with_detail:
        accounts = tuple(
            CT.AccountRow(
                code=str(li.get("ro_account_code") or ""),
                name=str(li.get("ro_account_name") or ""),
                amount_minor=int(round(float(li.get("amount") or 0) * 100)),
                currency=currency,
                statement=str(li.get("statement") or ""),
                bucket=str(li.get("bucket") or ""),
            )
            for li in assembled["lineItems"]
            if li.get("ro_account_code")
        )
        statements = assembled["statements"]
    return CT.PeriodRef(
        period_id=period_id, label=label, entity_id=entity_id,
        currency=currency, period_end="2024-12-31",
        envelope=envelope, statements=statements, accounts=accounts,
        snapshot_id="sha256-%s" % period_id,
    )


@pytest.fixture()
def dec_period(pack):
    return _period(pack, DEC_ROWS, period_id="p-dec", label="December 2024")


@pytest.fixture()
def nov_period(pack):
    return _period(pack, NOV_ROWS, period_id="p-nov", label="November 2024")


@pytest.fixture()
def empty_period():
    """A period row that exists with NO attached file — the C5 headline
    case, and the one an estimate would be most tempting for."""
    return CT.PeriodRef(period_id="p-oct", label="October 2024",
                        entity_id="org-1", currency="RON")


@pytest.fixture()
def ctx(dec_period, nov_period, empty_period):
    return CT.CapsuleContext(
        entity_id="org-1",
        periods=(dec_period, nov_period, empty_period),
        benchmarks=(
            CT.BenchmarkStat(peer_group="food_manufacturing",
                             metric="ebitda_margin",
                             unit=_ratio_units.UNIT_PERCENT,
                             p25=0.06, p50=0.10, p75=0.14,
                             sample_size=41, source="RO SME panel",
                             as_of="2025"),
            CT.BenchmarkStat(peer_group="niche_group", metric="ebitda_margin",
                             unit=_ratio_units.UNIT_PERCENT,
                             p25=0.01, p50=0.02, p75=0.03,
                             sample_size=3, source="RO SME panel",
                             as_of="2025"),
        ),
        help_topics=(
            CT.HelpTopic(topic_id="upload_tb", title_key="help.upload.title",
                         body_key="help.upload.body", route="/dashboard",
                         keywords=("upload", "trial balance", "balanta")),
        ),
    )


# ══════════════════════════════════════════════════════════════════════
# C2 — no write tool exists, at construction AND at runtime
# ══════════════════════════════════════════════════════════════════════


class _Planted(object):
    """A planted WRITE tool. It records every invocation so a test can
    prove not merely that the call was refused, but that the callable
    never ran."""

    def __init__(self) -> None:
        self.calls = []  # type: List[Any]

    def __call__(self, ctx, **kwargs):  # noqa: ANN001 — tool signature
        self.calls.append(kwargs)
        raise AssertionError(
            "a planted write tool executed — the capsule tool layer is not "
            "read-only after all")


def _planted_spec(name: str, fn, read_only: bool = True) -> "CT.ToolSpec":
    return CT.ToolSpec(name=name, fn=fn, description="plants a write",
                       params=(), returns="never", read_only=read_only)


def test_c2_planted_write_tool_is_refused_at_construction():
    """SEAM 1 — the registry builder. Four independent reasons, each
    fatal on its own: the mutation verb, the missing read_only flag, the
    absence from the allowlist, and a non-spec object."""
    planted = _Planted()

    # (a) a mutation verb, even if somebody also allowlisted the name.
    with pytest.raises(CT.ToolRegistryError) as exc:
        CT.register_tools(list(CT._SPECS) +
                          [_planted_spec("set_period_status", planted)])
    assert "mutation" in str(exc.value)

    # (b) read_only not declared.
    with pytest.raises(CT.ToolRegistryError) as exc:
        CT.register_tools(list(CT._SPECS) +
                          [_planted_spec("get_facts_writer", planted,
                                         read_only=False)])
    assert "read_only" in str(exc.value)

    # (c) a perfectly innocent-looking read name that nobody allowlisted.
    with pytest.raises(CT.ToolRegistryError) as exc:
        CT.register_tools(list(CT._SPECS) +
                          [_planted_spec("fetch_and_persist", planted)])
    assert "TOOL_ALLOWLIST" in str(exc.value)

    # (d) not a ToolSpec at all — a bare callable cannot sneak in.
    with pytest.raises(CT.ToolRegistryError):
        CT.register_tools(list(CT._SPECS) + [planted])

    assert planted.calls == [], "a refused registration must never execute"


def test_c2_planted_write_tool_cannot_be_injected_into_the_live_registry():
    """SEAM 2 — the live registry object itself. It is a MappingProxyType,
    so planting is a TypeError, not a silent success."""
    planted = _Planted()
    with pytest.raises(TypeError):
        CT.TOOL_REGISTRY["set_period_status"] = _planted_spec(  # type: ignore[index]
            "set_period_status", planted)
    with pytest.raises((TypeError, AttributeError)):
        CT.TOOL_REGISTRY.update({"delete_period": planted})  # type: ignore[attr-defined]
    assert "set_period_status" not in CT.TOOL_REGISTRY
    assert planted.calls == []


def test_c2_planted_write_tool_is_refused_at_dispatch(ctx, monkeypatch):
    """SEAM 3 — the dispatcher. Even with a registry that HAS been
    replaced wholesale with one containing a write tool, dispatch
    refuses on the allowlist before it looks anything up."""
    planted = _Planted()
    rogue = dict(CT.TOOL_REGISTRY)
    rogue["set_period_status"] = _planted_spec("set_period_status", planted)
    monkeypatch.setattr(CT, "TOOL_REGISTRY", rogue)

    result = CT.dispatch("set_period_status", {"status": "approved"}, ctx)
    assert not result.ok
    assert [g.code for g in result.gaps] == [CT.GAP_TOOL_NOT_ALLOWLISTED]
    assert planted.calls == [], "the planted callable must never be invoked"
    # The refusal names what CAN be called — no silent empty answer.
    assert "get_facts" in result.gaps[0].fix


def test_c2_the_allowlist_itself_contains_no_mutation_verb():
    """The allowlist is data, and data drifts. Scan it the way the
    builder does, so an added name that reads as a write fails here as
    well as at construction."""
    for name in CT.TOOL_ALLOWLIST:
        for prefix in CT.WRITE_VERB_PREFIXES:
            assert not name.lower().startswith(prefix), (
                "allowlisted tool %r names a mutation (%r)" % (name, prefix))
    assert len(set(CT.TOOL_ALLOWLIST)) == len(CT.TOOL_ALLOWLIST)


def test_c2_every_schema_declares_read_only_and_covers_the_allowlist():
    schemas = CT.tool_schemas()
    assert [s["name"] for s in schemas] == list(CT.TOOL_ALLOWLIST)
    assert all(s["read_only"] is True for s in schemas)
    # Serializable as-is — this is what the answer lane hands the model.
    json.dumps(schemas)


def test_c2_module_exposes_no_callable_that_writes():
    """A last structural sweep: nothing public in this module names a
    mutation. Catches a helper added later that a future registry edit
    could then expose."""
    for name in dir(CT):
        if name.startswith("_"):
            continue
        if not callable(getattr(CT, name)):
            continue
        for prefix in CT.WRITE_VERB_PREFIXES:
            assert not name.lower().startswith(prefix), (
                "public callable %r in the capsule tool layer names a "
                "mutation" % name)


# ══════════════════════════════════════════════════════════════════════
# C5 — missing data is NAMED, never estimated, never zeroed
# ══════════════════════════════════════════════════════════════════════


def test_c5_period_without_a_file_names_the_period_and_the_fix(ctx):
    result = CT.dispatch("get_facts",
                         {"metric": "total_assets", "period": "October 2024"},
                         ctx)
    assert not result.ok
    assert result.values == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_NO_SOURCE_FILE
    assert gap.missing == ("October 2024",)
    assert gap.detail == "October 2024 has no attached file."
    assert gap.fix == "Upload the trial balance for October 2024."
    # And nothing numeric leaked into the payload.
    payload = result.to_payload()
    assert payload["facts"] == {} and payload["currency"] is None


def test_c5_unknown_period_never_answers_with_a_neighbouring_one(ctx):
    result = CT.dispatch("get_facts",
                         {"metric": "total_assets", "period": "March 2019"},
                         ctx)
    assert result.values == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_PERIOD_NOT_FOUND
    assert "December 2024" in gap.fix  # it offers, it does not substitute


def test_c5_unknown_metric_lists_what_exists(ctx):
    result = CT.dispatch("get_facts",
                         {"metric": "gross_margin_ish", "period": "p-dec"},
                         ctx)
    gap = result.gaps[0]
    assert gap.code == CT.GAP_UNKNOWN_METRIC
    assert gap.missing == ("gross_margin_ish",)
    assert "total_assets" in gap.fix


def test_c5_absent_account_is_a_gap_not_a_zero(ctx):
    result = CT.dispatch("get_account", {"code": "9999", "period": "p-dec"},
                         ctx)
    assert result.values == () and result.rows == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_NOT_FOUND
    assert gap.missing == ("9999",)
    assert "December 2024" in gap.detail


def test_c5_missing_analytic_detail_on_a_summary_tier_is_a_typed_gap():
    """A reduced open-data filing genuinely cannot carry working capital
    — its DATORII column has no maturity split. The refusal must say so
    and offer the upload, not compute a plausible-looking number off the
    two totals it does have."""
    period = CT.PeriodRef(period_id="p-pub", label="FY2024",
                          entity_id="org-1", currency="RON",
                          envelope=_ps_envelope())
    ctx = CT.CapsuleContext(entity_id="org-1", periods=(period,))
    result = CT.dispatch("get_facts",
                         {"metric": "working_capital", "period": "FY2024"},
                         ctx)
    assert result.values == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_NEEDS_TRIAL_BALANCE
    assert gap.upsell_key  # the paywall key rides along
    assert "Upload the trial balance" in gap.fix


def test_c5_undefined_ratio_is_refused_not_reported_as_zero(pack):
    """A zero denominator makes a ratio UNDEFINED. Reporting 0.0 would
    read as "healthy" for exactly the ratios where it means the opposite."""
    rows = [_row("5121", sf_d=1000.00), _row("1012", sf_c=1000.00)]
    period = _period(pack, rows, period_id="p-nocl", label="Flat 2024")
    ctx = CT.CapsuleContext(entity_id="org-1", periods=(period,))
    result = CT.dispatch("get_facts",
                         {"metric": "current_ratio", "period": "Flat 2024"},
                         ctx)
    assert result.values == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_UNDEFINED_RATIO
    assert "not zero" in gap.detail


def test_c5_benchmark_absence_and_thin_sample_are_different_refusals(ctx):
    absent = CT.dispatch("get_benchmark",
                         {"peer_group": "shipbuilding", "metric": "ebitda_margin"},
                         ctx)
    assert absent.gaps[0].code == CT.GAP_NOT_FOUND
    assert "food_manufacturing" in absent.gaps[0].fix

    thin = CT.dispatch("get_benchmark",
                       {"peer_group": "niche_group", "metric": "ebitda_margin"},
                       ctx)
    assert thin.rows == ()
    assert thin.limitations[0].rule == CT.LIMIT_SAMPLE_SIZE
    # The thin band's NUMBERS never reach the payload.
    assert "0.02" not in json.dumps(thin.to_payload())


def test_c5_help_miss_is_named(ctx):
    result = CT.dispatch("search_help", {"topic": "quantum accounting"}, ctx)
    assert result.gaps[0].code == CT.GAP_NOT_FOUND
    hit = CT.dispatch("search_help", {"topic": "balanță"}, ctx)
    assert [r.row_id for r in hit.rows] == ["upload_tb"]


def test_c5_no_gap_ever_carries_a_number(ctx):
    """The structural half of "never an estimate": scan every gap this
    suite can provoke for a digit-bearing substitute value."""
    provocations = [
        ("get_facts", {"metric": "total_assets", "period": "October 2024"}),
        ("get_facts", {"metric": "nope", "period": "p-dec"}),
        ("get_account", {"code": "9999", "period": "p-dec"}),
        ("get_benchmark", {"peer_group": "shipbuilding", "metric": "x"}),
        ("get_public_company", {"entity": "NOSUCH"}),
        ("search_help", {"topic": "zzz"}),
    ]
    for tool, args in provocations:
        for gap in CT.dispatch(tool, args, ctx).gaps:
            payload = gap.to_payload()
            assert "value" not in payload and "amount_minor" not in payload


# ══════════════════════════════════════════════════════════════════════
# ALIGNMENT — a comparison is refused unless it is honest
# ══════════════════════════════════════════════════════════════════════


def test_alignment_same_entity_periods_compare_with_an_exact_delta(ctx):
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets", "revenue"],
                          "p1": "November 2024", "p2": "December 2024"}, ctx)
    assert result.ok and result.limitations == ()
    by_fact = dict((v.fact, v) for v in result.money_values())
    assert set(by_fact) == {
        "total_assets_a", "total_assets_b", "total_assets_delta",
        "revenue_a", "revenue_b", "revenue_delta",
    }
    # Integer minor units all the way — the delta is exact, not rounded
    # through a display float.
    assert (by_fact["total_assets_delta"].amount_minor
            == by_fact["total_assets_b"].amount_minor
            - by_fact["total_assets_a"].amount_minor)
    assert by_fact["revenue_delta"].amount_minor == 200000  # 9000 − 7000 RON
    assert result.to_payload()["currency"] == "RON"
    prov = by_fact["revenue_delta"].provenance
    assert prov["from_period_id"] == "p-nov" and prov["to_period_id"] == "p-dec"


def test_alignment_refuses_cross_entity(pack, dec_period):
    other = _period(pack, NOV_ROWS, period_id="p-other",
                    label="December 2024 (other co)", entity_id="org-2")
    ctx = CT.CapsuleContext(entity_id="org-1", periods=(dec_period, other))
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets"], "p1": "p-dec",
                          "p2": "p-other"}, ctx)
    assert result.values == ()
    assert result.limitations[0].rule == CT.LIMIT_SAME_ENTITY


def test_alignment_refuses_cross_currency_without_converting(pack, dec_period):
    eur = _period(pack, NOV_ROWS, period_id="p-eur", label="November 2024",
                  currency="EUR")
    ctx = CT.CapsuleContext(entity_id="org-1", periods=(dec_period, eur))
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets"], "p1": "p-eur",
                          "p2": "p-dec"}, ctx)
    assert result.values == ()
    limitation = result.limitations[0]
    assert limitation.rule == CT.LIMIT_NATIVE_UNITS
    assert "RON" in limitation.detail and "EUR" in limitation.detail


def test_alignment_refuses_an_unlabelled_period(pack, dec_period):
    unlabelled = _period(pack, NOV_ROWS, period_id="p-blank", label="")
    ctx = CT.CapsuleContext(entity_id="org-1",
                            periods=(dec_period, unlabelled))
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets"], "p1": "p-blank",
                          "p2": "p-dec"}, ctx)
    assert result.values == ()
    assert result.limitations[0].rule == CT.LIMIT_LABELLED_PERIOD


def test_alignment_one_absent_metric_does_not_poison_the_others():
    """Two open-data filings that carry assets but NOT the total-expense
    column must still compare assets — with a NAMED gap on each side for
    the metric neither can serve, and no delta invented for it."""
    thin = _ps_envelope(indicators={"I15": None})
    del thin["public_summary"]["indicators"]["I15"]
    a = CT.PeriodRef(period_id="p-fy23", label="FY2023", entity_id="org-1",
                     currency="RON", envelope=copy.deepcopy(thin))
    b = CT.PeriodRef(period_id="p-fy24", label="FY2024", entity_id="org-1",
                     currency="RON", envelope=copy.deepcopy(thin))
    ctx = CT.CapsuleContext(entity_id="org-1", periods=(a, b))
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets", "expenses"],
                          "p1": "p-fy23", "p2": "p-fy24"}, ctx)
    facts = set(v.fact for v in result.money_values())
    assert "total_assets_delta" in facts
    assert not any(f.startswith("total_expenses") for f in facts)
    assert [g.missing for g in result.gaps] == [("expenses",), ("expenses",)]
    assert all(g.code == CT.GAP_CONCEPT_ABSENT for g in result.gaps)


def test_alignment_cross_entity_public_company_states_the_boundary(ctx):
    """REAL SEC bytes → the REAL EDGAR adapter → a pm1 envelope. A
    hand-written "market envelope" would test the fixture, not the
    gateway probe that decides which tier a document is."""
    from engine.public_market import edgar, model, registry

    fixtures = (Path(__file__).resolve().parent / "fixtures" / "public_market")
    doc = json.loads(
        (fixtures / "companyfacts_CIK0000320193_truncated.json").read_text(
            encoding="utf-8"))
    ir = edgar.build_summary_ir(doc, fetched_at="2026-08-29T20:53:16Z")
    market_env = model.normalize_envelope(
        edgar.build_envelope(ir, ticker="AAPL"), registry.get_market("us"),
        # A licensed end-of-day close, in the shape prices.price_block
        # emits. Without it EVERY market metric refuses on the absent
        # price — honest, but it would leave the value path untested.
        price={"price_minor": 21050, "currency": "USD",
               "as_of": "2026-08-28", "delay_note": "End-of-day close"})
    ctx2 = CT.CapsuleContext(
        entity_id=ctx.entity_id, periods=ctx.periods,
        public_companies=(CT.PublicCompanyRef(entity="AAPL", name="Apple Inc",
                                              envelope=market_env,
                                              currency="USD"),))
    result = CT.dispatch("get_public_company", {"entity": "AAPL"}, ctx2)
    assert any(l.rule == CT.LIMIT_CROSS_ENTITY for l in result.limitations)
    # The feed's own figures come through in ITS currency, never
    # relabelled to the workspace's RON.
    served = dict((v.metric, v) for v in result.values)
    assert "market.price" in served
    assert served["market.price"].currency == "USD"
    assert served["market.price"].amount_minor == 21050
    # Every metric the feed did not publish is a NAMED refusal, not a
    # silently omitted row and not a partial computation.
    assert result.gaps, "an incomplete feed must produce named gaps"
    for gap in result.gaps:
        assert gap.missing
        assert gap.code in (CT.GAP_FEED_INPUT_ABSENT, CT.GAP_CONCEPT_ABSENT)


def test_alignment_unknown_public_company_is_not_guessed(ctx):
    result = CT.dispatch("get_public_company", {"entity": "TLV"}, ctx)
    assert result.values == ()
    assert result.gaps[0].code == CT.GAP_NOT_FOUND


# ══════════════════════════════════════════════════════════════════════
# UNITS, PROVENANCE, MONEY DISCIPLINE
# ══════════════════════════════════════════════════════════════════════


def test_every_money_value_is_integer_minor_units_with_provenance(ctx):
    result = CT.dispatch("get_facts",
                         {"metric": "total_assets", "period": "p-dec"}, ctx)
    money = result.money_values()[0]
    assert isinstance(money.amount_minor, int)
    assert money.currency == "RON"
    assert money.provenance["period_id"] == "p-dec"
    assert money.provenance["snapshot_id"] == "sha256-p-dec"
    assert money.provenance["tier"] == "canonical_bs"
    # The one float conversion happens at the boundary and nowhere else.
    assert money.native() == money.amount_minor / 100.0


def test_facts_and_fact_units_are_the_placeholder_bridge(ctx):
    """The answer lane binds ``{{money:<fact>}}`` against these two maps.
    Units are DECLARED here — nothing downstream infers money from
    magnitude, which is the whole 461 lesson."""
    result = CT.dispatch("compare_periods",
                         {"metrics": ["total_assets"], "p1": "p-nov",
                          "p2": "p-dec"}, ctx)
    payload = result.to_payload()
    assert set(payload["facts"]) == set(payload["fact_units"])
    assert all(unit == _ratio_units.UNIT_MONEY
               for unit in payload["fact_units"].values())
    # Placeholder-safe names: the FE regex accepts [A-Za-z0-9_]+ only.
    for name in payload["facts"]:
        assert name.replace("_", "").isalnum()


def test_ratio_facts_agree_with_the_engine_unit_registry():
    """Where a metric's fact name is one the engine already declares, the
    unit this layer declares must AGREE. A layer that says "money" about
    a name the engine calls a percent is the mixed-claim bug wearing a
    different hat."""
    for spec in CT.METRICS.values():
        declared = _ratio_units.unit_for_fact(spec.fact)
        if declared == _ratio_units.UNIT_UNKNOWN:
            # Undeclared names are fine: this layer ships the unit on the
            # payload, so no consumer has to guess. They must NOT be
            # dimensionless names, though.
            assert spec.unit == _ratio_units.UNIT_MONEY, (
                "dimensionless fact %r must be declared in _ratio_units"
                % spec.fact)
            continue
        assert declared == spec.unit, (
            "fact %r: capsule says %s, engine registry says %s"
            % (spec.fact, spec.unit, declared))


def test_ratios_are_computed_on_native_operands_and_are_invariant(ctx):
    result = CT.dispatch("get_facts",
                         {"metric": "equity_ratio", "period": "p-dec"}, ctx)
    ratio = result.values[0]
    assert isinstance(ratio, CT.ToolRatio)
    assert ratio.unit == _ratio_units.UNIT_PERCENT
    # The exact integer pair rides along, so the quotient is checkable.
    assert (ratio.numerator_minor / float(ratio.denominator_minor)
            == pytest.approx(ratio.value))
    # A ratio is dimensionless: it never appears in the result's currency.
    assert result.to_payload()["currency"] is None


def test_a_result_never_straddles_two_currencies(ctx):
    """Structural, not hoped-for: ``currency()`` raises rather than serve
    a payload whose money spans a conversion boundary."""
    good = CT.dispatch("get_facts", {"metric": "revenue", "period": "p-dec"},
                       ctx)
    mixed = CT.ToolResult(tool="get_facts", values=(
        good.money_values()[0],
        CT.ToolMoney(fact="x", metric="x", amount_minor=1, currency="EUR",
                     provenance={}),
    ))
    with pytest.raises(AssertionError):
        mixed.currency()


def test_account_children_are_listed_never_summed(ctx, pack):
    rows = list(DEC_ROWS) + [_row("4111", sf_d=120.00), _row("4118", sf_d=80.00)]
    period = _period(pack, rows, period_id="p-child", label="Child 2024")
    ctx2 = CT.CapsuleContext(entity_id="org-1", periods=(period,))
    result = CT.dispatch("get_account", {"code": "411", "period": "p-child"},
                         ctx2)
    codes = sorted(r.row_id for r in result.rows)
    assert codes == ["4111", "4118"]
    amounts = sorted(m.amount_minor for m in result.money_values())
    assert amounts == [8000, 12000]
    assert 20000 not in amounts, "no invented subtotal"
    assert any("no subtotal" in note for note in result.notes)


# ══════════════════════════════════════════════════════════════════════
# SCENARIO PREVIEW — arithmetic, never a write, never a pipeline re-run
# ══════════════════════════════════════════════════════════════════════


def test_scenario_preview_is_exact_and_states_its_own_scope(ctx):
    result = CT.dispatch("run_scenario_preview", {
        "drivers": [{"metric": "revenue", "mode": "pct", "value": -0.10},
                    {"metric": "expenses", "mode": "absolute", "value": -500.0}],
        "period": "p-dec",
    }, ctx)
    by_fact = dict((v.fact, v) for v in result.money_values())
    base_rev = by_fact["revenue"].amount_minor
    assert by_fact["scenario_revenue"].amount_minor == (
        base_rev + int(round(base_rev * -0.10)))
    # −10% revenue and −500 RON of cost: the result delta is the net.
    assert by_fact["scenario_result_delta"].amount_minor == (
        int(round(base_rev * -0.10)) + 50000)
    assert any(l.rule == CT.LIMIT_PREVIEW_SCOPE for l in result.limitations)
    assert all(m.provenance.get("preview") or m.metric in ("revenue", "expenses")
               for m in result.money_values())


def test_scenario_preview_refuses_a_driver_it_cannot_move(ctx):
    result = CT.dispatch("run_scenario_preview", {
        "drivers": [{"metric": "total_assets", "mode": "pct", "value": 0.5}],
        "period": "p-dec"}, ctx)
    assert result.values == ()
    gap = result.gaps[0]
    assert gap.code == CT.GAP_UNKNOWN_METRIC
    assert "revenue" in gap.fix


def test_scenario_preview_leaves_the_period_untouched(ctx):
    """The read-only claim, measured: the context's envelope bytes are
    identical before and after a preview."""
    before = json.dumps(ctx.periods[0].envelope, sort_keys=True,
                        ensure_ascii=False)
    CT.dispatch("run_scenario_preview", {
        "drivers": [{"metric": "revenue", "mode": "pct", "value": 2.0}],
        "period": "p-dec"}, ctx)
    after = json.dumps(ctx.periods[0].envelope, sort_keys=True,
                       ensure_ascii=False)
    assert before == after


# ══════════════════════════════════════════════════════════════════════
# FINDINGS + DISPATCH HYGIENE + DETERMINISM
# ══════════════════════════════════════════════════════════════════════


def test_list_findings_carries_the_detector_contract_and_the_checks(ctx):
    result = CT.dispatch("list_findings", {"period": "p-dec"}, ctx)
    assert result.notes and "detector check(s) ran" in result.notes[0]
    for row in result.rows:
        if row.kind != "finding":
            continue
        # Surfaced rows only, with their own figures and units intact.
        assert row.fields.get("surfaced") is True
        assert row.fields.get("facts_cited")
        assert row.fields.get("contract_elements")


def test_list_findings_without_statements_is_a_gap(ctx, pack):
    period = _period(pack, DEC_ROWS, period_id="p-nostm", label="Bare 2024",
                     with_detail=False)
    ctx2 = CT.CapsuleContext(entity_id="org-1", periods=(period,))
    result = CT.dispatch("list_findings", {"period": "p-nostm"}, ctx2)
    assert result.rows == ()
    assert result.gaps[0].code == CT.GAP_NO_SERVED_STATEMENT


def test_dispatch_rejects_unknown_and_missing_arguments(ctx):
    unknown = CT.dispatch("get_facts",
                          {"metric": "total_assets", "sql": "drop table"}, ctx)
    assert unknown.gaps[0].code == CT.GAP_BAD_ARGUMENTS
    assert unknown.gaps[0].missing == ("sql",)

    missing = CT.dispatch("get_account", {"period": "p-dec"}, ctx)
    assert missing.gaps[0].code == CT.GAP_BAD_ARGUMENTS
    assert missing.gaps[0].missing == ("code",)


def test_dispatch_turns_an_unexpected_failure_into_a_calm_gap(ctx, monkeypatch):
    """A2 in the tool layer: no raw payload, no stack trace — one typed
    refusal the surface can render calmly."""
    def _boom(ctx, **kwargs):  # noqa: ANN001 — tool signature
        raise RuntimeError("internal detail nobody should read: token=abc123")

    rogue = dict(CT.TOOL_REGISTRY)
    rogue["get_facts"] = CT.ToolSpec(
        name="get_facts", fn=_boom, description="",
        params=CT.TOOL_REGISTRY["get_facts"].params, returns="")
    monkeypatch.setattr(CT, "TOOL_REGISTRY", rogue)

    result = CT.dispatch("get_facts", {"metric": "total_assets"}, ctx)
    gap = result.gaps[0]
    assert gap.code == CT.GAP_TOOL_ERROR
    assert "token=abc123" not in json.dumps(gap.to_payload())


def test_results_are_deterministic_byte_for_byte(ctx):
    for tool, args in (
        ("get_facts", {"metric": "total_assets", "period": "p-dec"}),
        ("compare_periods", {"metrics": ["total_assets", "revenue"],
                             "p1": "p-nov", "p2": "p-dec"}),
        ("get_account", {"code": "5121", "period": "p-dec"}),
        ("list_findings", {"period": "p-dec"}),
        ("run_scenario_preview", {"drivers": [{"metric": "revenue",
                                               "mode": "pct", "value": 0.1}],
                                  "period": "p-dec"}),
    ):
        first = json.dumps(CT.dispatch(tool, dict(args), ctx).to_payload(),
                           sort_keys=True, ensure_ascii=False)
        second = json.dumps(CT.dispatch(tool, dict(args), ctx).to_payload(),
                            sort_keys=True, ensure_ascii=False)
        assert first == second, "%s is not deterministic" % tool


def test_the_tool_layer_imports_no_model_client():
    """No AI in any numeric path — asserted on the module source, not on
    a promise in a docstring."""
    source = (REPO / "src" / "engine" / "api" / "_capsule_tools.py").read_text(
        encoding="utf-8")
    for banned in ("import anthropic", "from anthropic", "openai",
                   "ai_analyzer", "ai_orchestrator"):
        assert banned not in source, "capsule tool layer references %r" % banned


def test_context_is_not_mutated_by_any_tool(ctx):
    before = copy.deepcopy(
        [(p.period_id, p.label, p.currency, len(p.accounts)) for p in ctx.periods])
    for tool, args in (
        ("get_facts", {"metric": "revenue", "period": "p-dec"}),
        ("get_account", {"code": "411", "period": "p-dec"}),
        ("list_findings", {"period": "p-dec"}),
        ("get_benchmark", {"peer_group": "food_manufacturing",
                           "metric": "ebitda_margin"}),
        ("search_help", {"topic": "upload"}),
    ):
        CT.dispatch(tool, args, ctx)
    after = [(p.period_id, p.label, p.currency, len(p.accounts))
             for p in ctx.periods]
    assert before == after
