"""R1–R3 (+ provenance, the cap policy, materiality refusal, the marker,
the cache and the no-model law) — THE GATES RADAR IS ALLOWED TO SHIP
THROUGH.

Radar is the ONE source every findings surface renders. The failure
modes these gates exist for are all silent: a second source that drifts
from the first by a rounding — or by a whole envelope the route never
loaded; a Critical that vanishes under a cap because the ranker filed
it as a contributor of a lesser row; a dismissal that quietly deletes
the one finding that mattered; a figure that contradicts the served
envelope and is printed anyway; a payload that recomputes on every open
and calls itself cached. None of that raises. This file makes each of
them red.

    R1 ONE SOURCE     the route's rows and the Capsule's list_findings
                      rows are byte-identical for the same period —
                      THROUGH THEIR OWN LOADERS, over a client that
                      honours the projection; the engine's checks are
                      the route's checks, in order.
    R2 THE CAP        N+1 non-Criticals -> exactly N surface and the
                      demotion is recorded with its reason; N+1
                      Criticals -> ALL surface and the payload says the
                      cap was exceeded by Criticals; a Critical BURIED as
                      a merged contributor of a lesser primary is never
                      held; the statement counts Criticals below the
                      floor rather than claiming every Critical surfaces.
    R3 DISMISSAL      a dismissed Critical stays in `surfaced`, flagged,
                      reason shown — and so does a dismissed non-Critical
                      primary whose group carries a Critical; a dismissed
                      non-Critical moves to the checks with the reason;
                      scope is honoured.
    PROVENANCE        every money figure a row cites is verified through
                      a FactsGateway accessor or WITHHELD with the
                      reason; a figure that contradicts the gateway
                      refuses the row; net income is the gateway's
                      net_result — account 121; the snapshot id on the
                      payload is the gateway's content hash.
    CAP POLICY        read from the pack as DATA; absent -> the ranker's
                      default, and the policy says which.
    MATERIALITY       ABSENT is not ZERO — no basis, no verdict, a
                      "fired but not ranked" row with the reason.
    MARKER            `source: "radar"` on the payload and every row.
    INCREMENTAL       the same request twice runs the engine once.
    NO MODEL          no AI import reachable from the serving modules,
                      no clock read inside them.

Subjects are REAL ENGINE OUTPUT (TC-1): the committed captures under
tests/engine/fixtures/radar — the real pipeline's envelope + statements
for the corpus books through the SERVED seam (envelope on the row,
account 121 anchored), the real detector engine over them, and the real
Radar serving layer's own payload.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import dataclasses
import json
from pathlib import Path

import pytest
import yaml

from engine.api import _capsule_tools as CT
from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _finding_rank as R
from engine.api import _org
from engine.api import _radar as RT
from engine.api import _supabase
from engine.api.findings import s_engine
from engine.radar import cap as CAP
from engine.radar import explain as X
from engine.radar import serve as RS
from engine.serving import FactsGateway
from tests.engine.radar_fakes import ProjectingAdmin

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar"

#: Every committed capture. Listed so a fixture added to the directory
#: without being gated here is visible.
CASES = (
    "saga_10_col_carniprod",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
    "saga_10_col",
    "imbalance_03pct",
)

DISMISSED_AT = "2026-09-04T00:00:00+00:00"

#: The money facts the detectors cite for which `engine.serving.facts`
#: has NO accessor today. Radar WITHHOLDS them from its own citation
#: (the hand-off for the accessors is in SERVE_GATES.md); a name leaving
#: this set means an accessor landed and `RS.FACT_ACCESSORS` must map
#: it, and this census must be updated in the same commit.
WITHHELD_TODAY = frozenset(["cash", "total_cash", "net_debt", "bank_debt_total",
                            "affiliate_income"])


# ── shared helpers ───────────────────────────────────────────────────────


def fixture(case):
    with open(str(FIXTURES / (case + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


def content_hash(fx):
    return fx["envelope"]["provenance"]["content_hash"]


def target_of(case, fx, ordinal=0):
    """The target as the route hands it over: the content hash as the
    snapshot id, the source document under its own name."""
    return RS.PeriodInput(
        period_id="p-%s" % case, label="FY%s" % fx["period_end"][:4],
        period_end=fx["period_end"], period_start=fx["period_start"],
        ordinal=ordinal, currency=fx["currency"], statements=fx["statements"],
        envelope=fx["envelope"], snapshot_id=content_hash(fx),
        source_document_id="doc-%s" % case, content_key=content_hash(fx), caen=None)


def request_for(case, fx=None, **kwargs):
    fx = fx or fixture(case)
    return RS.RadarRequest(org_id="org-%s" % case, target=target_of(case, fx), **kwargs)


def rows_of(payload):
    return list(payload["surfaced"]) + list(payload["info"]) + list(payload["demoted"])


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


@pytest.fixture(scope="module")
def payloads():
    return dict((case, RS.serve_period(request_for(case))) for case in CASES)


@pytest.fixture(scope="module")
def critical_case(payloads):
    """The committed book that carries a CRITICAL surfaced finding. A
    census, not a hard-coded name: if no capture carries one the gate
    has nothing to prove and must say so."""
    for case in CASES:
        for row in payloads[case]["surfaced"]:
            if row["severity"] == "critical":
                return case, row
    pytest.fail("no committed Radar capture carries a surfaced CRITICAL finding — "
                "R3 has no subject")


def single_lane_surfaced(case, fx=None):
    """The single lane's ranked rows, uncapped, exactly as serve_period
    builds them before the cap."""
    fx = fx or fixture(case)
    target = target_of(case, fx)
    result = s_engine.run_single_period(
        target.statements, period_id=target.period_id, caen=None,
        snapshot_id=target.engine_snapshot_id())
    gateway = RS.gateway_for(target)
    basis = RS.resolve_basis(target, result.profile, gateway)
    policy = R.MaterialityPolicy.from_pack()
    inputs, _refusals, _facts = RS.rank_inputs_for(
        result, basis, policy, result.profile.currency, 0, gateway=gateway)
    report = R.rank_findings(inputs, checks=(), cap=max(1, len(inputs)),
                             policy_source=policy.source)
    return list(report.surfaced), result


def single_lane_inputs(case):
    fx = fixture(case)
    target = target_of(case, fx)
    result = s_engine.run_single_period(
        target.statements, period_id=target.period_id, caen=None,
        snapshot_id=target.engine_snapshot_id())
    gateway = RS.gateway_for(target)
    basis = RS.resolve_basis(target, result.profile, gateway)
    policy = RS.materiality_policy()
    inputs, _refusals, _facts = RS.rank_inputs_for(
        result, basis, policy, result.profile.currency, 0, gateway=gateway)
    return inputs, result, policy


def clones(ranked, n, severity):
    """`n` distinct rows derived from ONE real ranked finding: the rule
    id and root cause are made unique so the ranker treats them as
    separate root causes, the severity is the plant. Everything else —
    evidence, threshold, impact, materiality — is the engine's own."""
    out = []
    for i in range(n):
        rule_id = "%s#%d" % (ranked.finding.rule_id, i)
        threshold = dataclasses.replace(ranked.finding.threshold, rule_id=rule_id)
        finding = dataclasses.replace(ranked.finding, rule_id=rule_id,
                                      severity=severity, threshold=threshold)
        out.append(dataclasses.replace(ranked, finding=finding,
                                       root_cause="%s#%d" % (ranked.root_cause, i)))
    return out


