"""AI extraction lane battery (HU/OTHER jurisdictions) — ALL MOCKED.

No network and no live Anthropic calls anywhere in this file: every
model interaction goes through an injected fake client factory, and
Supabase access goes through fake admin factories. Locked properties:

  · Happy-path HU fixture end-to-end with canned model JSONs → a
    canonical_bs built by the SAME builder (build_canonical_bs_v2),
    permanently labelled extraction.method=="llm" +
    classification.method=="llm", status capped (NEVER BALANCED),
    needs_review populated for the <0.85 account whose balance rides
    the Unclassified rows, self-check deltas correct, ai_audit complete.
  · Malformed JSON → ONE retry (with the parse error in the retry
    prompt) → success; twice-malformed → AiLaneError, nothing persisted.
  · Cache: same content_hash + prompt versions → zero client calls;
    force_reextract (doc flag or envelope marker) and prompt-version
    bumps bypass the cache.
  · RO fixtures NEVER enter the AI lane (the pipeline gate returns None
    and the client factory / lane is never invoked).
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

import engine.ai_lane as lane
from engine.ai_lane import (
    AI_LANE_DETECTED_TYPE,
    FORCE_REEXTRACT_ENVELOPE_KEY,
    AiLaneError,
    build_source_anchor,
    config as lane_config,
)
from engine.ai_lane.schemas import ExtractedRow, ExtractResult, FormatDetectResult

REPO = Path(__file__).resolve().parents[2]
HU_FIXTURE = (
    REPO / "src" / "engine" / "country_packs" / "hu_hungary" / "fixtures"
    / "hu_szamlatukor_tb_2025.csv"
)
HU_BYTES = HU_FIXTURE.read_bytes()
HU_DOC = {
    "id": "doc-hu-1",
    "org_id": "org-1",
    "original_filename": "hu_szamlatukor_tb_2025.csv",
}


# ── Fake Anthropic client (scripted responses) ─────────────────────────

class _FakeMessages:
    def __init__(self, responses: List[Any]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("fake client ran out of scripted responses")
        r = self._responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=r)])


class _FakeClient:
    def __init__(self, responses: List[Any]):
        self.messages = _FakeMessages(responses)


class _ExplodingFactory:
    """Client factory that must never be invoked (cache-hit guard)."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> Any:
        self.calls += 1
        raise AssertionError("client factory invoked — the cache should have hit")


# ── Fake Supabase admin (context-manager) ──────────────────────────────

