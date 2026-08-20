"""packs/ro/omfp1802-v1 — the RUNTIME classification pack vs its frozen port source.

Phase 3 cutover: the pack YAML is the production classification source
(chart_of_accounts.bucket_for / accounts_to_assemble_shape read it); the
pre-cutover in-code tables live on ONLY as the FROZEN snapshot inside
scripts/port_ro_pack.py (FROZEN_RULES / FROZEN_BIFUNCTIONAL_WRONG_SIDE_
FLIPS / FROZEN_PARSER_SIDE_FLIPS). These tests pin v1 immutability and
frozen-vs-pack consistency:

  · the checked-in pack loads and LINTS CLEAN (zero findings, warnings
    included);
  · pack_hash is stable across loads and directory location;
  · REGENERATION IS BYTE-IDENTICAL — scripts/port_ro_pack.py re-run from
    the frozen snapshot (+ the still-live engine constants it mirrors)
    must reproduce the five files exactly: v1 cannot drift silently, and
    pack_hash cannot change without a deliberate new pack version;
  · completeness census BOTH directions: every FROZEN_RULES entry has a
    pack rule (same prefix, same line, same contra) and every pack rule
    maps back to FROZEN_RULES or to a flip-carrier synthesized from the
    frozen flip layers;
  · UNIVERSE PARITY vs the FROZEN model: for every 1-4 digit code (plus
    rule/flip prefix extensions), the pack classifies exactly like the
    frozen tables — same rule-or-None, same line_id, same contra, same
    flip behavior on both closing sides (frozen parser layer first,
    then the frozen bifunctional layer) — AND the LIVE facades
    (chart_of_accounts.bucket_for / wrong_side_flip_bucket) agree with
    the pack, so the production seam can never drift from the data it
    fronts;
  · spot semantics: 28x contra, 4111 side-conditional, 5121 overdraft
    flip, class 8 excluded, 121 result/control;
  · D0-D9 check configuration mirrors engine.confidence.
    reconciliation_checks constants; reconcile.yaml mirrors the
    auto-reconcile constants (0.001 gate, class-6/7 P&L placement,
    'Diferențe de reconciliere' labels).
"""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.country_packs.ro_romania import canonical_adapter as ca
from engine.packs import (
    KNOWN_DECLARATIVE_CHECK_IDS,
    NoPackFoundError,
    lint_pack,
    load_pack,
    resolve,
)


def load_module_from_path(name: str, path: Path):
    """Load a non-package module (script) by path — same helper pattern
    as tests/engine/test_corpus_replay.py (tests/engine is not a
    package, so conftest helpers aren't importable)."""
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


REPO = Path(__file__).resolve().parents[2]
PACK_DIR = REPO / "packs" / "ro" / "omfp1802-v1"
PORT_SCRIPT = REPO / "scripts" / "port_ro_pack.py"

#: Asset-side fields of the legacy BS dict — decide each bucket's natural
#: balance side (asset = debit-natural). Asserted against _empty_bs below.
_ASSET_BS_FIELDS = {
    "cash", "accountsReceivable", "inventory", "otherCurrentAssets",
    "propertyPlantEquipment", "intangibles", "otherNonCurrentAssets",
}


@pytest.fixture(scope="module")
def ro_pack():
    return load_pack(PACK_DIR)


@pytest.fixture(scope="module")
def porter():
    """The generator module — loaded by path so the tests exercise the
    exact script that produced the checked-in files."""
    return load_module_from_path("_port_ro_pack_under_test", PORT_SCRIPT)


@pytest.fixture(scope="module")
def rc_checks(porter):
    """engine/confidence/reconciliation_checks.py, file-path loaded (the
    package __init__ pulls siblings absent in some checkouts)."""
    return porter.load_reconciliation_checks_module()


def _natural_side(bucket: str) -> str:
    field = coa._BUCKET_TO_BS_FIELD[bucket]
    return "debit" if field in _ASSET_BS_FIELDS else "credit"