# ══ R1 — ONE SOURCE ══════════════════════════════════════════════════════


def capsule_list_findings(case, fx):
    period = CT.PeriodRef(
        period_id="p-%s" % case, label="FY%s" % fx["period_end"][:4],
        entity_id="org-%s" % case, currency=fx["currency"],
        period_end=fx["period_end"], envelope=fx["envelope"],
        statements=fx["statements"], accounts=(), caen=None,
        snapshot_id="doc-%s" % case)
    ctx = CT.CapsuleContext(entity_id="org-%s" % case, periods=(period,))
    return CT.dispatch("list_findings", {"period": "p-%s" % case}, ctx)


@pytest.mark.parametrize("case", CASES)
def test_r1_route_rows_and_list_findings_agree_byte_for_byte(case, payloads):
    """Every row the Capsule tool serves for the period appears in the
    Radar payload with the SAME bytes on every key the tool carries.
    Radar wraps a row (rank, materiality, cap, dismissal, provenance);
    it never edits one. The engine's checks are the Radar checks, in
    order, as a prefix — the tool's own count is the same number. (This
    test hands both the SAME statements; the loader-level version is
    `test_r1_route_and_capsule_agree_through_their_own_loaders`.)"""
    fx = fixture(case)
    tool = capsule_list_findings(case, fx)
    assert not tool.gaps, tool.gaps
    capsule_rows = [r.fields for r in tool.rows if r.kind == "finding"]
    capsule_silence = [r.fields for r in tool.rows if r.kind == "silence"]
    payload = payloads[case]
    by_key = dict((r["rule_key"], r) for r in rows_of(payload))

    assert capsule_rows or capsule_silence, "the tool served neither rows nor silence"
    for crow in capsule_rows:
        rrow = by_key.get(crow["rule_key"])
        assert rrow is not None, ("R1 ONE-SOURCE VIOLATED — list_findings serves %s "
                                  "and Radar has no row for it" % crow["rule_key"])
        projected = dict((k, rrow.get(k)) for k in crow)
        assert canonical(projected) == canonical(crow), (
            "R1 ONE-SOURCE VIOLATED — %s/%s differs between list_findings and Radar"
            % (case, crow["rule_key"]))

    engine_checks = fx["single_period"]["all_checks"]
    assert engine_checks, "the capture carries no engine checks"
    assert payload["checks"][:len(engine_checks)] == engine_checks, (
        "R1 ONE-SOURCE VIOLATED — the engine's checks are not the prefix of Radar's")
    note = tool.notes[0]
    assert int(note.split(" ", 1)[0]) == len(engine_checks)

    if capsule_silence:
        assert payload["silence"] is not None
        assert payload["silence"]["profile_id"] == capsule_silence[0]["profile_id"]
        assert payload["silence"]["statement"] == capsule_silence[0]["statement"]


@pytest.mark.parametrize("case", CASES)
def test_r1_radar_rows_are_the_engine_payloads_the_capture_recorded(case, payloads):
    """The captured engine output (s_engine.payloads()) is what the Radar
    rows are built from — same rule keys, same bytes on the contract."""
    fx = fixture(case)
    engine_rows = dict((r["rule_key"], r) for r in fx["single_period"]["payloads"])
    radar_rows = dict((r["rule_key"], r) for r in rows_of(payloads[case])
                      if r["lane"] == RS.LANE_SINGLE)
    assert set(engine_rows) == set(radar_rows), (set(engine_rows) ^ set(radar_rows))
    for key, erow in engine_rows.items():
        projected = dict((k, radar_rows[key].get(k)) for k in erow)
        assert canonical(projected) == canonical(erow), key


def _period_row(period_id, org_id, fx):
    end = fx["period_end"]
    return {
        "id": period_id, "org_id": org_id,
        "period_start": end[:4] + "-01-01", "period_end": end,
        "currency": fx["currency"], "source_document_id": "doc-" + period_id,
        "updated_at": "2026-01-02T10:00:00+00:00", "caen_code": None,
        "extraction_confidence": None,
        "assembled_canonical_v1": copy.deepcopy(fx["envelope"]),
    }