class _FakeAdminCtx:
    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows
        self.selects: List[Any] = []

    def __enter__(self) -> "_FakeAdminCtx":
        return self

    def __exit__(self, *args: Any) -> bool:
        return False

    def select(self, table: str, filters: Optional[Dict[str, str]] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        self.selects.append((table, filters))
        return list(self.rows)


# ── Canned model JSONs (mirror the synthetic HU fixture) ───────────────

FMT_JSON = json.dumps({
    "layout": {"columns": ["Számla", "Megnevezés", "Tartozik egyenleg", "Követel egyenleg"],
               "header_row": 1, "totals_row_index": 15},
    "currency": "HUF", "scale": 1,
    "thousands_sep": " ", "decimal_sep": ",", "language": "hu",
})

_ROWS = [
    {"code": "114", "label": "Szellemi termékek", "debit": 2500000.0, "credit": None, "balance": None},
    {"code": "123", "label": "Épületek", "debit": 12000000.0, "credit": None, "balance": None},
    {"code": "211", "label": "Anyagok", "debit": 3200000.0, "credit": None, "balance": None},
    {"code": "311", "label": "Belföldi vevők", "debit": 4750000.0, "credit": None, "balance": None},
    {"code": "384", "label": "Elszámolási betétszámla", "debit": 6400000.0, "credit": None, "balance": None},
    {"code": "381", "label": "Pénztár", "debit": 350000.0, "credit": None, "balance": None},
    {"code": "466", "label": "Előzetesen felszámított áfa", "debit": 400000.0, "credit": None, "balance": None},
    {"code": "411", "label": "Jegyzett tőke", "debit": None, "credit": 10000000.0, "balance": None},
    {"code": "413", "label": "Eredménytartalék", "debit": None, "credit": 5500000.0, "balance": None},
    {"code": "454", "label": "Belföldi szállítók", "debit": None, "credit": 3800000.0, "balance": None},
    {"code": "467", "label": "Fizetendő áfa", "debit": None, "credit": 900000.0, "balance": None},
    {"code": "522", "label": "Bérleti díjak", "debit": 500000.0, "credit": None, "balance": None},
    {"code": "811", "label": "Anyagjellegű ráfordítások", "debit": 7500000.0, "credit": None, "balance": None},
    {"code": "911", "label": "Belföldi értékesítés árbevétele", "debit": None, "credit": 17400000.0, "balance": None},
]

EXTRACT_JSON = json.dumps({
    "rows": _ROWS,
    "totals_row": {"debit": 37600000.0, "credit": 37600000.0},
})

# 466 is deliberately below the 0.85 gate → needs_review + Unclassified.
_ASSIGNMENTS = [
    {"code": "114", "line_id": "intangibles_other", "confidence": 0.9, "rationale": "intellectual property"},
    {"code": "123", "line_id": "ppe_buildings", "confidence": 0.97, "rationale": "buildings"},
    {"code": "211", "line_id": "inventory_raw_materials", "confidence": 0.95, "rationale": "raw materials"},
    {"code": "311", "line_id": "ar_trade_gross", "confidence": 0.96, "rationale": "trade receivables"},
    {"code": "384", "line_id": "cash_operating", "confidence": 0.98, "rationale": "bank account"},
    {"code": "381", "line_id": "cash_operating", "confidence": 0.97, "rationale": "petty cash"},
    {"code": "466", "line_id": "ar_tax_recoverable", "confidence": 0.62, "rationale": "input VAT — uncertain"},
    {"code": "411", "line_id": "share_capital", "confidence": 0.99, "rationale": "registered capital"},
    {"code": "413", "line_id": "retained_earnings_prior_years", "confidence": 0.95, "rationale": "retained earnings"},
    {"code": "454", "line_id": "ap_trade", "confidence": 0.96, "rationale": "trade payables"},
    {"code": "467", "line_id": "ap_tax", "confidence": 0.93, "rationale": "output VAT payable"},
    {"code": "522", "line_id": "rent_operating_lease", "confidence": 0.9, "rationale": "rent expense"},
    {"code": "811", "line_id": "cogs_raw_materials", "confidence": 0.92, "rationale": "material expenses"},
    {"code": "911", "line_id": "revenue_products", "confidence": 0.94, "rationale": "sales revenue"},
]
CLASSIFY_JSON = json.dumps({"assignments": _ASSIGNMENTS})

HU_RESOLUTION = {"jurisdiction": "HU", "source": "language", "confidence": 0.95}


def _run_happy_path(client: Optional[_FakeClient] = None) -> Dict[str, Any]:
    client = client or _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    return lane.run_ai_lane(
        doc=dict(HU_DOC),
        file_bytes=HU_BYTES,
        kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=lambda: client,
    )


# ── 1. Happy path — HU fixture end-to-end ──────────────────────────────

def test_happy_path_canonical_bs_llm_labels_and_cap():
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    parsed = _run_happy_path(client)

    assert parsed["detected_type"] == AI_LANE_DETECTED_TYPE
    assert parsed["accounts"] == []  # RO stages must never see AI accounts
    assert parsed["currency"] == "HUF"

    env = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]
    cbs = env["canonical_bs"]

    # Permanent llm labels + additive source_format vocabulary.
    assert cbs["extraction"]["method"] == "llm"
    assert cbs["extraction"]["source_format"] == "llm_hu"
    assert cbs["extraction"]["model"] == lane_config.MODEL_ID
    assert cbs["extraction"]["parser_version"] == lane_config.AI_LANE_PARSER_VERSION
    assert cbs["extraction"]["prompt_versions"] == lane_config.prompt_versions()
    assert cbs["classification"]["method"] == "llm"
    assert cbs["classification"]["prompt_version"] == lane_config.CLASSIFY_PROMPT_VERSION
    assert cbs["classification"]["model"] == lane_config.MODEL_ID

    # Status cap: the identity holds exactly here (difference 0.00) yet
    # an LLM extraction can NEVER be BALANCED.
    assert cbs["difference"] == 0.0
    assert cbs["status"] == "MINOR_DRIFT"
    assert cbs["status"] != "BALANCED"

    # Totals from the classified leaves + unclassified rows.
    assert cbs["totals"]["assets"] == pytest.approx(29_600_000.0)
    assert cbs["totals"]["equity_plus_liabilities"] == pytest.approx(29_600_000.0)

    # Model calls all pinned to the ONE config module's model id.
    assert len(client.messages.calls) == 3
    assert all(c["model"] == lane_config.MODEL_ID for c in client.messages.calls)


