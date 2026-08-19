"""FACTS GATEWAY invariants (sv1) — engine.serving.facts + status.

The gateway is the ONE typed reader of served balance-sheet truth; these
tests lock its contract against the REAL production composition (the
same TB → parse → assemble → auto-reconcile → serve chain
test_reconciliation.py exercises — its fixture builders are reused, not
mirrored):

  I2 — BALANCED serving: gateway totals == canonical totals EXACTLY, in
       integer cents; raw == adjusted on every concept.
  I3 — RECONCILED servings (one balance_sheet-placed, one pnl-placed,
       built via the real reconcile machinery on synthetic envelopes):
       gateway == the ADJUSTED figures; every raw_*() accessor still
       returns the UNCHANGED source cents.
  I4 — engine half of the status contract: present_status NEVER yields
       a 'balanced'-family display (EN "balanc*" / RO "echilibr*") for
       machine RECONCILED, and the API serialization path
       (_apply_envelope_truth_to_statements → statements.canonical_bs
       .status_presentation) uses present_status's output verbatim.

Plus the surrounding sv1 contract: the intentional valuation-equity fix
(_rebuild_assembled completes equity from the ADJUSTED gateway figure),
the briefing grand-totals helper, the additive-only serve guard (unit +
wired into served_canonical_bs), the legacy methodology tier, and the
raw_* accessor CI boundary (no engine callers outside audit surfaces).
"""

from __future__ import annotations

import copy
import importlib.util
import re
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

from engine.api import _reconcile
from engine.serving import (
    ENVELOPE_VERSION,
    AdditiveServeViolation,
    FactsGateway,
    MissingFactError,
    additive_serve_violations,
    assert_additive_serve,
    present_status,
)
from engine.serving.status import SURFACES

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


# Reuse test_reconciliation's REAL-composition fixture builders (TB rows
# → parse shape → attach_closing_result → assemble_parsed_tb → provenance
# stamp) — one source of truth for how production envelopes are made.
_trec = _load_by_path(
    "reconciliation_fixture_builders",
    Path(__file__).resolve().parent / "test_reconciliation.py",
)
_row = _trec._row
_envelope_for = _trec._envelope_for
ROUNDING_ROWS = _trec.ROUNDING_ROWS
CONTENT_HASH = _trec.CONTENT_HASH


def _cents(value: Any) -> int:
    return int(round(float(value or 0) * 100))


BALANCED_ROWS = [
    _row("212", sf_d=2500.00),    # buildings → non_current_assets
    _row("5121", sf_d=1000.00),   # bank → current_assets
    _row("1012", sf_c=3000.00),   # share capital → equity
    _row("401", sf_c=500.00),     # trade payables → current_liabilities
]

PNL_INCOME_ROWS = [
    _row("5121", sf_d=1_000_777.77),
    _row("704", sf_c=200.00),
    _row("1012", sf_c=1_000_000.00),
]

PNL_EXPENSE_ROWS = [
    _row("5121", sf_d=1_000_000.00),
    _row("371", sf_d=500.00),
    _row("609", sf_d=200.00),
    _row("1012", sf_c=1_001_477.77),
]


def _mock_ai(monkeypatch, target_account: str, amount_cents: int) -> None:
    monkeypatch.setattr(
        _reconcile,
        "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": target_account,
            "amount_cents": amount_cents,
            "rationale": "test proposal",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )


@pytest.fixture()
def balanced_env(pack):
    return _envelope_for(pack, BALANCED_ROWS)


@pytest.fixture()
def reconciled_bs_env(pack):
    """ROUNDING_ROWS (1.60 RON drift) auto-reconciled — the
    balance_sheet-placed synthetic-row case (R1, no AI)."""
    env = _envelope_for(pack, ROUNDING_ROWS)
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "accepted"
    assert out["placement"] == "balance_sheet"
    return env

@pytest.fixture()
def reconciled_pnl_income_env(pack, monkeypatch):
    """+577.77 drift, class-7 cause (704) → pnl placement, income side."""
    env = _envelope_for(pack, PNL_INCOME_ROWS)
    _mock_ai(monkeypatch, "704", 57777)
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "accepted"
    assert out["placement"] == "pnl"
    return env


