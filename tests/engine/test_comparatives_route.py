"""The comparatives route's core and its tenant wall.

Two things are pinned here:

  THE WALL. Both period ids come from the browser. Each is loaded with the
  caller's organization IN THE FILTER (`financial_periods` by id AND
  org_id) — the standing rule for anything keyed by a caller-supplied id.
  A period in another workspace is not found; a period in ANOTHER of the
  caller's own workspaces is not found either, because the prior must be
  the same company's year.

  THE CORE, on real books: the served-payload shape in, a JSON-ready
  document out, whose bridges close and whose detail levels are the ones
  the pack detects.

WHAT THESE RED ON, with the route correct (TC-11):
  · `load_period_in_org` dropping `org_id` from the filter, or accepting
    a row whose org differs
  · the core producing anything json.dumps cannot serialise
  · the bridges no longer closing on the served-shape envelopes
  · the prior canonical rows losing their ids, so the balance-sheet
    opening column could no longer be paired
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from engine.api import _comparatives as C

from _comparatives_fixtures import pick_pair, served_payload

MINE = "11111111-1111-1111-1111-111111111111"
THEIRS = "22222222-2222-2222-2222-222222222222"


def _payload(env, period_id, period_end, org_id=MINE):
    """The `/api/period/{id}` shape: `statements` + `line_items` + `period`."""
    return served_payload(env, period_id, period_end)


def _row(period_id, period_end, org_id=MINE):
    return {"id": period_id, "org_id": org_id, "period_end": period_end,
            "period_start": period_end[:4] + "-01-01", "currency": "RON"}


class _Client:
    """Records every select so the test can read the FILTER back."""

    def __init__(self, rows):
        self._rows = rows
        self.selects = []

    def select(self, table, *, filters=None, columns="*", single=False, **_):
        self.selects.append((table, dict(filters or {})))
        if table != "financial_periods":
            return []
        want_id = (filters or {}).get("id", "").replace("eq.", "")
        want_org = (filters or {}).get("org_id", "").replace("eq.", "")
        return [r for r in self._rows
                if r["id"] == want_id and (not want_org or r["org_id"] == want_org)]


# ── the wall ───────────────────────────────────────────────────────────

def test_the_tenant_is_in_the_filter_not_in_an_earlier_guard():
    client = _Client([_row("p-cur", "2025-12-31")])
    C.load_period_in_org(client, "p-cur", org_id=MINE)
    table, filters = client.selects[-1]
    assert table == "financial_periods"
    assert filters.get("org_id") == "eq." + MINE, (
        "the organization is not in the filter: %r" % (filters,))
    assert filters.get("id") == "eq.p-cur"


def test_a_period_in_another_workspace_is_not_found():
    client = _Client([_row("p-theirs", "2024-12-31", org_id=THEIRS)])
    with pytest.raises(C.ComparativesRefused) as e:
        C.load_period_in_org(client, "p-theirs", org_id=MINE)
    assert e.value.code == "period_not_in_workspace"
    assert e.value.status == 404


def test_a_period_in_the_callers_other_workspace_is_not_found_either():
    """Two workspaces, one user. The prior must be the SAME company's
    year; a period the caller may read elsewhere is still not this
    workspace's."""
    other_of_mine = "33333333-3333-3333-3333-333333333333"
    client = _Client([_row("p-other", "2024-12-31", org_id=other_of_mine)])
    with pytest.raises(C.ComparativesRefused):
        C.load_period_in_org(client, "p-other", org_id=MINE)


def test_org_id_is_required_by_signature():
    client = _Client([_row("p-cur", "2025-12-31")])
    with pytest.raises(TypeError):
        C.load_period_in_org(client, "p-cur")  # type: ignore[call-arg]
    with pytest.raises(C.ComparativesRefused):
        C.load_period_in_org(client, "p-cur", org_id="")


# ── the core, on real books ────────────────────────────────────────────

_AN, _SY = pick_pair()
if _AN is None or _SY is None:
    pytest.skip("the corpus no longer carries both an analytic and a synthetic "
                "deterministic book", allow_module_level=True)
ANALYTIC = _AN[1]
SYNTHETIC = _SY[1]


def test_the_core_is_json_ready_and_its_bridges_close():
    cur = _payload(ANALYTIC, "p-cur", "2025-12-31")
    pri = _payload(SYNTHETIC, "p-pri", "2024-12-31")
    out = C.compare_payloads(cur, pri, current_row=_row("p-cur", "2025-12-31"),
                             prior_row=_row("p-pri", "2024-12-31"))
    text = json.dumps(out)  # raises on anything non-serialisable
    assert len(text) > 1000
    assert out["current"]["detail_level"]["level"] == "analytic"
    assert out["prior"]["detail_level"]["level"] == "synthetic"
    assert out["comparability"]["level"] == "synthetic"
    assert out["comparability"]["statement_lines"] is True
    assert out["comparability"]["analytic_detail"] is False
    for name in ("pl", "bs_assets", "bs_liabilities_equity"):
        assert out["bridges"][name]["closes"] is True, out["bridges"][name]["reason"]
    assert out["coverage_source"] == {"current": "line_items", "prior": "line_items"}
    assert out["prior_statements"] is pri["statements"] or out["prior_statements"] == pri["statements"]
    assert len(out["prior_line_items"]) == len(SYNTHETIC["lineItems"])