def _both_routers(case, monkeypatch):
    """One app, both routers, one PROJECTION-FAITHFUL client. The route
    loads through its own `heavy_input`; the Capsule through its own
    `_context`. Neither is handed the other's rows."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    fx = fixture(case)
    book = ProjectingAdmin({
        "financial_periods": [_period_row("p-1", "org-a", fx)],
        "statement_line_items": [dict(li, period_id="p-1") for li in fx["line_items"]],
        "radar_dismissals": [],
        "organizations": [{"id": "org-a", "name": "Alpha SRL"}],
    })
    monkeypatch.setattr(_org, "resolve_org", lambda jwt, requested=None: ("user-1", "org-a"))
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: book)
    monkeypatch.setattr(RT, "_CACHE", RS.RadarCache())
    app = FastAPI()
    app.include_router(RT.build_router(
        clock=lambda: DISMISSED_AT,
        explain=RT.ExplainWiring(store=X.MemoryExplainStore(), background=False)))
    app.include_router(CT.build_router())
    return TestClient(app), book, fx


@pytest.mark.parametrize("case", CASES)
def test_r1_route_and_capsule_agree_through_their_own_loaders(case, monkeypatch, tmp_path):
    """THE LOADER-LEVEL R1. The route lists periods LIGHT and rebuilds
    off that row; the Capsule reads the full row. Under a client that
    honours `columns=` — as PostgREST does — the two served different
    figures on every corpus book (agras: an extra data_quality Critical
    at rank 1; realestate total_equity 10,694,320 vs 40,284,135) while
    the lane's own fake could not see the difference (SERVE_GATES.md,
    A2). Byte for byte, every capture, through the two real loaders."""
    monkeypatch.setenv(X.CACHE_DIR_ENV, str(tmp_path / "explain_cache"))
    client, _book, fx = _both_routers(case, monkeypatch)
    headers = {"Authorization": "Bearer t", "X-Org-Id": "org-a"}
    radar = client.get("/api/radar/p-1", headers=headers)
    assert radar.status_code == 200, radar.text
    radar = radar.json()
    tool = client.post("/api/capsule/tools/list_findings", headers=headers,
                       json={"period": "p-1"})
    assert tool.status_code == 200, tool.text
    tool = tool.json()
    capsule_rows = [r["fields"] for r in tool.get("rows", []) if r.get("kind") == "finding"]
    capsule_silence = [r["fields"] for r in tool.get("rows", []) if r.get("kind") == "silence"]
    assert capsule_rows or capsule_silence, "the Capsule served neither rows nor silence"
    radar_rows = dict((r["rule_key"], r) for r in rows_of(radar))
    for crow in capsule_rows:
        rrow = radar_rows.get(crow["rule_key"])
        assert rrow is not None, (
            "R1 ONE-SOURCE VIOLATED (loaders) — %s: list_findings serves %s and the "
            "route has no row for it" % (case, crow["rule_key"]))
        differing = [k for k in crow if canonical(crow[k]) != canonical(rrow.get(k))]
        assert not differing, (
            "R1 ONE-SOURCE VIOLATED (loaders) — %s/%s differs between the Capsule's "
            "loader and the route's on %s; facts_cited capsule=%s route=%s"
            % (case, crow["rule_key"], differing, crow.get("facts_cited"),
               rrow.get("facts_cited")))
    extra = [k for k, r in radar_rows.items() if r.get("surfaced") is True
             and k not in set(c["rule_key"] for c in capsule_rows)]
    assert not extra, (
        "R1 ONE-SOURCE VIOLATED (loaders) — %s: the route serves %s and the Capsule "
        "does not (the light row handed to the rebuild seam without its envelope "
        "fires the balance-sheet imbalance detector)" % (case, extra))
    # And the route's rows are the capture's — the served seam is one seam.
    golden = dict((r["rule_key"], r) for r in rows_of(fx["radar"]))
    for key, row in radar_rows.items():
        assert row["facts_cited"] == golden[key]["facts_cited"], (case, key)
        assert row["facts_provenance"] == golden[key]["facts_provenance"], (case, key)
    assert radar["snapshot_id"] == content_hash(fx)
    assert radar["materiality"]["basis"] == fx["radar"]["materiality"]["basis"]


def test_r1_census_the_captures_carry_findings_to_compare(payloads):
    """A one-source gate over empty payloads proves nothing (TC-3)."""
    total = sum(len(rows_of(payloads[c])) for c in CASES)
    assert total >= 12, "the captures carry too few findings to gate on: %d" % total
    assert all(payloads[c]["counts"]["checks"] >= 17 for c in CASES)


# ══ R2 — THE CAP ═════════════════════════════════════════════════════════


def test_r2_plant_n_plus_one_non_criticals_exactly_n_surface_and_the_demotion_is_recorded():
    """N+1 material, non-Critical rows under a cap of N: N surface, ONE
    is held — demoted with the reason, and the reason is on a check row
    the reader can open. Nothing is dropped."""
    policy = CAP.CapPolicy.from_pack()
    n = policy.cap
    surfaced, _ = single_lane_surfaced("saga_10_col_agras")
    seed = [r for r in surfaced if r.finding.severity != "critical"]
    assert seed, "no non-Critical surfaced row to derive from"
    rows = clones(seed[0], n + 1, "medium")

    decision = CAP.apply_cap(rows, policy)
    assert len(decision.surfaced) == n, (
        "R2 CAP VIOLATED — %d surfaced under a cap of %d" % (len(decision.surfaced), n))
    assert len(decision.held) == 1
    assert [r.rank for r in decision.surfaced] == list(range(1, n + 1))
    held = decision.held[0]
    assert held.disposition == R.DISPOSITION_CHECKS and held.rank == 0
    assert held.recommendation is False
    assert held.demotion_reason == CAP.HELD_BELOW_CAP % n
    assert len(decision.checks) == 1
    assert (CAP.HELD_BELOW_CAP % n) in decision.checks[0]["note"]
    assert decision.checks[0]["rule_id"] == held.finding.rule_id
    assert decision.exceeded_by_critical is False
    assert decision.held_back == 1
    # The held row is the LOWEST ranked, not an arbitrary one.
    assert CAP.order_key(held) >= max(CAP.order_key(r) for r in decision.surfaced)


def test_r2_plant_n_plus_one_criticals_all_surface_and_the_payload_says_so():
    """N+1 Criticals under a cap of N: every one surfaces, none is held,
    and the decision states that the cap was exceeded by Criticals. A
    Critical is never discovered under All checks."""
    policy = CAP.CapPolicy.from_pack()
    n = policy.cap
    surfaced, _ = single_lane_surfaced("saga_10_col_agras")
    rows = clones(surfaced[0], n + 1, "critical")
    decision = CAP.apply_cap(rows, policy)
    assert len(decision.surfaced) == n + 1, (
        "R2 CAP VIOLATED — a Critical was capped out (%d of %d surfaced)"
        % (len(decision.surfaced), n + 1))
    assert decision.held == ()
    assert decision.exceeded_by_critical is True
    assert decision.critical_count == n + 1
    assert "exceed the cap" in decision.statement()
    assert decision.to_payload()["exceeded_by_critical"] is True


def test_r2_the_cap_applies_below_critical_criticals_take_their_slots_first():
    policy = CAP.CapPolicy(cap=5, source="test")
    surfaced, _ = single_lane_surfaced("saga_10_col_agras")
    crit = clones(surfaced[0], 3, "critical")
    med = clones(surfaced[0], 6, "medium")
    decision = CAP.apply_cap(med + crit, policy)
    assert len(decision.surfaced) == 5
    assert sum(1 for r in decision.surfaced if CAP.is_critical(r)) == 3
    assert sum(1 for r in decision.surfaced if not CAP.is_critical(r)) == 2
    assert len(decision.held) == 4
    assert all(not CAP.is_critical(r) for r in decision.held)


def _bury_a_critical(case="saga_10_col_agras"):
    """The critic's construction over real findings: `fx_exposure`
    re-graded Critical and given `liquidity_cash_tight`'s root cause, so
    the ranker merges the two and — picking the primary by score — files
    the Critical as a `merged_from` contributor of the HIGH primary."""
    inputs, result, policy = single_lane_inputs(case)
    by_rule = dict((i.finding.rule_id, i) for i in inputs)
    liq, fxp = by_rule["liquidity_cash_tight"], by_rule["fx_exposure"]
    buried = dataclasses.replace(
        fxp, finding=dataclasses.replace(fxp.finding, severity="critical"),
        root_cause=liq.root_cause, scope_key=liq.root_cause)
    assert R.score_of(liq).total > R.score_of(buried).total, (
        "the construction needs the HIGH primary to outscore the buried Critical")
    others = [i for i in inputs if i.finding.rule_id not in ("liquidity_cash_tight", "fx_exposure")]
    thr = liq.finding.threshold
    true_crit = dataclasses.replace(
        liq, finding=dataclasses.replace(
            liq.finding, rule_id="liquidity_cash_tight#c", severity="critical",
            threshold=(dataclasses.replace(thr, rule_id="liquidity_cash_tight#c") if thr else None)),
        root_cause="CLONE", scope_key="CLONE")
    severity_by_rule = dict((i.finding.rule_id, i.finding.severity)
                            for i in [liq, buried, true_crit] + others)
    return liq, buried, true_crit, others, severity_by_rule, policy


def test_r2_a_critical_buried_under_a_non_critical_primary_is_never_held():
    """The critic's case (SERVE_GATES.md A3): with one true Critical
    ranked above and a cap of 1, the group whose Critical is a merged
    contributor was HELD "below the Radar cap" — a Critical under All
    checks. Critical is a property of the GROUP: it surfaces, the
    decision counts it, and the cap is exceeded by Criticals."""
    liq, buried, true_crit, others, severity_by_rule, policy = _bury_a_critical()
    report = R.rank_findings([liq, buried, true_crit] + others, cap=99,
                             policy_source=policy.source)
    primary = [r for r in report.surfaced if r.finding.rule_id == "liquidity_cash_tight"][0]
    assert primary.finding.severity == "high" and "fx_exposure" in primary.merged_from, (
        "the ranker no longer buries the Critical this way; re-derive the construction")
    assert CAP.group_severity(primary, severity_by_rule) == "critical"
    assert CAP.is_critical(primary, severity_by_rule)
    assert not CAP.is_critical(primary), "without the members' severities the primary reads HIGH"

    decision = CAP.apply_cap(list(report.surfaced), CAP.CapPolicy(cap=1, source="t"),
                             severity_by_rule)
    surfaced_rules = [r.finding.rule_id for r in decision.surfaced]
    assert "liquidity_cash_tight" in surfaced_rules, (
        "R2 CAP VIOLATED — the group carrying the buried Critical fx_exposure was held "
        "below the cap: %s" % [(r.finding.rule_id, list(r.merged_from)) for r in decision.held])
    assert "liquidity_cash_tight#c" in surfaced_rules
    assert decision.critical_count == 2 and decision.exceeded_by_critical is True
    assert all(not CAP.is_critical(r, severity_by_rule) for r in decision.held)


def _serve_with_buried_critical(monkeypatch, case="saga_10_col_agras", **kwargs):
    """serve_period over the real book with the engine's result edited
    in place: fx_exposure re-graded Critical on liquidity's subject."""
    fx = fixture(case)
    target = target_of(case, fx)
    result = s_engine.run_single_period(
        target.statements, period_id=target.period_id, caen=None,
        snapshot_id=target.engine_snapshot_id())
    findings = result.finding_set._findings
    liq = [f for f in findings if f.rule_id == "liquidity_cash_tight"][0]
    for i, f in enumerate(findings):
        if f.rule_id == "fx_exposure":
            findings[i] = dataclasses.replace(f, severity="critical", subject=liq.subject)
    real = s_engine.run_single_period

    def edited(statements, **kw):
        if kw.get("period_id") == target.period_id:
            return result
        return real(statements, **kw)
    monkeypatch.setattr(RS.s_engine, "run_single_period", edited)
    return RS.serve_period(request_for(case, fx, **kwargs)), fx