@pytest.fixture()
def reconciled_pnl_expense_env(pack, monkeypatch):
    """−777.77 drift, class-6 cause (609) → pnl placement, expense side."""
    env = _envelope_for(pack, PNL_EXPENSE_ROWS)
    _mock_ai(monkeypatch, "609", -77777)
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "accepted"
    assert out["placement"] == "pnl"
    return env


# ── I2 — BALANCED: gateway == canonical totals, exact integer cents ────


def test_i2_balanced_gateway_equals_canonical_totals_exactly(balanced_env):
    cbs = balanced_env["canonical_bs"]
    assert cbs["status"] == "BALANCED"
    totals = cbs["totals"]

    gw = FactsGateway.from_envelope(balanced_env)
    assert gw is not None and gw.tier == FactsGateway.TIER_CANONICAL

    pairs = [
        (gw.total_assets, "assets"),
        (gw.equity, "equity"),
        (gw.total_liabilities, "liabilities"),
        (gw.equity_plus_liabilities, "equity_plus_liabilities"),
        (gw.current_assets, "current_assets"),
        (gw.current_liabilities, "current_liabilities"),
    ]
    for accessor, key in pairs:
        fact = accessor()
        assert type(fact.amount_minor) is int  # integer minor units, never bool/float
        assert fact.amount_minor == _cents(totals[key]), key
        assert fact.currency == "RON"
        assert fact.provenance == {"snapshot_id": CONTENT_HASH, "line_id": None}

    assert gw.difference().amount_minor == 0
    assert gw.working_capital().amount_minor == _cents(totals["current_assets"]) - _cents(totals["current_liabilities"])
    assert gw.net_result().amount_minor == 0  # no result row on this TB

    # BALANCED ⇒ raw == adjusted on every concept.
    assert gw.raw_total_assets().amount_minor == gw.total_assets().amount_minor
    assert gw.raw_equity().amount_minor == gw.equity().amount_minor
    assert gw.raw_total_liabilities().amount_minor == gw.total_liabilities().amount_minor
    assert gw.raw_equity_plus_liabilities().amount_minor == gw.equity_plus_liabilities().amount_minor
    assert gw.raw_current_assets().amount_minor == gw.current_assets().amount_minor
    assert gw.raw_current_liabilities().amount_minor == gw.current_liabilities().amount_minor
    assert gw.raw_difference().amount_minor == 0
    assert gw.raw_net_result().amount_minor == 0


def test_i2_statement_line_and_section_subtotal(balanced_env):
    gw = FactsGateway.from_envelope(balanced_env)
    served = gw.served_canonical_bs
    for row in served["rows"]:
        fact = gw.statement_line(row["id"])
        assert fact.amount_minor == _cents(row["amount"])
        assert fact.provenance["line_id"] == row["id"]
    for section in served["sections"]:
        fact = gw.section_subtotal(section["id"])
        assert fact.amount_minor == _cents(section["subtotal"])
        assert fact.provenance["line_id"] == section["id"]
    with pytest.raises(MissingFactError):
        gw.statement_line("no_such_row")
    with pytest.raises(MissingFactError):
        gw.section_subtotal("no_such_section")


# ── I3 — RECONCILED (balance_sheet placement) ──────────────────────────


def test_i3_bs_placed_gateway_is_adjusted_raw_is_source(reconciled_bs_env):
    env = reconciled_bs_env
    raw_cbs = env["canonical_bs"]
    # Persisted source cents are untouched by the reconciliation.
    assert raw_cbs["status"] == "MINOR_DRIFT"
    assert raw_cbs["difference"] == 1.60

    gw = FactsGateway.from_envelope(env)
    served = gw.served_canonical_bs
    assert served["status"] == "RECONCILED"

    # Adjusted == the served figures (E+L side gained the 1.60 line).
    assert gw.difference().amount_minor == 0
    assert gw.total_assets().amount_minor == _cents(raw_cbs["totals"]["assets"])
    assert gw.total_liabilities().amount_minor == _cents(raw_cbs["totals"]["liabilities"]) + 160
    assert gw.current_liabilities().amount_minor == _cents(raw_cbs["totals"]["current_liabilities"]) + 160
    assert gw.equity().amount_minor == _cents(raw_cbs["totals"]["equity"])  # BS placement: equity untouched
    assert gw.equity_plus_liabilities().amount_minor == gw.total_assets().amount_minor
    # The visible synthetic line is a served row the gateway can address.
    assert gw.statement_line(_reconcile.SYNTHETIC_ROW_ID).amount_minor == 160
    assert gw.section_subtotal("current_liabilities").amount_minor == _cents(raw_cbs["totals"]["current_liabilities"]) + 160

    # raw_*() == source cents unchanged.
    assert gw.raw_total_assets().amount_minor == _cents(raw_cbs["totals"]["assets"])
    assert gw.raw_total_liabilities().amount_minor == _cents(raw_cbs["totals"]["liabilities"])
    assert gw.raw_current_liabilities().amount_minor == _cents(raw_cbs["totals"]["current_liabilities"])
    assert gw.raw_equity().amount_minor == _cents(raw_cbs["totals"]["equity"])
    assert gw.raw_difference().amount_minor == 160


