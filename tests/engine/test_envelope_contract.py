"""SERVED-ENVELOPE CONTRACT (sv1) — docs/served_envelope.schema.json.

Two halves:

  1. CONTRACT VALIDATION — every serving of every fixture (the golden
     XLSX registry from scripts/verify_determinism.py, the Phase-5
     synthetic locale fixtures, the reconciliation states — BS-placed,
     P&L-placed, needs-review, suppressed-after-undo, hash-mismatch —
     and the AI-lane happy path) validates against the schema's
     $defs/canonical_bs, and the full serve-hook output validates
     against the top-level statements shape. `jsonschema` is not in the
     engine deps, so a minimal validator (type/const/enum/required/
     properties/items/$ref) lives here — enough for the subset the
     schema uses, and it fails loudly on unknown $ref targets.

  2. SCHEMA SNAPSHOT — tests/engine/served_envelope_schema_snapshot.json
     is the checked-in flattened field->type listing. Any field REMOVAL
     or RETYPE fails this suite unless `envelope_version` is bumped in
     the schema header AND a migration_notes entry for the new version
     is added (then the snapshot is regenerated:
     `python tests/engine/test_envelope_contract.py --regen`). Additions
     also require a regen so the snapshot can never go stale.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

REPO = Path(__file__).resolve().parents[2]
# sys.path bootstrap — same pattern as conftest.py, repeated here so the
# --regen entry point works under direct `python` execution too.
_SRC = REPO / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.api import _reconcile  # noqa: E402
from engine.serving import ENVELOPE_VERSION  # noqa: E402
SCHEMA_PATH = REPO / "docs" / "served_envelope.schema.json"
SNAPSHOT_PATH = Path(__file__).resolve().parent / "served_envelope_schema_snapshot.json"
SYNTHETIC_DIR = (
    REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures" / "synthetic"
)

CONTENT_HASH = "sha256-contract-fixture"


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_schema() -> Dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# ── Minimal JSON Schema validator (subset the schema file uses) ────────


def _type_ok(value: Any, type_name: str) -> bool:
    if type_name == "object":
        return isinstance(value, dict)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "null":
        return value is None
    raise AssertionError("validator does not know type %r" % type_name)


def _resolve_ref(node: Dict[str, Any], defs: Dict[str, Any]) -> Dict[str, Any]:
    seen = 0
    while "$ref" in node:
        ref = node["$ref"]
        assert ref.startswith("#/$defs/"), "unsupported $ref %r" % ref
        name = ref.split("/")[-1]
        assert name in defs, "unknown $ref target %r" % ref
        node = defs[name]
        seen += 1
        assert seen < 10, "circular $ref chain at %r" % ref
    return node


def validate_instance(instance: Any, node: Dict[str, Any], defs: Dict[str, Any],
                      path: str = "$", errors: List[str] = None) -> List[str]:
    if errors is None:
        errors = []
    node = _resolve_ref(node, defs)

    declared = node.get("type")
    if declared is not None:
        types = declared if isinstance(declared, list) else [declared]
        if not any(_type_ok(instance, t) for t in types):
            errors.append("%s: expected type %s, got %s (%r)" % (
                path, "|".join(types), type(instance).__name__, instance))
            return errors  # do not descend into a mistyped node
    if "const" in node and instance != node["const"]:
        errors.append("%s: expected const %r, got %r" % (path, node["const"], instance))
    if "enum" in node and instance not in node["enum"]:
        errors.append("%s: %r not in enum %r" % (path, instance, node["enum"]))

    if isinstance(instance, dict):
        for required_key in node.get("required", []) or []:
            if required_key not in instance:
                errors.append("%s: missing required key %r" % (path, required_key))
        for key, sub_schema in (node.get("properties") or {}).items():
            if key in instance:
                validate_instance(instance[key], sub_schema, defs,
                                  "%s.%s" % (path, key), errors)
    if isinstance(instance, list) and isinstance(node.get("items"), dict):
        for i, item in enumerate(instance):
            validate_instance(item, node["items"], defs, "%s[%d]" % (path, i), errors)
    return errors


def _assert_valid_served_cbs(served: Dict[str, Any], label: str) -> None:
    schema = _load_schema()
    errors = validate_instance(served, {"$ref": "#/$defs/canonical_bs"}, schema["$defs"])
    assert errors == [], "[%s] served canonical_bs violates the sv1 schema:\n%s" % (
        label, "\n".join(errors))
    # envelope_version wiring — every serving carries the sv1 stamp.
    assert served["envelope_version"] == ENVELOPE_VERSION == "sv1"


def _assert_valid_statements(statements: Dict[str, Any], label: str) -> None:
    schema = _load_schema()
    errors = validate_instance({"statements": statements}, schema, schema["$defs"])
    assert errors == [], "[%s] served statements violate the sv1 schema:\n%s" % (
        label, "\n".join(errors))


def _serve_statements(envelope: Dict[str, Any]) -> Dict[str, Any]:
    from engine.api.pipeline import _apply_envelope_truth_to_statements

    statements: Dict[str, Any] = {"assembled_bs": {}, "assembled_pl": {"revenue": 0.0}}
    _apply_envelope_truth_to_statements(statements, {"assembled_canonical_v1": envelope})
    return statements


# ── Fixture registry (reuses the determinism script's — one source) ────


_vd = _load_by_path("verify_determinism", REPO / "scripts" / "verify_determinism.py")

_GOLDEN = [(path, label) for path, label, _expected in _vd.FIXTURES]
_SYNTHETIC = [
    (SYNTHETIC_DIR / "synthetic_tb_ro_locale.xlsx", "synthetic_ro_locale"),
    (SYNTHETIC_DIR / "synthetic_tb_anglo_locale.xlsx", "synthetic_anglo_locale"),
    (SYNTHETIC_DIR / "synthetic_tb_ro_locale.csv", "synthetic_ro_csv"),
    (SYNTHETIC_DIR / "synthetic_tb_generic_4col.xlsx", "synthetic_generic_4col"),
]
_ALL_FILES = _GOLDEN + _SYNTHETIC

_trec = _load_by_path(
    "reconciliation_fixture_builders",
    Path(__file__).resolve().parent / "test_reconciliation.py",
)


def _stamped_envelope(assembled: Dict[str, Any]) -> Dict[str, Any]:
    """The provenance stamp stage_persist adds before the single write."""
    envelope = assembled.get("assembled_canonical_v1")
    assert isinstance(envelope, dict), "fixture emitted no canonical envelope"
    envelope = copy.deepcopy(envelope)
    envelope["provenance"] = {
        "source_document_id": "doc-contract",
        "original_filename": "contract_fixture.xlsx",
        "content_hash": CONTENT_HASH,
        "written_at": "2026-08-19T00:00:00+00:00",
    }
    return envelope


# ── 1a. Every file fixture serves schema-valid ─────────────────────────


@pytest.mark.parametrize(
    "fixture_path,label", _ALL_FILES, ids=[label for _p, label in _ALL_FILES]
)
def test_file_fixture_serving_validates(run_tb, fixture_path, label):
    assert fixture_path.is_file(), "fixture missing: %s" % fixture_path
    _tb, _shaped, assembled = run_tb(fixture_path)
    envelope = _stamped_envelope(assembled)

    served = _reconcile.served_canonical_bs(envelope)
    assert isinstance(served, dict), "[%s] fixture did not serve" % label
    _assert_valid_served_cbs(served, label)

    statements = _serve_statements(envelope)
    _assert_valid_statements(statements, label)
    # The serve hook serves the SAME schema-valid object verbatim.
    assert statements["canonical_bs"]["envelope_version"] == "sv1"


# ── 1b. Every reconciliation state serves schema-valid ─────────────────


def test_reconciled_bs_placed_serving_validates(pack):
    env = _trec._envelope_for(pack, _trec.ROUNDING_ROWS)
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "accepted" and out["placement"] == "balance_sheet"
    served = _reconcile.served_canonical_bs(env)
    assert served["status"] == "RECONCILED"
    _assert_valid_served_cbs(served, "reconciled_bs_placed")
    _assert_valid_statements(_serve_statements(env), "reconciled_bs_placed")


def test_reconciled_pnl_placed_serving_validates(pack, monkeypatch):
    env = _trec._envelope_for(pack, [
        _trec._row("5121", sf_d=1_000_777.77),
        _trec._row("704", sf_c=200.00),
        _trec._row("1012", sf_c=1_000_000.00),
    ])
    monkeypatch.setattr(
        _reconcile, "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed", "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": "704", "amount_cents": 57777,
            "rationale": "contract fixture", "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "accepted" and out["placement"] == "pnl"
    served = _reconcile.served_canonical_bs(env)
    _assert_valid_served_cbs(served, "reconciled_pnl_placed")
    statements = _serve_statements(env)
    _assert_valid_statements(statements, "reconciled_pnl_placed")
    # The P&L-placed visible line is part of the served statements contract.
    line = statements["assembled_pl"]["reconciliation_adjustment"]
    assert line["placement"] == "pl_other_income" and line["synthetic"] is True


def test_needs_review_serving_validates(pack, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "anthropic", None)
    env = _trec._envelope_for(pack, [
        _trec._row("5121", sf_d=1_000_000.00),
        _trec._row("413", sf_d=300.00),
        _trec._row("4282", sf_d=200.00),
        _trec._row("1012", sf_c=999_722.23),
    ])
    out = _reconcile.auto_reconcile_envelope(env)
    assert out["outcome"] == "needs_review"
    served = _reconcile.served_canonical_bs(env)
    assert served["needs_review"] is True and served["reconcile_offer"] is True
    _assert_valid_served_cbs(served, "needs_review")


def test_suppressed_after_undo_serving_validates(pack):
    env = _trec._envelope_for(pack, _trec.ROUNDING_ROWS)
    assert _reconcile.auto_reconcile_envelope(env)["outcome"] == "accepted"
    undone, served = _reconcile.perform_undo(env, "user-contract")
    assert served["status"] == "MINOR_DRIFT"  # the TRUE source imbalance
    _assert_valid_served_cbs(served, "suppressed_after_undo")
    # And the auto stage honors the suppression on re-persist.
    assert _reconcile.auto_reconcile_envelope(undone)["outcome"] == "suppressed"
    _assert_valid_served_cbs(
        _reconcile.served_canonical_bs(undone), "suppressed_re_serving")


def test_hash_mismatch_serving_validates(pack):
    env = _trec._envelope_for(pack, _trec.ROUNDING_ROWS)
    assert _reconcile.auto_reconcile_envelope(env)["outcome"] == "accepted"
    rescanned = copy.deepcopy(env)
    rescanned["provenance"]["content_hash"] = "sha256-DIFFERENT-FILE"
    served = _reconcile.served_canonical_bs(rescanned)
    assert served["status"] == "MINOR_DRIFT"  # stored entry ignored, kept
    _assert_valid_served_cbs(served, "hash_mismatch")


# ── 1c. AI-lane serving (needs_review ARRAY + classification + jurisdiction) ──


def test_ai_lane_serving_validates():
    ai = _load_by_path(
        "ai_lane_contract_fixture",
        Path(__file__).resolve().parent / "test_ai_lane.py",
    )
    parsed = ai._run_happy_path()
    envelope = copy.deepcopy(parsed["ai_lane"]["assembled"]["assembled_canonical_v1"])
    envelope["provenance"] = {
        "source_document_id": "doc-hu-1",
        "original_filename": "hu_szamlatukor_tb_2025.csv",
        "content_hash": CONTENT_HASH,
        "written_at": "2026-08-19T00:00:00+00:00",
    }
    served = _reconcile.served_canonical_bs(envelope)
    _assert_valid_served_cbs(served, "ai_lane_happy_path")
    # The AI-lane extras of the served contract:
    assert isinstance(served["needs_review"], list)  # array preserved
    assert served["classification"]["method"] == "llm"
    assert served["jurisdiction"]["resolved"] == "HU"
    assert served["extraction"]["method"] == "llm"
    assert served["status"] != "BALANCED"  # llm cap survives serving


# ── 2. Schema snapshot — flattened field->type listing ─────────────────


def _node_marker(node: Dict[str, Any]) -> str:
    if "$ref" in node:
        return "ref:%s" % node["$ref"].split("/")[-1]
    if "const" in node:
        return "const:%s" % node["const"]
    if "enum" in node:
        return "enum:%s" % ",".join(str(v) for v in sorted(node["enum"], key=str))
    declared = node.get("type")
    if declared is None:
        return "any"
    if isinstance(declared, list):
        return "|".join(sorted(declared))
    return str(declared)


def _flatten_node(node: Dict[str, Any], path: str, out: Dict[str, str]) -> None:
    out[path] = _node_marker(node)
    if "$ref" in node:
        return  # the target flattens under its own $defs.<name> prefix
    for key, sub in (node.get("properties") or {}).items():
        _flatten_node(sub, "%s.%s" % (path, key), out)
    items = node.get("items")
    if isinstance(items, dict):
        _flatten_node(items, "%s[]" % path, out)


def flatten_schema(schema: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key, sub in (schema.get("properties") or {}).items():
        _flatten_node(sub, "$.%s" % key, out)
    for name, sub in (schema.get("$defs") or {}).items():
        _flatten_node(sub, "$defs.%s" % name, out)
    return out


_SNAPSHOT_RULE = (
    "docs/served_envelope.schema.json changed shape. The sv1 rule: a field "
    "REMOVAL or RETYPE requires (1) bumping `envelope_version` in the schema "
    "header, (2) appending a `migration_notes` entry for the new version, and "
    "(3) regenerating the snapshot: "
    "`python tests/engine/test_envelope_contract.py --regen`. Additions only "
    "need the regen. Never edit the snapshot by hand."
)


def test_schema_snapshot_locks_field_types():
    assert SNAPSHOT_PATH.is_file(), (
        "snapshot missing — generate it: "
        "python tests/engine/test_envelope_contract.py --regen"
    )
    schema = _load_schema()
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    current = flatten_schema(schema)
    prior = snapshot["fields"]

    removed = sorted(set(prior) - set(current))
    retyped = sorted(
        k for k in set(prior) & set(current) if prior[k] != current[k]
    )
    added = sorted(set(current) - set(prior))

    if removed or retyped:
        bumped = schema.get("envelope_version") != snapshot.get("envelope_version")
        note_for_new = any(
            n.get("version") == schema.get("envelope_version")
            for n in schema.get("migration_notes") or []
        )
        assert bumped and note_for_new, (
            "%s\nremoved: %s\nretyped: %s" % (_SNAPSHOT_RULE, removed, retyped)
        )
    assert not (removed or retyped or added), (
        "%s\nremoved: %s\nretyped: %s\nadded: %s"
        % (_SNAPSHOT_RULE, removed, retyped, added)
    )
    assert schema["envelope_version"] == snapshot["envelope_version"]


def test_schema_header_pins_engine_constant_and_migration_note():
    schema = _load_schema()
    assert schema["envelope_version"] == ENVELOPE_VERSION
    notes = schema.get("migration_notes") or []
    assert any(n.get("version") == ENVELOPE_VERSION for n in notes), (
        "docs/served_envelope.schema.json must carry a migration_notes entry "
        "for the current envelope_version"
    )


def test_schema_declares_the_serve_stamps():
    """The schema itself must require the sv1 serve stamps on the served
    canonical_bs — the contract the FE reads from the same file."""
    schema = _load_schema()
    cbs = schema["$defs"]["canonical_bs"]
    for stamp in ("envelope_version", "status_presentation", "needs_review",
                  "reconcile_offer"):
        assert stamp in cbs["required"], stamp
    assert cbs["properties"]["envelope_version"]["const"] == "sv1"
    machine_enum = schema["$defs"]["status_presentation"]["properties"]["machine"]["enum"]
    assert sorted(machine_enum) == sorted(
        ["BALANCED", "RECONCILED", "MINOR_DRIFT", "MATERIAL_IMBALANCE"]
    )


def _regen_snapshot() -> None:
    schema = _load_schema()
    payload = {
        "_comment": (
            "GENERATED — do not edit by hand. Flattened field->type listing of "
            "docs/served_envelope.schema.json, locked by tests/engine/"
            "test_envelope_contract.py. Regenerate: "
            "python tests/engine/test_envelope_contract.py --regen"
        ),
        "envelope_version": schema["envelope_version"],
        "fields": flatten_schema(schema),
    }
    SNAPSHOT_PATH.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print("wrote %s (%d fields, %s)" % (
        SNAPSHOT_PATH, len(payload["fields"]), payload["envelope_version"]))


if __name__ == "__main__":
    if "--regen" in sys.argv:
        _regen_snapshot()
    else:
        print("usage: python tests/engine/test_envelope_contract.py --regen")
