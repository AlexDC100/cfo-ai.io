#!/usr/bin/env python3
"""Capture the firm-attention fixtures from REAL ENGINE OUTPUT (TC-1).

Every fixture in this directory is the persisted ``assembled_canonical_v1``
envelope plus the assembled statements that the REAL pipeline produces
for one trial balance — parse -> assemble -> ``stage_persist`` (the same
composition ``scripts/corpus_replay.py`` runs, reused here by path so
there is exactly one implementation). Nothing is hand-built.

    .venv/bin/python tests/engine/fixtures/firm/capture.py          # rewrite
    .venv/bin/python tests/engine/fixtures/firm/capture.py --check  # diff only

Sources:
  corpus/saga_10_col_{carniprod,agras,retail,realestate}   real, anonymised
  corpus/imbalance_03pct                                    synthetic input,
                                                            real engine output
  carniprod_filed_under_2017        the 2026-08-30 production audit case
                                    (tests/engine/fixtures/period_detect/
                                    production_cases.json) run through the
                                    REAL persist-time period resolver, so the
                                    envelope carries a genuine mismatch record
  synthetic_thin_equity /           a declared synthetic TB (equity at 10% /
  synthetic_negative_equity         -20% of capital) run through the REAL
                                    engine — the corpus carries no company
                                    below the art. 153^24 floor, and a fixture
                                    that never breaches proves nothing

The ONE scrub: ``envelope.provenance.written_at`` is a wall-clock stamp
the persist stage writes; it is pinned to the epoch so the capture is
byte-reproducible. Nothing else is touched.

The synthetic inputs are COMMITTED as bytes under ``inputs/`` and read
from there (an xlsx written by openpyxl carries zip timestamps, so
regenerating it changes the content hash the engine stamps). Pass
``--regen-inputs`` to rewrite them deliberately.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
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
from engine.core.country_pack_registry import get_pack  # noqa: E402

EPOCH = "1970-01-01T00:00:00+00:00"
INPUTS = HERE / "inputs"


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
synth = _load_by_path(
    "ro_synthetic_fixtures",
    SRC / "engine" / "country_packs" / "ro_romania" / "fixtures" / "synthetic"
    / "make_synthetic_fixtures.py")


# ── The real composition, once ───────────────────────────────────────────


def run_engine(case_id: str, filename: str, content: bytes,
               period_end_hint: Optional[str]
               ) -> Tuple[Dict[str, Any], Dict[str, Any], str, List[Dict[str, Any]]]:
    """parse -> assemble -> the REAL stage_persist (against corpus_replay's
    fake admin). Returns (envelope, statements, currency, line_items).

    ``line_items`` are the ``statement_line_items`` rows stage_persist
    INSERTED (minus the synthetic ``period_id``) — what the attention
    route reads back to rebuild statements through
    ``pipeline._rebuild_assembled_for_briefing`` on a cache miss. They are
    captured here, from the same persist run, so the route-shaped FC9
    gate drives the real rebuild path over real persisted rows."""
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
    # corpus_replay.run_stage_persist returns only the envelope; the same
    # seam is opened here so the inserted line items are captured too.
    with corpus_replay.no_live_api_guard():
        with corpus_replay.fake_persist_seam() as fake:
            period_id = _pipeline.stage_persist(doc, parsed, assembled)
            if period_id != "period-1":
                raise RuntimeError("stage_persist resolved unexpected period id %r" % period_id)
            envelope_writes = [
                patch["assembled_canonical_v1"]
                for table, patch, _f in fake.updates
                if table == "financial_periods" and "assembled_canonical_v1" in patch
            ]
            line_items = [dict((k, v) for k, v in row.items() if k != "period_id")
                          for row in fake.inserted_line_items]
    if not envelope_writes:
        raise RuntimeError("stage_persist wrote no canonical envelope")
    envelope = envelope_writes[-1]
    prov = envelope.get("provenance")
    if isinstance(prov, dict) and "written_at" in prov:
        prov["written_at"] = EPOCH
    return envelope, assembled["statements"], str(parsed.get("currency") or "RON"), line_items


# ── Synthetic inputs for the equity-floor breach (declared, not hidden) ──


def _fmt(v: float) -> str:
    return synth._fmt(v, "anglo")


def _tb(rows: List[Tuple[str, str, float, float, float, float]]) -> bytes:
    """10-col grid: (cont, name, st_d, st_c, sf_d, sf_c) — opening/rulaj
    columns blank, sume totale = rulaj for the P&L rows. A totals row
    closes the file so the source anchor is MATCHED."""
    grid = [list(synth.HEADER_10COL)]  # type: List[List[Optional[str]]]
    tot_st_d = tot_st_c = tot_sf_d = tot_sf_c = 0.0
    for cont, name, st_d, st_c, sf_d, sf_c in rows:
        grid.append([cont, name, None, None,
                     _fmt(st_d) if st_d else None, _fmt(st_c) if st_c else None,
                     _fmt(st_d) if st_d else None, _fmt(st_c) if st_c else None,
                     _fmt(sf_d) if sf_d else None, _fmt(sf_c) if sf_c else None])
        tot_st_d += st_d
        tot_st_c += st_c
        tot_sf_d += sf_d
        tot_sf_c += sf_c
    grid.append([None, "TOTAL", None, None, _fmt(tot_st_d), _fmt(tot_st_c),
                 _fmt(tot_st_d), _fmt(tot_st_c), _fmt(tot_sf_d), _fmt(tot_sf_c)])
    return synth._workbook_bytes(grid, "TB")


def thin_equity_tb() -> bytes:
    """Capital 100,000; loss 90,000 -> net assets 10,000 (10% of capital,
    below the 50% floor, still positive)."""
    return _tb([
        ("1012", "Capital subscris varsat", 0, 100000, 0, 100000),
        ("121", "Profit sau pierdere", 90000, 0, 90000, 0),
        ("5121", "Conturi la banci in lei", 8000, 0, 8000, 0),
        ("371", "Marfuri", 2000, 0, 2000, 0),
        ("607", "Cheltuieli privind marfurile", 90000, 0, 0, 0),
    ])


def negative_equity_tb() -> bytes:
    """Capital 100,000; loss 120,000 -> net assets -20,000; payables 28,000
    balance the 8,000 of cash."""
    return _tb([
        ("1012", "Capital subscris varsat", 0, 100000, 0, 100000),
        ("121", "Profit sau pierdere", 120000, 0, 120000, 0),
        ("5121", "Conturi la banci in lei", 8000, 0, 8000, 0),
        ("401", "Furnizori", 0, 28000, 0, 28000),
        ("607", "Cheltuieli privind marfurile", 120000, 0, 0, 0),
    ])


# ── The fixture book ─────────────────────────────────────────────────────


def _corpus_input(case: str) -> Tuple[Path, Dict[str, Any]]:
    case_dir = REPO / "corpus" / case
    return corpus_replay._input_path(case_dir), corpus_replay._load_meta(case_dir)


def build_all() -> Dict[str, Dict[str, Any]]:
    out = {}  # type: Dict[str, Dict[str, Any]]
    for case in ("saga_10_col_carniprod", "saga_10_col_agras", "saga_10_col_retail",
                 "saga_10_col_realestate", "imbalance_03pct"):
        input_path, meta = _corpus_input(case)
        content = input_path.read_bytes()
        period_end = str(meta.get("period_end") or "2025-12-31")
        envelope, statements, currency, line_items = run_engine(
            case, input_path.name, content, period_end)
        out[case] = {
            "_meta": {"source": "corpus/%s/%s" % (case, input_path.name),
                      "synthetic": bool(meta.get("synthetic")),
                      "captured_by": "tests/engine/fixtures/firm/capture.py",
                      "engine_path": "parse -> assemble -> stage_persist (corpus_replay seam)",
                      "scrubbed": ["envelope.provenance.written_at -> epoch"]},
            "case_id": case,
            "period_end": period_end,
            "period_start": period_end[:4] + "-01-01",
            "currency": currency,
            "envelope": envelope,
            "statements": statements,
            "line_items": line_items,
        }

    # The production audit case: a 2025 file confirmed under 2017-12.
    audit = json.loads((REPO / "tests" / "engine" / "fixtures" / "period_detect"
                        / "production_cases.json").read_text(encoding="utf-8"))
    case = [c for c in audit["cases"] if c["id"] == "carniprod_2025_filed_under_2017"][0]
    input_path, _meta = _corpus_input("saga_10_col_carniprod")
    envelope, statements, currency, line_items = run_engine(
        "carniprod_filed_under_2017", case["filename"], input_path.read_bytes(),
        case["period_end_hint"])
    out["carniprod_filed_under_2017"] = {
        "_meta": {"source": "corpus/saga_10_col_carniprod/input.xlsx as %r with hint %s"
                            % (case["filename"], case["period_end_hint"]),
                  "audit_case": case["id"], "synthetic": False,
                  "captured_by": "tests/engine/fixtures/firm/capture.py",
                  "engine_path": "parse -> assemble -> stage_persist (real period resolver)",
                  "scrubbed": ["envelope.provenance.written_at -> epoch"]},
        "case_id": "carniprod_filed_under_2017",
        "period_end": case["stored_period_end"],
        "period_start": case["stored_period_end"][:4] + "-01-01",
        "currency": currency,
        "envelope": envelope,
        "statements": statements,
        "line_items": line_items,
    }

    for case, builder, note in (
            ("synthetic_thin_equity", thin_equity_tb, "net assets 10% of capital"),
            ("synthetic_negative_equity", negative_equity_tb, "net assets -20% of capital")):
        content = _synthetic_input(case, builder)
        envelope, statements, currency, line_items = run_engine(
            case, case + ".xlsx", content, "2025-12-31")
        out[case] = {
            "_meta": {"source": "declared synthetic TB (capture.py:%s)" % builder.__name__,
                      "synthetic": True, "note": note,
                      "captured_by": "tests/engine/fixtures/firm/capture.py",
                      "engine_path": "parse -> assemble -> stage_persist",
                      "scrubbed": ["envelope.provenance.written_at -> epoch"]},
            "case_id": case,
            "period_end": "2025-12-31",
            "period_start": "2025-01-01",
            "currency": currency,
            "envelope": envelope,
            "statements": statements,
            "line_items": line_items,
        }
    return out


REGEN_INPUTS = False


def _synthetic_input(case: str, builder) -> bytes:
    """The committed input bytes, written once by the builder."""
    INPUTS.mkdir(parents=True, exist_ok=True)
    target = INPUTS / (case + ".xlsx")
    if REGEN_INPUTS or not target.is_file():
        target.write_bytes(builder())
        print("wrote %s" % target.relative_to(REPO))
    return target.read_bytes()


def _dump(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False,
                      default=str) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    global REGEN_INPUTS
    args = list(sys.argv[1:] if argv is None else argv)
    check = "--check" in args
    REGEN_INPUTS = "--regen-inputs" in args
    fixtures = build_all()
    changed = []  # type: List[str]
    for case, payload in sorted(fixtures.items()):
        target = HERE / (case + ".json")
        text = _dump(payload)
        if check:
            if not target.is_file() or target.read_text(encoding="utf-8") != text:
                changed.append(case)
        else:
            target.write_text(text, encoding="utf-8")
            print("wrote %s (%d bytes)" % (target.relative_to(REPO), len(text)))
    if check:
        if changed:
            print("FIRM FIXTURES DRIFT — regenerate with capture.py: %s" % ", ".join(changed))
            return 1
        print("FIRM FIXTURES: byte-identical to a fresh capture (%d cases)" % len(fixtures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
