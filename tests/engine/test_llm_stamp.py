"""Scanned-PDF LLM-fallback provenance stamp — integrity regression.

Verifier finding (corpus build, 2026-08-20), reproduced verbatim as a
failing test per the operator's rule "no fix lands without its red test":

    the RO PDF LLM fallback (financial_statements.parse_document ->
    stage_extract PDF branch) returns no "extraction" stamp, so
    build_canonical_bs_v2 defaults to method="deterministic" and the
    envelope can claim BALANCED — violating CANONICAL_BS_V2
    ("llm => never BALANCED") and leaving it eligible for auto-reconcile.

The test drives the SAME machinery as the llm_fallback_scanned_pdf corpus
case (scripts/corpus_replay.py _run_ro_llm_fallback: scripted anthropic
module + real stage_map/stage_persist against the fake admin — zero live
API) and asserts the persisted envelope carries the llm stamp and the
capped status end to end (persisted AND served).
"""

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location(
    "corpus_replay_for_stamp_test", REPO / "scripts" / "corpus_replay.py"
)
_replay = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_replay)  # type: ignore[union-attr]


def _run_llm_fallback_case():
    case_dir = REPO / "corpus" / "llm_fallback_scanned_pdf"
    assert case_dir.is_dir(), "corpus case llm_fallback_scanned_pdf missing"
    meta = _replay._load_meta(case_dir)
    input_path = _replay._input_path(case_dir)
    content = input_path.read_bytes()
    with _replay.no_live_api_guard():
        return _replay._run_ro_llm_fallback(
            case_dir.name, meta, input_path, content
        )


def test_scanned_pdf_llm_fallback_carries_llm_stamp_and_cap():
    _extraction, _classification, envelope, _currency = _run_llm_fallback_case()

    cbs = (envelope or {}).get("canonical_bs") or {}
    ext = cbs.get("extraction") or {}
    assert ext.get("method") == "llm", (
        "scanned-PDF fallback must stamp extraction.method='llm' — got "
        f"{ext.get('method')!r}; the never-BALANCED cap keys off this stamp"
    )
    assert cbs.get("status") != "BALANCED", (
        f"llm-extracted document may never claim BALANCED (got {cbs.get('status')!r})"
    )

    # Served view too — the stamp must survive the serve stage.
    from engine.api import _reconcile

    served = _reconcile.served_canonical_bs(envelope)
    assert (served.get("extraction") or {}).get("method") == "llm"
    assert served.get("status") != "BALANCED"
