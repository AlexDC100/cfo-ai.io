"""Unit tests for the AI Council extraction-integrity reviewer.

All tests run OFFLINE — the Anthropic client is forced to None so the
council exercises its deterministic baseline + chair, with no network.
That keeps the tests hermetic and fast while still covering the full
aggregation and alert-conversion surface.
"""

from __future__ import annotations

import pytest

from engine.api import _ai_council
from engine.api._ai_council import (
    _aggregate,
    _build_evidence,
    _deterministic_baseline,
    council_findings_as_alerts,
    run_council,
)


# ── Fixtures: assembled/parsed envelopes ─────────────────────────────────

def _clean_assembled():
    return {
        "statements": {
            "assembled_bs": {
                "total_assets": 1_000_000.0,
                "total_equity": 400_000.0,
                "total_liabilities": 600_000.0,
                "bs_balance_delta": 0.0,
            },
            "assembled_pl": {
                "net_income_statutory": 120_000.0,
                "net_income": 121_500.0,  # ~1.25% off → within P&L tolerance
            },
        },
        "unmapped": [],
        "ignored": [{"code": "581"}, {"code": "121"}],
    }


def _clean_parsed(n_accounts=200):
    # Spread codes across classes 1-7 so completeness passes.
    accounts = []
    for i in range(n_accounts):
        cls = str((i % 7) + 1)
        accounts.append({"code": f"{cls}{i:03d}"})
    return {
        "accounts": accounts,
        "company_name": "Test SRL",
        "period_label": "FY2025",
        "currency": "RON",
    }


# ── Evidence + baseline ──────────────────────────────────────────────────

def test_evidence_computes_reconciliation_pcts():
    ev = _build_evidence(_clean_assembled(), _clean_parsed())
    recon = ev["reconciliation"]
    assert recon["bs_reconciliation_pct"] == pytest.approx(0.0)
    assert recon["pnl_reconciliation_pct"] == pytest.approx(1.25, abs=0.01)
    assert ev["account_count"] == 200
    assert ev["ignored_count"] == 2


def test_baseline_pass_on_clean_extraction():
    ev = _build_evidence(_clean_assembled(), _clean_parsed())
    base = _deterministic_baseline(ev)
    assert base["verdict"] == "pass"
    assert base["findings"] == []


def test_baseline_fail_on_unbalanced_bs():
    asm = _clean_assembled()
    # 5% imbalance → beyond 2× the 1% tolerance → fail.
    asm["statements"]["assembled_bs"]["bs_balance_delta"] = 50_000.0
    ev = _build_evidence(asm, _clean_parsed())
    base = _deterministic_baseline(ev)
    assert base["verdict"] == "fail"
    assert any("balance sheet" in f["title"].lower() for f in base["findings"])


def test_baseline_warn_on_missing_revenue_class():
    parsed = _clean_parsed(n_accounts=120)
    # Strip every class-7 (revenue) account.
    parsed["accounts"] = [a for a in parsed["accounts"] if not a["code"].startswith("7")]
    ev = _build_evidence(_clean_assembled(), parsed)
    base = _deterministic_baseline(ev)
    assert base["verdict"] == "warn"
    assert any("class 7" in f["title"].lower() for f in base["findings"])


def test_baseline_warn_on_truncated_extract():
    ev = _build_evidence(_clean_assembled(), _clean_parsed(n_accounts=20))
    base = _deterministic_baseline(ev)
    assert base["verdict"] == "warn"
    assert any("few accounts" in f["title"].lower() for f in base["findings"])


# ── Chair aggregation ────────────────────────────────────────────────────

def _member(key, verdict, conf, findings=None):
    return {
        "member": key, "member_title": key, "model": "test",
        "available": True, "verdict": verdict, "confidence": conf,
        "summary": "", "findings": findings or [],
    }


