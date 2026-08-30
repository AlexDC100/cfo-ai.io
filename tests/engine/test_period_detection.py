"""PERIOD DETECTION SERVICE (Part B, gates W1/W2) — the red suite.

The bug this locks shut: `documents.period_end_hint` is the channel that
means "a human confirmed THIS document belongs to THIS month". The
frontend was filling it with the DROP TARGET's date, so the engine —
whose ranked resolution correctly puts the hint first — dutifully
discarded its own correct detection. Production proof (2026-08-30 audit):
every mismatched row has `hint == stored`, including a 2025 Carniprod
trial balance filed under 2017-12.

What this suite pins:

  W1  UI STATE IS NOT AN INPUT. `detect_period` takes exactly two
      keyword-only arguments — `extracted` and `filename`. There is no
      parameter, and no **kwargs escape hatch, through which the
      currently-open period could ever reach the decision. The POST
      route mirrors that with `extra="forbid"`.

  W2  RANKED, HINT-FREE RESOLUTION:
        1. in_document      — a period end the document itself states
        2. closing_balance  — a date next to closing-balance vocabulary
        3. filename         — via the engine's own helper, reused
        4. none             — ABSENT. proposed=None, confidence 0.0.
      ABSENT != ZERO: an undetectable document yields "none" and forces
      an explicit human choice. It never falls back to today, and it can
      never fall back to whatever period happens to be open.
"""

from __future__ import annotations

import inspect
import json
from datetime import date
from pathlib import Path
from typing import Any, Dict

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _period_detect
from engine.api._period_detect import detect_period
from engine.api import pipeline

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "period_detect"
AUTH = {"Authorization": "Bearer test-token"}


def _cases() -> Dict[str, Dict[str, Any]]:
    payload = json.loads((FIXTURES / "production_cases.json").read_text("utf-8"))
    return {c["id"]: c for c in payload["cases"]}


PRODUCTION_CASES = _cases()


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(pipeline.build_router())
    return TestClient(app)


# ── W1 — the signature makes UI state unrepresentable ──────────────────


def test_signature_is_exactly_extracted_and_filename_keyword_only():
    sig = inspect.signature(detect_period)
    assert set(sig.parameters) == {"extracted", "filename"}, (
        "detect_period must take exactly `extracted` and `filename`. Any "
        "other parameter is a door for UI state (the open period, the drop "
        "target) to reach the decision — which is the bug being fixed."
    )
    for name, param in sig.parameters.items():
        assert param.kind is inspect.Parameter.KEYWORD_ONLY, (
            "%s must be keyword-only so no caller can pass it positionally"
            % name
        )


def test_signature_has_no_var_kwargs_escape_hatch():
    kinds = {p.kind for p in inspect.signature(detect_period).parameters.values()}
    assert inspect.Parameter.VAR_KEYWORD not in kinds
    assert inspect.Parameter.VAR_POSITIONAL not in kinds


@pytest.mark.parametrize(
    "ui_state_kwarg",
    [
        "open_period_end",
        "active_period_end",
        "target_period_end",
        "current_period_end",
        "selected_period_end",
    ],
)
def test_ui_state_cannot_be_passed(ui_state_kwarg):
    with pytest.raises(TypeError):
        detect_period(
            extracted=None,
            filename="Carniprod Trial Balance 2025.xlsx",
            **{ui_state_kwarg: "2017-12-31"}
        )


def test_cannot_be_called_positionally():
    with pytest.raises(TypeError):
        detect_period(None, "Carniprod Trial Balance 2025.xlsx")


# ── W2 — the reported production case ──────────────────────────────────


def test_2025_file_proposes_2025_while_a_2017_period_is_open():
    """The reported case, and the whole point of W1: there is no way to
    tell the service that 2017 is the open period, so a 2025-dated file
    can only ever resolve to 2025."""
    case = PRODUCTION_CASES["carniprod_2025_filed_under_2017"]
    out = detect_period(extracted=case["extracted"], filename=case["filename"])

    assert out["proposed_period_end"] == case["expected_proposed_period_end"]
    assert out["signal_used"] == case["expected_signal_used"]
    assert out["proposed_period_end"] != case["stored_period_end"]
    assert out["proposed_period_end"] != case["period_end_hint"]
    assert out["confidence"] > 0
    assert case["filename"] in out["evidence_snippet"]


@pytest.mark.parametrize("case_id", sorted(PRODUCTION_CASES))
def test_production_audit_cases(case_id):
    case = PRODUCTION_CASES[case_id]
    out = detect_period(extracted=case["extracted"], filename=case["filename"])
    assert out["proposed_period_end"] == case["expected_proposed_period_end"], case["note"]
    assert out["signal_used"] == case["expected_signal_used"], case["note"]


def test_out_of_range_legacy_date_is_refused_not_proposed():
    """The 2050-12-31 agras rows. `_sane_period_end` rejects the year, so
    the service must report ABSENT rather than propose a corrupt date —
    and must not silently substitute today."""
    out = detect_period(extracted={"period_end": "2050-12-31"},
                        filename="agras_tb_2050.xlsx")
    assert out["proposed_period_end"] is None
    assert out["signal_used"] == "none"
    assert out["confidence"] == 0.0


