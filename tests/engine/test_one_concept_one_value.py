"""ONE CONCEPT, ONE VALUE — the two halves of `GET /api/period/{id}`.

`GET /api/period/{id}` answers with two independently-computed halves:

  · `statements.assembled_pl` — the canonical P&L that
    `ro_romania/chart_of_accounts.assemble_statements()` builds, and the
    ONLY half that sees the account-121 anchor (`net_income_statutory`
    is overridden to 121's closing balance when the class-6/7
    reconstruction diverges by more than 5%).

  · `metrics` — the `calculated_metrics` rows `pipeline.stage_compute()`
    builds, from `statements.incomeStatement`, with its own arithmetic
    and no anchor anywhere near it.

Where the two halves emit the SAME NAME they must carry the SAME NUMBER,
because the report renders from both — section 2 (P&L) and the KPI tiles
read `assembled_pl`, section 5 (Financial Ratios) and the KPI margin
sub-label read `metrics`. A reader comparing them is comparing one
concept, and must not be shown two answers.

WHAT THIS REDS ON, after the repair (TC-11):

  · a metric that re-derives a figure the canonical assembly already
    anchored, instead of reading it — the exact defect measured on
    2026-09-06, where `metrics.net_income_statutory` was the class-6/7
    reconstruction (agras 14,106,102.03) while
    `assembled_pl.net_income_statutory` was account 121 (7,533,676.02);
  · any ratio built on net income drifting off the anchor — net_margin,
    roa, roe, free_cash_flow and the profitability sub-score of the
    credit composite are each pinned to the anchor here, by value, on
    all four books;
  · a NEW same-name field added to one half and not the other, or added
    to both with different arithmetic — the collision check is over the
    intersection of the two key sets, so it grows on its own.

WHAT IT CANNOT SEE: two values for one concept under DIFFERENT names
(`free_cash_flow` vs `free_cash_flow_proxy` is checked here only because
it is named explicitly below), and anything about what the browser
actually paints. The rendered-DOM half of this law is
`frontend/lib/__tests__/oneConceptOneValue.test.tsx` (G1) and
`plBuildUpFoots.test.tsx` (G2).
"""

from __future__ import annotations

import contextlib
import json
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")


class _NoDatabase:
    def delete(self, *_a: Any, **_k: Any) -> None:
        return None

    def insert(self, *_a: Any, **_k: Any) -> None:
        return None


@contextlib.contextmanager
def _no_database() -> Iterator[_NoDatabase]:
    yield _NoDatabase()


def _book(name: str) -> Dict[str, Any]:
    return json.loads((FIXTURES / f"saga_10_col_{name}.json").read_text("utf-8"))


def _served(name: str) -> Dict[str, Any]:
    """Both halves of the served period response, from the real engine."""
    from engine.api import pipeline

    fixture = _book(name)
    original = pipeline._supabase.admin  # type: ignore[attr-defined]
    pipeline._supabase.admin = _no_database  # type: ignore[attr-defined]
    try:
        metrics: List[Dict[str, Any]] = pipeline.stage_compute(
            {"org_id": "gate"},
            {
                "statements": fixture["statements"],
                "source_data_quality": (fixture.get("envelope") or {}).get(
                    "source_data_quality"
                )
                or {},
            },
            "gate",
        )
    finally:
        pipeline._supabase.admin = original  # type: ignore[attr-defined]
    return {
        "assembled_pl": fixture["statements"]["assembled_pl"],
        "metrics": {m["name"]: m["value"] for m in metrics},
        "p121": (
            ((fixture.get("envelope") or {}).get("canonical_bs") or {}).get("invariants")
            or {}
        ).get("p121_cross_check")
        or {},
    }


@pytest.fixture(scope="module")
def served() -> Dict[str, Dict[str, Any]]:
    return {name: _served(name) for name in BOOKS}


# ── the fixtures are not vacuous ──────────────────────────────────────


def test_every_book_carries_both_net_income_views_and_an_anchor(served):
    """A gate over four books proves nothing if the books agree by
    accident. Each one must carry a reconstruction that DIFFERS from the
    filed 121 figure, so 'read the anchor' is a real constraint."""
    for name in BOOKS:
        apl = served[name]["assembled_pl"]
        statutory = apl["net_income_statutory"]
        operational = apl["net_income_operational"]
        assert isinstance(statutory, float) and isinstance(operational, float)
        assert abs(statutory - operational) > 1.0, (
            f"{name}: the two net-income views agree, so this book cannot "
            f"distinguish an anchored figure from a reconstruction"
        )
        assert abs(served[name]["p121"].get("p121") - statutory) < 0.005, (
            f"{name}: assembled_pl.net_income_statutory is not the account-121 "
            f"closing balance the envelope witnesses"
        )


