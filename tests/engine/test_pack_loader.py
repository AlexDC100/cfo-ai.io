"""engine.packs — Part C loader suite (shadow phase, zero behavior change).

Locked properties:
  · load round-trip: the fixture packs load into a schema-valid,
    JSON-serializable canonical form; loading twice is identical.
  · deep immutability: frozen dataclasses, proxied mappings, tuples.
  · pack_hash: stable across loads / formatting / directory location,
    sensitive to ANY semantic edit.
  · effective-dated resolution incl. the N3 SEED CASE — a 2024-dated
    period resolves the 2024 pack even after the 2025 pack exists —
    plus typed NoPackFound / Ambiguous errors.
  · classification semantics: exact > longest-prefix > range precedence,
    side_flip by closing side (4111 credit -> customer advances),
    contra flags.
  · CHECK_IMPLS escape hatch: packs may only reference registered ids.
  · lint rejections: effective overlap, effective gap, exact/prefix
    shadowing, range-shadowed-by-prefix, dangling line_id, non-leaf
    target; the shipped fixture packs lint clean.
  · coverage mode: corpus-style code extraction + unmatched reporting.
  · CLI smoke: scripts/pack_lint.py exit codes + JSON shape.

The two tiny packs under tests/engine/fixtures/packs/ are TEST DATA,
not production rules.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
from dataclasses import FrozenInstanceError
from datetime import date
from pathlib import Path

import pytest
import yaml

from engine.packs import (
    KNOWN_DECLARATIVE_CHECK_IDS,
    PACK_FILES,
    AmbiguousPackError,
    CompiledPack,
    NoPackFoundError,
    PackError,
    PackSchemaError,
    compute_pack_hash,
    coverage_report,
    discover_packs,
    extract_codes,
    lint_pack,
    lint_root,
    load_pack,
    register_check_impl,
    registered_check_impls,
    resolve,
    unregister_check_impl,
)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "packs"
RO_2024 = FIXTURES / "ro_2024"
RO_2025 = FIXTURES / "ro_2025"


# ── tmp-pack builder ──────────────────────────────────────────────────

BASE_PACK = {
    "schema_version": "pack1",
    "jurisdiction": "RO",
    "pack_id": "ro_tmp",
    "version": "1.0",
    "effective_from": "2024-01-01",
    "effective_to": None,
    "legal_sources": ["OMFP 1802/2014"],
    "changelog": [{"version": "1.0", "date": "2024-01-01", "notes": "test pack"}],
}
BASE_RULES = {
    "rules": [
        {"rule_id": "r.cash", "exact": "5121", "line_id": "cash"},
        {"rule_id": "r.ar", "prefix": "411", "line_id": "trade_receivables"},
    ]
}
BASE_CHECKS = {"checks": [{"check_id": "D0_ANCHOR_DIVERGENCE", "enabled": True}]}
BASE_STATEMENT_MAP = {
    "statements": {
        "balance_sheet": [
            {"id": "assets", "label": "Assets", "children": [
                {"id": "cash", "label": "Cash"},
                {"id": "trade_receivables", "label": "Trade receivables"},
                {"id": "inventory", "label": "Inventory"},
            ]},
            {"id": "equity_liabilities", "label": "Equity and liabilities",
             "children": [
                 {"id": "customer_advances", "label": "Customer advances"},
                 {"id": "st_debt", "label": "Short-term debt"},
                 {"id": "share_capital", "label": "Share capital"},
             ]},
        ],
        "profit_loss": [
            {"id": "pl", "label": "Profit or loss", "children": [
                {"id": "revenue", "label": "Revenue"},
                {"id": "opex", "label": "Operating expenses"},
            ]},
        ],
    }
}
BASE_RECONCILE = {
    "threshold": 0.001,
    "placement_rules": [{"cause": "default", "placement": "bs"}],
    "adjustment_labels": {"en": "Reconciliation differences"},
}


def write_pack(pack_dir: Path, *, pack=None, rules=None, checks=None,
               statement_map=None, reconcile=None) -> Path:
    """Materialize a pack directory from the base template + overrides."""
    pack_dir.mkdir(parents=True, exist_ok=True)
    parts = {
        "pack.yaml": pack if pack is not None else copy.deepcopy(BASE_PACK),
        "classification.yaml": rules if rules is not None
        else copy.deepcopy(BASE_RULES),
        "checks.yaml": checks if checks is not None
        else copy.deepcopy(BASE_CHECKS),
        "statement_map.yaml": statement_map if statement_map is not None
        else copy.deepcopy(BASE_STATEMENT_MAP),
        "reconcile.yaml": reconcile if reconcile is not None
        else copy.deepcopy(BASE_RECONCILE),
    }
    for name, data in parts.items():
        (pack_dir / name).write_text(
            yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
    return pack_dir


def issue_codes(exc: PackSchemaError):
    return {i.code for i in exc.issues}


# ── load round-trip ───────────────────────────────────────────────────


def test_fixture_pack_loads_with_expected_identity():
    pack = load_pack(RO_2024)
    ident = pack.identity
    assert ident.jurisdiction == "RO"
    assert ident.pack_id == "ro_omfp1802_test"
    assert ident.version == "2024.1"
    assert ident.effective_from == date(2024, 1, 1)
    assert ident.effective_to == date(2025, 1, 1)
    assert [s.citation for s in ident.legal_sources][0].startswith("OMFP 1802/2014")
    assert len(ident.legal_sources) == 2
    assert ident.changelog[0].version == "2024.1"
    assert len(pack.rules) == 16
    assert len(pack.checks) == 5
    assert pack.reconcile.threshold == 0.001
    assert pack.reconcile.label_for("ro") == "Diferențe de reconciliere"
    assert pack.reconcile.placement_for("unknown-cause") == "bs"
    assert pack.reconcile.placement_for("pl_class_6_7_income") == "pl_other_income"
    # statement map covers every classification target (loader guarantee)
    leaves = set(pack.leaf_line_ids())
    for r in pack.rules:
        assert r.line_id in leaves
        if r.side_flip is not None:
            assert r.side_flip.line_id in leaves


def test_canonical_form_is_json_round_trippable():
    pack = load_pack(RO_2024)
    canonical = pack.canonical_form()
    blob = json.dumps(canonical, sort_keys=True)
    assert json.loads(blob) == canonical
    # the stored hash is exactly the hash of the canonical form
    assert pack.pack_hash == compute_pack_hash(canonical)
    assert len(pack.pack_hash) == 64  # sha256 hex


def test_loading_twice_is_identical():
    a = load_pack(RO_2024)
    b = load_pack(RO_2024)
    assert a.pack_hash == b.pack_hash
    assert a.canonical_form() == b.canonical_form()
    assert a.rules == b.rules
    assert a.identity == b.identity


# ── immutability ──────────────────────────────────────────────────────


def test_compiled_pack_is_deeply_immutable():
    pack = load_pack(RO_2024)
    with pytest.raises(FrozenInstanceError):
        pack.pack_hash = "tampered"
    with pytest.raises(FrozenInstanceError):
        pack.identity.jurisdiction = "HU"
    with pytest.raises(FrozenInstanceError):
        pack.rules[0].line_id = "cash"
    assert isinstance(pack.rules, tuple)
    assert isinstance(pack.identity.legal_sources, tuple)
    with pytest.raises(TypeError):
        pack.exact_index["9999"] = pack.rules[0]
    with pytest.raises(TypeError):
        pack.reconcile.placement_rules["x"] = "bs"
    with pytest.raises(TypeError):
        pack.reconcile.adjustment_labels["xx"] = "boom"
    park = next(c for c in pack.checks if c.params)
    with pytest.raises(TypeError):
        park.params["injected"] = 1


# ── pack_hash stability / sensitivity ─────────────────────────────────


def test_pack_hash_ignores_formatting_comments_and_location(tmp_path):
    original = load_pack(RO_2024)
    clone_dir = tmp_path / "relocated_and_reformatted"
    shutil.copytree(RO_2024, clone_dir)
    # reformat pack.yaml: reparse + dump with sorted keys, add a comment
    data = yaml.safe_load((clone_dir / "pack.yaml").read_text(encoding="utf-8"))
    (clone_dir / "pack.yaml").write_text(
        "# formatting-only change — must NOT move the hash\n"
        + yaml.safe_dump(data, allow_unicode=True, sort_keys=True),
        encoding="utf-8",
    )
    clone = load_pack(clone_dir)
    assert clone.pack_hash == original.pack_hash


def test_pack_hash_changes_on_semantic_edit(tmp_path):
    original = load_pack(RO_2024)
    edited_dir = tmp_path / "edited"
    shutil.copytree(RO_2024, edited_dir)
    text = (edited_dir / "classification.yaml").read_text(encoding="utf-8")
    assert "line_id: cash" in text
    (edited_dir / "classification.yaml").write_text(
        text.replace("- rule_id: ro.cash.5311\n    exact: \"5311\"\n    line_id: cash",
                     "- rule_id: ro.cash.5311\n    exact: \"5311\"\n    line_id: inventory"),
        encoding="utf-8",
    )
    edited = load_pack(edited_dir)
    assert edited.pack_hash != original.pack_hash
    # and the two fixture packs (one rule apart) never collide
    assert load_pack(RO_2025).pack_hash != original.pack_hash


# ── effective-dated resolution ────────────────────────────────────────


def test_resolution_n3_seed_case():
    """N3: a 2024-dated period keeps resolving the 2024 pack AFTER the
    2025 pack exists in the same lineage."""
    packs = discover_packs(FIXTURES)
    assert [p.identity.version for p in packs] == ["2024.1", "2025.1"]
    hit_2024 = resolve(packs, "RO", date(2024, 12, 31))
    assert hit_2024.identity.version == "2024.1"
    # window is half-open: the successor takes over exactly at its start
    assert resolve(packs, "RO", date(2025, 1, 1)).identity.version == "2025.1"
    assert resolve(packs, "RO", date(2025, 6, 30)).identity.version == "2025.1"
    # first day of the 2024 window belongs to 2024
    assert resolve(packs, "RO", date(2024, 1, 1)).identity.version == "2024.1"
    # ISO strings accepted; jurisdiction is case-insensitive
    assert resolve(packs, "ro", "2024-12-31").identity.version == "2024.1"
    # deterministic: same inputs, same pack
    assert resolve(packs, "RO", "2024-12-31").pack_hash == hit_2024.pack_hash


def test_resolution_typed_errors(tmp_path):
    packs = discover_packs(FIXTURES)
    with pytest.raises(NoPackFoundError) as before:
        resolve(packs, "RO", date(2023, 12, 31))
    # the error narrates the known windows
    assert "[2024-01-01, 2025-01-01)" in str(before.value)
    with pytest.raises(NoPackFoundError):
        resolve(packs, "HU", date(2024, 12, 31))
    with pytest.raises(NoPackFoundError):
        resolve(packs, "RO", "not-a-date")
    with pytest.raises(NoPackFoundError):
        resolve(packs, "RO", 20241231)  # type: ignore[arg-type]

    # ambiguous: two windows of the same lineage both contain the date
    a = copy.deepcopy(BASE_PACK)
    a.update({"version": "1.0", "effective_from": "2024-01-01",
              "effective_to": "2025-01-01"})
    b = copy.deepcopy(BASE_PACK)
    b.update({"version": "1.1", "effective_from": "2024-06-01",
              "effective_to": None})
    write_pack(tmp_path / "a", pack=a)
    write_pack(tmp_path / "b", pack=b)
    overlapping = discover_packs(tmp_path)
    with pytest.raises(AmbiguousPackError):
        resolve(overlapping, "RO", date(2024, 8, 15))
    # outside the overlap the resolution still works
    assert resolve(overlapping, "RO", date(2024, 3, 1)).identity.version == "1.0"


# ── classification semantics ──────────────────────────────────────────


def test_precedence_exact_beats_prefix_beats_range(tmp_path):
    rules = {"rules": [
        {"rule_id": "t.range", "range": {"from": "5300", "to": "5399"},
         "line_id": "inventory"},
        {"rule_id": "t.prefix2", "prefix": "51", "line_id": "trade_receivables"},
        {"rule_id": "t.prefix3", "prefix": "512", "line_id": "st_debt"},
        {"rule_id": "t.exact", "exact": "5121", "line_id": "cash"},
    ]}
    pack = load_pack(write_pack(tmp_path / "prec", rules=rules))
    assert pack.match("5121").rule_id == "t.exact"        # exact wins
    assert pack.match("51211").rule_id == "t.prefix3"     # longest prefix
    assert pack.match("5199").rule_id == "t.prefix2"      # shorter prefix
    assert pack.match("5305").rule_id == "t.range"        # range band
    assert pack.match("5305999").rule_id == "t.range"     # band on first 4 digits
    assert pack.match("53") is None                       # shorter than band
    assert pack.match("9999") is None
    assert pack.target_line("9999") is None


def test_side_flip_routes_by_closing_side():
    pack = load_pack(RO_2024)
    # 4111 natural side (debit) -> receivables; credit closing -> advances
    assert pack.target_line("4111", closing_side="debit") == "trade_receivables"
    assert pack.target_line("4111", closing_side="credit") == "customer_advances"
    assert pack.target_line("4111") == "trade_receivables"  # side unknown
    # the overdraft flip: 5121 credit closing -> short-term debt
    assert pack.target_line("5121", closing_side="credit") == "st_debt"
    assert pack.target_line("5121", closing_side="debit") == "cash"
    # a rule without side_flip ignores the side entirely
    assert pack.target_line("5311", closing_side="credit") == "cash"


def test_contra_flags_surface_on_the_rule():
    pack = load_pack(RO_2024)
    assert pack.match("491101").contra is True            # AR allowance
    assert pack.match("394101").contra is True            # range band contra
    assert pack.match("281101").contra is True            # accumulated dep
    assert pack.match("371101").contra is False


# ── CHECK_IMPLS escape hatch ──────────────────────────────────────────


def test_builtin_check_impls_are_registered():
    impls = registered_check_impls()
    assert "builtin.bs_diagnosis" in impls
    assert "builtin.reconciliation_identities" in impls


def test_pack_referencing_unknown_impl_is_rejected(tmp_path):
    checks = {"checks": [
        {"check_id": "RO_CUSTOM", "impl": "not.a.registered.impl"},
    ]}
    with pytest.raises(PackSchemaError) as exc:
        load_pack(write_pack(tmp_path / "bad_impl", checks=checks))
    assert "unknown-check-impl" in issue_codes(exc.value)
    # the message tells the author what IS registered
    assert "builtin.bs_diagnosis" in str(exc.value)


def test_non_declarative_check_without_impl_is_rejected(tmp_path):
    checks = {"checks": [{"check_id": "RO_CUSTOM_NO_IMPL"}]}
    with pytest.raises(PackSchemaError) as exc:
        load_pack(write_pack(tmp_path / "no_impl", checks=checks))
    assert "unknown-check-id" in issue_codes(exc.value)


def test_registering_an_impl_unlocks_the_pack(tmp_path):
    impl_id = "test.custom_check_impl"
    register_check_impl(impl_id, lambda *a, **k: [])
    try:
        checks = {"checks": [
            {"check_id": "RO_CUSTOM", "impl": impl_id, "params": {"x": 1}},
        ]}
        pack = load_pack(write_pack(tmp_path / "ok_impl", checks=checks))
        cfg = pack.checks[0]
        assert cfg.impl == impl_id
        assert cfg.params["x"] == 1
        # registry hygiene: duplicate registration refuses loudly
        with pytest.raises(PackError):
            register_check_impl(impl_id, lambda: None)
    finally:
        unregister_check_impl(impl_id)
    assert impl_id not in registered_check_impls()
    with pytest.raises(PackError):
        unregister_check_impl(impl_id)


def test_declarative_ids_need_no_impl():
    assert KNOWN_DECLARATIVE_CHECK_IDS >= {
        "D0_ANCHOR_DIVERGENCE", "D9_UNMAPPED_INCLUDED"}
    pack = load_pack(RO_2024)
    d0 = next(c for c in pack.checks if c.check_id == "D0_ANCHOR_DIVERGENCE")
    assert d0.impl is None and d0.enabled is True


# ── schema rejections (loader) ────────────────────────────────────────


def test_missing_file_and_missing_fields_are_reported(tmp_path):
    d = write_pack(tmp_path / "broken")
    (d / "reconcile.yaml").unlink()
    with pytest.raises(PackSchemaError) as exc:
        load_pack(d)
    assert "missing-file" in issue_codes(exc.value)
    assert set(PACK_FILES) == {
        "pack.yaml", "classification.yaml", "checks.yaml",
        "statement_map.yaml", "reconcile.yaml"}

    bad_ident = copy.deepcopy(BASE_PACK)
    del bad_ident["jurisdiction"]
    bad_ident["effective_to"] = "2023-01-01"  # before effective_from
    with pytest.raises(PackSchemaError) as exc2:
        load_pack(write_pack(tmp_path / "broken2", pack=bad_ident))
    codes = issue_codes(exc2.value)
    assert "missing-field" in codes
    assert "bad-effective-window" in codes


def test_dangling_and_non_leaf_line_ids_are_rejected(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.dangling", "exact": "5121", "line_id": "no_such_line"},
        {"rule_id": "r.parent", "exact": "5311", "line_id": "assets"},
        {"rule_id": "r.flip", "prefix": "411", "line_id": "trade_receivables",
         "side_flip": {"side": "credit", "line_id": "also_missing"}},
    ]}
    with pytest.raises(PackSchemaError) as exc:
        load_pack(write_pack(tmp_path / "dangling", rules=rules))
    codes = issue_codes(exc.value)
    assert "dangling-line-id" in codes
    assert "non-leaf-target" in codes


def test_shadowed_rules_are_rejected(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.first", "exact": "5121", "line_id": "cash"},
        {"rule_id": "r.shadowed", "exact": "5121", "line_id": "inventory"},
        {"rule_id": "r.p1", "prefix": "411", "line_id": "trade_receivables"},
        {"rule_id": "r.p2", "prefix": "411", "line_id": "inventory"},
    ]}
    with pytest.raises(PackSchemaError) as exc:
        load_pack(write_pack(tmp_path / "shadow", rules=rules))
    codes = issue_codes(exc.value)
    assert "rule-shadowed-exact" in codes
    assert "rule-shadowed-prefix" in codes


def test_matcher_shape_is_validated(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.none", "line_id": "cash"},                      # no matcher
        {"rule_id": "r.two", "exact": "5121", "prefix": "51",
         "line_id": "cash"},                                           # two matchers
        {"rule_id": "r.range", "range": {"from": "39", "to": "398"},
         "line_id": "cash"},                                           # unequal bounds
        {"rule_id": "r.range2", "range": {"from": "398", "to": "391"},
         "line_id": "cash"},                                           # inverted
        {"rule_id": "r.alpha", "exact": "51a1", "line_id": "cash"},    # non-digit
    ]}
    with pytest.raises(PackSchemaError) as exc:
        load_pack(write_pack(tmp_path / "matchers", rules=rules))
    codes = issue_codes(exc.value)
    assert {"bad-matcher", "bad-range", "bad-code"} <= codes


# ── lint ──────────────────────────────────────────────────────────────


def test_lint_reports_effective_overlap_and_gap(tmp_path):
    # overlap lineage
    a = copy.deepcopy(BASE_PACK)
    a.update({"version": "1.0", "effective_to": "2025-01-01"})
    b = copy.deepcopy(BASE_PACK)
    b.update({"version": "1.1", "effective_from": "2024-06-01",
              "effective_to": None})
    write_pack(tmp_path / "overlap" / "a", pack=a)
    write_pack(tmp_path / "overlap" / "b", pack=b)
    report = lint_root(tmp_path / "overlap")
    assert not report.ok
    assert "effective-overlap" in {f.code for f in report.findings}

    # gap lineage: [2024-01-01, 2024-06-01) then [2025-01-01, open)
    c = copy.deepcopy(BASE_PACK)
    c.update({"version": "1.0", "effective_to": "2024-06-01"})
    d = copy.deepcopy(BASE_PACK)
    d.update({"version": "2.0", "effective_from": "2025-01-01",
              "effective_to": None})
    write_pack(tmp_path / "gap" / "c", pack=c)
    write_pack(tmp_path / "gap" / "d", pack=d)
    report_gap = lint_root(tmp_path / "gap")
    assert not report_gap.ok
    gap = next(f for f in report_gap.findings if f.code == "effective-gap")
    assert "[2024-06-01, 2025-01-01)" in gap.message
    # a period inside the hole resolves to nothing — same disease, typed
    with pytest.raises(NoPackFoundError):
        resolve(discover_packs(tmp_path / "gap"), "RO", date(2024, 9, 30))


def test_lint_reports_schema_errors_instead_of_raising(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.dangling", "exact": "5121", "line_id": "nope"},
    ]}
    d = write_pack(tmp_path / "broken", rules=rules)
    report = lint_pack(d)
    assert not report.ok
    assert "dangling-line-id" in {f.code for f in report.findings}
    assert report.packs == {}  # nothing loaded


def test_lint_flags_range_shadowed_by_prefix(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.catchall", "prefix": "3", "line_id": "inventory"},
        {"rule_id": "r.dead", "range": {"from": "391", "to": "398"},
         "line_id": "inventory", "contra": True},
    ]}
    d = write_pack(tmp_path / "deadrange", rules=rules)
    report = lint_pack(d)  # loads fine — the shadow is a lint-level error
    assert str(d) in report.packs
    assert not report.ok
    finding = next(f for f in report.findings
                   if f.code == "range-shadowed-by-prefix")
    assert "r.dead" in finding.message and "r.catchall" in finding.message


def test_fixture_packs_lint_clean():
    report = lint_root(FIXTURES)
    assert report.ok
    assert len(report.packs) == 2
    # only the two documented redundant-exact warnings per pack
    assert {f.code for f in report.findings} == {"redundant-exact"}


# ── coverage mode ─────────────────────────────────────────────────────


def test_extract_codes_and_coverage(tmp_path):
    corpus_like = tmp_path / "classification.json"
    corpus_like.write_text(json.dumps({
        "accounts": [
            {"code": "5121", "name": "Banca", "amount": 10.0},
            {"code": "4111", "name": "Clienti", "amount": 5.0},
            {"code": "9998", "name": "Novel", "amount": 1.0},
            {"code": "5121", "name": "dup", "amount": 2.0},
        ]
    }), encoding="utf-8")
    codes = extract_codes(corpus_like)
    assert codes == ("5121", "4111", "9998")  # deduped, order kept

    txt = tmp_path / "codes.txt"
    txt.write_text("# comment\n5121\n371, Marfuri\n\n", encoding="utf-8")
    assert extract_codes(txt) == ("5121", "371")

    pack = load_pack(RO_2024)
    cov = coverage_report(pack, codes, source="unit")
    assert cov["total"] == 3
    assert cov["matched"] == 2
    assert cov["unmatched"] == ["9998"]
    assert 0 < cov["coverage_pct"] < 100


def test_coverage_against_real_corpus_extraction_shapes():
    """The corpus expected/ artifacts are the documented coverage inputs;
    both shapes (accounts[].code, rows[].cont) must extract codes."""
    classification = REPO / "corpus" / "saga_10_col" / "expected" / "classification.json"
    extraction = REPO / "corpus" / "saga_10_col" / "expected" / "extraction.json"
    if not classification.is_file() or not extraction.is_file():
        pytest.skip("golden corpus artifacts not present in this checkout")
    from_classification = extract_codes(classification)
    from_extraction = extract_codes(extraction)
    assert len(from_classification) > 100
    assert len(from_extraction) > 100
    pack = load_pack(RO_2024)
    cov = coverage_report(pack, from_classification, source="corpus")
    # the tiny fixture pack covers SOME of the real chart, never all —
    # and the report says exactly which codes fell through
    assert cov["matched"] > 0
    assert cov["unmatched"]
    assert cov["total"] == cov["matched"] + len(cov["unmatched"])


# ── CLI ───────────────────────────────────────────────────────────────


def _run_cli(*args: str):
    return subprocess.run(
        [sys.executable, str(REPO / "scripts" / "pack_lint.py"), *args],
        capture_output=True, text=True, cwd=str(REPO),
    )


def test_cli_clean_root_exits_zero_and_reports_hashes():
    proc = _run_cli("--root", str(FIXTURES), "--json")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert len(payload["packs"]) == 2
    # cross-process hash stability: the CLI sees the same hashes
    in_process = {p.identity.version: p.pack_hash
                  for p in discover_packs(FIXTURES)}
    cli_hashes = {v["version"]: v["pack_hash"] for v in payload["packs"].values()}
    assert cli_hashes == in_process


def test_cli_broken_pack_exits_one(tmp_path):
    rules = {"rules": [
        {"rule_id": "r.dangling", "exact": "5121", "line_id": "nope"},
    ]}
    d = write_pack(tmp_path / "broken", rules=rules)
    proc = _run_cli(str(d))
    assert proc.returncode == 1
    assert "dangling-line-id" in proc.stdout


def test_cli_usage_error_exits_two():
    proc = _run_cli()
    assert proc.returncode == 2


def test_cli_coverage_unmatched_exits_one(tmp_path):
    codes = tmp_path / "codes.txt"
    codes.write_text("5121\n999999\n", encoding="utf-8")
    proc = _run_cli(str(RO_2024), "--coverage", str(codes))
    assert proc.returncode == 1
    assert "unmatched 999999" in proc.stdout
    fully_covered = tmp_path / "covered.txt"
    fully_covered.write_text("5121\n4111\n", encoding="utf-8")
    proc_ok = _run_cli(str(RO_2024), "--coverage", str(fully_covered))
    assert proc_ok.returncode == 0, proc_ok.stdout + proc_ok.stderr