# ── W2 — filename tier ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "filename,expected",
    [
        # Already handled by the engine's helper — pinned so the service
        # can never regress what production already resolves correctly.
        ("Balanta Scandia Food_31.12.2025 LV.xls", "2025-12-31"),
        ("Balanta_EEI_dec_2025.pdf", "2025-12-31"),
        ("TB-2024-09-30.xlsx", "2024-09-30"),
        ("Carniprod Trial Balance 2025.xlsx", "2025-12-31"),
        ("balanta 12.2025.xlsx", "2025-12-31"),
        # Patterns the helper alone falls through to TODAY on — the exact
        # "never today" failure this lane exists to close.
        ("balanta_2025.xlsx", "2025-12-31"),
        ("dec2025.xls", "2025-12-31"),
        ("FY2025.xlsx", "2025-12-31"),
        ("tb_2025-12.xlsx", "2025-12-31"),
        ("trial_balance_2024-06.xlsx", "2024-06-30"),
        ("TB 09-2024.xlsx", "2024-09-30"),
    ],
)
def test_filename_only_evidence_resolves(filename, expected):
    out = detect_period(extracted=None, filename=filename)
    assert out["proposed_period_end"] == expected
    assert out["signal_used"] == "filename"
    assert out["proposed_period_end"] != date.today().isoformat() or expected == date.today().isoformat()


def test_filename_evidence_snippet_is_the_literal_filename():
    out = detect_period(extracted=None, filename="balanta_2025.xlsx")
    assert out["evidence_snippet"] == "balanta_2025.xlsx"


# ── W2 — content tiers and ranking ─────────────────────────────────────


def test_in_document_beats_a_disagreeing_filename():
    out = detect_period(
        extracted={"period_end": "2025-12-31"},
        filename="Carniprod Trial Balance 2017.xlsx",
    )
    assert out["proposed_period_end"] == "2025-12-31"
    assert out["signal_used"] == "in_document"
    # The disagreement stays visible for the mismatch chip's "why" line.
    by_signal = {c["signal"]: c["period_end"] for c in out["candidates"]}
    assert by_signal["filename"] == "2017-12-31"


def test_in_document_from_period_label():
    out = detect_period(
        extracted={"period_label": "Decembrie 2025"},
        filename="scan.pdf",
    )
    assert out["proposed_period_end"] == "2025-12-31"
    assert out["signal_used"] == "in_document"
    assert "Decembrie 2025" in out["evidence_snippet"]


def test_closing_balance_header_resolves_and_beats_filename():
    header = (FIXTURES / "carniprod_tb_header.txt").read_text("utf-8")
    out = detect_period(
        extracted={"header_text": header},
        filename="Carniprod Trial Balance 2017.xlsx",
    )
    assert out["proposed_period_end"] == "2025-12-31"
    assert out["signal_used"] == "closing_balance"
    assert "31.12.2025" in out["evidence_snippet"]


def test_in_document_beats_closing_balance():
    header = (FIXTURES / "carniprod_tb_header.txt").read_text("utf-8")
    out = detect_period(
        extracted={"period_end": "2024-12-31", "header_text": header},
        filename="scan.pdf",
    )
    assert out["proposed_period_end"] == "2024-12-31"
    assert out["signal_used"] == "in_document"
    by_signal = {c["signal"]: c["period_end"] for c in out["candidates"]}
    assert by_signal["closing_balance"] == "2025-12-31"


def test_unrelated_date_without_closing_vocabulary_is_not_used():
    out = detect_period(
        extracted={"header_text": "Tiparit de operator la 04.02.2026 ora 11:20"},
        filename="scan.pdf",
    )
    assert out["proposed_period_end"] is None
    assert out["signal_used"] == "none"


# ── W2 — ABSENT != ZERO ────────────────────────────────────────────────


def test_undetectable_document_returns_absent_never_today():
    out = detect_period(extracted=None, filename="scan.pdf")
    assert out["proposed_period_end"] is None
    assert out["confidence"] == 0.0
    assert out["signal_used"] == "none"
    assert out["evidence_snippet"] is None
    assert out["candidates"] == []


def test_absent_on_empty_inputs():
    out = detect_period(extracted=None, filename=None)
    assert out["proposed_period_end"] is None
    assert out["signal_used"] == "none"


def test_never_returns_today_as_a_detection():
    today = date.today().isoformat()
    for filename in ("scan.pdf", "raport final.pdf", "document(1).xlsx", ""):
        out = detect_period(extracted=None, filename=filename)
        assert out["proposed_period_end"] != today
        assert out["proposed_period_end"] is None


def test_is_deterministic():
    args = dict(extracted={"period_label": "Decembrie 2025"},
                filename="tb_2025-12.xlsx")
    first = detect_period(**args)
    second = detect_period(**args)
    assert first == second