# ── I3 — RECONCILED (pnl placement, both sides) ────────────────────────


def test_i3_pnl_income_placed_adjusted_vs_raw(reconciled_pnl_income_env):
    env = reconciled_pnl_income_env
    raw_cbs = env["canonical_bs"]
    assert raw_cbs["difference"] == 577.77
    raw_equity_cents = _cents(raw_cbs["totals"]["equity"])          # 1,000,200.00
    raw_revenue_cents = _cents(env["methodology"]["totals"]["revenue_net"])  # 200.00
    raw_ebitda_cents = _cents(env["methodology"]["ebitda"]["reported"])

    gw = FactsGateway.from_envelope(env)
    assert gw.served_canonical_bs["status"] == "RECONCILED"

    # pnl placement reaches equity THROUGH the result row…
    assert gw.equity().amount_minor == raw_equity_cents + 57777
    assert gw.net_result().amount_minor == 20000 + 57777
    # …and the revenue side (pl_other_income) + EBITDA include the delta.
    assert gw.revenue().amount_minor == raw_revenue_cents + 57777
    assert gw.ebitda().amount_minor == raw_ebitda_cents + 57777
    # expenses = revenue − net_result: unchanged by an income-side delta.
    assert gw.expenses().amount_minor == (raw_revenue_cents + 57777) - (20000 + 57777)
    # Assets untouched; statement closes exactly.
    assert gw.total_assets().amount_minor == _cents(raw_cbs["totals"]["assets"])
    assert gw.difference().amount_minor == 0

    # raw_*() == source cents unchanged.
    assert gw.raw_equity().amount_minor == raw_equity_cents
    assert gw.raw_net_result().amount_minor == 20000
    assert gw.raw_difference().amount_minor == 57777


def test_i3_pnl_expense_placed_adjusted_vs_raw(reconciled_pnl_expense_env):
    env = reconciled_pnl_expense_env
    raw_cbs = env["canonical_bs"]
    assert raw_cbs["difference"] == -777.77
    raw_equity_cents = _cents(raw_cbs["totals"]["equity"])
    raw_revenue_cents = _cents(env["methodology"]["totals"]["revenue_net"])

    gw = FactsGateway.from_envelope(env)
    assert gw.served_canonical_bs["status"] == "RECONCILED"

    # Expense side: equity + result SHRINK by 777.77; revenue unchanged;
    # expenses (revenue − net_result) grow by 777.77.
    assert gw.equity().amount_minor == raw_equity_cents - 77777
    assert gw.net_result().amount_minor == -20000 - 77777
    assert gw.revenue().amount_minor == raw_revenue_cents
    assert gw.expenses().amount_minor == raw_revenue_cents - (-20000 - 77777)
    assert gw.difference().amount_minor == 0

    assert gw.raw_equity().amount_minor == raw_equity_cents
    assert gw.raw_net_result().amount_minor == -20000
    assert gw.raw_difference().amount_minor == -77777


# ── I4 — RECONCILED never presents as a 'balanced'-family display ──────

_BALANCED_FAMILY = ("balanc", "echilibr")


def _assert_not_balanced_family(presentation: Dict[str, Any]) -> None:
    for key in ("display_key", "display_en", "display_ro"):
        low = str(presentation[key]).lower()
        for marker in _BALANCED_FAMILY:
            assert marker not in low, (key, presentation[key])


