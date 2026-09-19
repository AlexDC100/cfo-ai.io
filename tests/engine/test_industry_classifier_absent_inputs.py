"""Industry classifier + period detection — absent cost lines refuse.

Owner ruling 2026-09-15 (floor substitutes, fix_list C8.1): a cost-structure
rule is not evaluated over absent inputs. ``m.get("cogs", 0) or 0`` read a
period without cost keys as a business with no cost of goods and no
payroll — the real-estate signature. Measured before the repair: a
Scandia-shaped calculated_metrics set (revenue, EBITDA, gross profit, net
income, total assets — the names credit_model writes, no cost lines) was
suggested CAEN 6820 at 0.7 and resolved to real_estate_commercial_rental at
0.63; with its cost lines it is 1012 poultry at 0.7.

``detect_industry_for_period`` also read calculated_metrics alone, which
never carries cost lines, so on that live path the classifier ALWAYS saw
absent cost. It now reads the PL line items too.

The CAEN → industry mapping rows come from the committed seed
(``src/engine/api/seed/caen_industry_mappings.yaml``), not hand-built rows.

TC-11, what this reds on after the repair: a CAEN suggested over a metrics
set that lacks any cost line; a period with PL line items classified
without them; a services-shaped fallback chosen on an absent COGS.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from engine.api import _industry_detection as det
from engine.api._industry_classifier import (
    COST_STRUCTURE_INPUTS,
    COST_STRUCTURE_UNAVAILABLE,
    SINGLE_MATCH_CONFIDENCE,
    classify_cost_structure,
    cost_structure_metrics,
    suggest_caen_code,
)

SEED = Path(det.__file__).parent / "seed" / "caen_industry_mappings.yaml"

# Scandia Food FY2025 reference values (CLAUDE.md Appendix A §8 and the
# classifier's self-test). calculated_metrics names as credit_model writes.
SCANDIA_CALCULATED = {
    "revenue": 413_727_560,
    "total_operating_revenue": 413_727_560,
    "ebitda": 54_443_834,
    "gross_profit": 246_830_257,
    "net_income_statutory": 36_787_353,
    "total_assets": 293_050_085,
}
SCANDIA_COSTS = {
    "cogs": 166_897_303,
    "opex_personnel": 78_674_529,
    "opex_external_services": 30_000_000,
    "opex_energy": 13_542_383,
    "depreciation_amortization": 13_649_645,
    "opex_rent": 0,
}


class _SeedClient:
    """select() over the committed CAEN seed; every industry key resolves."""

    def __init__(self, metric_rows=(), line_items=()):
        rows = yaml.safe_load(SEED.read_text(encoding="utf-8"))
        rows = rows.get("mappings", rows) if isinstance(rows, dict) else rows
        self._mappings = {str(r["caen_code"]): r for r in rows}
        self._metric_rows = list(metric_rows)
        self._line_items = list(line_items)
        self.tables_read = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def select(self, table, filters=None, columns="*", **kw):
        self.tables_read.append(table)
        f = filters or {}
        if table == "caen_industry_mappings":
            row = self._mappings.get(f.get("caen_code", "").split(".", 1)[-1])
            return [row] if row else []
        if table == "industry_profiles":
            key = f.get("key", "").split(".", 1)[-1]
            return [{"key": key, "display_name": key, "parent_key": None, "sector": key}]
        if table == "calculated_metrics":
            return self._metric_rows
        if table == "statement_line_items":
            return self._line_items
        return []


def test_seed_maps_the_two_codes_under_test():
    client = _SeedClient()
    assert client._mappings["6820"]["industry_key"] == "real_estate_commercial_rental"
    assert client._mappings["1012"]["industry_key"] == "poultry_meat_processing"


def test_metrics_without_cost_lines_refuse_instead_of_suggesting_real_estate():
    result = classify_cost_structure(SCANDIA_CALCULATED)
    assert result.caen is None
    assert result.refusal["code"] == COST_STRUCTURE_UNAVAILABLE
    assert result.refusal["inputs"] == list(COST_STRUCTURE_INPUTS)
    assert result.refusal["text"] == (
        "Cost-structure classification unavailable: cost of goods, personnel, D&A, "
        "external services, energy and rent are not in this period's metrics."
    )
    assert suggest_caen_code(SCANDIA_CALCULATED) == (None, None, 0.0)


def test_with_its_cost_lines_scandia_is_poultry_at_single_match_confidence():
    caen, _label, conf = suggest_caen_code({**SCANDIA_CALCULATED, **SCANDIA_COSTS})
    assert (caen, conf) == ("1012", SINGLE_MATCH_CONFIDENCE)


@pytest.mark.parametrize("missing", list(COST_STRUCTURE_INPUTS))
def test_any_one_absent_cost_line_refuses(missing):
    metrics = {**SCANDIA_CALCULATED, **SCANDIA_COSTS}
    del metrics[missing]
    result = classify_cost_structure(metrics)
    assert result.caen is None and result.refusal["inputs"] == [missing]


def test_detect_from_signals_falls_back_and_says_why():
    """Measured before: real_estate_commercial_rental at 0.63 via CAEN 6820."""
    r = det.detect_from_signals(_SeedClient(), metrics=dict(SCANDIA_CALCULATED))
    assert r.primary.source == det.SOURCE_FALLBACK
    assert r.primary.industry_key == "manufacturing_generic"
    assert r.primary.confidence == 0.30
    assert [x["code"] for x in r.inputs["refusals"]] == [COST_STRUCTURE_UNAVAILABLE]


def test_services_fallback_needs_a_measured_cogs():
    """High personnel and ABSENT COGS used to pass `cogs < 20%` on a 0."""
    r = det.detect_from_signals(_SeedClient(), metrics={
        "total_operating_revenue": 1_000_000, "opex_personnel": 500_000})
    assert r.primary.industry_key == "manufacturing_generic"
    r = det.detect_from_signals(_SeedClient(), metrics={
        "total_operating_revenue": 1_000_000, "opex_personnel": 500_000, "cogs": 50_000})
    assert r.primary.industry_key == "professional_services_generic"


def _pl(code, bucket, amount):
    return {"statement": "PL", "bucket": bucket, "ro_account_code": code, "amount": amount}


SCANDIA_PL_ITEMS = [
    _pl("701", "revenue", 413_727_560),
    _pl("601", "cogs", 150_000_000),
    _pl("602", "cogs", 16_897_303),
    _pl("641", "personnel", 60_000_000),
    _pl("645", "personnel", 18_674_529),
    _pl("605", "otherOpex", 13_542_383),
    _pl("622", "otherOpex", 30_000_000),
    _pl("6811", "depreciation", 13_649_645),
]


def test_cost_structure_metrics_leaves_cost_lines_absent_without_pl_items():
    metric_rows = [{"name": k, "value": v} for k, v in SCANDIA_CALCULATED.items()]
    flat = cost_structure_metrics(metric_rows, [])
    assert not set(COST_STRUCTURE_INPUTS) & set(flat)


def test_detect_industry_for_period_reads_the_pl_line_items(monkeypatch):
    metric_rows = [{"name": k, "value": v} for k, v in SCANDIA_CALCULATED.items()]
    tenant = _SeedClient(metric_rows=metric_rows, line_items=SCANDIA_PL_ITEMS)
    catalog = _SeedClient()
    monkeypatch.setattr(det._supabase, "admin", lambda: catalog)
    r = det.detect_industry_for_period(tenant, period_id="p1", org_id="o1")
    assert "statement_line_items" in tenant.tables_read
    assert r.primary.source == det.SOURCE_AUTO_ACCOUNT_STRUCT
    assert r.primary.industry_key == "poultry_meat_processing"
    assert r.inputs["refusals"] == []
    assert r.inputs["line_item_count"] == len(SCANDIA_PL_ITEMS)


def test_detect_industry_for_period_without_line_items_refuses_the_rule(monkeypatch):
    metric_rows = [{"name": k, "value": v} for k, v in SCANDIA_CALCULATED.items()]
    tenant = _SeedClient(metric_rows=metric_rows, line_items=[])
    monkeypatch.setattr(det._supabase, "admin", lambda: _SeedClient())
    r = det.detect_industry_for_period(tenant, period_id="p1", org_id="o1")
    assert r.primary.industry_key != "real_estate_commercial_rental"
    assert r.primary.source == det.SOURCE_FALLBACK
    assert r.inputs["refusals"][0]["code"] == COST_STRUCTURE_UNAVAILABLE


# ─── the served benchmark path: GET /api/benchmarks/report/{period_id} ─────
#
# `_benchmarks._load_period_signals` kept its own flattening that pre-filled
# the six cost lines with 0 when a period had no PL line items; measured
# 2026-09-19 on f68d45a, a Scandia-shaped revenue-only period then reached
# the classifier as six "measured" zeros, rule 6820 fired at 0.7 (exactly
# `_AUTODETECT_MIN_CONFIDENCE`) and /report auto-assigned real estate to a
# period with no cost lines — the C8.1 defect, one caller over.

from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _benchmarks


class _BenchClient(_SeedClient):
    """The four extra tables the /report route reads before the CAEN gate."""

    def __init__(self, metric_rows=(), line_items=(), seeded_caens=("6820", "1012")):
        super().__init__(metric_rows=metric_rows, line_items=line_items)
        self._seeded = set(seeded_caens)

    def select(self, table, filters=None, columns="*", **kw):
        f = filters or {}
        if table == "financial_periods":
            self.tables_read.append(table)
            return [{"id": "p1", "org_id": "o1"}]
        if table == "organizations":
            self.tables_read.append(table)
            return [{"id": "o1", "name": "Test SRL"}]
        if table == "company_industry_assignments":
            self.tables_read.append(table)
            return []
        if table == "industry_benchmarks":
            self.tables_read.append(table)
            caen = f.get("caen_code", "").split(".", 1)[-1]
            return [{"caen_code": caen}] if caen in self._seeded else []
        if table == "benchmark_reports":
            self.tables_read.append(table)
            return []
        return super().select(table, filters=filters, columns=columns, **kw)


@pytest.fixture
def bench_app(monkeypatch):
    def _make(metric_rows=(), line_items=()):
        store = _BenchClient(metric_rows=metric_rows, line_items=line_items)
        monkeypatch.setattr(_benchmarks._supabase, "per_user", lambda jwt: store)
        monkeypatch.setattr(_benchmarks._supabase, "admin", lambda: store)
        monkeypatch.setattr(_benchmarks._org, "resolve_org", lambda jwt, org_id=None: ("u1", "o1"))
        app = FastAPI()
        app.include_router(_benchmarks.build_router())
        return TestClient(app, raise_server_exceptions=False), store
    return _make


_SCANDIA_METRIC_ROWS = [{"name": k, "value": v} for k, v in SCANDIA_CALCULATED.items()]


def test_report_route_gates_a_no_line_items_period_with_the_refusal(bench_app):
    """Before: `{"error": ...}` never came back — the route served a real-estate
    benchmark report (source auto_detected, CAEN 6820) for this period."""
    client, store = bench_app(metric_rows=_SCANDIA_METRIC_ROWS, line_items=[])
    caen, source, refusal = _benchmarks._resolve_effective_caen(jwt="x", period_id="p1")
    assert (caen, source) == ("", "unknown"), (caen, source)
    assert refusal["code"] == COST_STRUCTURE_UNAVAILABLE
    r = client.get("/api/benchmarks/report/p1", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("error") == "caen_not_set", body
    assert body["refusal"]["code"] == COST_STRUCTURE_UNAVAILABLE
    assert body["refusal"]["inputs"] == list(COST_STRUCTURE_INPUTS)
    assert body["message"].endswith(
        "Cost-structure classification unavailable: cost of goods, personnel, D&A, "
        "external services, energy and rent are not in this period's metrics.")
    assert "statement_line_items" in store.tables_read


def test_resolver_auto_detects_a_single_rule_match_over_measured_line_items(bench_app):
    """Control: EEI-shaped PL line items (no COGS rows, external services 44% of
    revenue) match exactly the 6820 rule and the seeded CAEN is served."""
    eei_items = [_pl("706", "revenue", 4_911_000), _pl("641", "personnel", 125_808),
                 _pl("622", "otherOpex", 2_172_788), _pl("6811", "depreciation", 355_606)]
    _client, _store = bench_app(metric_rows=[], line_items=eei_items)
    assert _benchmarks._resolve_effective_caen(jwt="x", period_id="p1") == (
        "6820", "auto_detected", None)


def test_resolver_auto_detects_scandia_from_its_own_pl_line_items(bench_app):
    """The same metric rows that refused above, WITH their PL line items:
    COGS 40% and personnel 19% of revenue match the 1012 rule alone."""
    _client, _store = bench_app(metric_rows=_SCANDIA_METRIC_ROWS, line_items=SCANDIA_PL_ITEMS)
    assert _benchmarks._resolve_effective_caen(jwt="x", period_id="p1") == (
        "1012", "auto_detected", None)


def test_the_benchmark_loader_is_the_classifier_flattening(bench_app):
    _client, _store = bench_app(metric_rows=_SCANDIA_METRIC_ROWS, line_items=SCANDIA_PL_ITEMS)
    assert _benchmarks._load_period_signals("x", "p1") == cost_structure_metrics(
        _SCANDIA_METRIC_ROWS, SCANDIA_PL_ITEMS)
    _client, _store = bench_app(metric_rows=_SCANDIA_METRIC_ROWS, line_items=[])
    assert not set(COST_STRUCTURE_INPUTS) & set(_benchmarks._load_period_signals("x", "p1"))