def test_response_shape_is_the_contract():
    out = detect_period(extracted=None, filename="balanta_2025.xlsx")
    assert set(out) == {
        "proposed_period_end", "confidence", "signal_used",
        "evidence_snippet", "candidates",
    }
    assert out["signal_used"] in _period_detect.SIGNALS


# ── The route the upload flow calls BEFORE creating the document ───────


def test_get_route_resolves_from_filename_alone(client):
    r = client.get("/api/period/detect",
                   params={"filename": "Carniprod Trial Balance 2025.xlsx"},
                   headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proposed_period_end"] == "2025-12-31"
    assert body["signal_used"] == "filename"


def test_get_route_is_not_shadowed_by_the_period_id_route(client):
    """`/api/period/{period_id}` would happily swallow the literal path
    `detect`. Registration order is load-bearing; this pins it."""
    r = client.get("/api/period/detect", params={"filename": "scan.pdf"},
                   headers=AUTH)
    assert r.status_code == 200, r.text
    assert "signal_used" in r.json()


def test_post_route_accepts_a_parsed_preview(client):
    header = (FIXTURES / "carniprod_tb_header.txt").read_text("utf-8")
    r = client.post(
        "/api/period/detect",
        json={"filename": "Carniprod Trial Balance 2017.xlsx",
              "extracted": {"header_text": header}},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proposed_period_end"] == "2025-12-31"
    assert body["signal_used"] == "closing_balance"


def test_post_route_forbids_ui_state_in_the_body(client):
    r = client.post(
        "/api/period/detect",
        json={"filename": "Carniprod Trial Balance 2025.xlsx",
              "open_period_end": "2017-12-31"},
        headers=AUTH,
    )
    assert r.status_code == 422, (
        "the route must refuse UI state outright, not ignore it"
    )


def test_get_route_ignores_a_smuggled_open_period(client):
    r = client.get("/api/period/detect",
                   params={"filename": "Carniprod Trial Balance 2025.xlsx",
                           "open_period_end": "2017-12-31"},
                   headers=AUTH)
    assert r.status_code == 200, r.text
    assert r.json()["proposed_period_end"] == "2025-12-31"


def test_route_requires_auth(client):
    r = client.get("/api/period/detect", params={"filename": "scan.pdf"})
    assert r.status_code == 401


def test_route_reports_absent_without_guessing(client):
    r = client.get("/api/period/detect", params={"filename": "scan.pdf"},
                   headers=AUTH)
    body = r.json()
    assert body["proposed_period_end"] is None
    assert body["signal_used"] == "none"
    assert body["confidence"] == 0.0


# ── stage_persist traceability — the mismatch chip's ground truth ──────


def test_stage_persist_resolution_keeps_the_hint_at_rank_1():
    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "Carniprod Trial Balance 2025.xlsx",
         "period_end_hint": "2017-12-31"},
        {},
    )
    assert period_end == "2017-12-31", "rank 1 stays the confirmed hint"
    assert record["signal_used"] == "user_confirmed"
    # …but the document's own evidence is recorded alongside it, so the
    # chip has ground truth instead of recomputing.
    assert record["detected"]["proposed_period_end"] == "2025-12-31"
    assert record["detected"]["signal_used"] == "filename"
    assert record["mismatch"] is True


def test_stage_persist_records_no_mismatch_when_hint_agrees():
    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "Carniprod Trial Balance 2025.xlsx",
         "period_end_hint": "2025-12-31"},
        {},
    )
    assert period_end == "2025-12-31"
    assert record["mismatch"] is False


def test_absent_detection_is_never_counted_as_a_disagreement():
    """ABSENT != ZERO applies to the audit too: a file with no evidence
    of its own cannot disagree with the human's choice."""
    _, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "scan.pdf", "period_end_hint": "2017-12-31"},
        {},
    )
    assert record["detected"]["signal_used"] == "none"
    assert record["mismatch"] is False


def test_stage_persist_falls_through_hint_to_content_then_filename():
    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "Carniprod Trial Balance 2017.xlsx"},
        {"period_end": "2025-12-31"},
    )
    assert period_end == "2025-12-31"
    assert record["signal_used"] == "in_document"

    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "Carniprod Trial Balance 2017.xlsx"}, {},
    )
    assert period_end == "2017-12-31"
    assert record["signal_used"] == "filename"


def test_stage_persist_last_resort_today_is_labelled_as_such():
    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "scan.pdf"}, {},
    )
    assert period_end == date.today().isoformat()
    assert record["signal_used"] == "fallback_today", (
        "today must be recorded as a fallback, never as a detection"
    )
    assert record["detected"]["proposed_period_end"] is None


def test_insane_hint_falls_through_exactly_as_before():
    """Pre-existing behavior, pinned: an out-of-range hint is not trusted."""
    period_end, record = pipeline.resolve_period_end_for_persist(
        {"original_filename": "Carniprod Trial Balance 2025.xlsx",
         "period_end_hint": "2115-03-31"},
        {},
    )
    assert period_end == "2025-12-31"
    assert record["signal_used"] == "filename"
    assert record["hint"] is None