def test_r2_through_serve_a_buried_critical_group_surfaces_and_is_labelled(monkeypatch):
    payload, _fx = _serve_with_buried_critical(
        monkeypatch, cap_policy=CAP.CapPolicy(cap=1, source="t"))
    rows = dict((r["rule_key"], r) for r in payload["surfaced"])
    assert "liquidity_cash_tight" in rows, (
        "R2 CAP VIOLATED — the group carrying the buried Critical is not surfaced: %s"
        % [(r["rule_key"], r["demotion_reason"]) for r in payload["demoted"]])
    row = rows["liquidity_cash_tight"]
    assert row["severity"] == "high" and "fx_exposure" in row["merged_from"]
    assert row["group_severity"] == "critical" and row["group_critical"] is True
    assert payload["cap_policy"]["critical_count"] == 1
    assert "Critical" in payload["cap_policy"]["statement"]


def test_r2_through_serve_the_held_row_is_in_demoted_and_in_checks_with_the_reason():
    """End to end: a cap of 1 over a real book with several material
    non-Critical rows. Exactly one surfaces; the others are in `demoted`
    AND on the checks list with the same reason; `counts.held_back`
    says how many; nothing is missing from the union."""
    case = "saga_10_col_agras"
    uncapped = RS.serve_period(request_for(case))
    assert len(uncapped["surfaced"]) >= 2, "the book needs 2+ surfaced rows"
    assert all(r["severity"] != "critical" for r in uncapped["surfaced"])
    capped = RS.serve_period(request_for(case, cap_policy=CAP.CapPolicy(cap=1, source="t")))
    assert len(capped["surfaced"]) == 1
    assert capped["cap"] == 1 and capped["cap_policy"]["exceeded_by_critical"] is False
    held_keys = set(r["rule_key"] for r in uncapped["surfaced"]) - \
        set(r["rule_key"] for r in capped["surfaced"])
    assert held_keys
    reason = CAP.HELD_BELOW_CAP % 1
    demoted = dict((r["rule_key"], r) for r in capped["demoted"])
    for key in held_keys:
        assert key in demoted, "R2 — held row %s vanished from the payload" % key
        assert demoted[key]["demotion_reason"] == reason
        assert demoted[key]["disposition"] == R.DISPOSITION_CHECKS
        assert any(c["rule_id"] == key and reason in (c.get("note") or "")
                   for c in capped["checks"]), key
    assert capped["counts"]["held_back"] == len(held_keys)
    assert set(r["rule_key"] for r in rows_of(capped)) == \
        set(r["rule_key"] for r in rows_of(uncapped))


def test_r2_through_serve_a_critical_is_never_capped_out(critical_case):
    case, crit = critical_case
    capped = RS.serve_period(request_for(case, cap_policy=CAP.CapPolicy(cap=1, source="t")))
    keys = [r["rule_key"] for r in capped["surfaced"]]
    assert crit["rule_key"] in keys, "R2 — the Critical was capped out"
    assert all(r["severity"] == "critical" for r in capped["surfaced"])


def test_r2_the_statement_says_what_is_true_about_criticals_below_the_floor(critical_case):
    """"Every Critical surfaces, always" was overstated: a Critical
    BELOW the materiality floor is an info or a check row by the
    ranker's own rule. The statement now counts them. Under floors
    nothing clears, both Criticals of the retail book go below the
    floor, none surfaces, and the payload SAYS so with the count."""
    case, _crit = critical_case
    plain = RS.serve_period(request_for(case))
    crit_count = len([r for r in plain["surfaced"] if r["severity"] == "critical"])
    assert crit_count >= 1
    assert "every finding graded Critical at or above the materiality floor surfaces (%d)" \
        % crit_count in plain["cap_policy"]["statement"]
    assert plain["cap_policy"]["critical_below_floor"] == 0
    assert "always" not in plain["cap_policy"]["statement"]

    strict = R.MaterialityPolicy(
        floors=dict((k, 10.0) for k in R.DEFAULT_FLOORS), info_fraction=0.5,
        source="test#everything-below-the-floor")
    below = RS.serve_period(request_for(case, materiality_policy=strict))
    assert below["surfaced"] == []
    assert below["cap_policy"]["critical_below_floor"] == crit_count, (
        below["cap_policy"], below["counts"])
    assert ("%d Critical(s) below the materiality floor" % crit_count) in below["statement"]
    assert below["silence"] is not None