def test_i4_present_status_reconciled_is_never_balanced_family(reconciled_bs_env):
    served = _reconcile.served_canonical_bs(reconciled_bs_env)
    assert served["status"] == "RECONCILED"
    for surface in SURFACES:
        p = present_status(served, surface=surface)
        assert p["machine"] == "RECONCILED"
        _assert_not_balanced_family(p)
        # The adjustment is disclosed, not hidden behind a green label.
        assert p["micro_caption"] == "auto-adjusted 1.60"


def test_i4_api_serialization_path_uses_the_presenter(reconciled_bs_env, reconciled_pnl_income_env):
    """The REAL serve hook (/api/period + briefing rebuild) must carry
    present_status's output verbatim on statements.canonical_bs."""
    from engine.api.pipeline import _apply_envelope_truth_to_statements

    for env in (reconciled_bs_env, reconciled_pnl_income_env):
        statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {}}
        _apply_envelope_truth_to_statements(
            statements, {"assembled_canonical_v1": env}
        )
        cbs = statements["canonical_bs"]
        assert cbs["status"] == "RECONCILED"
        sp = cbs["status_presentation"]
        assert sp == present_status(cbs, surface="api")
        assert sp["machine"] == "RECONCILED"
        _assert_not_balanced_family(sp)
        assert cbs["envelope_version"] == ENVELOPE_VERSION == "sv1"


def test_i4_other_statuses_present_their_own_band(balanced_env, pack, monkeypatch):
    served = _reconcile.served_canonical_bs(balanced_env)
    p = present_status(served)
    assert p["machine"] == "BALANCED"
    assert p["display_en"] == "Balanced"
    assert p["micro_caption"] is None

    # MINOR_DRIFT + needs_review boolean → "needs review" caption.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "anthropic", None)
    env = _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),
        _row("4282", sf_d=200.00),
        _row("1012", sf_c=999_722.23),
    ])
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "needs_review"
    served = _reconcile.served_canonical_bs(env)
    p = served["status_presentation"]
    assert p["machine"] == "MINOR_DRIFT"
    assert p["micro_caption"] == "needs review"


# ── THE intentional fix — valuation equity completion is ADJUSTED ──────


def _equity_completion_line_items():
    return [{
        "statement": "BS", "bucket": "shareCapital",
        "ro_account_code": "1012", "ro_account_name": "Capital subscris vărsat",
        "amount": 1_000_000.0, "is_derived": False,
    }]


def test_valuation_equity_completion_uses_adjusted_equity(reconciled_pnl_income_env):
    """pipeline._rebuild_assembled (the POST/DELETE /valuation-assumptions
    + POST /valuation/recompute rebuild) completes bucket equity to the
    gateway's ADJUSTED equity — previously the RAW persisted
    canonical_bs totals (pre-reconciliation) leaked into the Valuation
    tab. THE one intentional number change of the sv1 effort."""
    from engine.api.pipeline import _rebuild_assembled

    env = reconciled_pnl_income_env
    period = {"assembled_canonical_v1": env}
    assembled = _rebuild_assembled(_equity_completion_line_items(), period)

    bs = assembled["balanceSheet"]
    bucket_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    gw = FactsGateway.from_envelope(env)
    adjusted = round(gw.equity().to_float(), 2)      # 1,000,777.77
    raw = round(gw.raw_equity().to_float(), 2)       # 1,000,200.00
    assert adjusted != raw
    assert round(bucket_equity, 2) == adjusted
    assert round(bucket_equity, 2) != raw


def test_valuation_equity_completion_unchanged_on_balanced(balanced_env):
    """BALANCED periods: adjusted == raw ⇒ zero number change."""
    from engine.api.pipeline import _rebuild_assembled

    period = {"assembled_canonical_v1": balanced_env}
    assembled = _rebuild_assembled(_equity_completion_line_items(), period)
    bs = assembled["balanceSheet"]
    bucket_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    assert round(bucket_equity, 2) == round(
        FactsGateway.from_envelope(balanced_env).equity().to_float(), 2
    ) == 3000.00


# ── Briefing grand totals — write-time == served truth ─────────────────