# ── lint / hash / identity ────────────────────────────────────────────


def test_pack_lints_clean():
    report = lint_pack(PACK_DIR)
    assert report.ok, report.render()
    # not just no errors: ZERO findings — warnings included.
    assert report.findings == [], report.render()


def test_pack_hash_stable_across_loads_and_location(ro_pack, tmp_path):
    again = load_pack(PACK_DIR)
    assert again.pack_hash == ro_pack.pack_hash
    copy_dir = tmp_path / "relocated"
    shutil.copytree(PACK_DIR, copy_dir)
    relocated = load_pack(copy_dir)
    assert relocated.pack_hash == ro_pack.pack_hash


def test_identity_and_effective_window(ro_pack):
    ident = ro_pack.identity
    assert ident.jurisdiction == "RO"
    assert ident.pack_id == "omfp1802"
    assert ident.version == "v1"
    assert ident.effective_from == date(2015, 1, 1)
    assert ident.effective_to is None  # OMFP 1802/2014 still in force
    assert any("OMFP" in s.citation and "1802/2014" in s.citation
               for s in ident.legal_sources)
    # the changelog documents the mechanical port of the code-table vintage
    notes = ident.changelog[0].notes
    assert coa.MAPPING_VERSION in notes
    assert "commit HEAD" in notes
    assert "scripts/port_ro_pack.py" in notes


def test_effective_dated_resolution(ro_pack):
    assert resolve([ro_pack], "ro", "2025-12-31") is ro_pack
    assert resolve([ro_pack], "RO", date(2015, 1, 1)) is ro_pack
    with pytest.raises(NoPackFoundError):
        resolve([ro_pack], "RO", "2014-12-31")  # pre-OMFP-1802 period


# ── regeneration — the drift alarm ────────────────────────────────────


def test_regeneration_is_byte_identical(porter):
    fresh = porter.generate()
    assert set(fresh.keys()) == set(porter.PACK_FILE_NAMES)
    for name in porter.PACK_FILE_NAMES:
        on_disk = (PACK_DIR / name).read_text(encoding="utf-8")
        assert on_disk == fresh[name], (
            "packs/ro/omfp1802-v1/%s no longer matches the in-code tables — "
            "the code table and the pack have DRIFTED. Regenerate with "
            "`python scripts/port_ro_pack.py` and commit, or revert the "
            "table change." % name
        )


