"""PUBLIC_SUMMARY through the gateway — PS1 / PS2 / PS5 serving tests.

The public-data acquisition engine serves reduced open-data filings
(data.gov.ro bilant indicators) as a NEW top-level envelope kind:
``envelope["public_summary"]`` (version "ps1") — never through
canonical_bs, never through MACHINE_STATUSES, never through reconcile /
consensus / AI (PS1 structural refusals, PS2 no-AI tripwire).

The gateway grows a THIRD tier (TIER_SUMMARY): whole-RON integer
indicators (I1..I20, per the verified FY2019-FY2025 stable layout)
served as strict integer-cent Facts. Account-level detail that a
summary can never carry (DSO / DIO / CCC / working capital) is refused
with a typed :class:`LockedRatio` (PS5) — a paywall refusal distinct
from :class:`MissingFactError` (data absent), never carrying a number.
"""
from __future__ import annotations

import contextlib
import copy
import os
import sys
from typing import Any, Dict, Iterator, List
from unittest import mock

import pytest

from engine.api import _reconcile
from engine.api import pipeline as _pipeline
from engine.serving import (
    MACHINE_STATUSES,
    FactsGateway,
    Fact,
    LockedRatio,
    MissingFactError,
    present_public_summary,
)
from engine.serving import facts as _facts_mod


# ── Fixture: one synthetic ps1 envelope (PJ company, FY2024 layout) ────

_INDICATORS = {
    # VERIFIED stable layout FY2019-FY2025 (data.gov.ro WEB_UU_AN<yr>):
    # I1 Active imobilizate, I2 Active circulante, I6 Chelt. in avans,
    # I7 DATORII, I10 CAPITALURI TOTAL, I13 Cifra de afaceri neta,
    # I18 Profit net, I19 Pierdere neta, I20 Numar mediu salariati.
    "I1": 1_000_000,
    "I2": 2_500_000,
    "I3": 400_000,
    "I4": 900_000,
    "I5": 700_000,
    "I6": 50_000,
    "I7": 1_200_000,
    "I8": 30_000,
    "I9": 20_000,
    "I10": 2_300_000,
    "I11": 200,
    "I13": 5_400_000,
    "I14": 5_600_000,
    "I15": 5_100_000,
    "I16": 500_000,
    "I17": 0,
    "I18": 420_000,
    "I19": 0,
    "I20": 37,
}


def _ps_envelope(**overrides: Any) -> Dict[str, Any]:
    indicators = dict(_INDICATORS)
    indicators.update(overrides.pop("indicators", {}))
    summary: Dict[str, Any] = {
        "version": "ps1",
        "cui": 12345678,
        "year": 2024,
        "dataset_version": "situatii_financiare_2024",
        "status": "PUBLIC_SUMMARY",
        "indicators": indicators,
        "derived": {
            # Active totale = I1 + I2 + I6 (computed at build time).
            "total_assets": indicators.get("I1", 0)
            + indicators.get("I2", 0)
            + indicators.get("I6", 0),
            "net_result": indicators.get("I18", 0) - indicators.get("I19", 0),
        },
        "provenance": {
            "source": "data.gov.ro/mfp",
            "dataset_version": "situatii_financiare_2024",
            "fetch_date": "2026-08-01",
            "cui": 12345678,
            "year": 2024,
            "content_hash": "ps-hash-abc123",
        },
    }
    summary.update(overrides)
    return {"public_summary": summary}


# ── PS: the summary tier ───────────────────────────────────────────────


def test_from_envelope_builds_summary_tier():
    gw = FactsGateway.from_envelope(_ps_envelope())
    assert gw is not None
    assert gw.tier == FactsGateway.TIER_SUMMARY == "public_summary"


def test_summary_totals_are_strict_whole_ron_cents():
    gw = FactsGateway.from_envelope(_ps_envelope())
    # THE corpus contract: equity / total_assets / net_result must all
    # answer as Facts (corpus_replay._gateway_facts calls them
    # unconditionally on every case).
    assert isinstance(gw.equity(), Fact)
    assert gw.equity().amount_minor == 2_300_000 * 100  # I10 CAPITALURI TOTAL
    assert gw.total_assets().amount_minor == (1_000_000 + 2_500_000 + 50_000) * 100
    assert gw.total_liabilities().amount_minor == 1_200_000 * 100  # I7
    assert gw.net_result().amount_minor == 420_000 * 100  # I18 - I19
    assert gw.revenue().amount_minor == 5_400_000 * 100  # I13
    assert gw.equity().currency == "RON"


def test_summary_snapshot_id_comes_from_ps_provenance():
    gw = FactsGateway.from_envelope(_ps_envelope())
    assert gw.equity().provenance["snapshot_id"] == "ps-hash-abc123"