def test_briefing_grand_totals_write_time_uses_gateway(reconciled_bs_env):
    from engine.api.pipeline import _briefing_grand_totals

    builder_fresh = {
        "total_assets": 4000.0, "total_equity": 2000.0,
        "total_liabilities": 1998.40, "bs_balance_delta": 1.60,
    }
    # WRITE-TIME shape: the envelope rides at assembled's top level
    # (stage_persist mutated it in place before stage_narrate runs).
    assembled = {"assembled_canonical_v1": reconciled_bs_env, "statements": {}}
    out = _briefing_grand_totals(assembled, builder_fresh)
    assert out == {
        "total_assets": 4000.0, "total_equity": 2000.0,
        "total_liabilities": 2000.0, "bs_balance_delta": 0.0,
    }

    # REGENERATE shape: no top-level envelope — bs_canonical already
    # carries the served truth (landed by the serve hook); passthrough.
    served_landed = {
        "total_assets": 4000.0, "total_equity": 2000.0,
        "total_liabilities": 2000.0, "bs_balance_delta": 0.0,
    }
    assert _briefing_grand_totals({"statements": {}}, served_landed) == served_landed


# ── Legacy methodology tier ────────────────────────────────────────────


def test_legacy_methodology_tier_totals_and_missing_facts():
    env = {
        "provenance": {"content_hash": "legacy-hash"},
        "methodology": {"totals": {
            "total_assets": 100.50, "total_liabilities": 40.25, "total_equity": 60.00,
        }},
    }
    gw = FactsGateway.from_envelope(env)
    assert gw is not None and gw.tier == FactsGateway.TIER_METHODOLOGY
    assert gw.served_canonical_bs is None
    assert gw.total_assets().amount_minor == 10050
    assert gw.equity().amount_minor == 6000
    assert gw.total_liabilities().amount_minor == 4025
    assert gw.equity_plus_liabilities().amount_minor == 10025
    assert gw.difference().amount_minor == 25
    # Legacy periods predate reconciliation: raw == adjusted.
    assert gw.raw_equity().amount_minor == gw.equity().amount_minor
    assert gw.raw_difference().amount_minor == 25
    for accessor in (gw.current_assets, gw.current_liabilities,
                     gw.working_capital, gw.net_result, gw.raw_net_result):
        with pytest.raises(MissingFactError):
            accessor()
    with pytest.raises(MissingFactError):
        gw.statement_line("cash_operating")
    with pytest.raises(MissingFactError):
        gw.section_subtotal("equity")


def test_from_envelope_returns_none_without_any_authority():
    assert FactsGateway.from_envelope(None) is None
    assert FactsGateway.from_envelope({}) is None
    assert FactsGateway.from_envelope({"methodology": {"totals": {"total_assets": 1.0}}}) is None


def test_apply_envelope_truth_legacy_tier_overrides_assembled_bs():
    from engine.api.pipeline import _apply_envelope_truth_to_statements

    period = {"assembled_canonical_v1": {
        "methodology": {"totals": {
            "total_assets": 100.50, "total_liabilities": 40.25,
            "total_equity": 60.00, "current_assets": 30.00,
            "current_liabilities": 10.00,
        }},
    }}
    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {}}
    _apply_envelope_truth_to_statements(statements, period)
    assert "canonical_bs" not in statements
    a_bs = statements["assembled_bs"]
    assert a_bs["total_assets"] == 100.50
    assert a_bs["total_equity"] == 60.00
    assert a_bs["total_liabilities"] == 40.25
    assert a_bs["bs_balance_delta"] == 0.25
    assert a_bs["total_current_assets"] == 30.00
    assert a_bs["total_non_current_assets"] == 70.50
    assert a_bs["total_current_liabilities"] == 10.00
    assert a_bs["total_non_current_liabilities"] == 30.25


# ── ADDITIVE-ONLY serve guard ──────────────────────────────────────────


def test_additive_guard_allows_adds_and_type_stable_updates():
    before = {"status": "MINOR_DRIFT", "difference": 1.6,
              "totals": {"assets": 10.0}, "rows": [{"id": "a"}],
              "opening": None}
    after = {"status": "RECONCILED", "difference": 0.0,
             "totals": {"assets": 10.0, "extra": 1.0}, "rows": [{"id": "a"}, {"id": "b"}],
             "opening": 3.0,               # null-before wildcard
             "needs_review": False,        # documented boolean stamp (add)
             "envelope_version": "sv1"}
    assert additive_serve_violations(before, after) == []
    assert_additive_serve(before, after)  # must not raise