def test_port_script_check_mode_cli():
    proc = subprocess.run(
        [sys.executable, str(PORT_SCRIPT), "--check"],
        capture_output=True, text=True, cwd=str(REPO),
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "clean" in proc.stdout


def test_regeneration_into_fresh_dir_same_hash(porter, tmp_path, ro_pack):
    out = tmp_path / "regen"
    porter.write_pack(out)
    assert load_pack(out).pack_hash == ro_pack.pack_hash


# ── completeness census — both directions ─────────────────────────────


def test_census_every_frozen_rule_has_a_pack_counterpart(ro_pack, porter):
    by_prefix = {r.prefix: r for r in ro_pack.rules}
    for rule in porter.FROZEN_RULES:
        pack_rule = by_prefix.get(rule.prefix)
        assert pack_rule is not None, "missing pack rule for prefix %s" % rule.prefix
        assert pack_rule.kind == "prefix"
        assert pack_rule.line_id == rule.bucket, rule.prefix
        assert pack_rule.contra == (rule.sign == -1), rule.prefix
        # the frozen description is carried verbatim (per-rule OMFP
        # citations may be appended in brackets)
        assert pack_rule.description.startswith(rule.description), rule.prefix


def test_census_every_pack_rule_maps_back(ro_pack, porter):
    frozen = {r.prefix for r in porter.FROZEN_RULES}
    flip_table = dict(porter.FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS)
    parser_flips = set(porter.extract_parser_side_flips())
    extras = []
    for rule in ro_pack.rules:
        if rule.prefix in frozen:
            continue
        extras.append(rule)
        # only permissible extras: flip-carriers for flip entries FINER
        # than the rule table (from EITHER flip layer) — classification
        # must be unchanged.
        winner = porter.frozen_bucket_for(rule.prefix)
        assert winner is not None and len(winner.prefix) < len(rule.prefix)
        assert rule.line_id == winner.bucket, rule.rule_id
        assert rule.contra is False
        assert rule.side_flip is not None
        if rule.prefix in flip_table:
            assert rule.side_flip.line_id == flip_table[rule.prefix]
        else:
            # parser-layer carrier: fires on the CREDIT side, targets
            # otherCurrentLiab (trial_balance_parser's override bucket)
            assert rule.prefix in parser_flips, rule.rule_id
            assert rule.side_flip.side == "credit"
            assert rule.side_flip.line_id == "otherCurrentLiab"
    # exactly two carriers: the 512 overdraft family (bifunctional) and
    # 1687 current-portion interest (parser layer) — order-insensitive,
    # compiled rule order is the loader's concern
    assert sorted(r.prefix for r in extras) == ["1687", "512"]


def test_census_flip_table_fully_represented(ro_pack, porter):
    for flip_prefix, flip_bucket in porter.FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS:
        winner = porter.frozen_bucket_for(flip_prefix)
        if winner is None:
            # code-unreachable family head (e.g. '411': 4112-4117/4119
            # have no rule); its code-mapped SUB-families must carry the
            # flip that fires for their codes.
            subs = [r for r in ro_pack.rules if r.prefix.startswith(flip_prefix)]
            assert subs, flip_prefix
            for sub in subs:
                assert sub.side_flip is not None, sub.rule_id
                assert sub.side_flip.line_id == porter.frozen_wrong_side_flip_bucket(sub.prefix)
            continue
        rule = ro_pack.match(flip_prefix)
        assert rule is not None and rule.side_flip is not None, flip_prefix
        # longest-prefix-first: the flip that fires for this family
        assert rule.side_flip.line_id == porter.frozen_wrong_side_flip_bucket(flip_prefix)
        assert rule.side_flip.side == (
            "credit" if _natural_side(rule.line_id) == "debit" else "debit"
        )


# ── universe parity — the executable equivalence proof ─────────────────


def test_census_parser_flip_table_fully_represented(ro_pack, porter):
    """Every parser-layer credit-side re-route family
    (trial_balance_parser SIDE_FLIP_TO_LIAB_PREFIXES) is represented:
    the credit-side target is otherCurrentLiab wherever a rule matches
    (via a rule-level flip, a synthesized carrier, or a rule already
    targeting otherCurrentLiab — the 425 no-op), the debit side keeps
    the in-code winner's bucket, and no-rule families (467) stay
    unmapped on BOTH sides — the legacy flip can never fire for them
    because rule lookup precedes the flip check."""
    for prefix in porter.extract_parser_side_flips():
        winner = porter.frozen_bucket_for(prefix)
        if winner is None:
            assert ro_pack.match(prefix) is None, prefix  # 467
            continue
        assert ro_pack.target_line(prefix, "credit") == "otherCurrentLiab", prefix
        assert ro_pack.target_line(prefix, "debit") == winner.bucket, prefix
        # deeper analytics inside the family flip the same way
        assert ro_pack.target_line(prefix + "01", "credit") == "otherCurrentLiab", prefix


def test_universe_parity_with_frozen_tables(ro_pack, porter):
    """The pack classifies every code exactly like the FROZEN pre-cutover
    model (frozen parser flip layer first, then the frozen bifunctional
    layer), AND the LIVE pack-backed facades agree with the pack — the
    executable proof that the cutover changed the SOURCE of the rules,
    not their meaning."""
    assert _ASSET_BS_FIELDS <= set(coa._empty_bs().keys())
    parser_flips = porter.extract_parser_side_flips()
    codes = [str(n) for n in range(1, 10000)]
    extras = set()
    for rule in porter.FROZEN_RULES:
        extras.add(rule.prefix + "0")
        extras.add(rule.prefix + "9")
    for flip_prefix, _bucket in porter.FROZEN_BIFUNCTIONAL_WRONG_SIDE_FLIPS:
        extras.add(flip_prefix + "0")
        extras.add(flip_prefix + "1")
    for flip_prefix in parser_flips:
        extras.add(flip_prefix + "0")
        extras.add(flip_prefix + "1")
    codes += sorted(extras - set(codes))

    for code in codes:
        frozen_rule = porter.frozen_bucket_for(code)
        pack_rule = ro_pack.match(code)
        live_rule = coa.bucket_for(code)
        if frozen_rule is None:
            assert pack_rule is None, code
            assert live_rule is None, code
            continue
        assert pack_rule is not None, code
        assert pack_rule.line_id == frozen_rule.bucket, code
        assert pack_rule.contra == (frozen_rule.sign == -1), code
        # the LIVE facade is a view over the pack — same surface values
        assert live_rule is not None, code
        assert live_rule.bucket == pack_rule.line_id, code
        assert live_rule.sign == (-1 if pack_rule.contra else 1), code
        assert live_rule.prefix == pack_rule.prefix, code

        # The FULL frozen flip model, both closing sides. The parser
        # layer fired FIRST (deterministic lane: any ruled code inside a
        # frozen parser-flip family whose closing balance sits on the
        # CREDIT side re-routed to otherCurrentLiab); then the
        # assembler's bifunctional wrong-side flip fired on sign=+1
        # rules when the balance sat on the non-natural side.
        def frozen_target(side: str) -> str:
            if side == "credit" and any(code.startswith(p) for p in parser_flips):
                return "otherCurrentLiab"
            if frozen_rule.sign == 1:
                flip_bucket = porter.frozen_wrong_side_flip_bucket(code)
                if flip_bucket is not None:
                    natural = _natural_side(frozen_rule.bucket)
                    if side != natural:
                        return flip_bucket
            return frozen_rule.bucket

        for side in ("debit", "credit"):
            assert ro_pack.target_line(code, side) == frozen_target(side), (code, side)
        # side-agnostic lookup keeps the plain rule line
        assert ro_pack.target_line(code, None) == frozen_rule.bucket, code

        # the LIVE wrong-side facade == the pack's wrong-side flip
        # (side_flip on the winning rule, wrong-side only, never contra)
        expected_wrong_side = None
        if pack_rule.side_flip is not None and not pack_rule.contra:
            natural = _natural_side(pack_rule.line_id)
            if pack_rule.side_flip.side != natural:
                expected_wrong_side = pack_rule.side_flip.line_id
        assert coa.wrong_side_flip_bucket(code) == expected_wrong_side, code


def test_spot_28x_accumulated_depreciation_is_contra(ro_pack):
    for code, line in (
        ("2801", "intangibles"), ("2805", "intangibles"), ("2808", "intangibles"),
        ("2811", "ppe"), ("2813", "ppe"), ("2815", "ppe"),
    ):
        rule = ro_pack.match(code)
        assert rule is not None and rule.contra is True, code
        assert rule.line_id == line, code
    # the wider contra families ported with the same flag
    assert ro_pack.match("29").contra is True          # impairments on fixed assets
    assert ro_pack.match("391").contra is True         # inventory allowances
    assert ro_pack.match("491").contra is True         # AR allowances
    assert ro_pack.match("59").contra is True          # treasury allowances
    assert ro_pack.match("169").contra is True         # bond premium contra-debt
    assert ro_pack.match("269").contra is True         # contra to 26x


def test_spot_4111_is_side_conditional(ro_pack):
    rule = ro_pack.match("4111")
    assert rule.line_id == "ar"
    assert rule.side_flip is not None
    assert rule.side_flip.side == "credit"
    # credit-closing customers = advances received, never negative AR
    assert ro_pack.target_line("4111", "credit") == "otherCurrentLiab"
    assert ro_pack.target_line("4111", "debit") == "ar"


def test_spot_5121_credit_side_is_overdraft(ro_pack):
    assert ro_pack.target_line("5121", "debit") == "cash"
    assert ro_pack.target_line("5121", "credit") == "stDebt"
    assert ro_pack.target_line("5124", "credit") == "stDebt"
    # 512x analytics flip via the synthesized carrier; 511x/518x (plain
    # bank family, no flip in the in-code table) must NOT flip.
    assert ro_pack.target_line("5125", "credit") == "stDebt"
    assert ro_pack.target_line("511", "credit") == "cash"
    assert ro_pack.target_line("518", "credit") == "cash"


def test_spot_class_8_is_excluded(ro_pack):
    for code in ("8", "801", "8034", "8038", "89"):
        rule = ro_pack.match(code)
        assert rule is not None, code
        assert rule.line_id == "ignore_offbalance", code
    # 891/892 stay separate rules so excluded-reasons can distinguish
    # the opening/closing BS control accounts from ordinary memo codes
    assert ro_pack.match("891").rule_id == "ro.891"
    assert ro_pack.match("892").rule_id == "ro.892"
    assert ro_pack.match("891").line_id == "ignore_offbalance"
    # the excluded leaves live under the dedicated non-section branch
    bs_top = [n.id for n in ro_pack.balance_sheet]
    assert bs_top == list(ca._BS_V2_SECTION_ORDER) + ["excluded"]
    excluded = next(n for n in ro_pack.balance_sheet if n.id == "excluded")
    assert [c.id for c in excluded.children] == [
        "ignore_control", "ignore_transit", "ignore_offbalance",
    ]


def test_spot_121_is_the_result_control(ro_pack):
    for code in ("121", "1210", "121101"):
        rule = ro_pack.match(code)
        assert rule is not None, code
        assert rule.line_id == "ignore_control", code
    assert "CONTROL" in ro_pack.match("121").description
    # 581 transit — the classic cash-overstatement trap — also excluded
    assert ro_pack.match("581").line_id == "ignore_transit"
    # the derived result rows exist in the equity section (row vocabulary)
    equity = next(n for n in ro_pack.balance_sheet if n.id == "equity")
    child_ids = [c.id for c in equity.children]
    assert "current_year_profit" in child_ids
    assert "current_year_loss" in child_ids


# ── checks.yaml — D0-D9 configuration ─────────────────────────────────


def test_checks_cover_d0_to_d9(ro_pack):
    ids = [c.check_id for c in ro_pack.checks]
    assert set(ids) >= KNOWN_DECLARATIVE_CHECK_IDS
    assert set(ids) == KNOWN_DECLARATIVE_CHECK_IDS | {"reconciliation_identities"}
    assert all(c.enabled for c in ro_pack.checks)
    by_id = {c.check_id: c for c in ro_pack.checks}
    # D0-D8 are emitted by the engine's diagnosis pass; D9 by the builder
    for n in range(9):
        check = by_id["D%d_%s" % (n, _D_SUFFIXES[n])]
        assert check.impl == "builtin.bs_diagnosis", check.check_id
    assert by_id["D9_UNMAPPED_INCLUDED"].impl is None
    assert by_id["D9_UNMAPPED_INCLUDED"].params["emit_regardless_of_status"] is True
    assert list(by_id["D9_UNMAPPED_INCLUDED"].params["row_ids"]) == [
        "unclassified_debit", "unclassified_credit",
    ]
    assert by_id["reconciliation_identities"].impl == "builtin.reconciliation_identities"


_D_SUFFIXES = {
    0: "ANCHOR_DIVERGENCE", 1: "SOURCE_IMBALANCED", 2: "FINGERPRINT",
    3: "CONTRA_MISPLACED", 4: "BIFUNCTIONAL_SIDE", 5: "DUPLICATE_ROWS",
    6: "121_MISMATCH", 7: "MAGNITUDE", 8: "OMITTED",
}


def test_check_params_mirror_incode_constants(ro_pack, rc_checks):
    by_id = {c.check_id: c for c in ro_pack.checks}
    assert list(by_id["D0_ANCHOR_DIVERGENCE"].params["anchor_pair_order"]) == list(
        rc_checks._ANCHOR_PAIR_ORDER
    )
    assert by_id["D1_SOURCE_IMBALANCED"].params["detail_label_ro"] == "Sursă dezechilibrată"
    d3 = by_id["D3_CONTRA_MISPLACED"].params
    assert list(d3["contra_prefixes"]) == list(rc_checks._CONTRA_PREFIXES)
    assert list(d3["asset_section_ids"]) == sorted(rc_checks._ASSET_SECTION_IDS)
    d4 = by_id["D4_BIFUNCTIONAL_SIDE"].params
    assert list(d4["bifunctional_prefixes"]) == list(rc_checks._BIFUNCTIONAL_PREFIXES)
    # 117/121 negative balances are legitimate negative equity — exempt
    assert list(d4["negative_equity_exempt_prefixes"]) == ["117", "121"]
    for check_id in ("D0_ANCHOR_DIVERGENCE", "D2_FINGERPRINT", "D5_DUPLICATE_ROWS",
                     "D7_MAGNITUDE"):
        assert by_id[check_id].params["ron_tolerance"] == rc_checks._RON_TOLERANCE
    ident = by_id["reconciliation_identities"].params
    assert ident["ron_tolerance"] == rc_checks._RON_TOLERANCE
    assert ident["pct_tolerance"] == rc_checks._PCT_TOLERANCE      # BALANCED gate
    assert ident["minor_drift_pct"] == rc_checks._MINOR_DRIFT_PCT  # 0.5% ceiling
    assert by_id["D6_121_MISMATCH"].params["invariant_key"] == "p121_cross_check"


# ── reconcile.yaml — the auto-reconcile constants ─────────────────────


def test_reconcile_policy_constants(ro_pack, porter):
    consts = porter.extract_reconcile_constants()
    policy = ro_pack.reconcile
    # the 0.1% gate: |difference| / max(assets, E+L) <= 0.001
    assert policy.threshold == 0.001
    assert policy.threshold == 1.0 / int(consts["gate_multiplier"])
    # class-6/7 diagnosed cause -> P&L by the delta's sign; all else BS
    assert policy.placement_for("class_67_target_delta_positive") == "pl_other_income"
    assert policy.placement_for("class_67_target_delta_negative") == "pl_other_expense"
    assert policy.placement_for("default") == "bs"
    assert policy.placement_for("rounding_cents_or_anything_else") == "bs"
    # one visible line, statutory Romanian label in BOTH languages —
    # exactly what the engine serves (SYNTHETIC_ROW_LABEL)
    assert policy.label_for("ro") == "Diferențe de reconciliere"
    assert policy.label_for("en") == "Diferențe de reconciliere"
    assert consts["synthetic_row_label"] == "Diferențe de reconciliere"


# ── statement map — section/row vocabulary ────────────────────────────


def test_statement_map_carries_canonical_sections_and_rule_targets(ro_pack):
    bs_top = [n.id for n in ro_pack.balance_sheet]
    assert bs_top[:8] == list(ca._BS_V2_SECTION_ORDER)
    leaves = set(ro_pack.leaf_line_ids())
    # every classification target (incl. side_flip re-route targets) is a leaf
    for rule in ro_pack.rules:
        assert rule.line_id in leaves, rule.rule_id
        if rule.side_flip is not None:
            assert rule.side_flip.line_id in leaves, rule.rule_id
    # the derived result rows match the canonical adapter's vocabulary
    assert set(ca._RESULT_LEAF_NAMES) <= leaves
    # closing-identity rows present on their contract sections
    current_assets = next(n for n in ro_pack.balance_sheet if n.id == "current_assets")
    assert current_assets.children[-1].id == "unclassified_debit"
    current_liab = next(
        n for n in ro_pack.balance_sheet if n.id == "current_liabilities"
    )
    assert current_liab.children[-1].id == "unclassified_credit"