def test_aggregate_worst_verdict_wins():
    members = [
        _member("reconciliation_auditor", "pass", 0.9),
        _member("completeness_auditor", "warn", 0.7),
        _member("classification_auditor", "fail", 0.8),
    ]
    baseline = {"verdict": "pass", "confidence": 0.9, "summary": "", "findings": []}
    out = _aggregate(members, baseline)
    assert out["verdict"] == "fail"
    assert out["confidence"] == pytest.approx((0.9 + 0.7 + 0.8) / 3, abs=0.01)


def test_aggregate_falls_back_to_baseline_when_no_members():
    members = [
        {"member": "reconciliation_auditor", "available": False, "verdict": None,
         "confidence": 0.0, "findings": []},
    ]
    baseline = {"verdict": "warn", "confidence": 0.6, "summary": "",
                "findings": [{"severity": "medium", "title": "X", "detail": "y"}]}
    out = _aggregate(members, baseline)
    assert out["verdict"] == "warn"
    assert out["confidence"] == 0.6
    assert any(f["title"] == "X" for f in out["findings"])


def test_aggregate_dedupes_findings_by_title():
    dup = {"severity": "high", "title": "Balance sheet does not reconcile", "detail": "a"}
    members = [_member("m1", "fail", 0.8, findings=[dict(dup)])]
    baseline = {"verdict": "fail", "confidence": 0.85, "summary": "",
                "findings": [dict(dup)]}
    out = _aggregate(members, baseline)
    titles = [f["title"] for f in out["findings"]]
    assert titles.count("Balance sheet does not reconcile") == 1


# ── End-to-end offline (no API key) ──────────────────────────────────────

def test_run_council_offline_uses_baseline(monkeypatch):
    # Force no client regardless of ambient ANTHROPIC_API_KEY.
    monkeypatch.setattr(_ai_council, "_anthropic_client", lambda api_key: None)
    result = run_council(_clean_assembled(), _clean_parsed())
    assert result["verdict"] == "pass"
    assert all(m["available"] is False for m in result["members"])
    assert result["evidence"]["account_count"] == 200


def test_run_council_never_raises_on_garbage(monkeypatch):
    monkeypatch.setattr(_ai_council, "_anthropic_client", lambda api_key: None)
    # Totally malformed inputs must still return a dict, not raise.
    result = run_council({"statements": None}, {"accounts": None})
    assert isinstance(result, dict)
    assert result["verdict"] in ("pass", "warn", "fail", "unknown")


# ── Alert conversion ─────────────────────────────────────────────────────

def test_findings_as_alerts_shape_and_keys():
    council = {
        "verdict": "fail",
        "confidence": 0.82,
        "summary": "split — worst verdict adopted",
        "findings": [
            {"severity": "high", "title": "Balance sheet does not reconcile", "detail": "gap 5%"},
            {"severity": "low", "title": "Many unmapped accounts", "detail": "12 unmapped"},
        ],
    }
    alerts = council_findings_as_alerts(council)
    # 1 summary + 2 findings.
    assert len(alerts) == 3
    summary = alerts[0]
    assert summary["alert_key"] == "ai_council::summary"
    assert summary["severity"] == "high"  # fail → high
    assert summary["category"] == "data_quality"
    # Every alert carries the required persisted-schema keys + unique keys.
    keys = [a["alert_key"] for a in alerts]
    assert len(keys) == len(set(keys))
    for a in alerts:
        assert set(a) >= {"alert_key", "severity", "category", "title", "body", "rule_key"}
        assert a["category"] == "data_quality"
        assert a["rule_key"] == "ai_council"


def test_findings_as_alerts_pass_is_info():
    alerts = council_findings_as_alerts({"verdict": "pass", "confidence": 0.95,
                                         "summary": "clean", "findings": []})
    assert len(alerts) == 1
    assert alerts[0]["severity"] == "info"


def test_findings_as_alerts_empty_on_empty_result():
    assert council_findings_as_alerts({}) == []