def test_the_document_is_deterministic():
    cur = _payload(ANALYTIC, "p-cur", "2025-12-31")
    pri = _payload(SYNTHETIC, "p-pri", "2024-12-31")
    a = json.dumps(C.compare_payloads(cur, pri, current_row=_row("p-cur", "2025-12-31"),
                                      prior_row=_row("p-pri", "2024-12-31")), sort_keys=True)
    b = json.dumps(C.compare_payloads(copy.deepcopy(cur), copy.deepcopy(pri),
                                      current_row=_row("p-cur", "2025-12-31"),
                                      prior_row=_row("p-pri", "2024-12-31")), sort_keys=True)
    assert a == b


def test_no_analytic_only_line_moves_against_the_synthetic_prior():
    cur = _payload(ANALYTIC, "p-cur", "2025-12-31")
    pri = _payload(SYNTHETIC, "p-pri", "2024-12-31")
    out = C.compare_payloads(cur, pri, current_row=_row("p-cur", "2025-12-31"),
                             prior_row=_row("p-pri", "2024-12-31"))
    analytic_cols = [c for c in out["columns"] if c["requires"] == "analytic"]
    assert analytic_cols, "the registry lost its analytic-only family"
    for c in analytic_cols:
        assert c["status"] == "not_disclosed_at_this_detail_level"
        assert c["delta"] is None and c["delta_pct"] is None


def test_prior_canonical_rows_are_keyed_by_id_when_present():
    pri_env = copy.deepcopy(SYNTHETIC)
    pri_env["statements"]["canonical_bs"] = {
        "schema": "bs_v2",
        "rows": [{"id": "cash", "section": "current_assets", "label": "Cash", "amount": 12.5,
                  "account_codes": ["512"], "opening": None},
                 {"id": "trade_receivables", "section": "current_assets", "label": "AR",
                  "amount": 100.0, "account_codes": ["411"], "opening": None}],
        "sections": [{"id": "current_assets", "subtotal": 112.5}],
        "totals": {"assets": 112.5, "equity_plus_liabilities": 112.5},
        "difference": 0.0,
        "status": "BALANCED",
    }
    out = C.compare_payloads(_payload(ANALYTIC, "p-cur", "2025-12-31"),
                             _payload(pri_env, "p-pri", "2024-12-31"),
                             current_row=_row("p-cur", "2025-12-31"),
                             prior_row=_row("p-pri", "2024-12-31"))
    pcb = out["prior_canonical_bs"]
    assert pcb["rows"]["cash"]["amount"] == 12.5
    assert pcb["rows"]["trade_receivables"]["section"] == "current_assets"
    assert pcb["sections"]["current_assets"] == 112.5
    # Totals come through the serving gateway, never the raw snapshot.
    assert "totals" not in pcb
    assert pcb["facts"] == {"assets": 112.5, "equity_plus_liabilities": 112.5}


def test_a_payload_without_statements_is_refused_not_compared():
    with pytest.raises(C.ComparativesRefused) as e:
        C.compare_payloads({"line_items": []}, _payload(SYNTHETIC, "p", "2024-12-31"),
                           current_row=_row("p-cur", "2025-12-31"),
                           prior_row=_row("p", "2024-12-31"))
    assert e.value.code == "period_not_servable" and e.value.status == 409


# ── the two-period ratio block rides the core (ratios B4) ──────────────

def test_the_core_serves_the_ratio_block_over_two_real_get_period_bodies():
    """The route calls get_period for both ids and hands both bodies to the
    core. Two REAL GET /api/period bodies (agras as the current year,
    retail as the prior; their persisted calculated_metrics are empty, as
    for any period the double has no rows for) — the served prior still
    carries its composite, scored from its own served statements.

    Reds AFTER the repair on: `ratios` missing from the core's output, the
    prior composite or letter missing although the prior's statements
    score, or the served prior composite differing from
    compute_period_metrics over the prior's served statements."""
    import _served_books as SB
    from engine.ratios.credit_model import compute_period_metrics

    cur, pri = SB.served_body("agras"), SB.served_body("retail")
    assert cur["metrics"] == [] and pri["metrics"] == []
    out = C.compare_payloads(cur, pri, current_row=_row("p-cur", "2025-12-31"),
                             prior_row=_row("p-pri", "2024-12-31"))
    ratios = out["ratios"]
    comps = {r["key"]: r for r in ratios["composites"]}
    want = {r["name"]: r["value"] for r in compute_period_metrics(copy.deepcopy(pri["statements"]))}
    assert comps["credit_composite"]["prior"]["value"] == want["credit_composite"]
    assert comps["letter_grade"]["prior"]["value_q"] is not None
    assert comps["altman_z"]["prior"]["value"] == want["altman_z_score"]
    assert ratios["stamps"]["prior"]["pack_provenance"] == pri["pack_provenance"]
    json.dumps(ratios, allow_nan=False)
