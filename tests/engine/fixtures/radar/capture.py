#!/usr/bin/env python3
"""Capture the Radar fixtures from REAL ENGINE OUTPUT (TC-1).

Every fixture in this directory is what the REAL pipeline produces for
one committed trial balance — parse -> assemble -> ``stage_persist`` (the
composition ``scripts/corpus_replay.py`` runs, loaded here by path so
there is exactly one implementation) — plus what the REAL detector
engine and the REAL Radar serving layer return over it. Nothing is
hand-built.

    .venv/bin/python tests/engine/fixtures/radar/capture.py          # rewrite
    .venv/bin/python tests/engine/fixtures/radar/capture.py --check  # diff only

Per case the file carries:

  envelope          the persisted assembled_canonical_v1 (stage_persist)
  line_items        assembled["lineItems"] — what statement_line_items
                    stores
  statements        the statements REBUILT from those line items and
                    that envelope through `pipeline._rebuild_assembled_
                    for_briefing` — the seam /api/period, the Capsule
                    and the Radar route all read. MEASURED, not assumed:
                    with the envelope on the row the rebuild applies the
                    persisted reconciliation, so its totals are the
                    gateway's ADJUSTED totals (agras: 39,319,114.09) and
                    not the raw assemble-path ones (39,272,501.03), and
                    it anchors statutory net income on account 121
                    (retail: 3,205,212.62, not the class-6/7
                    reconstruction 1,161,957.98 — commit 06ee60f). The
                    surfaces read the anchored, adjusted view; so does
                    this capture. `_meta.assemble_path_total_assets`
                    keeps the raw figure beside it, and
                    `_meta.net_income_anchor` records the anchor status
                    the seam labelled, so a capture taken on an
                    unanchored seam is visible as such.
  single_period     s_engine.run_single_period over the statements:
                    payloads, all_checks, silence — the Capsule's
                    list_findings reads exactly these
  radar             engine.radar.serve.serve_period over the same
                    period, alone on its spine (cold start) — the golden
                    the determinism gate replays against

The ONE scrub: ``envelope.provenance.written_at`` is a wall-clock stamp
the persist stage writes; it is pinned to the epoch so the capture is
byte-reproducible. Nothing else is touched.

Sources: corpus/saga_10_col_{carniprod,agras,retail,realestate} (real,
anonymised), corpus/saga_10_col (prod-frozen fictional data) and
corpus/imbalance_03pct (synthetic input, real engine output — the one
book that carries a CRITICAL data-quality finding).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.api import pipeline as _pipeline  # noqa: E402
from engine.api.findings import s_engine  # noqa: E402
from engine.core.country_pack_registry import get_pack  # noqa: E402
from engine.radar import serve as RS  # noqa: E402

EPOCH = "1970-01-01T00:00:00+00:00"

CASES = (
    "saga_10_col_carniprod",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
    "saga_10_col",
    "imbalance_03pct",
)


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


corpus_replay = _load_by_path("corpus_replay", REPO / "scripts" / "corpus_replay.py")


# ── The real composition, once ───────────────────────────────────────────


def run_engine(case_id: str, filename: str, content: bytes,
               period_end_hint: Optional[str]
               ) -> Tuple[Dict[str, Any], Dict[str, Any], List[Dict[str, Any]], str]:
    """parse -> assemble -> the REAL stage_persist (against corpus_replay's
    fake admin). Returns (envelope, statements, line_items, currency)."""
    pack = get_pack("RO")
    tb_rows = pack.parse_trial_balance(content, filename)
    _tb, shaped, assembled = pack.assemble_parsed_tb(
        tb_rows, company_name=Path(filename).stem, period_label="Imported period")
    doc = {
        "id": "doc-%s" % case_id,
        "org_id": "org-%s" % case_id,
        "original_filename": filename,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": period_end_hint,
    }
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows))
    with corpus_replay.no_live_api_guard():
        envelope = corpus_replay.run_stage_persist(doc, parsed, assembled)
    prov = envelope.get("provenance")
    if isinstance(prov, dict) and "written_at" in prov:
        prov["written_at"] = EPOCH
    line_items = [dict(li) for li in (assembled.get("lineItems") or [])]
    return envelope, assembled["statements"], line_items, str(parsed.get("currency") or "RON")


def served_statements(case: str, envelope: Dict[str, Any],
                      line_items: List[Dict[str, Any]], currency: str,
                      period_end: str) -> Dict[str, Any]:
    """The statements every surface reads: rebuilt from the persisted
    line items with the persisted envelope on the period row, through
    the ONE rebuild seam. The row carries what the route's light listing
    carries."""
    row = {
        "id": "p-%s" % case, "currency": currency, "period_end": period_end,
        "period_start": period_end[:4] + "-01-01",
        "source_document_id": "doc-%s" % case,
        "assembled_canonical_v1": envelope,
    }
    return _pipeline._rebuild_assembled_for_briefing(line_items, row, None)["statements"]


def period_input(case: str, fixture: Dict[str, Any], ordinal: int = 0) -> RS.PeriodInput:
    """The target as the route would hand it over: the persisted envelope,
    the rebuilt statements, the envelope's content hash as the snapshot
    id (the id the FactsGateway stamps on every fact) and the source
    document under its own name — the detectors are handed the document
    id, the Capsule's convention (R1)."""
    envelope = fixture["envelope"]
    content_hash = str(((envelope.get("provenance") or {}).get("content_hash")) or "")
    return RS.PeriodInput(
        period_id="p-%s" % case, label="FY%s" % fixture["period_end"][:4],
        period_end=fixture["period_end"], period_start=fixture["period_start"],
        ordinal=int(ordinal), currency=fixture["currency"],
        statements=fixture["statements"], envelope=envelope,
        snapshot_id=content_hash or None, source_document_id="doc-%s" % case,
        content_key=content_hash or None, caen=None)


