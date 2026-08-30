"""Offline capture of a REAL /api/period `statements` payload for a corpus case.

Composition mirrors scripts/corpus_replay.py (pack.parse_trial_balance ->
assemble_parsed_tb -> pipeline.stage_persist) and then the /api/period serve
path: statements.assembled_canonical_v1 = the re-assembled envelope
(pipeline.py:4792), then _apply_envelope_truth_to_statements swaps in the
PERSISTED served canonical_bs (pipeline.py:4819). Nothing is hand-written.
"""
import json, os, sys, pathlib
REPO = pathlib.Path("/Users/alex/Desktop/folder claude Scandia copy")
sys.path.insert(0, str(REPO / "src")); sys.path.insert(0, str(REPO / "scripts"))
os.chdir(REPO)
import corpus_replay as CR
from engine.core.country_pack_registry import get_pack
from engine.api import pipeline as _pipeline

case_id, company, period_label, out = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
case_dir = REPO / "corpus" / case_id
meta = CR._load_meta(case_dir)
inp = [p for p in sorted(case_dir.iterdir()) if p.name.startswith("input")][0]
content = inp.read_bytes()
pack = get_pack("RO")
tb_rows = pack.parse_trial_balance(content, inp.name)
_t, shaped, assembled = pack.assemble_parsed_tb(
    tb_rows, company_name=company, period_label=period_label)
doc = CR._doc_for(case_id, inp, content, meta)
parsed = _pipeline._deterministic_tb_parsed(
    doc, tb_rows, shaped,
    pack.compute_statutory_net_profit_anchor(tb_rows),
    pack.compute_source_imbalance(tb_rows))
envelope = CR.run_stage_persist(doc, parsed, assembled)
statements = assembled["statements"]
statements["assembled_canonical_v1"] = assembled.get("assembled_canonical_v1")
_pipeline._apply_envelope_truth_to_statements(
    statements, {"assembled_canonical_v1": envelope})
# VOLATILE-KEY normalizer, same discipline as corpus_replay: run-time stamps
# are replaced so the fixture is byte-stable across regenerations.
VOLATILE = ("written_at", "applied_at", "attempted_at", "updated_at", "at",
            "archived_at", "undone_at", "suppressed_at", "period_end",
            "detected_at")
def scrub(o):
    if isinstance(o, dict):
        return {k: ("<normalized>" if k in VOLATILE else scrub(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub(v) for v in o]
    return o
# PROJECTION (deletion only, never an edit): the envelope's raw `leaves`
# and `aggregates` blocks are dropped. Tier 0 never reads them; every field
# it DOES read stays verbatim engine output.
_acv = statements.get("assembled_canonical_v1")
if isinstance(_acv, dict):
    for _drop in ("leaves", "aggregates"):
        _acv.pop(_drop, None)
statements = scrub(statements)
print("canonical_bs:", (statements.get("canonical_bs") or {}).get("status"),
      "| methodology:", bool(((statements.get("assembled_canonical_v1") or {}).get("methodology"))))
out.write_text(json.dumps(statements, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
print("wrote", out.name, out.stat().st_size, "bytes")