def test_happy_path_needs_review_and_unclassified_row():
    parsed = _run_happy_path()
    env = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]
    cbs = env["canonical_bs"]

    # 466 (confidence 0.62 < 0.85) → needs_review, on the object AND in
    # the classification meta (the serve path overwrites the top-level
    # key with the reconciliation boolean — the meta copy survives).
    for review_list in (cbs["needs_review"], cbs["classification"]["needs_review"]):
        assert [n["code"] for n in review_list] == ["466"]
        assert review_list[0]["reason"] == "low_confidence_llm"
        assert review_list[0]["confidence"] == pytest.approx(0.62)
        # FE CanonicalBsNeedsReviewEntry contract: signed amount + the
        # Unclassified section the value landed in.
        assert review_list[0]["amount"] == pytest.approx(400_000.0)
        assert review_list[0]["section"] == "current_assets"

    # FE jurisdiction badge contract.
    assert cbs["jurisdiction"] == {
        "resolved": "HU",
        "source": "auto",
        "pack_version": lane_config.AI_LANE_PARSER_VERSION,
    }
    # FE AI-read badge tooltip reads the singular extraction.prompt_version.
    assert cbs["extraction"]["prompt_version"] == lane_config.EXTRACT_PROMPT_VERSION

    # Value NEVER dropped: the balance rides the Unclassified debit row.
    unclassified = [r for r in cbs["rows"] if r["id"] == "unclassified_debit"]
    assert len(unclassified) == 1
    assert unclassified[0]["amount"] == pytest.approx(400_000.0)
    assert unclassified[0]["leaf_ids"] == ["466"]
    unmapped_466 = [u for u in cbs["unmapped"] if u["code"] == "466"]
    assert unmapped_466 and unmapped_466[0]["reason"] == "low_confidence_llm"

    # Classified rows landed on their canonical leaves.
    rows_by_id = {r["id"]: r for r in cbs["rows"]}
    assert rows_by_id["cash_operating"]["amount"] == pytest.approx(6_750_000.0)
    assert rows_by_id["ppe_buildings"]["amount"] == pytest.approx(12_000_000.0)
    assert rows_by_id["share_capital"]["amount"] == pytest.approx(10_000_000.0)
    # P&L classified accounts net into the reconstruction result row.
    assert rows_by_id["current_year_profit"]["amount"] == pytest.approx(9_400_000.0)
    assert cbs["invariants"]["result_basis"] == "reconstruction"

    # The low-confidence account is NOT among the persisted line items.
    line_codes = {li["ro_account_code"] for li in parsed["ai_lane"]["assembled"]["lineItems"]}
    assert "466" not in line_codes


def test_happy_path_self_check_anchor_matched():
    parsed = _run_happy_path()
    anchor = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]["canonical_bs"]["source_anchor"]
    assert anchor["totals_row_found"] is True
    assert anchor["anchor_status"] == "MATCHED"
    assert anchor["source_balanced"] is True
    sf = anchor["pairs"]["sf"]
    assert sf["file_debit"] == pytest.approx(37_600_000.0)
    assert sf["extracted_debit"] == pytest.approx(37_600_000.0)
    assert sf["delta_debit"] == pytest.approx(0.0)
    assert sf["delta_credit"] == pytest.approx(0.0)


def test_happy_path_ai_audit_complete():
    parsed = _run_happy_path()
    env = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]
    audit = env["ai_audit"]
    assert audit["model"] == lane_config.MODEL_ID
    assert audit["prompt_versions"] == lane_config.prompt_versions()
    assert audit["content_hash"] == lane.content_hash_of(HU_BYTES)
    assert audit["jurisdiction"] == "HU"
    assert audit["resolution"] == HU_RESOLUTION
    stages = audit["stages"]
    assert [s["stage"] for s in stages] == ["format_detect", "extract", "classify"]
    for s in stages:
        assert s["model"] == lane_config.MODEL_ID
        assert s["prompt_version"]
        assert s["raw_response"]  # FULL raw responses persisted
        assert s["at"]