def single_period_capture(case: str, statements: Dict[str, Any]) -> Dict[str, Any]:
    result = s_engine.run_single_period(
        statements, period_id="p-%s" % case, caen=None, snapshot_id="doc-%s" % case)
    return {
        "profile_id": result.profile.profile_id,
        "payloads": result.payloads(),
        "surfaced_rule_keys": [r["rule_key"] for r in result.surfaced()],
        "all_checks": result.all_checks(),
        "silence": result.silence_statement(),
    }


def _corpus_input(case: str) -> Tuple[Path, Dict[str, Any]]:
    case_dir = REPO / "corpus" / case
    return corpus_replay._input_path(case_dir), corpus_replay._load_meta(case_dir)


def build_all() -> Dict[str, Dict[str, Any]]:
    out = {}  # type: Dict[str, Dict[str, Any]]
    for case in CASES:
        input_path, meta = _corpus_input(case)
        content = input_path.read_bytes()
        period_end = str(meta.get("period_end") or "2025-12-31")
        envelope, assembled_statements, line_items, currency = run_engine(
            case, input_path.name, content, period_end)
        statements = served_statements(case, envelope, line_items, currency, period_end)
        fixture = {
            "_meta": {"source": "corpus/%s/%s" % (case, input_path.name),
                      "synthetic": bool(meta.get("synthetic")),
                      "captured_by": "tests/engine/fixtures/radar/capture.py",
                      "engine_path": "parse -> assemble -> stage_persist (corpus_replay "
                                     "seam) -> _rebuild_assembled_for_briefing over the "
                                     "persisted line items + envelope (the served seam) "
                                     "-> s_engine.run_single_period -> "
                                     "engine.radar.serve.serve_period",
                      "assemble_path_total_assets": (assembled_statements.get(
                          "assembled_bs") or {}).get("total_assets"),
                      "served_total_assets": (statements.get("assembled_bs") or {}
                                              ).get("total_assets"),
                      "net_income_anchor": {
                          "status": (statements.get("assembled_pl") or {}
                                     ).get("net_income_anchor_status"),
                          "source": (statements.get("assembled_pl") or {}
                                     ).get("net_income_anchor_source"),
                          "account_121": (statements.get("assembled_pl") or {}
                                          ).get("net_income_statutory_anchor"),
                          "served": (statements.get("assembled_pl") or {}
                                     ).get("net_income_statutory")},
                      "scrubbed": ["envelope.provenance.written_at -> epoch"]},
            "case_id": case,
            "period_end": period_end,
            "period_start": period_end[:4] + "-01-01",
            "currency": currency,
            "envelope": envelope,
            "statements": statements,
            "line_items": line_items,
        }
        fixture["single_period"] = single_period_capture(case, statements)
        request = RS.RadarRequest(org_id="org-%s" % case,
                                  target=period_input(case, fixture))
        fixture["radar"] = RS.serve_period(request)
        out[case] = fixture
    return out


def _dump(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False,
                      default=str) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    check = "--check" in args
    fixtures = build_all()
    changed = []  # type: List[str]
    for case, payload in sorted(fixtures.items()):
        target = HERE / (case + ".json")
        text = _dump(payload)
        if target.is_file() and target.read_text(encoding="utf-8") == text:
            print("unchanged %s" % target.relative_to(REPO))
            continue
        changed.append(case)
        if check:
            print("DIFFERS   %s" % target.relative_to(REPO))
        else:
            target.write_text(text, encoding="utf-8")
            print("wrote     %s" % target.relative_to(REPO))
    if check and changed:
        print("RADAR FIXTURES: %d case(s) differ from the committed capture"
              % len(changed))
        return 1
    print("RADAR FIXTURES: %s — %d case(s)" % ("PASS" if check else "written",
                                               len(fixtures)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