def test_additive_guard_flags_removal_and_retype():
    before = {"diagnosis": [], "difference": 1.6, "needs_review": [{"code": "466"}]}
    removed = {"difference": 1.6, "needs_review": [{"code": "466"}]}
    violations = additive_serve_violations(before, removed)
    assert violations == ["$.diagnosis: removed by serve mutation"]

    # The array-preserve guard: AI-lane needs_review array → boolean is a RETYPE.
    retyped = {"diagnosis": [], "difference": 1.6, "needs_review": False}
    violations = additive_serve_violations(before, retyped)
    assert violations == ["$.needs_review: retyped array -> boolean by serve mutation"]

    nested_before = {"totals": {"assets": 1.0, "equity": 2.0}}
    nested_after = {"totals": {"assets": "1.0", "equity": 2.0}}
    assert additive_serve_violations(nested_before, nested_after) == [
        "$.totals.assets: retyped number -> string by serve mutation"
    ]
    with pytest.raises(AdditiveServeViolation):
        assert_additive_serve(before, retyped)


def test_serve_guard_wired_falls_back_to_unmutated_serving(reconciled_bs_env, monkeypatch, caplog):
    """If a future serve mutation drops a pipeline field, serving falls
    back to the UNMUTATED persisted object (stamps only) and logs loudly
    — it never ships a payload that lost pipeline truth."""
    original = _reconcile._apply_adjustment

    def bad_apply(served, amount_cents, receipt, placement=_reconcile.PLACEMENT_BS):
        out = original(served, amount_cents, receipt, placement=placement)
        out.pop("diagnosis", None)  # simulate a field-dropping serve bug
        return out

    monkeypatch.setattr(_reconcile, "_apply_adjustment", bad_apply)
    with caplog.at_level("ERROR", logger="engine.api.reconcile"):
        served = _reconcile.served_canonical_bs(reconciled_bs_env)
    assert any("ADDITIVE-ONLY SERVE GUARD" in r.message for r in caplog.records)
    # Fallback = honest raw serving with the sv1 stamps.
    assert served["status"] == "MINOR_DRIFT"
    assert served["difference"] == 1.60
    assert "diagnosis" in served
    assert served["envelope_version"] == "sv1"
    assert served["status_presentation"]["machine"] == "MINOR_DRIFT"


# ── raw_* accessor CI boundary — audit surfaces only ───────────────────

# Files under src/engine/ permitted to call gateway raw_*() accessors.
# Audit/receipt/undo surfaces only (per the facts.py module docstring);
# currently NONE — _reconcile builds receipts from its own cents flow.
_RAW_CALLER_ALLOWLIST: frozenset = frozenset()

_RAW_CALL_RE = re.compile(
    r"\.raw_(?:total_assets|total_liabilities|equity|equity_plus_liabilities"
    r"|current_assets|current_liabilities|difference|net_result)\s*\("
)


def test_raw_accessors_have_no_unsanctioned_engine_callers():
    engine_root = REPO / "src" / "engine"
    serving_root = engine_root / "serving"
    offenders = []
    for py_file in sorted(engine_root.rglob("*.py")):
        try:
            py_file.relative_to(serving_root)
            continue  # the gateway itself
        except ValueError:
            pass
        rel = py_file.relative_to(REPO).as_posix()
        if rel in _RAW_CALLER_ALLOWLIST:
            continue
        for lineno, line in enumerate(
            py_file.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if _RAW_CALL_RE.search(line):
                offenders.append("%s:%d: %s" % (rel, lineno, line.strip()))
    assert offenders == [], (
        "gateway raw_*() accessors are reserved for audit/receipt/undo "
        "surfaces (see src/engine/serving/facts.py docstring):\n"
        + "\n".join(offenders)
    )


# ── Serving stability with the sv1 stamps ──────────────────────────────


def test_serving_stays_byte_identical_with_stamps(reconciled_pnl_income_env):
    import json

    env = copy.deepcopy(reconciled_pnl_income_env)
    dumps = [
        json.dumps(_reconcile.served_canonical_bs(env), sort_keys=True, ensure_ascii=False)
        for _ in range(3)
    ]
    assert dumps[0] == dumps[1] == dumps[2]