def test_other_jurisdiction_gets_llm_intl_and_user_source():
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    parsed = lane.run_ai_lane(
        doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
        resolution={"jurisdiction": "OTHER", "source": "user", "confidence": 1.0},
        client_factory=lambda: client,
    )
    cbs = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]["canonical_bs"]
    assert cbs["extraction"]["source_format"] == "llm_intl"
    assert cbs["extraction"]["method"] == "llm"
    assert cbs["status"] != "BALANCED"
    # FE wire code for OTHER is "INTL"; explicit user choice → "hint".
    assert cbs["jurisdiction"]["resolved"] == "INTL"
    assert cbs["jurisdiction"]["source"] == "hint"
    assert parsed["currency"] == "HUF"  # format-detect currency still wins


# ── 2. Self-check divergence ───────────────────────────────────────────

def test_diverged_totals_row_marks_anchor_and_material_imbalance():
    bad_extract = json.dumps({
        "rows": _ROWS,
        "totals_row": {"debit": 40_000_000.0, "credit": 37_600_000.0},
    })
    parsed = _run_happy_path(_FakeClient([FMT_JSON, bad_extract, CLASSIFY_JSON]))
    cbs = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]["canonical_bs"]
    anchor = cbs["source_anchor"]
    assert anchor["anchor_status"] == "DIVERGED"
    assert anchor["pairs"]["sf"]["delta_debit"] == pytest.approx(-2_400_000.0)
    # Contract: DIVERGED ⇒ the extraction failed its external anchor.
    assert cbs["status"] == "MATERIAL_IMBALANCE"
    # Figures were NEVER auto-altered to force a match.
    assert anchor["pairs"]["sf"]["extracted_debit"] == pytest.approx(37_600_000.0)


def test_no_totals_row_is_no_anchor():
    fmt = FormatDetectResult(totals_row_index=None)
    result = ExtractResult(rows=[
        ExtractedRow(code="384", label="Bank", balance=100.0),
        ExtractedRow(code="411", label="Capital", balance=-100.0),
    ])
    anchor = build_source_anchor(result, fmt)
    assert anchor["anchor_status"] == "NO_ANCHOR"
    assert anchor["totals_row_found"] is False
    assert anchor["source_balanced"] is None
    # Balance-only rows split by sign into the extracted pair.
    assert anchor["pairs"]["sf"]["extracted_debit"] == pytest.approx(100.0)
    assert anchor["pairs"]["sf"]["extracted_credit"] == pytest.approx(100.0)


# ── 3. Malformed JSON — one retry, then honest failure ─────────────────

def test_malformed_json_once_retries_and_succeeds():
    client = _FakeClient([FMT_JSON, "this is {not json", EXTRACT_JSON, CLASSIFY_JSON])
    parsed = _run_happy_path(client)
    assert len(client.messages.calls) == 4  # fmt + extract×2 + classify
    # Retry prompt carries the parse error back to the model.
    retry_call = client.messages.calls[2]
    retry_texts = [
        blk["text"]
        for m in retry_call["messages"]
        for blk in m["content"]
        if isinstance(blk, dict) and blk.get("type") == "text"
    ]
    assert any("not valid JSON" in t and "Parse error" in t for t in retry_texts)
    # Audit records BOTH extract attempts (full raw responses).
    stages = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]["ai_audit"]["stages"]
    extract_attempts = [s["attempt"] for s in stages if s["stage"] == "extract"]
    assert extract_attempts == [1, 2]


def test_malformed_json_twice_raises_ai_lane_error_nothing_persisted():
    client = _FakeClient([FMT_JSON, "still {not json", "again {not json"])
    admin = _FakeAdminCtx([])  # has NO update method — any write would crash

    with pytest.raises(AiLaneError) as exc:
        lane.run_ai_lane(
            doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
            resolution=dict(HU_RESOLUTION),
            client_factory=lambda: client,
            admin_factory=lambda: admin,
        )
    msg = str(exc.value)
    assert "extract" in msg and "malformed JSON twice" in msg
    # Exactly one retry happened, then the lane stopped — no third try.
    assert len(client.messages.calls) == 3  # fmt + extract attempt 1 + attempt 2
    # Nothing persisted: the lane owns no write path and the fake admin
    # (read-only) was only ever used for the cache lookup.
    assert all(t == "financial_periods" for t, _f in admin.selects)


