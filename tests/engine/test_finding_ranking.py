"""MATERIALITY, MERGE, RANK, CAP — under test.

The measured baseline (`design_review/findings/BASELINE.md`) shipped 59
rule-authored findings with no ordering beyond a severity bucket and no
materiality test at all. These tests pin the four properties that make
that impossible to ship again:

  1. MATERIALITY FIRST. A finding below the floor is at most an info row
     and is NEVER a recommendation, no matter how severe the rule that
     produced it thinks it is.
  2. ONE ROOT CAUSE, ONE FINDING. Three analyses tripping on the same
     balance produce one surfaced row with the other two attached as
     contributors — listed, never deleted.
  3. RANK BY WHAT IT IS WORTH. A `medium` finding at fifty times the
     floor outranks a `high` finding barely above it. Ranking by severity
     alone is the baseline's ordering, and it is the reason a rounding
     difference sorted above a fifth of the balance sheet.
  4. A CAP THAT DOES NOT LOSE ANYTHING. Seven surfaced; the rest on the
     checks list with the reason they are there and a count the reader
     can see.

And the one rule dismissal cannot break: a CRITICAL finding is never
silently suppressed.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json

import pytest
import yaml

from engine.api import _finding as F
from engine.api import _finding_rank as R
from engine.api import _ratio_units

RON = "RON"
ANCHOR = "mid-size inventory-heavy operator"


# ── A complete, contract-passing finding to rank ─────────────────────────


def complete_finding(rule_id="m_direction.ar_net", severity="medium",
                     code="411", steps=2, horizons=2, confidence="high",
                     observed=4.0, limit=3.0):
    """The seven elements, all present. Ranking is tested against
    findings the CONTRACT already accepts, so a ranking failure can never
    be mistaken for a contract failure."""
    facts = {
        "run_periods_count": observed,
        "cumulative_change_pct": 0.42,
        "line_share_pct": 0.196,
    }
    figures = (
        F.Figure("run_periods_count", observed, F.UNIT_COUNT,
                 "consecutive periods moving the same way"),
        F.Figure("cumulative_change_pct", 0.42, F.UNIT_PERCENT,
                 "cumulative move since the start of the run"),
        F.Figure("line_share_pct", 0.196, F.UNIT_PERCENT,
                 "share of total assets"),
    )
    impact = F.ratio_impact(
        "share_of_assets", "Trade receivables as a share of total assets",
        numerator=_ratio_units.money(6_000_000.0, RON),
        denominator=_ratio_units.money(39_194_178.0, RON),
        adjusted_numerator=_ratio_units.money(7_692_203.0, RON),
        adjusted_denominator=_ratio_units.money(39_194_178.0, RON),
        unit=F.UNIT_PERCENT)
    action_steps = []
    for i in range(steps):
        action_steps.append(F.ActionStep(
            imperative="Pull the account %s movement listing" % code,
            artefact="per-period movement listing for account %s" % code,
            provider="the financial controller",
            horizon=("before the next board pack" if i < horizons else None)))
    caveat = None if confidence == "high" else "one input could not be confirmed"
    return F.Finding(
        rule_id=rule_id, severity=severity, category="working_capital",
        currency=RON,
        subject=F.Subject(
            accounts=(F.Account(code, "Clienti", "BS", "ar_net"),),
            scope="Trade receivables (account %s)" % code),
        evidence=F.Evidence(
            figures=figures,
            provenance=F.Provenance(period_id="p4", snapshot_id="snap",
                                    line_refs=(code,)),
            comparison_basis=F.ComparisonBasis(
                kind="prior_period",
                description="measured against this company's own reading four "
                            "periods earlier",
                basis_value=0.15, basis_unit=F.UNIT_PERCENT)),
        threshold=F.Threshold(
            rule_id=rule_id, parameter="min_consecutive_periods",
            parameter_label="consecutive adverse periods", comparator=">=",
            limit=limit, observed=observed, unit=F.UNIT_COUNT,
            source="engine.api.findings.m_policy#ANALYSES.m_direction"
                   ".min_consecutive_periods"),
        impact=impact,
        why_here=F.WhyHere(
            profile_id="p_structure", profile_label=ANCHOR,
            rationale="One bad period is trading noise for a %s; the same "
                      "direction repeated without a break is the operating "
                      "pattern." % ANCHOR,
            signals=("related_party",), anchors=(ANCHOR,)),
        action=F.Action(steps=tuple(action_steps)),
        confidence=F.Confidence(level=confidence, basis="profile resolved from "
                                                        "structure",
                                caveat=caveat),
        profile_id="p_structure", profile_fingerprint="fp",
        facts_cited=facts)


def verdict(share, basis="total_assets", floor=0.005):
    tier = (R.TIER_MATERIAL if share >= floor
            else (R.TIER_INFO if share >= floor * R.DEFAULT_INFO_FRACTION
                  else R.TIER_IMMATERIAL))
    return R.MaterialityVerdict(
        basis_id=basis, basis_label="total assets", basis_value=39_194_178.0,
        amount=share * 39_194_178.0, share=share, floor=floor, tier=tier,
        source=R.POLICY_SOURCE_DEFAULT)


def item(rule_id="m_direction.ar_net", share=0.20, severity="medium",
         root_cause="411", persistence=1, **kwargs):
    return R.RankInput(
        finding=complete_finding(rule_id=rule_id, severity=severity, **kwargs),
        materiality=verdict(share), root_cause=root_cause,
        persistence=persistence, scope_key=root_cause, period_ordinal=4)


# ═════════════════════════════════════════════════════════════════════════
# 1. MATERIALITY FIRST
# ═════════════════════════════════════════════════════════════════════════


def test_a_material_finding_surfaces_as_a_recommendation():
    report = R.rank_findings([item(share=0.20)])
    assert len(report.surfaced) == 1
    assert report.surfaced[0].recommendation is True
    assert report.surfaced[0].disposition == R.DISPOSITION_SURFACED


def test_a_finding_below_the_floor_is_an_info_row_and_never_a_recommendation():
    report = R.rank_findings([item(share=0.002)])       # floor 0.005
    assert not report.surfaced
    assert len(report.info) == 1
    row = report.info[0]
    assert row.disposition == R.DISPOSITION_INFO
    assert row.recommendation is False
    assert row.effective_severity == "info"


def test_an_arithmetically_invisible_finding_does_not_even_get_an_info_row():
    report = R.rank_findings([item(share=0.0001)])
    assert not report.surfaced and not report.info
    assert report.counts["immaterial"] == 1
    note = report.checks[0]["note"]
    assert "below the materiality floor" in note


def test_severity_cannot_buy_its_way_past_the_floor():
    """A `critical` rule firing on 0.02% of the balance sheet is still
    0.02% of the balance sheet."""
    report = R.rank_findings([item(share=0.0002, severity="critical")])
    assert not report.surfaced
    assert report.counts["immaterial"] == 1


def test_assess_materiality_is_a_share_of_the_declared_basis():
    policy = R.MaterialityPolicy.default()
    v = R.assess_materiality(policy, "total_assets", "total assets",
                             39_194_178.0, 7_692_203.0, RON)
    assert v.share == pytest.approx(0.19626, rel=1e-4)
    assert v.tier == R.TIER_MATERIAL
    assert "of total assets" in v.statement()


def test_assess_materiality_refuses_an_absent_basis():
    policy = R.MaterialityPolicy.default()
    with pytest.raises(R.MaterialityBasisMissing):
        R.assess_materiality(policy, "revenue", "revenue", None, 1.0, RON)
    with pytest.raises(R.MaterialityBasisMissing):
        R.assess_materiality(policy, "revenue", "revenue", 0.0, 1.0, RON)


def test_materiality_is_dimensionless_and_survives_a_currency_change():
    policy = R.MaterialityPolicy.default()
    ron = R.assess_materiality(policy, "total_assets", "total assets",
                               39_194_178.0, 7_692_203.0, RON)
    eur = R.assess_materiality(policy, "total_assets", "total assets",
                               39_194_178.0 / 4.97, 7_692_203.0 / 4.97, "EUR")
    assert ron.share == pytest.approx(eur.share)


def test_an_undeclared_basis_takes_the_strictest_floor_not_a_lenient_one():
    policy = R.MaterialityPolicy.default()
    assert policy.floor("something_new") == max(policy.floors.values())


def test_the_policy_defaults_say_where_they_came_from():
    policy = R.MaterialityPolicy.default()
    assert policy.source == R.POLICY_SOURCE_DEFAULT
    assert R.MaterialityPolicy.from_pack().floors      # pack has no block today


def test_the_pack_can_configure_the_floors(tmp_path):
    target = tmp_path / "profiles.yaml"
    with open(str(target), "w", encoding="utf-8") as fh:
        yaml.safe_dump({"materiality": {"floors": {"total_assets": 0.25},
                                        "info_fraction": 0.5}}, fh)
    policy = R.MaterialityPolicy.from_pack(str(target))
    assert policy.floor("total_assets") == 0.25
    assert policy.info_fraction == 0.5
    assert str(target) in policy.source
    # And the configured floor actually changes the verdict.
    v = R.assess_materiality(policy, "total_assets", "total assets",
                             100.0, 20.0, RON)
    assert v.tier == R.TIER_INFO


def test_an_unreadable_pack_falls_back_to_the_declared_defaults(tmp_path):
    missing = tmp_path / "not-here.yaml"
    assert R.MaterialityPolicy.from_pack(str(missing)).source == \
        R.POLICY_SOURCE_DEFAULT


# ═════════════════════════════════════════════════════════════════════════
# 2. ONE ROOT CAUSE IS ONE FINDING
# ═════════════════════════════════════════════════════════════════════════


def test_correlated_findings_merge_into_one_with_the_others_listed():
    report = R.rank_findings([
        item(rule_id="m_direction.ar_net", share=0.20, root_cause="411"),
        item(rule_id="m_trend.ar_net", share=0.20, root_cause="411",
             severity="high"),
        item(rule_id="m_velocity.dso", share=0.20, root_cause="411"),
    ])
    assert len(report.surfaced) == 1
    primary = report.surfaced[0]
    assert primary.finding.rule_id == "m_trend.ar_net"       # highest score
    assert set(primary.merged_from) == {"m_direction.ar_net", "m_velocity.dso"}
    assert "Also detected by 2 correlated check(s)" in primary.contributor_summary()


def test_a_merged_finding_is_listed_on_the_checks_list_not_deleted():
    report = R.rank_findings([
        item(rule_id="m_direction.ar_net", root_cause="411"),
        item(rule_id="m_trend.ar_net", root_cause="411", severity="high"),
    ])
    merged_notes = [c for c in report.checks
                    if "merged into" in (c.get("note") or "")]
    assert len(merged_notes) == 1
    assert merged_notes[0]["rule_id"] == "m_direction.ar_net"
    assert report.counts["merged"] == 1


def test_different_root_causes_do_not_merge():
    report = R.rank_findings([
        item(rule_id="m_direction.ar_net", root_cause="411"),
        item(rule_id="m_direction.inventory", root_cause="3", code="371"),
    ])
    assert len(report.surfaced) == 2


def test_merging_takes_the_strongest_score_and_does_not_add_them_up():
    """Three views of one fact must not outrank a genuinely larger
    separate problem."""
    merged = R.rank_findings([
        item(rule_id="m_direction.ar_net", share=0.02, root_cause="411"),
        item(rule_id="m_trend.ar_net", share=0.02, root_cause="411"),
        item(rule_id="m_velocity.dso", share=0.02, root_cause="411"),
    ])
    single = R.rank_findings([item(rule_id="m_direction.ar_net", share=0.02)])
    assert merged.surfaced[0].score.total == \
        pytest.approx(single.surfaced[0].score.total)


# ═════════════════════════════════════════════════════════════════════════
# 3. RANK BY WHAT IT IS WORTH
# ═════════════════════════════════════════════════════════════════════════


def test_a_bigger_share_outranks_a_smaller_one_at_the_same_severity():
    report = R.rank_findings([
        item(rule_id="m_direction.small", share=0.006, root_cause="a"),
        item(rule_id="m_direction.big", share=0.40, root_cause="b"),
    ])
    assert [r.finding.rule_id for r in report.surfaced] == \
        ["m_direction.big", "m_direction.small"]


def test_a_large_medium_outranks_a_marginal_high():
    """The baseline defect, inverted. Severity is a weight, not the
    ordering."""
    report = R.rank_findings([
        item(rule_id="m_direction.marginal", share=0.0055, severity="high",
             root_cause="a"),
        item(rule_id="m_direction.large", share=0.30, severity="medium",
             root_cause="b"),
    ])
    assert report.surfaced[0].finding.rule_id == "m_direction.large"


def test_confidence_lowers_the_rank_of_an_otherwise_identical_finding():
    report = R.rank_findings([
        item(rule_id="m_direction.sure", share=0.20, root_cause="a"),
        item(rule_id="m_direction.unsure", share=0.20, root_cause="b",
             confidence="low"),
    ])
    assert report.surfaced[0].finding.rule_id == "m_direction.sure"


def test_persistence_lifts_a_recurring_finding_above_a_fresh_twin():
    report = R.rank_findings([
        item(rule_id="m_direction.fresh", share=0.20, root_cause="a"),
        item(rule_id="m_direction.recurring", share=0.20, root_cause="b",
             persistence=4),
    ])
    assert report.surfaced[0].finding.rule_id == "m_direction.recurring"
    assert report.surfaced[0].persistence_label == "4th consecutive period"


def test_actionability_lifts_the_finding_a_reader_can_actually_execute():
    report = R.rank_findings([
        item(rule_id="m_direction.vague", share=0.20, root_cause="a",
             steps=1, horizons=0),
        item(rule_id="m_direction.actionable", share=0.20, root_cause="b",
             steps=2, horizons=2),
    ])
    assert report.surfaced[0].finding.rule_id == "m_direction.actionable"
    assert R.actionability_component(
        complete_finding(steps=2, horizons=2)) == pytest.approx(1.0)
    assert R.actionability_component(
        complete_finding(steps=1, horizons=0)) == pytest.approx(0.7)


def test_persistence_component_is_capped():
    assert R.persistence_component(1) == 1.0
    assert R.persistence_component(2) == pytest.approx(1.15)
    assert R.persistence_component(50) == R.PERSISTENCE_CAP


def test_the_score_is_reproducible_from_the_payload():
    report = R.rank_findings([item(share=0.20, persistence=3)])
    score = report.surfaced[0].to_payload()["score"]
    assert score["total"] == pytest.approx(
        score["impact"] * score["confidence"] * score["persistence"]
        * score["actionability"])


def test_ordering_is_total_and_stable_for_identical_scores():
    rows = [item(rule_id="m_b.x", root_cause="b"),
            item(rule_id="m_a.x", root_cause="a")]
    first = [r.finding.rule_id for r in R.rank_findings(rows).surfaced]
    second = [r.finding.rule_id
              for r in R.rank_findings(list(reversed(rows))).surfaced]
    assert first == second == ["m_a.x", "m_b.x"]


# ═════════════════════════════════════════════════════════════════════════
# 4. THE CAP LOSES NOTHING
# ═════════════════════════════════════════════════════════════════════════


def _many(n, share=0.20):
    return [item(rule_id="m_direction.r%02d" % i, share=share,
                 root_cause="rc%02d" % i) for i in range(n)]


def test_the_cap_holds_at_seven_by_default():
    report = R.rank_findings(_many(10))
    assert len(report.surfaced) == R.DEFAULT_CAP == 7
    assert report.counts["held_back"] == 3


def test_everything_held_back_is_on_the_checks_list_with_a_reason():
    report = R.rank_findings(_many(10))
    held = [c for c in report.checks
            if "ranked below the cap" in (c.get("note") or "")]
    assert len(held) == 3
    assert report.statement().startswith("7 finding(s) surfaced")
    assert "ranked below the cap of 7" in report.statement()


def test_the_cap_is_configurable():
    assert len(R.rank_findings(_many(10), cap=3).surfaced) == 3
    assert len(R.rank_findings(_many(10), cap=0).surfaced) == 0


def test_the_cap_keeps_the_highest_scoring_findings():
    rows = _many(9, share=0.01)
    rows.append(item(rule_id="m_direction.biggest", share=0.90,
                     root_cause="rc99"))
    report = R.rank_findings(rows)
    assert report.surfaced[0].finding.rule_id == "m_direction.biggest"


def test_no_candidate_ever_disappears():
    """Conservation law: every candidate is either on a list or attached
    to one that is. Nothing is dropped, at any step, ever."""
    rows = _many(9) + [
        item(rule_id="m_direction.tiny", share=0.0001, root_cause="tiny"),
        item(rule_id="m_trend.r00", share=0.20, root_cause="rc00"),   # merges
        item(rule_id="m_trend.small", share=0.002, root_cause="s1"),  # info
        item(rule_id="m_direction.small", share=0.002, root_cause="s1"),
    ]
    report = R.rank_findings(rows)
    listed = report.surfaced + report.info + report.demoted
    accounted = len(listed) + sum(len(r.merged_from) for r in listed)
    assert accounted == len(rows)


def test_info_rows_obey_the_one_root_cause_rule_too():
    report = R.rank_findings([
        item(rule_id="m_trend.small", share=0.002, root_cause="s1"),
        item(rule_id="m_direction.small", share=0.002, root_cause="s1"),
        item(rule_id="m_trend.other", share=0.002, root_cause="s2"),
    ])
    assert len(report.info) == 2
    merged = [r for r in report.info if r.merged_from]
    assert len(merged) == 1
    note = [c for c in report.checks
            if "below the materiality floor" in (c.get("note") or "")
            and "merged into" in (c.get("note") or "")]
    assert len(note) == 1


# ═════════════════════════════════════════════════════════════════════════
# 5. DISMISSAL IS NOT DELETION
# ═════════════════════════════════════════════════════════════════════════


def test_a_dismissed_finding_leaves_the_surfaced_list_with_its_reason():
    dismissal = R.Dismissal(rule_id="m_direction.ar_net", scope_key="411",
                            reason="the balance settles in January",
                            dismissed_by="alex", dismissed_at="2026-08-30")
    report = R.rank_findings([item()], dismissals=R.DismissalIndex([dismissal]))
    assert not report.surfaced
    assert report.counts["dismissed"] == 1
    note = [c for c in report.checks if "dismissed:" in (c.get("note") or "")]
    assert note and "settles in January" in note[0]["note"]
    assert note[0]["dismissal"]["dismissed_by"] == "alex"


def test_a_critical_finding_is_never_silently_suppressed():
    dismissal = R.Dismissal(rule_id="m_direction.ar_net", scope_key="411",
                            reason="known and accepted")
    report = R.rank_findings([item(severity="critical")],
                             dismissals=R.DismissalIndex([dismissal]))
    assert len(report.surfaced) == 1
    row = report.surfaced[0]
    assert row.dismissed_but_retained is True
    assert row.dismissal.reason == "known and accepted"
    assert row.to_payload()["dismissed"] is True


def test_a_dismissal_is_scoped_to_the_balance_it_was_taken_on():
    dismissal = R.Dismissal(rule_id="m_direction.ar_net", scope_key="411")
    index = R.DismissalIndex([dismissal])
    assert index.match("m_direction.ar_net", "411") is not None
    assert index.match("m_direction.ar_net", "461") is None
    assert index.match("m_trend.ar_net", "411") is None


def test_a_wildcard_dismissal_covers_every_scope_for_its_rule():
    index = R.DismissalIndex([R.Dismissal(rule_id="m_direction.ar_net")])
    assert index.match("m_direction.ar_net", "anything") is not None


def test_a_dismissal_expires_after_the_window_it_was_given():
    dismissal = R.Dismissal(rule_id="m_direction.ar_net", scope_key="411",
                            from_period_ordinal=4, periods=2)
    index = R.DismissalIndex([dismissal])
    assert index.match("m_direction.ar_net", "411", 4) is not None
    assert index.match("m_direction.ar_net", "411", 5) is not None
    assert index.match("m_direction.ar_net", "411", 6) is None
    assert index.match("m_direction.ar_net", "411", 3) is None


def test_a_dismissal_round_trips_through_storage():
    dismissal = R.Dismissal(rule_id="m_direction.ar_net", scope_key="411",
                            reason="settled", dismissed_by="alex",
                            dismissed_at="2026-08-30", from_period_ordinal=4,
                            periods=3)
    assert R.Dismissal.from_payload(dismissal.to_payload()) == dismissal


def test_a_dismissal_payload_survives_json():
    dismissal = R.Dismissal(rule_id="r", scope_key="411", reason="x")
    blob = json.dumps(dismissal.to_payload(), sort_keys=True)
    assert R.Dismissal.from_payload(json.loads(blob)) == dismissal


# ═════════════════════════════════════════════════════════════════════════
# 6. THE CONTRACT STILL DECIDES WHAT MAY BE SEEN
# ═════════════════════════════════════════════════════════════════════════


def test_an_incomplete_finding_is_demoted_no_matter_how_material_it_is():
    from dataclasses import replace
    broken = replace(complete_finding(), action=None)
    row = R.RankInput(finding=broken, materiality=verdict(0.90),
                      root_cause="411", scope_key="411")
    report = R.rank_findings([row])
    assert not report.surfaced
    assert report.counts["incomplete"] == 1
    assert "action" in report.demoted[0].demotion_reason


def test_a_finding_whose_rule_did_not_fire_cannot_be_ranked_into_view():
    from dataclasses import replace
    finding = complete_finding()
    not_fired = replace(finding, threshold=replace(finding.threshold,
                                                   observed=1.0))
    report = R.rank_findings([R.RankInput(finding=not_fired,
                                          materiality=verdict(0.90),
                                          root_cause="411", scope_key="411")])
    assert not report.surfaced
    assert "did not actually fire" in report.demoted[0].demotion_reason


def test_every_surfaced_row_carries_its_materiality_and_its_rank():
    report = R.rank_findings(_many(3))
    for n, row in enumerate(report.surfaced, start=1):
        payload = row.to_payload()
        assert payload["rank"] == n
        assert payload["materiality"]["tier"] == R.TIER_MATERIAL
        assert payload["surfaced"] is True
        assert payload["title"] and payload["body"]


# ═════════════════════════════════════════════════════════════════════════
# 7. THE REPORT IS A CLAIM ABOUT EVERYTHING, NOT JUST THE SEVEN
# ═════════════════════════════════════════════════════════════════════════


def test_the_report_statement_accounts_for_what_is_not_shown():
    rows = _many(9) + [item(rule_id="m_direction.tiny", share=0.0001,
                            root_cause="tiny")]
    report = R.rank_findings(rows)
    statement = report.statement()
    assert "7 finding(s) surfaced" in statement
    assert "below the materiality floor" in statement
    assert "ranked below the cap" in statement


def test_incoming_checks_are_preserved_alongside_the_rank_notes():
    incoming = [{"rule_id": "m_seasonal.revenue", "note": "not run: needs 2 years"}]
    report = R.rank_findings([item()], checks=incoming)
    assert incoming[0] in report.checks


def test_the_report_payload_is_deterministic():
    rows = _many(9)
    first = json.dumps(R.rank_findings(rows).to_payload(), sort_keys=True)
    second = json.dumps(R.rank_findings(rows).to_payload(), sort_keys=True)
    assert first == second


def test_an_empty_candidate_list_is_an_honest_empty_report():
    report = R.rank_findings([])
    assert not report.surfaced and not report.info and not report.demoted
    assert report.counts["candidates"] == 0
    assert report.statement() == "0 finding(s) surfaced."