def test_summary_probe_precedes_canonical_probe():
    """An envelope that (illegally) carries BOTH blocks resolves to the
    summary tier — public data can never be dressed up as a served BS."""
    env = _ps_envelope()
    env["canonical_bs"] = {
        "schema": "bs_v2",
        "status": "BALANCED",
        "difference": 0,
        "totals": {"assets": 1.0, "equity": 1.0, "liabilities": 0.0},
        "rows": [],
        "sections": [],
    }
    gw = FactsGateway.from_envelope(env)
    assert gw is not None and gw.tier == FactsGateway.TIER_SUMMARY


def test_employees_is_a_plain_int_not_money():
    gw = FactsGateway.from_envelope(_ps_envelope())
    n = gw.employees()
    assert n == 37 and type(n) is int
    assert not isinstance(n, Fact)


def test_strings_are_refused_never_swallowed_to_zero():
    # data.gov.ro values must be parsed upstream; the gateway REFUSES a
    # non-int rather than the _cents() swallow-to-0 behavior.
    gw = FactsGateway.from_envelope(
        _ps_envelope(indicators={"I13": "5.400.000"})
    )
    with pytest.raises(MissingFactError):
        gw.revenue()
    gw2 = FactsGateway.from_envelope(_ps_envelope(indicators={"I10": True}))
    with pytest.raises(MissingFactError):
        gw2.equity()


def test_absent_indicators_refuse_rather_than_fabricate():
    ind = dict(_INDICATORS)
    for key in ("I13", "I18", "I19"):
        ind.pop(key, None)
    env = _ps_envelope()
    env["public_summary"]["indicators"] = ind
    env["public_summary"]["derived"] = {}
    gw = FactsGateway.from_envelope(env)
    with pytest.raises(MissingFactError):
        gw.revenue()
    with pytest.raises(MissingFactError):
        gw.net_result()  # BOTH result columns absent -> refuse, not 0


def test_loss_year_net_result_is_negative():
    gw = FactsGateway.from_envelope(
        _ps_envelope(
            indicators={"I18": 0, "I19": 150_000},
            derived={"total_assets": 3_550_000, "net_result": -150_000},
        )
    )
    assert gw.net_result().amount_minor == -150_000 * 100


def test_summary_never_claims_equity_plus_liabilities_identity():
    """I10 + I7 omits I8 (venituri in avans) and I9 (provizioane) — the
    gateway must not mint a fake balance identity / difference."""
    gw = FactsGateway.from_envelope(_ps_envelope())
    with pytest.raises(MissingFactError):
        gw.equity_plus_liabilities()
    with pytest.raises(MissingFactError):
        gw.difference()


def test_private_snapshot_fields_covers_summary_state():
    assert "_summary_indicators" in _facts_mod.PRIVATE_SNAPSHOT_FIELDS


# ── PS5: LockedRatio ───────────────────────────────────────────────────


def test_locked_ratio_refusals_on_summary_tier():
    gw = FactsGateway.from_envelope(_ps_envelope())
    for accessor in (gw.dso, gw.dio, gw.ccc, gw.working_capital):
        locked = accessor()
        assert isinstance(locked, LockedRatio)
        assert locked.locked is True
        assert locked.reason == "needs_trial_balance"
        assert locked.ratio_id
        assert locked.upsell_key
        # Never any numeric value inside a locked refusal.
        assert not any(
            isinstance(getattr(locked, f), (int, float)) and f != "locked"
            for f in getattr(locked, "__dataclass_fields__", {})
        )


def test_locked_ratios_lists_the_summary_refusals():
    gw = FactsGateway.from_envelope(_ps_envelope())
    ids = [r.ratio_id for r in gw.locked_ratios()]
    assert ids == ["dso", "dio", "ccc", "working_capital"]
    assert all(isinstance(r, LockedRatio) for r in gw.locked_ratios())


def test_locked_ratio_is_frozen():
    gw = FactsGateway.from_envelope(_ps_envelope())
    locked = gw.dso()
    with pytest.raises(Exception):
        locked.reason = "other"  # type: ignore[misc]


def test_non_summary_tiers_keep_todays_refusal_vocabulary():
    """On the legacy methodology tier the new accessors refuse with
    MissingFactError (data absent), never a paywall LockedRatio; and
    locked_ratios() is empty — the upsell exists only where the value
    is genuinely gated, not missing."""
    env = {
        "methodology": {
            "totals": {
                "total_assets": 100.0,
                "total_liabilities": 40.0,
                "total_equity": 60.0,
            }
        }
    }
    gw = FactsGateway.from_envelope(env)
    assert gw is not None and gw.tier == FactsGateway.TIER_METHODOLOGY
    assert gw.locked_ratios() == []
    for accessor in (gw.dso, gw.dio, gw.ccc, gw.working_capital):
        with pytest.raises(MissingFactError):
            accessor()


# ── present_public_summary (serving/public_summary.py) ─────────────────


def test_present_public_summary_shape_and_purity():
    env = _ps_envelope()
    before = copy.deepcopy(env)
    out = present_public_summary(env)
    assert out["status"] == "PUBLIC_SUMMARY"
    assert "Public filing data" in out["trust_en"]
    assert "summary level" in out["trust_en"]
    assert "data.gov.ro" in out["trust_en"] and "2024" in out["trust_en"]
    assert "nivel sumar" in out["trust_ro"]
    assert "data.gov.ro" in out["source_line"]
    assert out["license_line"]
    # Pure: no mutation, deterministic.
    assert env == before
    assert present_public_summary(env) == out