def test_api_transport_error_wrapped_as_ai_lane_error():
    client = _FakeClient([FMT_JSON, RuntimeError("529 overloaded_error")])
    with pytest.raises(AiLaneError) as exc:
        _run_happy_path(client)
    assert "extract" in str(exc.value)


# ── 4. Cache — the persisted envelope IS the cache ─────────────────────

def _cached_period_row(content_hash: str, prompt_versions: Optional[Dict[str, str]] = None,
                       extra_env: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    env: Dict[str, Any] = {
        "canonical_bs": {"status": "MINOR_DRIFT", "totals": {}},
        "ai_audit": {
            "content_hash": content_hash,
            "prompt_versions": prompt_versions or lane_config.prompt_versions(),
            "model": lane_config.MODEL_ID,
        },
    }
    env.update(extra_env or {})
    return {
        "id": "period-1",
        "currency": "HUF",
        "assembled_canonical_v1": env,
        "updated_at": "2026-08-19T00:00:00Z",
    }


def test_cache_hit_zero_client_calls():
    factory = _ExplodingFactory()
    row = _cached_period_row(lane.content_hash_of(HU_BYTES))
    parsed = lane.run_ai_lane(
        doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=factory,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert factory.calls == 0  # ZERO model client constructions/calls
    assert parsed["detected_type"] == AI_LANE_DETECTED_TYPE
    assert parsed["ai_lane"]["cached"] is True
    assert parsed["ai_lane"]["period_id"] == "period-1"


def test_cache_miss_on_prompt_version_bump():
    stale_versions = dict(lane_config.prompt_versions())
    stale_versions["extract"] = "extract_v0_stale"
    row = _cached_period_row(lane.content_hash_of(HU_BYTES), prompt_versions=stale_versions)
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    parsed = lane.run_ai_lane(
        doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=lambda: client,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert parsed["ai_lane"]["cached"] is False
    assert len(client.messages.calls) == 3  # re-extracted


def test_cache_miss_on_content_hash_change():
    row = _cached_period_row("deadbeef" * 8)
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    parsed = lane.run_ai_lane(
        doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=lambda: client,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert parsed["ai_lane"]["cached"] is False


def test_force_reextract_doc_flag_bypasses_cache():
    row = _cached_period_row(lane.content_hash_of(HU_BYTES))
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    doc = dict(HU_DOC)
    doc["force_reextract"] = True
    parsed = lane.run_ai_lane(
        doc=doc, file_bytes=HU_BYTES, kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=lambda: client,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert parsed["ai_lane"]["cached"] is False
    assert len(client.messages.calls) == 3


def test_force_reextract_envelope_marker_bypasses_cache():
    row = _cached_period_row(
        lane.content_hash_of(HU_BYTES),
        extra_env={FORCE_REEXTRACT_ENVELOPE_KEY: True},
    )
    client = _FakeClient([FMT_JSON, EXTRACT_JSON, CLASSIFY_JSON])
    parsed = lane.run_ai_lane(
        doc=dict(HU_DOC), file_bytes=HU_BYTES, kind="csv",
        resolution=dict(HU_RESOLUTION),
        client_factory=lambda: client,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert parsed["ai_lane"]["cached"] is False
    assert len(client.messages.calls) == 3


# ── 5. RO documents never enter the AI lane ────────────────────────────

RO_GOLDEN = [
    REPO / "files" / "prod_scandia_frozen_31.12.2025.xlsx",
    REPO / "files" / "agras_tb_2025.xlsx",
    REPO / "files" / "scandia_realestate_tb_2025.xlsx",
    REPO / "files" / "carniprod_tb_2025.xlsx",
]


@pytest.mark.parametrize("path", RO_GOLDEN, ids=[p.name for p in RO_GOLDEN])
def test_pipeline_gate_ro_fixture_never_enters_ai_lane(path: Path, monkeypatch):
    if not path.is_file():
        pytest.skip("golden fixture not present in this checkout: %s" % path.name)
    from engine.api import pipeline as _pipeline

    def _boom(**kwargs):  # pragma: no cover — must never run
        raise AssertionError("run_ai_lane called for an RO document")

    monkeypatch.setattr(lane, "run_ai_lane", _boom)
    doc = {"id": "doc-ro", "org_id": "org-1", "original_filename": path.name}
    assert _pipeline._maybe_route_ai_lane(doc, path.read_bytes(), "xlsx") is None


def test_pipeline_gate_hu_fixture_routes_to_ai_lane(monkeypatch):
    from engine.api import pipeline as _pipeline

    seen: Dict[str, Any] = {}

    def _fake_run(**kwargs):
        seen.update(kwargs)
        return {"detected_type": AI_LANE_DETECTED_TYPE, "ai_lane": {"cached": False}}

    monkeypatch.setattr(lane, "run_ai_lane", _fake_run)
    doc = {"id": "doc-hu", "org_id": "org-1",
           "original_filename": "hu_szamlatukor_tb_2025.csv"}
    parsed = _pipeline._maybe_route_ai_lane(doc, HU_BYTES, "csv")
    assert parsed is not None and parsed["detected_type"] == AI_LANE_DETECTED_TYPE
    assert seen["resolution"]["jurisdiction"] == "HU"
    assert seen["kind"] == "csv"
    assert callable(seen["admin_factory"])  # pipeline injects Supabase access


def test_pipeline_gate_resolver_crash_defaults_to_ro_path(monkeypatch):
    from engine.api import pipeline as _pipeline

    def _crash(doc, file_bytes, user_choice=None):
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr(lane, "resolve_jurisdiction", _crash)
    doc = {"id": "doc-x", "org_id": "org-1", "original_filename": "x.csv"}
    assert _pipeline._maybe_route_ai_lane(doc, b"anything", "csv") is None


# ── 6. Real persist seam — envelope through pipeline.stage_persist ─────


class _PersistFakeAdmin:
    """Just enough Supabase-admin surface for the REAL stage_persist
    (mirrors tests/engine/test_reconciliation.py's fake)."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Any] = []
        self.inserted_line_items: List[Dict[str, Any]] = []

    def select(self, table, *, filters=None, columns="*", limit=None,
               order=None, single=False):
        if table != "financial_periods":
            return []

        def _matches(row):
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if _matches(r)]

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-ai-1"
            self.period_rows.append(new)
            return [new]
        if table == "statement_line_items":
            self.inserted_line_items.extend(rows_list)
        return rows_list if returning else []

    def update(self, table, patch, *, filters):
        import copy as _copy
        self.updates.append((table, _copy.deepcopy(patch), dict(filters or {})))

    def delete(self, table, *, filters=None):
        return None


def test_ai_envelope_flows_through_real_stage_persist(monkeypatch):
    import contextlib

    from engine.api import pipeline as _pipeline

    parsed = _run_happy_path()
    assembled = parsed["ai_lane"]["assembled"]

    fake = _PersistFakeAdmin()

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    monkeypatch.setattr(_pipeline._supabase, "admin", _fake_admin)
    doc = dict(HU_DOC)
    doc["content_hash"] = "doc-row-hash"
    period_id = _pipeline.stage_persist(doc, parsed, assembled)
    assert period_id == "period-ai-1"

    envelope_writes = [
        patch["assembled_canonical_v1"]
        for table, patch, _f in fake.updates
        if table == "financial_periods" and "assembled_canonical_v1" in patch
    ]
    assert envelope_writes, "stage_persist wrote no canonical envelope"
    written = envelope_writes[-1]

    # canonical_bs + ai_audit survive the persist seam verbatim.
    assert written["canonical_bs"]["extraction"]["method"] == "llm"
    assert written["canonical_bs"]["status"] == "MINOR_DRIFT"
    assert written["ai_audit"]["content_hash"] == lane.content_hash_of(HU_BYTES)
    # Provenance stamp added by stage_persist (documents.content_hash).
    assert written["provenance"]["source_document_id"] == doc["id"]
    assert written["provenance"]["content_hash"] == "doc-row-hash"
    # Auto-reconcile stayed OUT of scope for the llm extraction: no
    # receipt was written and the status was not massaged.
    assert "reconciliation" not in written
    assert written.get(FORCE_REEXTRACT_ENVELOPE_KEY) is None
    # Line items landed (the classified accounts, sans needs_review).
    codes = {li.get("ro_account_code") for li in fake.inserted_line_items}
    assert "384" in codes and "466" not in codes


# ── 7. Reextract route sets the envelope marker ────────────────────────

class _FakeRouter:
    def __init__(self) -> None:
        self.posts: Dict[str, Any] = {}

    def post(self, path: str):
        def deco(fn):
            self.posts[path] = fn
            return fn
        return deco


class _FakeUserCtx:
    def __init__(self, rows): self._rows = rows
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def select(self, table, filters=None, single=False): return list(self._rows)


class _FakeWriteAdminCtx(_FakeAdminCtx):
    def __init__(self, rows):
        super().__init__(rows)
        self.updates: List[Any] = []

    def select(self, table, filters=None, order=None, single=False):
        self.selects.append((table, filters))
        return list(self.rows)

    def update(self, table, payload, filters=None):
        self.updates.append((table, payload, filters))


def test_reextract_route_sets_force_flag_hint_and_triggers(monkeypatch):
    from engine.ai_lane import routes as lane_routes
    from engine.api import _supabase as sup
    from engine.api import pipeline as _pipeline

    period_row = {
        "id": "p-1",
        "source_document_id": "doc-9",
        "assembled_canonical_v1": {"canonical_bs": {"totals": {}}},
    }
    admin = _FakeWriteAdminCtx([period_row])
    enqueued: List[str] = []
    monkeypatch.setattr(sup, "per_user", lambda jwt: _FakeUserCtx([{"id": "p-1"}]))
    monkeypatch.setattr(sup, "admin", lambda: admin)
    monkeypatch.setattr(_pipeline, "_enqueue", lambda doc_id: enqueued.append(doc_id))

    router = _FakeRouter()
    lane_routes.register_routes(router, require_jwt=lambda auth: "jwt-ok")
    handler = router.posts["/api/period/{period_id}/reextract"]

    out = handler(period_id="p-1", authorization="Bearer x",
                  payload={"jurisdiction": "HU"})
    assert out["status"] == "reextract_scheduled" and out["ok"] is True
    assert out["triggered"] is True and enqueued == ["doc-9"]

    updates = {t: (p, f) for t, p, f in admin.updates}
    # Jurisdiction override persisted onto the document (resolver's
    # user-choice rung reads documents.jurisdiction_hint).
    assert updates["documents"][0] == {"jurisdiction_hint": "HU"}
    # Force flag persisted on the envelope (ai-lane cache bypass).
    env = updates["financial_periods"][0]["assembled_canonical_v1"]
    assert env[FORCE_REEXTRACT_ENVELOPE_KEY] is True


def test_reextract_route_rejects_unknown_jurisdiction(monkeypatch):
    from fastapi import HTTPException

    from engine.ai_lane import routes as lane_routes

    router = _FakeRouter()
    lane_routes.register_routes(router, require_jwt=lambda auth: "jwt-ok")
    handler = router.posts["/api/period/{period_id}/reextract"]
    with pytest.raises(HTTPException) as exc:
        handler(period_id="p-1", authorization="Bearer x",
                payload={"jurisdiction": "DE"})
    assert exc.value.status_code == 422


def test_reextract_route_survives_missing_hint_column(monkeypatch):
    from engine.ai_lane import routes as lane_routes
    from engine.api import _supabase as sup
    from engine.api import pipeline as _pipeline

    class _HintlessAdmin(_FakeWriteAdminCtx):
        def update(self, table, payload, filters=None):
            if table == "documents":
                raise RuntimeError(
                    "Could not find the 'jurisdiction_hint' column of 'documents'"
                )
            super().update(table, payload, filters)

    period_row = {
        "id": "p-1",
        "source_document_id": "doc-9",
        "assembled_canonical_v1": {"canonical_bs": {"totals": {}}},
    }
    admin = _HintlessAdmin([period_row])
    monkeypatch.setattr(sup, "per_user", lambda jwt: _FakeUserCtx([{"id": "p-1"}]))
    monkeypatch.setattr(sup, "admin", lambda: admin)
    monkeypatch.setattr(_pipeline, "_enqueue", lambda doc_id: None)

    router = _FakeRouter()
    lane_routes.register_routes(router, require_jwt=lambda auth: "jwt-ok")
    handler = router.posts["/api/period/{period_id}/reextract"]
    out = handler(period_id="p-1", authorization="Bearer x",
                  payload={"jurisdiction": "HU"})
    # Graceful degradation — the force flag still landed.
    assert out["status"] == "reextract_scheduled"
    envelopes = [p for t, p, _f in admin.updates if t == "financial_periods"]
    assert envelopes and envelopes[0]["assembled_canonical_v1"][FORCE_REEXTRACT_ENVELOPE_KEY] is True