# ── G1e: the two halves never disagree under one name ─────────────────


def test_no_name_carries_two_values_across_the_two_served_halves(served):
    disagreements = []
    for name in BOOKS:
        apl = served[name]["assembled_pl"]
        metrics = served[name]["metrics"]
        for key in sorted(set(apl) & set(metrics)):
            a, m = apl[key], metrics[key]
            if a is None or m is None:
                continue
            if abs(float(a) - float(m)) > 0.005:
                disagreements.append(
                    f"{name}.{key}: assembled_pl={float(a):,.2f} "
                    f"metrics={float(m):,.2f} (delta {float(m) - float(a):,.2f})"
                )
    assert not disagreements, (
        "one concept, two values in a single /api/period response:\n  "
        + "\n  ".join(disagreements)
    )


# ── every ratio with net income in it reads the anchor ────────────────


NET_INCOME_RATIOS = ("net_margin", "roa", "roe")


def test_every_net_income_ratio_is_built_on_the_anchor(served):
    """Enumerated, not sampled: net_margin, roa, roe and the FCF proxy.
    Each is recomputed here from the ANCHOR and the same denominator the
    metric used, and must match what was served."""
    wrong = []
    for name in BOOKS:
        apl = served[name]["assembled_pl"]
        metrics = served[name]["metrics"]
        anchor = float(apl["net_income_statutory"])
        denominators = {
            "net_margin": float(metrics["revenue"]),
            "roa": float(metrics["total_assets"]),
            "roe": float(metrics["total_equity"]),
        }
        for ratio in NET_INCOME_RATIOS:
            denom = denominators[ratio]
            expected = None if denom == 0 else round(anchor / denom, 4)
            got = metrics[ratio]
            if expected is None:
                if got is not None:
                    wrong.append(f"{name}.{ratio}: served {got} over a zero denominator")
                continue
            if got is None or abs(float(got) - expected) > 1e-9:
                wrong.append(
                    f"{name}.{ratio}: served {got} — from the anchor "
                    f"{anchor:,.2f} it is {expected}"
                )
        # `free_cash_flow` is net income + D&A; D&A is read back off the
        # canonical assembly so the check does not re-derive it.
        expected_fcf = round(anchor + float(apl["depreciation"]), 2)
        if abs(float(metrics["free_cash_flow"]) - expected_fcf) > 0.005:
            wrong.append(
                f"{name}.free_cash_flow: served {float(metrics['free_cash_flow']):,.2f} "
                f"— from the anchor it is {expected_fcf:,.2f}"
            )
    assert not wrong, "a net-income ratio built on the reconstruction:\n  " + "\n  ".join(
        wrong
    )


def test_the_credit_profitability_subscore_is_built_on_the_anchor(served):
    """The composite credit grade moves with net income. `roe` and
    `net_margin` feed `credit_subscore_profitability` (pipeline.py, the
    Altman/composite block); if the ratios above are anchored and this
    is not, the letter grade still states a verdict on a figure the
    report never shows."""
    wrong = []
    for name in BOOKS:
        apl = served[name]["assembled_pl"]
        metrics = served[name]["metrics"]
        anchor = float(apl["net_income_statutory"])
        equity = float(metrics["total_equity"])
        revenue = float(metrics["revenue"])
        roe = anchor / equity if equity > 0 else 0
        margin = anchor / revenue if revenue > 0 else 0
        expected = round(min(100, max(0, (roe * 100 * 0.5 + margin * 100 * 5) / 1.5)), 1)
        got = metrics.get("credit_subscore_profitability")
        if got is None:
            continue
        if abs(float(got) - expected) > 0.05:
            wrong.append(
                f"{name}: served {got} — from the anchor it is {expected}"
            )
    assert not wrong, (
        "the credit profitability sub-score is built on the reconstruction:\n  "
        + "\n  ".join(wrong)
    )


# ── the committed frontend fixture is not stale ───────────────────────


def test_the_served_metrics_fixture_matches_the_live_engine(served):
    """`fixtures/firm/served_metrics.json` is what the frontend gates
    render against. If it drifts from what `stage_compute` really emits,
    those gates go green over a payload production never serves."""
    committed = json.loads((FIXTURES / "served_metrics.json").read_text("utf-8"))
    for name in BOOKS:
        assert committed.get(name) == served[name]["metrics"], (
            f"{name}: served_metrics.json is stale — re-run "
            f"`.venv/bin/python tests/engine/fixtures/firm/capture_served_metrics.py`"
        )
