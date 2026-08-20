"""packs/hu/actc2000-v1 + packs/intl/ifrs-captions-v1 — the AI-lane
classify packs vs their frozen port source (Phase 4 cutover).

The pack YAML is the runtime source of the classify prompt
(engine.ai_lane.classify renders the jurisdiction chart logic AND the
canonical line vocabulary from the resolved CompiledPack) and of the
classify prompt_version (engine.ai_lane.config derives it from the pack
content hash; the exact v1 contents alias to the frozen 'classify_v1').
The pre-cutover in-code sources (hu_hungary.classification_map + the
hardcoded blocks in ai_lane.classify) live on ONLY as the FROZEN
snapshot inside scripts/port_hu_pack.py. These tests pin:

  · both packs load and LINT CLEAN (zero findings, warnings included);
  · pack_hash stability across loads and directory location;
  · REGENERATION IS BYTE-IDENTICAL (scripts/port_hu_pack.py --check);
  · PROMPT PARITY: the pack-rendered classify system prompt is
    byte-identical to the pre-cutover hardcoded prompt for BOTH
    jurisdictions — so keeping the frozen 'classify_v1' version string
    for the v1 packs is honest;
  · VOCABULARY PARITY both directions: pack statement-map leaves ==
    engine.canonical BS_BUCKETS + PL_BUCKETS (ids, labels, document
    order) + the excluded_control token — the envelope builder's
    placement lookup (classify.vocabulary()) can place every pack leaf;
  · the classify prompt-version ALIASES pin exactly the two checked-in
    pack hashes; any content edit derives 'classify_<jur>@<hash12>';
  · corpus-mock equivalence: the hu_ai_lane golden's mocked assignments
    classify identically through the pack (its line_ids are pack leaves
    and, where a notable rule covers the code, the SAME line);
  · confirmed_mappings.yaml overlay: highest-precedence exact rules,
    schema-validated, hash-covered, rendered into the prompt;
  · the CACHE-INVALIDATION CHAIN end-to-end: bump a scratch pack copy →
    prompt_version changes → the persisted-envelope cache MISSES and the
    fresh run records the derived version (and the reverse control: the
    untouched packs still alias to 'classify_v1' and HIT).
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

import engine.ai_lane as lane
from engine.ai_lane import classify as ai_classify
from engine.ai_lane import config as lane_config
from engine.canonical import BS_BUCKETS, PL_BUCKETS
from engine.packs import PackSchemaError, lint_pack, load_pack
from engine.packs.runtime import invalidate_pack_cache


def load_module_from_path(name: str, path: Path):
    """Load a non-package module (script) by path — same helper pattern
    as tests/engine/test_ro_pack.py."""
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REPO = Path(__file__).resolve().parents[2]
HU_PACK_DIR = REPO / "packs" / "hu" / "actc2000-v1"
INTL_PACK_DIR = REPO / "packs" / "intl" / "ifrs-captions-v1"
PORT_SCRIPT = REPO / "scripts" / "port_hu_pack.py"
CORPUS_HU = REPO / "corpus" / "hu_ai_lane"

#: The frozen pre-cutover prompt_versions map — what every stored
#: HU envelope (and the golden corpus) carries.
FROZEN_V1_PROMPT_VERSIONS = {
    "parser_version": "ai_lane_v1",
    "format_detect": "format_detect_v1",
    "extract": "extract_v1",
    "classify": "classify_v1",
}

#: The classify stage's frame prompt exactly as it stood pre-cutover
#: (and still stands — it is LANE logic, not jurisdiction data). Frozen
#: here so the full-prompt parity test pins preamble + pack blocks.
FROZEN_PREAMBLE = (
    "You are a financial-statement classification engine. For EVERY "
    "account you are given, choose exactly one line_id from the "
    "canonical vocabulary below. Respond with ONLY a strict JSON "
    "object — no prose, no markdown fences — shaped as:\n"
    "{\n"
    '  "assignments": [{"code": <account code>,\n'
    '                   "line_id": <one vocabulary line_id>,\n'
    '                   "confidence": <0.0-1.0 — your calibrated confidence>,\n'
    '                   "rationale": <ONE short line>}, ...]\n'
    "}\n"
    "Rules:\n"
    "- One assignment per account; cover every account you were given.\n"
    "- Balance-sheet accounts get BS line_ids (asset/liability/equity); "
    "profit-and-loss accounts get revenue/expense line_ids.\n"
    "- Use `excluded_control` for technical, closing, clearing and "
    "memo accounts.\n"
    "- Be honest with confidence: use values below 0.85 whenever the "
    "account's meaning is not certain from its code and name — those "
    "accounts are routed to human review rather than guessed.\n\n"
)


@pytest.fixture(scope="module")
def hu_pack():
    return load_pack(HU_PACK_DIR)


@pytest.fixture(scope="module")
def intl_pack():
    return load_pack(INTL_PACK_DIR)


@pytest.fixture(scope="module")
def porter():
    """The generator module — loaded by path so the tests exercise the
    exact script that produced the checked-in files."""
    return load_module_from_path("_port_hu_pack_under_test", PORT_SCRIPT)


def _legacy_system_prompt(porter, jurisdiction_block: str) -> str:
    return FROZEN_PREAMBLE + jurisdiction_block + "\n\n" + porter.legacy_vocabulary_block()


# ── lint / hash / identity ────────────────────────────────────────────


@pytest.mark.parametrize("pack_dir", [HU_PACK_DIR, INTL_PACK_DIR],
                         ids=["hu", "intl"])
def test_pack_lints_clean(pack_dir):
    report = lint_pack(pack_dir)
    assert report.ok, report.render()
    # not just no errors: ZERO findings — warnings included.
    assert report.findings == [], report.render()


@pytest.mark.parametrize("pack_dir", [HU_PACK_DIR, INTL_PACK_DIR],
                         ids=["hu", "intl"])
def test_pack_hash_stable_across_loads_and_location(pack_dir, tmp_path):
    first = load_pack(pack_dir)
    again = load_pack(pack_dir)
    assert again.pack_hash == first.pack_hash
    copy_dir = tmp_path / "relocated"
    shutil.copytree(pack_dir, copy_dir)
    relocated = load_pack(copy_dir)
    assert relocated.pack_hash == first.pack_hash


def test_hu_identity_and_effective_window(hu_pack):
    ident = hu_pack.identity
    assert ident.jurisdiction == "HU"
    assert ident.pack_id == "actc2000"
    assert ident.version == "v1"
    assert ident.effective_from == date(2001, 1, 1)  # Act C of 2000 in force
    assert ident.effective_to is None
    assert any("2000. évi C. törvény" in s.citation for s in ident.legal_sources)
    assert any("§§ 160–161" in s.citation for s in ident.legal_sources)
    notes = ident.changelog[0].notes
    assert "classification_map" in notes
    assert "scripts/port_hu_pack.py" in notes
    assert hu_pack.prompt_guidance is not None
    assert len(hu_pack.prompt_guidance["class_map"]) == 10  # classes 0-9
    assert len([r for r in hu_pack.rules if r.kind == "exact"]) == 21


def test_intl_identity_and_effective_window(intl_pack):
    ident = intl_pack.identity
    assert ident.jurisdiction == "INTL"
    assert ident.pack_id == "ifrs-captions"
    assert ident.version == "v1"
    assert ident.effective_from == date(2005, 1, 1)
    assert ident.effective_to is None
    assert any("IAS 1" in s.citation for s in ident.legal_sources)
    assert any("IAS 7" in s.citation for s in ident.legal_sources)
    assert intl_pack.rules == ()  # arbitrary code schemes — no code rules
    assert intl_pack.prompt_guidance is not None
    assert "class_map" not in intl_pack.prompt_guidance


# ── regeneration — the drift alarm ────────────────────────────────────


def test_regeneration_is_byte_identical(porter):
    fresh = porter.generate()
    for key, pack_dir in (("hu", HU_PACK_DIR), ("intl", INTL_PACK_DIR)):
        assert set(fresh[key].keys()) == set(porter.PACK_FILE_NAMES)
        for name in porter.PACK_FILE_NAMES:
            on_disk = (pack_dir / name).read_text(encoding="utf-8")
            assert on_disk == fresh[key][name], (
                "%s/%s no longer matches the frozen port snapshot — the pack "
                "has DRIFTED. v1 is immutable: revert the edit and cut a new "
                "pack version, or regenerate with `python scripts/"
                "port_hu_pack.py` if a mirrored live engine constant moved."
                % (pack_dir.name, name)
            )


def test_port_script_check_mode_cli():
    proc = subprocess.run(
        [sys.executable, str(PORT_SCRIPT), "--check"],
        capture_output=True, text=True, cwd=str(REPO),
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "clean" in proc.stdout


def test_regeneration_into_fresh_dirs_same_hashes(porter, tmp_path, hu_pack,
                                                  intl_pack):
    out_hu = tmp_path / "regen-hu"
    out_intl = tmp_path / "regen-intl"
    porter.write_packs(out_hu, out_intl)
    assert load_pack(out_hu).pack_hash == hu_pack.pack_hash
    assert load_pack(out_intl).pack_hash == intl_pack.pack_hash


# ── vocabulary parity: pack leaves <-> canonical schema ───────────────


def _leaf_nodes(pack) -> List[Any]:
    out: List[Any] = []

    def walk(nodes):
        for n in nodes:
            if n.is_leaf:
                out.append(n)
            else:
                walk(n.children)

    walk(pack.balance_sheet)
    walk(pack.profit_loss)
    return out


@pytest.mark.parametrize("pack_dir", [HU_PACK_DIR, INTL_PACK_DIR],
                         ids=["hu", "intl"])
def test_statement_map_leaves_match_canonical_schema_exactly(pack_dir):
    """Document order, ids AND labels must mirror BS_BUCKETS + PL_BUCKETS
    (plus the excluded_control token last in the BS tree) — the prompt's
    vocabulary block renders from the pack, the envelope builder places
    through the schema, and this parity is what keeps them one thing."""
    pack = load_pack(pack_dir)
    leaves = _leaf_nodes(pack)
    schema_buckets = list(BS_BUCKETS) + list(PL_BUCKETS)
    # BS tree = the 5 schema BS groups in order, then the excluded section.
    bs_leaf_ids = [n.id for tree in (pack.balance_sheet,) for n in _leaf_nodes_of(tree)]
    assert bs_leaf_ids[:-1] == [b.canonical_name for b in BS_BUCKETS]
    assert bs_leaf_ids[-1] == ai_classify.EXCLUDED_CONTROL
    # PL tree = the schema PL groups in order.
    pl_leaf_ids = [n.id for n in _leaf_nodes_of(pack.profit_loss)]
    assert pl_leaf_ids == [b.canonical_name for b in PL_BUCKETS]
    # Labels verbatim (prompt fidelity).
    labels = {n.id: n.label for n in leaves}
    for b in schema_buckets:
        assert labels[b.canonical_name] == b.display_label
    # Every non-excluded leaf is placeable by the envelope builder.
    vocab = ai_classify.vocabulary()
    for n in leaves:
        if n.id != ai_classify.EXCLUDED_CONTROL:
            assert n.id in vocab
    # ...and the builder's vocabulary has no line the pack lacks.
    assert set(vocab) <= {n.id for n in leaves}


def _leaf_nodes_of(tree) -> List[Any]:
    out: List[Any] = []

    def walk(nodes):
        for n in nodes:
            if n.is_leaf:
                out.append(n)
            else:
                walk(n.children)

    walk(tree)
    return out


# ── prompt parity — byte-identical to the pre-cutover text ────────────


def test_hu_guidance_block_matches_legacy(hu_pack, porter):
    assert ai_classify._guidance_block(hu_pack) == porter.legacy_hu_prompt_block()


def test_intl_guidance_block_matches_legacy(intl_pack, porter):
    assert ai_classify._guidance_block(intl_pack) == porter.legacy_intl_prompt_block()


@pytest.mark.parametrize("pack_dir", [HU_PACK_DIR, INTL_PACK_DIR],
                         ids=["hu", "intl"])
def test_vocabulary_block_matches_legacy(pack_dir, porter):
    pack = load_pack(pack_dir)
    assert ai_classify._vocabulary_block(pack) == porter.legacy_vocabulary_block()


def test_full_system_prompt_byte_identical_hu(hu_pack, porter):
    assert ai_classify._system_prompt(hu_pack) == _legacy_system_prompt(
        porter, porter.legacy_hu_prompt_block()
    )


def test_full_system_prompt_byte_identical_intl(intl_pack, porter):
    assert ai_classify._system_prompt(intl_pack) == _legacy_system_prompt(
        porter, porter.legacy_intl_prompt_block()
    )


# ── prompt-version derivation + aliases ───────────────────────────────


def test_prompt_version_aliases_pin_exactly_the_v1_packs(hu_pack, intl_pack):
    aliases = lane_config._CLASSIFY_PROMPT_VERSION_ALIASES
    assert set(aliases) == {hu_pack.pack_hash, intl_pack.pack_hash}, (
        "the alias table in engine.ai_lane.config no longer matches the "
        "checked-in v1 pack hashes — if a pack legitimately changed (new "
        "version), add its hash mapping deliberately; if not, the pack "
        "drifted."
    )
    assert all(v == lane_config.CLASSIFY_PROMPT_VERSION for v in aliases.values())
    assert lane_config.classify_prompt_version_for(hu_pack) == "classify_v1"
    assert lane_config.classify_prompt_version_for(intl_pack) == "classify_v1"


def test_prompt_versions_map_is_the_frozen_v1_map_for_both_lanes():
    assert lane_config.prompt_versions("HU") == FROZEN_V1_PROMPT_VERSIONS
    assert lane_config.prompt_versions("OTHER") == FROZEN_V1_PROMPT_VERSIONS


def test_derived_version_shape_for_non_v1_content(hu_pack):
    fake = SimpleNamespace(
        pack_hash="ab" * 32,
        identity=SimpleNamespace(jurisdiction="HU"),
    )
    derived = lane_config.classify_prompt_version_for(fake)
    assert derived == "classify_hu@" + ("ab" * 32)[:12]
    assert derived != lane_config.CLASSIFY_PROMPT_VERSION


# ── corpus-mock equivalence (the hu_ai_lane golden's pinning) ─────────


def _corpus_mock_assignments() -> List[Dict[str, Any]]:
    mocks = json.loads((CORPUS_HU / "mock_model_responses.json").read_text(
        encoding="utf-8"))
    return json.loads(mocks["classify"])["assignments"]


def test_corpus_mock_line_ids_are_pack_leaves(hu_pack):
    """The mocked classify assignments must flow through the pack-built
    vocabulary exactly as before: every assigned line_id is a pack leaf
    the envelope builder can place (or the excluded token)."""
    leaf_ids = {n.id for n in _leaf_nodes(hu_pack)}
    vocab = ai_classify.vocabulary()
    for a in _corpus_mock_assignments():
        assert a["line_id"] in leaf_ids
        assert a["line_id"] in vocab or a["line_id"] == ai_classify.EXCLUDED_CONTROL


def test_hu_notable_rules_agree_with_corpus_mock(hu_pack):
    """Where a notable exact rule covers a mocked code, the pack's line
    must be the line the golden pins — a divergent port would teach the
    model something the calibrated case contradicts."""
    mock_by_code = {a["code"]: a["line_id"] for a in _corpus_mock_assignments()}
    checked = 0
    for rule in hu_pack.rules:
        if rule.kind == "exact" and rule.exact in mock_by_code:
            assert rule.line_id == mock_by_code[rule.exact], (
                "pack rule %s -> %s disagrees with the hu_ai_lane golden "
                "mock (%s)" % (rule.exact, rule.line_id, mock_by_code[rule.exact])
            )
            checked += 1
    assert checked >= 10  # the mock covers most notables — keep the net wide


# ── checks / reconcile mirror the live engine constants ───────────────


@pytest.mark.parametrize("pack_dir", [HU_PACK_DIR, INTL_PACK_DIR],
                         ids=["hu", "intl"])
def test_checks_and_reconcile_mirror_live_engine_constants(pack_dir, porter):
    pack = load_pack(pack_dir)
    rc = porter._ro_porter().load_reconciliation_checks_module()
    by_id = {c.check_id: c for c in pack.checks}
    assert set(by_id) == {
        "D0_ANCHOR_DIVERGENCE", "D1_SOURCE_IMBALANCED", "D2_FINGERPRINT",
        "D3_CONTRA_MISPLACED", "D4_BIFUNCTIONAL_SIDE", "D5_DUPLICATE_ROWS",
        "D6_121_MISMATCH", "D7_MAGNITUDE", "D8_OMITTED",
        "D9_UNMAPPED_INCLUDED", "reconciliation_identities",
    }
    assert by_id["D0_ANCHOR_DIVERGENCE"].params["ron_tolerance"] == rc._RON_TOLERANCE
    ident = by_id["reconciliation_identities"]
    assert ident.impl == "builtin.reconciliation_identities"
    assert ident.params["pct_tolerance"] == rc._PCT_TOLERANCE
    assert ident.params["minor_drift_pct"] == rc._MINOR_DRIFT_PCT
    assert pack.reconcile.threshold == pytest.approx(0.001)
    assert pack.reconcile.placement_for("default") == "bs"
    assert pack.reconcile.placement_for("class_67_target_delta_positive") == "pl_other_income"


# ── confirmed_mappings.yaml — the human-confirmed overlay ─────────────


def _scratch_hu_pack(tmp_path: Path) -> Path:
    dst = tmp_path / "hu-scratch"
    shutil.copytree(HU_PACK_DIR, dst)
    return dst


def test_confirmed_overlay_is_highest_precedence_and_hash_covered(tmp_path,
                                                                  hu_pack):
    scratch = _scratch_hu_pack(tmp_path)
    (scratch / "confirmed_mappings.yaml").write_text(
        "confirmed_mappings:\n"
        # overrides the BASE exact rule hu.466 (ar_tax_recoverable)
        "  - code: \"466\"\n"
        "    line_id: \"ap_tax\"\n"
        "    confirmed_by: \"operator@example.com\"\n"
        "    confirmed_at: 2026-08-20\n"
        "    note: \"net VAT position is payable for this client\"\n"
        # a code no base rule covers
        "  - code: \"3841\"\n"
        "    line_id: \"cash_operating\"\n",
        encoding="utf-8",
    )
    pack = load_pack(scratch)
    # Highest precedence: the overlay wins the exact index for 466.
    win = pack.match("466")
    assert win is not None
    assert win.rule_id == "confirmed.466"
    assert win.line_id == "ap_tax"
    assert pack.target_line("466") == "ap_tax"
    # Provenance folded deterministically into the description (hash-covered).
    assert win.description == (
        "Human-confirmed mapping (2026-08-20, operator@example.com): "
        "net VAT position is payable for this client"
    )
    # New coverage for the uncovered code.
    assert pack.target_line("3841") == "cash_operating"
    # The base rules are still present in the rules tuple (auditability)...
    assert any(r.rule_id == "hu.466" for r in pack.rules)
    # ...and the overlay changed the content hash → derived prompt version.
    assert pack.pack_hash != hu_pack.pack_hash
    derived = lane_config.classify_prompt_version_for(pack)
    assert derived == "classify_hu@%s" % pack.pack_hash[:12]
    # The confirmation renders into the prompt as a notable line.
    guidance = ai_classify._guidance_block(pack)
    assert "  3841 = Human-confirmed mapping" in guidance
    assert "  466 = Human-confirmed mapping (2026-08-20, operator@example.com)" \
        in guidance


def test_confirmed_overlay_validation_errors(tmp_path):
    scratch = _scratch_hu_pack(tmp_path)
    (scratch / "confirmed_mappings.yaml").write_text(
        "confirmed_mappings:\n"
        "  - code: \"466\"\n"
        "    line_id: \"ap_tax\"\n"
        "  - code: \"466\"\n"                      # duplicate IN the overlay
        "    line_id: \"ar_tax_recoverable\"\n"
        "  - code: \"12a\"\n"                      # not a digit string
        "    line_id: \"cash_operating\"\n"
        "  - code: \"556\"\n"
        "    line_id: \"cash_operating\"\n"
        "    surprise: true\n",                    # unknown key
        encoding="utf-8",
    )
    with pytest.raises(PackSchemaError) as exc:
        load_pack(scratch)
    codes = {i.code for i in exc.value.issues}
    assert "duplicate-confirmed-code" in codes
    assert "bad-code" in codes
    assert "unknown-field" in codes


def test_confirmed_overlay_dangling_line_id(tmp_path):
    """Cross-file validation (needs a structurally-valid overlay): a
    confirmation targeting a line the statement map does not define is
    rejected — memoizations can never invent vocabulary."""
    scratch = _scratch_hu_pack(tmp_path)
    (scratch / "confirmed_mappings.yaml").write_text(
        "confirmed_mappings:\n"
        "  - code: \"555\"\n"
        "    line_id: \"no_such_line\"\n",
        encoding="utf-8",
    )
    with pytest.raises(PackSchemaError) as exc:
        load_pack(scratch)
    issues = {(i.code, i.where) for i in exc.value.issues}
    assert ("dangling-line-id", "confirmed.555") in issues


def test_confirmed_overlay_bad_file_shape(tmp_path):
    scratch = _scratch_hu_pack(tmp_path)
    (scratch / "confirmed_mappings.yaml").write_text(
        "not_the_right_key: []\n", encoding="utf-8",
    )
    with pytest.raises(PackSchemaError) as exc:
        load_pack(scratch)
    assert any(i.code in ("bad-file", "unknown-field") for i in exc.value.issues)


def test_prompt_guidance_validation_errors(tmp_path):
    scratch = _scratch_hu_pack(tmp_path)
    text = (scratch / "classification.yaml").read_text(encoding="utf-8")
    assert "prompt_guidance:\n  header:" in text
    text = text.replace(
        "prompt_guidance:\n  header:",
        "prompt_guidance:\n  mystery: 1\n  header:",
    )
    # A duplicate class digit, injected as a valid class_map entry just
    # before the footer line.
    assert "\n  footer:" in text
    text = text.replace(
        "\n  footer:",
        "\n    - digit: \"9\"\n      name: \"dup\"\n"
        "      guidance: \"dup digit\"\n  footer:",
    )
    (scratch / "classification.yaml").write_text(text, encoding="utf-8")
    with pytest.raises(PackSchemaError) as exc:
        load_pack(scratch)
    codes = {i.code for i in exc.value.issues}
    assert "unknown-field" in codes
    assert "duplicate-class-digit" in codes


# ── the cache-invalidation chain, end-to-end ──────────────────────────
# bump a scratch pack copy → prompt_version changes → cache miss (and
# the reverse control: untouched packs still alias → cache hit).


class _FakeMessages:
    def __init__(self, responses: List[str]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("fake client ran out of scripted responses")
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self._responses.pop(0))]
        )


class _FakeClient:
    def __init__(self, responses: List[str]):
        self.messages = _FakeMessages(responses)


class _ExplodingFactory:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> Any:
        self.calls += 1
        raise AssertionError("client factory invoked — the cache should have hit")


class _FakeAdminCtx:
    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows

    def __enter__(self) -> "_FakeAdminCtx":
        return self

    def __exit__(self, *args: Any) -> bool:
        return False

    def select(self, table: str, filters: Optional[Dict[str, str]] = None,
               order: Optional[str] = None, single: bool = False):
        return list(self.rows)


@pytest.fixture()
def scratch_packs_root(tmp_path, monkeypatch):
    """A full copy of the repo packs tree (RO + HU + INTL) the runtime is
    pointed at for one test; always restored + re-invalidated."""
    root = tmp_path / "packs"
    shutil.copytree(REPO / "packs", root)
    monkeypatch.setenv("ENGINE_PACKS_ROOT", str(root))
    invalidate_pack_cache()
    try:
        yield root
    finally:
        monkeypatch.delenv("ENGINE_PACKS_ROOT", raising=False)
        invalidate_pack_cache()


def _corpus_mocks() -> Dict[str, str]:
    return json.loads((CORPUS_HU / "mock_model_responses.json").read_text(
        encoding="utf-8"))


def _hu_doc_and_bytes():
    content = (CORPUS_HU / "input.csv").read_bytes()
    doc = {"id": "doc-hu-cache", "org_id": "org-1",
           "original_filename": "input.csv"}
    return doc, content


def _cached_row(content_hash: str, versions: Dict[str, str]) -> Dict[str, Any]:
    return {
        "id": "period-1",
        "currency": "HUF",
        "updated_at": "2026-08-19T00:00:00Z",
        "assembled_canonical_v1": {
            "canonical_bs": {"status": "MINOR_DRIFT", "totals": {}},
            "ai_audit": {
                "content_hash": content_hash,
                "prompt_versions": versions,
                "model": lane_config.MODEL_ID,
            },
        },
    }


def test_untouched_packs_alias_to_v1_and_cache_hits(scratch_packs_root):
    """Control: pointing at a byte-identical copy of the packs keeps the
    frozen 'classify_v1' (content-hash alias, not path- or identity-
    keyed) and a stored v1 envelope still HITS the cache."""
    assert lane_config.classify_prompt_version("HU") == "classify_v1"
    doc, content = _hu_doc_and_bytes()
    row = _cached_row(lane.content_hash_of(content), dict(FROZEN_V1_PROMPT_VERSIONS))
    factory = _ExplodingFactory()
    parsed = lane.run_ai_lane(
        doc=doc, file_bytes=content, kind="csv",
        resolution={"jurisdiction": "HU", "source": "language", "confidence": 0.95},
        client_factory=factory,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert factory.calls == 0
    assert parsed["ai_lane"]["cached"] is True


def test_pack_bump_reversions_prompt_and_misses_cache(scratch_packs_root):
    """THE chain the task contract demands: edit a scratch pack copy (a
    human-confirmed mapping lands in the overlay) → pack_hash changes →
    classify prompt_version derives → a stored envelope keyed on the v1
    versions MISSES → the model re-runs with the confirmation IN the
    prompt, and the fresh envelope records the derived version."""
    hu_dir = scratch_packs_root / "hu" / "actc2000-v1"
    (hu_dir / "confirmed_mappings.yaml").write_text(
        "confirmed_mappings:\n"
        "  - code: \"522\"\n"
        "    line_id: \"rent_operating_lease\"\n"
        "    confirmed_at: 2026-08-20\n"
        "    note: \"bérleti díjak — operating rent\"\n",
        encoding="utf-8",
    )
    invalidate_pack_cache()  # the runtime must see the edited copy

    edited = load_pack(hu_dir)
    derived = lane_config.classify_prompt_version("HU")
    assert derived == "classify_hu@%s" % edited.pack_hash[:12]
    assert derived != "classify_v1"
    assert lane_config.prompt_versions("HU")["classify"] == derived
    # INTL is untouched — still the frozen alias (independent lanes).
    assert lane_config.classify_prompt_version("OTHER") == "classify_v1"

    doc, content = _hu_doc_and_bytes()
    # The stored envelope carries the PRE-EDIT versions → must MISS.
    row = _cached_row(lane.content_hash_of(content), dict(FROZEN_V1_PROMPT_VERSIONS))
    mocks = _corpus_mocks()
    client = _FakeClient([mocks["format_detect"], mocks["extract"], mocks["classify"]])
    parsed = lane.run_ai_lane(
        doc=doc, file_bytes=content, kind="csv",
        resolution={"jurisdiction": "HU", "source": "language", "confidence": 0.95},
        client_factory=lambda: client,
        admin_factory=lambda: _FakeAdminCtx([row]),
    )
    assert parsed["ai_lane"]["cached"] is False
    assert len(client.messages.calls) == 3  # cache missed → full re-run

    # The confirmation reached the model: the classify call's system
    # prompt carries the new notable line (memoization feeds the prompt).
    classify_call = client.messages.calls[2]
    system_text = classify_call["system"][0]["text"]
    assert "  522 = Human-confirmed mapping (2026-08-20)" in system_text
    assert classify_call is client.messages.calls[-1]

    # The fresh envelope records the derived version everywhere the
    # version lives: the cache key (ai_audit) and the classification meta.
    env = parsed["ai_lane"]["assembled"]["assembled_canonical_v1"]
    assert env["ai_audit"]["prompt_versions"]["classify"] == derived
    assert env["canonical_bs"]["classification"]["prompt_version"] == derived
    assert env["canonical_bs"]["extraction"]["prompt_versions"]["classify"] == derived

    # And a SECOND run against the fresh envelope's versions now HITS.
    row2 = _cached_row(lane.content_hash_of(content),
                       dict(env["ai_audit"]["prompt_versions"]))
    factory = _ExplodingFactory()
    parsed2 = lane.run_ai_lane(
        doc=doc, file_bytes=content, kind="csv",
        resolution={"jurisdiction": "HU", "source": "language", "confidence": 0.95},
        client_factory=factory,
        admin_factory=lambda: _FakeAdminCtx([row2]),
    )
    assert factory.calls == 0
    assert parsed2["ai_lane"]["cached"] is True