# ── the cap policy is DATA ───────────────────────────────────────────────


def _profiles_copy(tmp_path, block):
    raw = yaml.safe_load(Path(CP.DEFAULT_PROFILES_PATH).read_text(encoding="utf-8"))
    if block is not None:
        raw[CAP.PACK_BLOCK] = block
    target = tmp_path / "profiles.yaml"
    target.write_text(yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
    return str(target)


def test_cap_policy_is_read_from_the_pack_and_says_where_it_came_from(tmp_path):
    path = _profiles_copy(tmp_path, {CAP.PACK_KEY: 3})
    policy = CAP.CapPolicy.from_pack(path)
    assert policy.cap == 3
    assert policy.source == "%s#%s.%s" % (path, CAP.PACK_BLOCK, CAP.PACK_KEY)


def test_cap_policy_absent_in_the_pack_falls_back_to_the_ranker_default_and_says_so(tmp_path):
    path = _profiles_copy(tmp_path, None)
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    raw.pop(CAP.PACK_BLOCK, None)
    Path(path).write_text(yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
    policy = CAP.CapPolicy.from_pack(path)
    assert policy.cap == R.DEFAULT_CAP
    assert policy.source == CAP.CAP_SOURCE_DEFAULT


@pytest.mark.parametrize("bad", [0, -1, "seven", 2.5, True])
def test_cap_policy_refuses_a_cap_that_is_not_a_positive_integer(tmp_path, bad):
    path = _profiles_copy(tmp_path, {CAP.PACK_KEY: bad})
    with pytest.raises(CAP.CapPolicyError):
        CAP.CapPolicy.from_pack(path)


def test_cap_policy_never_consults_a_profile_or_company_name():
    """The no-ladder law. One number for the jurisdiction: the cap module
    holds no comparison against a profile id or a company name."""
    source = (REPO / "src" / "engine" / "radar" / "cap.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    catalog = CP.load_catalog()
    ids = set(p.id for p in catalog.structural_profiles)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert node.value not in ids, "cap.py names profile %r" % node.value
            assert "scandia" not in node.value.lower()
            assert "carniprod" not in node.value.lower()


# ══ R3 — DISMISSAL WITH REASON ═══════════════════════════════════════════


def dismissal_for(row, reason="known and disclosed to the auditors", **kwargs):
    return R.Dismissal(rule_id=row["rule_key"], scope_key=row["root_cause"],
                       reason=reason, dismissed_by="user-1",
                       dismissed_at=DISMISSED_AT, **kwargs)


def test_r3_a_dismissed_critical_stays_surfaced_flagged_with_the_reason(critical_case):
    """Dismiss the Critical. It must still be in `surfaced` — flagged
    `dismissed` and `dismissed_but_retained`, its reason shown — and
    the payload must count it as retained. Suppressing a Critical is a
    decision, and a decision has to be visible to be one."""
    case, crit = critical_case
    dismissal = dismissal_for(crit)
    payload = RS.serve_period(request_for(case, dismissals=(dismissal,)))
    rows = dict((r["rule_key"], r) for r in payload["surfaced"])
    assert crit["rule_key"] in rows, (
        "R3 DISMISSAL VIOLATED — the dismissed Critical %s left the surfaced list"
        % crit["rule_key"])
    row = rows[crit["rule_key"]]
    assert row["dismissed"] is True
    assert row["dismissed_but_retained"] is True
    assert row["dismissal"]["reason"] == dismissal.reason
    assert row["dismissal"]["dismissed_by"] == "user-1"
    assert row["dismissal"]["dismissed_at"] == DISMISSED_AT
    assert row["severity"] == "critical" and row["rank"] >= 1
    assert payload["dismissals"]["retained_critical"] == 1
    assert payload["dismissals"]["applied"] >= 1
    assert payload["dismissals"]["in_force"] == [dismissal.to_payload()]
    assert payload["counts"]["dismissed"] >= 1


def test_r3_dismissing_the_non_critical_primary_of_a_critical_group_retains_it():
    """The critic's second mechanism (A4): dismissing the HIGH primary
    took the buried Critical to the checks with
    `dismissed_but_retained=False`. Group-aware: the row stays surfaced,
    flagged retained, its demotion check row withdrawn."""
    liq, buried, true_crit, others, severity_by_rule, policy = _bury_a_critical()
    dismissal = R.Dismissal(rule_id="liquidity_cash_tight", scope_key=liq.root_cause,
                            reason="facility renewed", dismissed_by="u",
                            dismissed_at=DISMISSED_AT)
    report = R.rank_findings([liq, buried] + others, cap=99,
                             dismissals=R.DismissalIndex((dismissal,)),
                             policy_source=policy.source)
    assert "liquidity_cash_tight" not in [r.finding.rule_id for r in report.surfaced], (
        "the ranker now retains it on its own; the construction no longer applies")
    retained = RS.retain_dismissed_critical_groups(report, severity_by_rule)
    rows = dict((r.finding.rule_id, r) for r in retained.surfaced)
    assert "liquidity_cash_tight" in rows, (
        "R3 DISMISSAL VIOLATED — the group carrying the buried Critical fx_exposure "
        "left the surfaced list on a dismissal of its primary")
    row = rows["liquidity_cash_tight"]
    assert row.dismissed_but_retained is True and row.dismissal is dismissal
    assert row.disposition == R.DISPOSITION_SURFACED and row.recommendation is True
    assert "liquidity_cash_tight" not in [r.finding.rule_id for r in retained.demoted]
    assert not [c for c in retained.checks
                if c["rule_id"] == "liquidity_cash_tight"
                and "dismissed: facility renewed" in (c.get("note") or "")]
    assert len(retained.checks) == len(report.checks) - 1
    # Without a Critical in the group the ranker's own outcome stands.
    assert RS.retain_dismissed_critical_groups(report, {}) is report


def test_r3_through_serve_a_dismissed_critical_group_is_retained(monkeypatch):
    payload, _fx = _serve_with_buried_critical(monkeypatch)
    liq = [r for r in payload["surfaced"] if r["rule_key"] == "liquidity_cash_tight"][0]
    assert liq["group_critical"] is True
    dismissal = R.Dismissal(rule_id="liquidity_cash_tight", scope_key=liq["root_cause"],
                            reason="facility renewed", dismissed_by="u",
                            dismissed_at=DISMISSED_AT)
    dismissed, _fx = _serve_with_buried_critical(monkeypatch, dismissals=(dismissal,))
    rows = dict((r["rule_key"], r) for r in dismissed["surfaced"])
    assert "liquidity_cash_tight" in rows, [
        (r["rule_key"], r["demotion_reason"]) for r in dismissed["demoted"]]
    assert rows["liquidity_cash_tight"]["dismissed_but_retained"] is True
    assert rows["liquidity_cash_tight"]["dismissal"]["reason"] == "facility renewed"
    assert dismissed["dismissals"]["retained_critical"] == 1


def test_r3_a_dismissed_non_critical_moves_to_the_checks_with_the_reason():
    case = "saga_10_col_agras"
    plain = RS.serve_period(request_for(case))
    victim = [r for r in plain["surfaced"] if not r["group_critical"]][0]
    dismissal = dismissal_for(victim, reason="facility renewed in January")
    payload = RS.serve_period(request_for(case, dismissals=(dismissal,)))
    assert victim["rule_key"] not in [r["rule_key"] for r in payload["surfaced"]]
    demoted = dict((r["rule_key"], r) for r in payload["demoted"])
    assert victim["rule_key"] in demoted, "R3 — a dismissed finding was DELETED"
    row = demoted[victim["rule_key"]]
    assert row["dismissed"] is True and row["dismissed_but_retained"] is False
    assert row["demotion_reason"] == "dismissed: facility renewed in January"
    assert any(c["rule_id"] == victim["rule_key"]
               and "facility renewed in January" in (c.get("note") or "")
               and (c.get("dismissal") or {}).get("reason") == "facility renewed in January"
               for c in payload["checks"])
    assert payload["counts"]["dismissed"] == 1
    assert payload["dismissals"]["retained_critical"] == 0


def test_r3_dismissal_is_scoped_to_the_subject_it_judged():
    """A dismissal on another balance of the same rule does nothing;
    `*` covers every subject; the period span is honoured."""
    case = "saga_10_col_agras"
    plain = RS.serve_period(request_for(case))
    victim = [r for r in plain["surfaced"] if not r["group_critical"]][0]
    other_scope = R.Dismissal(rule_id=victim["rule_key"], scope_key="9999",
                              reason="x", dismissed_by="u", dismissed_at=DISMISSED_AT)
    payload = RS.serve_period(request_for(case, dismissals=(other_scope,)))
    assert victim["rule_key"] in [r["rule_key"] for r in payload["surfaced"]]

    any_scope = R.Dismissal(rule_id=victim["rule_key"], scope_key=R.SCOPE_ANY,
                            reason="x", dismissed_by="u", dismissed_at=DISMISSED_AT)
    payload = RS.serve_period(request_for(case, dismissals=(any_scope,)))
    assert victim["rule_key"] not in [r["rule_key"] for r in payload["surfaced"]]

    expired = R.Dismissal(rule_id=victim["rule_key"], scope_key=victim["root_cause"],
                          reason="x", dismissed_by="u", dismissed_at=DISMISSED_AT,
                          from_period_ordinal=0, periods=1)
    fx = fixture(case)
    later = RS.RadarRequest(org_id="org-x", target=target_of(case, fx, ordinal=3),
                            dismissals=(expired,))
    payload = RS.serve_period(later)
    assert victim["rule_key"] in [r["rule_key"] for r in payload["surfaced"]], (
        "a one-period dismissal held three periods later")


def test_r3_re_serving_after_a_dismissal_is_deterministic(critical_case):
    case, crit = critical_case
    dismissal = dismissal_for(crit)
    req = request_for(case, dismissals=(dismissal,))
    first = RS.canonical_bytes(RS.serve_period(req))
    for _ in range(3):
        assert RS.canonical_bytes(RS.serve_period(req)) == first
    assert RS.cache_key(req) != RS.cache_key(request_for(case))


# ══ PROVENANCE — every cited figure through the gateway ═════════════════


def _money_facts(row):
    from engine.api import _ratio_units
    return sorted(k for k in row["facts_cited"]
                  if _ratio_units.unit_for_fact(k) == _ratio_units.UNIT_MONEY)


def test_b3_every_cited_money_figure_is_verified_through_the_gateway_or_withheld_with_a_reason(payloads):
    """On every capture, every row, every money fact: either CITED by
    Radar with the accessor that served the same cents and the
    gateway's snapshot id, or WITHHELD with a reason and no value.
    Never silently unverified, never a conflict on a served row."""
    verified = withheld = 0
    for case in CASES:
        payload = payloads[case]
        fx = fixture(case)
        for row in rows_of(payload):
            block = row["facts_provenance"]
            assert block is not None, (case, row["rule_key"])
            assert block["conflict_count"] == 0 and block["conflicts"] == [], (
                case, row["rule_key"], block["conflicts"])
            for fact in _money_facts(row):
                if fact in block["cited"]:
                    cited = block["cited"][fact]
                    assert cited["value"] == row["facts_cited"][fact], (case, row["rule_key"], fact)
                    assert cited["accessor"].startswith("FactsGateway."), cited
                    assert cited["snapshot_id"] == content_hash(fx), (case, fact, cited)
                    verified += 1
                else:
                    assert fact in block["withheld"], (
                        "PROVENANCE VIOLATED — %s/%s cites %s, neither verified nor "
                        "withheld" % (case, row["rule_key"], fact))
                    entry = block["withheld"][fact]
                    assert entry["reason"].strip() and "value" not in entry, entry
                    assert entry["status"] in (RS.PROVENANCE_WITHHELD, RS.PROVENANCE_UNVERIFIED)
                    assert fact not in RS.FACT_ACCESSORS, (
                        "%s has an accessor and was withheld anyway" % fact)
                    withheld += 1
            assert set(block["cited"]) | set(block["withheld"]) == set(_money_facts(row))
        summary = payload["provenance"]
        assert summary["gateway"]["available"] is True and summary["gateway"]["tier"] == "canonical_bs"
        assert summary["facts"]["conflicts_on_served_rows"] == 0
        assert summary["facts"]["rows_refused_for_conflict"] == 0
        assert summary["snapshot_id"] == content_hash(fx) == summary["gateway"]["snapshot_id"]
    assert verified >= 20, "too few verified figures to gate on: %d" % verified
    assert withheld >= 5, "the census of withheld figures collapsed: %d" % withheld


def test_b3_the_withheld_facts_are_exactly_the_ones_without_an_accessor(payloads):
    """The census: what Radar withholds today is the set of detector
    facts `engine.serving.facts` has no accessor for. A name leaving
    this set means an accessor landed — map it and update this list in
    the same commit; a name entering it is a regression."""
    seen = set()
    for case in CASES:
        for row in rows_of(payloads[case]):
            seen.update(row["facts_provenance"]["withheld"])
        seen.update(payloads[case]["provenance"]["facts"]["unverified_or_withheld_facts"])
    assert seen == WITHHELD_TODAY, sorted(seen ^ WITHHELD_TODAY)
    assert not (seen & set(RS.FACT_ACCESSORS))
    for fact in WITHHELD_TODAY:
        assert not hasattr(FactsGateway, fact), (
            "FactsGateway now has %r — map it in RS.FACT_ACCESSORS" % fact)


def test_b3_net_income_is_the_gateways_net_result_which_is_account_121(payloads):
    """The retail contradiction: the rebuild seam served 1,161,957.98 as
    the statutory result while the gateway served 3,205,212.62. Both now
    read account 121, and Radar CITES the gateway's."""
    case = "saga_10_col_retail"
    fx = fixture(case)
    cbs = fx["envelope"]["canonical_bs"]
    p121 = float(cbs["invariants"]["p121_cross_check"]["p121"])
    gateway = FactsGateway.from_envelope(fx["envelope"], currency=fx["currency"])
    rows = dict((r["rule_key"], r) for r in rows_of(payloads[case]))
    row = rows["affiliate_income_dependency"]
    cited = row["facts_provenance"]["cited"]["net_income"]
    assert cited["accessor"] == "FactsGateway.net_result()"
    assert abs(cited["value"] - p121) < 0.005 and abs(cited["value"] - gateway.net_result().to_float()) < 0.005
    assert abs(float(row["facts_cited"]["net_income"]) - p121) < 0.005, (
        "the row still cites the class-6/7 reconstruction under the statutory name")
    assert fx["_meta"]["net_income_anchor"]["status"] == "anchored", fx["_meta"]


def test_b3_the_snapshot_id_is_the_gateways_content_hash_and_the_document_is_named_beside_it(payloads):
    for case in CASES:
        fx = fixture(case)
        payload = payloads[case]
        assert payload["snapshot_id"] == content_hash(fx), case
        assert payload["source_document_id"] == "doc-%s" % case
        assert payload["snapshot_key"] == "content:" + content_hash(fx)
        for row in rows_of(payload):
            for cited in row["facts_provenance"]["cited"].values():
                assert cited["snapshot_id"] == payload["snapshot_id"], (case, row["rule_key"])
            # The engine row's own provenance is the Capsule's convention
            # (the source document) — R1 holds it there.
            assert row["contract_elements"]["evidence"]["provenance"]["snapshot_id"] \
                == payload["source_document_id"]


def test_b3_plant_a_figure_that_contradicts_the_gateway_refuses_the_row_with_the_reason():
    """Statements of one book, envelope of another: every accessor-backed
    figure now contradicts the gateway. No such row is served — each is
    a check row saying which fact contradicts what, the payload counts
    them, and the surfaced list is silent rather than wrong."""
    agras = fixture("saga_10_col_agras")
    other = fixture("saga_10_col_carniprod")
    target = dataclasses.replace(target_of("saga_10_col_agras", agras),
                                 envelope=other["envelope"],
                                 snapshot_id=content_hash(other),
                                 content_key=content_hash(other))
    payload = RS.serve_period(RS.RadarRequest(org_id="org-x", target=target))
    refused = [c for c in payload["checks"] if "provenance conflict" in (c.get("note") or "")]
    assert refused, "PROVENANCE VIOLATED — a row citing a figure the gateway contradicts was served"
    assert payload["counts"]["refused_provenance"] == len(refused) >= 3
    assert payload["provenance"]["facts"]["rows_refused_for_conflict"] == len(refused)
    served_keys = set(r["rule_key"] for r in rows_of(payload))
    for check in refused:
        assert check["rule_id"] not in served_keys, check["rule_id"]
        assert check["provenance_conflicts"], check
        first = check["provenance_conflicts"][0]
        assert first["cited"] != first["served"]
        assert "FactsGateway." in first["accessor"]
        assert "serves %.2f" % first["served"] in check["note"]
    assert "fired but not served (a cited figure contradicts the served envelope)" \
        in payload["statement"]
    # Rows citing only accessor-less facts are not refused by this: they
    # are withheld, never contradicted. Nothing on the surfaced list
    # carries a conflict.
    for row in rows_of(payload):
        assert row["facts_provenance"]["conflict_count"] == 0


def test_b3_without_an_envelope_every_figure_is_withheld_and_nothing_conflicts():
    case = "saga_10_col_agras"
    fx = fixture(case)
    target = dataclasses.replace(target_of(case, fx), envelope=None, content_key=None,
                                 snapshot_id=None)
    payload = RS.serve_period(RS.RadarRequest(org_id="org-x", target=target))
    assert payload["provenance"]["gateway"]["available"] is False
    assert payload["materiality"]["basis"]["source"] == RS.BASIS_SOURCE_STATEMENTS
    for row in rows_of(payload):
        block = row["facts_provenance"]
        assert block["cited"] == {} and block["conflict_count"] == 0
        assert set(block["withheld"]) == set(_money_facts(row))
        for entry in block["withheld"].values():
            assert "no served envelope" in entry["reason"]


# ══ MATERIALITY — ABSENT IS NOT ZERO ═════════════════════════════════════


def test_materiality_amount_is_read_off_the_findings_own_figures(payloads):
    """Every ranked row's materiality amount is a money figure the row
    itself cites (never a company total), the fact is named, and the
    payload says whether that figure is gateway-verified."""
    seen = 0
    for case in CASES:
        for row in rows_of(payloads[case]):
            if row["lane"] != RS.LANE_SINGLE or row.get("materiality") is None:
                continue
            fact = row["materiality_amount_fact"]
            assert fact and fact not in RS.BASIS_TOTALS, (case, row["rule_key"])
            cited = dict((f["fact"], f["value"])
                         for f in row["contract_elements"]["evidence"]["figures"])
            cited.update(row["facts_cited"])
            assert fact in cited, (case, row["rule_key"], fact)
            assert abs(float(cited[fact])) == abs(float(row["materiality"]["amount"]))
            assert row["materiality"]["basis_id"] == RS.MATERIALITY_BASIS_ID
            assert row["materiality_amount_verified"] == (fact in row["facts_provenance"]["cited"])
            seen += 1
    assert seen >= 12, "materiality was checked on too few rows: %d" % seen


def test_materiality_basis_is_the_served_total_assets_through_the_gateway(payloads):
    for case in CASES:
        basis = payloads[case]["materiality"]["basis"]
        assert basis["source"] == RS.BASIS_SOURCE_GATEWAY, (case, basis)
        assert basis["value"] and basis["value"] > 0


def test_materiality_refuses_without_a_basis_and_records_the_reason():
    """No total assets anywhere -> no verdict. The finding is a check
    row saying "fired but not ranked" with the reason; it is not
    surfaced, not an info row, and not silently gone."""
    case = "saga_10_col_agras"
    fx = fixture(case)
    target = target_of(case, fx)
    result = s_engine.run_single_period(target.statements, period_id=target.period_id,
                                        snapshot_id=target.engine_snapshot_id())
    absent = RS.Basis(value=None, source=RS.BASIS_SOURCE_NONE, detail="test")
    inputs, refusals, _ = RS.rank_inputs_for(
        result, absent, R.MaterialityPolicy.from_pack(), result.profile.currency, 0)
    assert inputs == []
    assert len(refusals) == len(result.finding_set.surfaced) + len(result.finding_set.demoted)
    assert refusals
    for row in refusals:
        assert "fired but not ranked" in row["note"]
        assert "materiality is undefined" in row["note"]
        assert row["materiality"] is None


def test_materiality_refuses_a_finding_that_cites_only_company_totals():
    case = "saga_10_col_agras"
    fx = fixture(case)
    target = target_of(case, fx)
    result = s_engine.run_single_period(target.statements, period_id=target.period_id,
                                        snapshot_id=target.engine_snapshot_id())
    finding = result.finding_set.surfaced[0]
    only_totals = tuple(f for f in finding.evidence.figures
                        if f.unit != F.UNIT_MONEY or f.fact in RS.BASIS_TOTALS)
    facts = dict((k, v) for k, v in finding.facts_cited.items()
                 if k in RS.BASIS_TOTALS or F.UNIT_MONEY != _unit(k))
    stripped = dataclasses.replace(
        finding, evidence=dataclasses.replace(finding.evidence, figures=only_totals),
        facts_cited=facts)
    assert RS.amount_at_stake(stripped) is None
    assert RS.amount_at_stake(finding) is not None


def _unit(fact):
    from engine.api import _ratio_units
    return _ratio_units.unit_for_fact(fact)


# ══ THE MARKER ═══════════════════════════════════════════════════════════


def test_marker_every_payload_and_every_row_says_source_radar(payloads):
    for case in CASES:
        payload = payloads[case]
        assert payload["source"] == RS.SOURCE == "radar"
        assert payload["version"] == RS.RADAR_VERSION
        rows = rows_of(payload)
        assert rows, case
        for row in rows:
            assert row["source"] == "radar", (case, row["rule_key"])
            assert row["lane"] in (RS.LANE_SINGLE, RS.LANE_MULTI)
            assert row["id"] == RS.finding_id(payload["period_id"], _finding_stub(row))
            assert row["group_severity"] in R.SEVERITY_RANK
            assert row["group_critical"] == (row["group_severity"] == "critical")


def _finding_stub(row):
    return type("F", (), {"rule_id": row["rule_key"],
                          "subject": type("S", (), {"accounts": tuple(
                              type("A", (), {"code": c})() for c in row["root_cause"].split("+")
                              if row["root_cause"] != row["rule_key"])})()})()


def test_marker_the_legacy_alert_rows_carry_no_source_key():
    """The contrast the frontend wave asserts on (TC-7): the legacy
    `/api/period` alert rows are built without a `source` key, so a
    surface can tell which source it rendered."""
    source = (REPO / "src" / "engine" / "api" / "pipeline.py").read_text(encoding="utf-8")
    start = source.index('"alerts": [')
    block = source[start:source.index("for a in alerts", start)]
    assert '"source"' not in block


# ══ INCREMENTAL ══════════════════════════════════════════════════════════


def test_incremental_the_same_request_twice_runs_the_engine_once(monkeypatch):
    case = "saga_10_col_agras"
    cache = RS.RadarCache()
    runs = []
    real = s_engine.run_single_period

    def counting(*args, **kwargs):
        runs.append(1)
        return real(*args, **kwargs)
    monkeypatch.setattr(RS.s_engine, "run_single_period", counting)
    req = request_for(case)
    first = RS.serve_cached(req, cache)
    second = RS.serve_cached(req, cache)
    assert len(runs) == 1, "INCREMENTAL VIOLATED — the engine ran %d times" % len(runs)
    assert cache.hits == 1 and cache.misses == 1
    assert RS.canonical_bytes(first) == RS.canonical_bytes(second)
    # A hit hands back a COPY: mutating it cannot poison the cache.
    second["surfaced"].clear()
    assert RS.serve_cached(req, cache)["surfaced"]
    # The side material the explanation lane needs rides beside the entry.
    _payload, served = cache.get_or_build_with(RS.cache_key(req), lambda: RS.compose(req))
    assert isinstance(served, RS.Served) and served.surfaced and served.profile is not None
    assert len(runs) == 1
    # A new dismissal is a new key — exactly one more run.
    victim = first["surfaced"][0]
    RS.serve_cached(request_for(case, dismissals=(dismissal_for(victim),)), cache)
    assert len(runs) == 2


def test_incremental_the_key_moves_with_the_snapshot_and_with_the_dismissal_set():
    case = "saga_10_col_agras"
    fx = fixture(case)
    base = request_for(case, fx)
    moved = copy.deepcopy(fx)
    moved["envelope"]["provenance"]["content_hash"] = "sha256-moved"
    assert RS.cache_key(base) != RS.cache_key(request_for(case, moved))
    payload = RS.serve_period(base)
    dismissed = request_for(case, fx, dismissals=(dismissal_for(payload["surfaced"][0]),))
    assert RS.cache_key(base) != RS.cache_key(dismissed)
    assert RS.cache_key(base) == RS.cache_key(request_for(case, fx))
    # A dismissal re-anchored on a moved spine is a new key too.
    anchored = R.Dismissal(rule_id="fx_exposure", scope_key=R.SCOPE_ANY, reason="x",
                           dismissed_by="u", dismissed_at=DISMISSED_AT,
                           from_period_ordinal=1, periods=1)
    shifted = dataclasses.replace(anchored, from_period_ordinal=2)
    assert RS.cache_key(request_for(case, fx, dismissals=(anchored,))) != \
        RS.cache_key(request_for(case, fx, dismissals=(shifted,)))


# ══ NO MODEL, NO CLOCK ═══════════════════════════════════════════════════

SERVING_MODULES = (
    REPO / "src" / "engine" / "radar" / "serve.py",
    REPO / "src" / "engine" / "radar" / "cap.py",
)
BLOCKED_ROOTS = ("engine.ai", "anthropic", "openai")


def _imports_of(path):
    out = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            out.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            out.append(node.module or "")
    return out


def test_no_model_is_reachable_from_the_serving_modules():
    offenders = []
    for path in SERVING_MODULES:
        for name in _imports_of(path):
            if any(name == root or name.startswith(root + ".") for root in BLOCKED_ROOTS):
                offenders.append("%s imports %s" % (path.name, name))
    assert offenders == [], offenders
    assert X.critical_path_violations() == []


def test_the_serving_module_has_no_explanation_writer_of_its_own():
    """`explain.attach` is the ONE writer of `row["explanation"]`. The
    serve module used to carry a second, unguarded seam
    (`attach_explanations`) with a mock shape the product could not
    emit; it is gone, and the module offers only the strip."""
    source = SERVING_MODULES[0].read_text(encoding="utf-8")
    tree = ast.parse(source)
    names = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
    assert "attach_explanations" not in names and "ExplanationRefused" not in names
    assert "strip_explanations" in names
    assert not hasattr(RS, "EXPLANATION_KEYS")


def test_no_clock_is_read_inside_the_serving_modules():
    for path in SERVING_MODULES:
        source = path.read_text(encoding="utf-8")
        assert "date.today()" not in source and "datetime.now(" not in source, path.name
        assert "time.time(" not in source, path.name