def test_present_public_summary_refuses_non_summary_envelopes():
    assert present_public_summary({"canonical_bs": {}}) is None
    assert present_public_summary(None) is None


# ── PS1: structural refusals ───────────────────────────────────────────


def test_machine_statuses_tuple_unchanged():
    assert MACHINE_STATUSES == (
        "BALANCED",
        "RECONCILED",
        "MINOR_DRIFT",
        "MATERIAL_IMBALANCE",
    )
    assert "PUBLIC_SUMMARY" not in MACHINE_STATUSES


def test_reconcile_status_gates_never_see_public_summary():
    # A public_summary envelope never yields a canonical serving at all —
    # the status ladder (and its gates) is unreachable by construction.
    assert _reconcile.served_canonical_bs(_ps_envelope()) is None


def test_is_public_summary_envelope_predicate():
    assert _reconcile.is_public_summary_envelope(_ps_envelope()) is True
    assert _reconcile.is_public_summary_envelope({"canonical_bs": {}}) is False
    assert _reconcile.is_public_summary_envelope(None) is False
    assert _reconcile.is_public_summary_envelope({"public_summary": "x"}) is False


def test_auto_reconcile_refuses_public_summary_first():
    outcome = _reconcile.auto_reconcile_envelope(_ps_envelope())
    assert outcome == {"outcome": "public_summary_refused"}


def test_auto_reconcile_refusal_is_named_not_incidental():
    """The refusal must survive someone attaching a canonical_bs-shaped
    block for convenience — the check is on the DOCUMENT CLASS, before
    the canonical_bs probe."""
    env = _ps_envelope()
    env["canonical_bs"] = {
        "schema": "bs_v2",
        "status": "MINOR_DRIFT",
        "difference": 10.0,
        "totals": {
            "assets": 100000.0,
            "equity": 60000.0,
            "liabilities": 39990.0,
            "equity_plus_liabilities": 99990.0,
        },
        "extraction": {"method": "deterministic"},
        "rows": [],
        "sections": [],
    }
    env["provenance"] = {"content_hash": "x" * 8}
    outcome = _reconcile.auto_reconcile_envelope(env)
    assert outcome == {"outcome": "public_summary_refused"}


def test_perform_reconcile_raises_public_summary_409():
    with pytest.raises(_reconcile.ReconcileRejected) as exc_info:
        _reconcile.perform_reconcile(_ps_envelope(), user_id="ops@test")
    payload = exc_info.value.payload
    assert payload["status"] == "rejected"
    codes = [d.get("code") for d in payload["diagnosis"]]
    assert "PUBLIC_SUMMARY" in codes


def test_serve_hook_skips_public_summary_envelopes():
    """pipeline._apply_envelope_truth_to_statements must never serve a
    public_summary envelope as BS truth — no canonical_bs, no
    assembled_bs total overrides."""
    statements: Dict[str, Any] = {"currency": "RON"}
    period = {"assembled_canonical_v1": _ps_envelope()}
    _pipeline._apply_envelope_truth_to_statements(statements, period)
    assert "canonical_bs" not in statements
    assert "assembled_bs" not in statements


# ── PS2: no-AI tripwire (the _ai_blocked sentinel, verbatim pattern) ───


@contextlib.contextmanager
def _ai_blocked() -> Iterator[List[int]]:
    """Copied from tests/engine/test_properties.py::_ai_blocked — the
    three-part model-quarantine sentinel: `_ai_propose` replaced by a
    recording raiser, the `anthropic` module made unimportable, and the
    env key stripped. `calls == []` proves the AI path was never
    entered."""
    calls: List[int] = []

    def _blocked(cbs: Any) -> Dict[str, Any]:
        calls.append(1)
        raise RuntimeError("AI blocked in public_summary suite — no live calls")

    with mock.patch.object(_reconcile, "_ai_propose", _blocked), \
            mock.patch.dict(sys.modules, {"anthropic": None}), \
            mock.patch.dict(os.environ):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        yield calls


def test_ps2_public_summary_never_consults_the_model():
    with _ai_blocked() as ai_calls:
        env = _ps_envelope()
        # Build + serve + gateway-read the full public_summary surface.
        presentation = present_public_summary(env)
        assert presentation is not None
        gw = FactsGateway.from_envelope(env)
        assert gw is not None
        gw.equity()
        gw.total_assets()
        gw.total_liabilities()
        gw.net_result()
        gw.revenue()
        gw.employees()
        gw.locked_ratios()
        # The persist-path refusals engage without ever reaching AI.
        assert _reconcile.auto_reconcile_envelope(env) == {
            "outcome": "public_summary_refused"
        }
        with pytest.raises(_reconcile.ReconcileRejected):
            _reconcile.perform_reconcile(env, user_id="ops@test")
    assert ai_calls == [], "the model was consulted on a public_summary case"
