"""E6 — MOVEMENTS (rulaje) intelligence: convention probe, M-coded
identity findings, the pack-declared check channel, and the advisory AI
movement review.

Covers:
  * convention probe on a direct "Total sume includes opening" rows
    fixture (the Sibiu-style 4-pair family) -> B;
  * real-fixture probes via the classic parse (agras + frozen), outcome
    recorded HONESTLY: these SAGA exports carry cumulative MOVEMENTS in
    the st pair (net(si)+net(st)==net(sf) exact on every row) -> C;
  * planted per-account violation -> M1 names the account with exact
    minor units; planted cross-foot break -> M2;
  * absent pairs -> honest not_applicable, never a guessed verdict;
  * findings never mutate rows (byte-compare before/after);
  * zero jurisdiction tokens in the new engine modules (N7-style
    self-test);
  * the pack-declared channel: the REAL zz pack's checks.yaml binds
    builtin.movement_identities and the impl executes via CHECK_IMPLS
    with the pack's own params;
  * the env-gated attach seam on the RO pack parse path (default OFF —
    goldens embed source_anchor byte-for-byte);
  * movement_review: scripted clients only, whitelist projection,
    env-gate + failure isolation.

NO AI CALLS ANYWHERE: model interaction is via scripted client objects.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

import engine.country_packs.ro_romania  # noqa: F401 — registers the RO pack
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.country_packs.ro_romania.pack import RomaniaPack
from engine.packs.schema import CHECK_IMPLS
from engine.packs.runtime import active_pack
from engine.passes import movements
from engine.passes import movement_review
from engine.passes.movements import (
    compute_movement_checks,
    movement_checks_pass,
)

REPO = Path(__file__).resolve().parents[2]
FILES = REPO / "files"

ALL_PAIRS = {"si": True, "rl": True, "rc": True, "sf": True}


def _row(cont, si_d=0.0, si_c=0.0, r_d=0.0, r_c=0.0,
         st_d=0.0, st_c=0.0, sf_d=0.0, sf_c=0.0, nume="acct"):
    return {
        "cont": cont, "nume_cont": nume,
        "si_d": si_d, "si_c": si_c, "r_d": r_d, "r_c": r_c,
        "st_d": st_d, "st_c": st_c, "sf_d": sf_d, "sf_c": sf_c,
    }


def _b_style_rows():
    """4-pair 'Total sume' family: st = si + r per side (includes the
    opening), sf = net(st). Openings and movements each cross-foot
    (Σd == Σc, real double-entry) and several openings are nonzero so
    identity C (which excludes the opening) fails."""
    rows = []
    specs = [
        # cont, si_d, si_c, r_d, r_c   (Σsi: 1400/1400, Σr: 875/875)
        ("100", 0.0, 500.00, 0.0, 250.00),
        ("212", 900.00, 0.0, 100.00, 0.0),
        ("371", 300.00, 0.0, 120.00, 70.00),
        ("401", 0.0, 400.00, 150.00, 50.00),
        ("512", 200.00, 0.0, 505.00, 505.00),
        ("117", 0.0, 500.00, 0.0, 0.00),
    ]
    for cont, si_d, si_c, r_d, r_c in specs:
        st_d, st_c = si_d + r_d, si_c + r_c
        net = round(st_d - st_c, 2)
        sf_d, sf_c = (net, 0.0) if net >= 0 else (0.0, -net)
        rows.append(_row(cont, si_d, si_c, r_d, r_c, st_d, st_c, sf_d, sf_c))
    return rows


def _c_style_rows():
    """'Rulaj cumulat' family: st = cumulative movements EXCLUDING the
    opening (here equal to r), sf = net(si + st). Openings and
    movements each cross-foot (Σsi: 2150/2150, Σr: 1930/1930)."""
    rows = []
    specs = [
        ("100", 0.0, 800.00, 100.00, 300.00),
        ("212", 1500.00, 0.0, 250.00, 0.0),
        ("371", 400.00, 0.0, 90.00, 140.00),
        ("401", 0.0, 350.00, 200.00, 300.00),
        ("512", 250.00, 0.0, 1290.00, 1190.00),
        ("117", 0.0, 1000.00, 0.0, 0.00),
    ]
    for cont, si_d, si_c, r_d, r_c in specs:
        st_d, st_c = r_d, r_c
        net = round((si_d - si_c) + (st_d - st_c), 2)
        sf_d, sf_c = (net, 0.0) if net >= 0 else (0.0, -net)
        rows.append(_row(cont, si_d, si_c, r_d, r_c, st_d, st_c, sf_d, sf_c))
    return rows


# ═══════════════════════════════════════════════════════════════════════
# Convention probe
# ═══════════════════════════════════════════════════════════════════════


def test_convention_b_on_total_sume_rows_sibiu_style():
    result = compute_movement_checks(_b_style_rows(), ALL_PAIRS)
    conv = result["convention"]
    assert conv["winner"] == "B"
    assert conv["rates"]["B"]["rate"] == 1.0
    # st == si + r holds per side in the 4-pair family
    assert conv["rates"]["B"]["per_side_rate"] == 1.0
    # C excludes the opening and must fail on the nonzero-si rows
    assert conv["rates"]["C"]["rate"] < 1.0
    # A also holds (r covers all movements) — the tie resolves to B by
    # the fixed preference order, and says so
    assert conv["rates"]["A"]["rate"] == 1.0
    assert "tie_note" in conv
    by_code = {f["code"]: f for f in result["findings"]}
    assert by_code["M1_PER_ACCOUNT_IDENTITY"]["status"] == "pass"
    assert by_code["M3_CLOSING_CONSISTENT"]["status"] == "pass"
    assert movement_checks_pass(result) is True


def test_convention_c_on_cumulative_movement_rows():
    result = compute_movement_checks(_c_style_rows(), ALL_PAIRS)
    conv = result["convention"]
    assert conv["winner"] == "C"
    assert conv["rates"]["C"]["rate"] == 1.0
    assert conv["rates"]["B"]["rate"] < 1.0


@pytest.mark.parametrize("fixture,expected_winner", [
    ("agras_tb_2025.xlsx", "C"),
    ("scandia_frozen_tb_2025.xlsx", "C"),
])
def test_real_fixture_probe_via_classic_parse(fixture, expected_winner):
    """HONEST recorded outcome: these SAGA 10-col exports carry
    cumulative MOVEMENTS (opening excluded) in the st pair —
    net(si) + net(st) == net(sf) holds on every on-balance row, so the
    probe reports C, and all three M-checks pass with the RO class-8
    memo family excluded via params (single-entry, off-balance)."""
    rows = tbp.parse_trial_balance_file(
        (FILES / fixture).read_bytes(), fixture
    )
    pairs = rows.source_anchor.get("pairs") or {}
    pairs_present = {k: (pairs.get(k) is not None) for k in ALL_PAIRS}
    result = compute_movement_checks(
        rows, pairs_present,
        params={"exclude_code_prefixes": ["8"],
                "crossfoot_tolerance_minor": 100},
    )
    conv = result["convention"]
    assert conv["winner"] == expected_winner
    assert conv["rates"][expected_winner]["rate"] == 1.0
    by_code = {f["code"]: f for f in result["findings"]}
    assert by_code["M1_PER_ACCOUNT_IDENTITY"]["status"] == "pass"
    assert by_code["M2_CROSSFOOT"]["status"] == "pass"
    assert by_code["M3_CLOSING_CONSISTENT"]["status"] == "pass"
    assert movement_checks_pass(result) is True
    # sf pair genuinely present on this family (not synthesized)
    assert result["pairs_present"]["sf"] is True


def test_frozen_fixture_crossfoot_sums_are_exact_integers():
    rows = tbp.parse_trial_balance_file(
        (FILES / "scandia_frozen_tb_2025.xlsx").read_bytes(),
        "scandia_frozen_tb_2025.xlsx",
    )
    result = compute_movement_checks(
        rows, None, params={"exclude_code_prefixes": ["8"],
                            "crossfoot_tolerance_minor": 100},
    )
    m2 = next(f for f in result["findings"] if f["code"] == "M2_CROSSFOOT")
    assert m2["status"] == "pass"
    for entry in m2["pairs"]:
        assert isinstance(entry["sum_debit_minor"], int)
        assert isinstance(entry["sum_credit_minor"], int)
        assert isinstance(entry["delta_minor"], int)


# ═══════════════════════════════════════════════════════════════════════
# Planted defects
# ═══════════════════════════════════════════════════════════════════════


def _c_style_many(copies):
    """`copies` balanced clones of the C-style block with distinct
    account codes — enough rows that one planted violation cannot tank
    the document-wide convention vote (as in real files)."""
    rows = []
    for i in range(copies):
        for base in _c_style_rows():
            r = dict(base)
            r["cont"] = "%s%02d" % (base["cont"], i)
            rows.append(r)
    return rows


def test_planted_violation_m1_names_the_account_with_exact_minor_units():
    rows = _c_style_many(12)  # 72 rows; 1 violation keeps the vote >= 98%
    # corrupt one account's closing by exactly 12.34
    victim = next(r for r in rows if r["cont"] == "37100")
    victim["sf_d"] = round(victim["sf_d"] + 12.34, 2)
    result = compute_movement_checks(rows, ALL_PAIRS)
    assert result["convention"]["winner"] == "C"
    m1 = next(f for f in result["findings"]
              if f["code"] == "M1_PER_ACCOUNT_IDENTITY")
    assert m1["status"] == "fail"
    assert m1["violations_total"] == 1
    [v] = m1["violations"]
    assert v["cont"] == "37100"
    assert v["delta_minor"] == -1234  # identity minus sf: sf overstated
    m3 = next(f for f in result["findings"]
              if f["code"] == "M3_CLOSING_CONSISTENT")
    assert m3["status"] == "fail"
    assert m3["aggregate_delta_minor"] == -1234
    assert movement_checks_pass(result) is False


def test_m1_violation_list_is_capped_but_total_is_exact():
    rows = _c_style_many(34)  # 204 rows; 2 violations keep the vote >= 98%
    rows[0]["sf_c"] = round(rows[0]["sf_c"] + 1.00, 2)
    rows[1]["sf_d"] = round(rows[1]["sf_d"] + 2.00, 2)
    result = compute_movement_checks(
        rows, ALL_PAIRS, params={"violation_cap": 1},
    )
    m1 = next(f for f in result["findings"]
              if f["code"] == "M1_PER_ACCOUNT_IDENTITY")
    assert m1["status"] == "fail"
    assert m1["violations_total"] == 2
    assert len(m1["violations"]) == 1
    assert m1["violations_truncated"] is True


def test_crossfoot_break_fires_m2():
    rows = _c_style_rows()
    rows[1]["r_d"] = round(rows[1]["r_d"] + 5.00, 2)  # Σ r_d != Σ r_c now
    result = compute_movement_checks(rows, ALL_PAIRS)
    m2 = next(f for f in result["findings"] if f["code"] == "M2_CROSSFOOT")
    assert m2["status"] == "fail"
    rl = next(e for e in m2["pairs"] if e["pair"] == "rl")
    assert rl["delta_minor"] == 500
    assert movement_checks_pass(result) is False


# ═══════════════════════════════════════════════════════════════════════
# Honesty: absent pairs, synthesized sf, insufficient data
# ═══════════════════════════════════════════════════════════════════════


def test_absent_pairs_yield_honest_not_applicable():
    rows = [_row("212", sf_d=100.0), _row("401", sf_c=100.0)]
    result = compute_movement_checks(
        rows, {"si": False, "rl": False, "rc": False, "sf": True},
    )
    assert result["convention"]["winner"] == "insufficient"
    statuses = {f["code"]: f["status"] for f in result["findings"]}
    assert statuses == {
        "M1_PER_ACCOUNT_IDENTITY": "not_applicable",
        "M2_CROSSFOOT": "not_applicable",
        "M3_CLOSING_CONSISTENT": "not_applicable",
    }
    assert movement_checks_pass(result) is None
    assert result["class_signals"] == []


def test_synthesized_sf_excludes_identity_a_from_the_vote():
    rows = []
    for cont, si_d, si_c, r_d, r_c in [
        ("212", 100.0, 0.0, 50.0, 0.0),
        ("401", 0.0, 80.0, 10.0, 40.0),
        ("512", 30.0, 0.0, 0.0, 20.0),
    ]:
        net = (si_d - si_c) + (r_d - r_c)
        sf_d, sf_c = (net, 0.0) if net >= 0 else (0.0, -net)
        rows.append(_row(cont, si_d, si_c, r_d, r_c, 0.0, 0.0, sf_d, sf_c))
    result = compute_movement_checks(
        rows, {"si": True, "rl": True, "rc": False, "sf": True},
        layout_hint={"source_format": "compact", "synthesized_sf": True},
    )
    conv = result["convention"]
    assert conv["rates"]["A"].get("by_construction") is True
    assert conv["winner"] == "insufficient"  # nothing else testable
    m1 = next(f for f in result["findings"]
              if f["code"] == "M1_PER_ACCOUNT_IDENTITY")
    assert m1["status"] == "not_applicable"
    # cross-foot still runs on the genuinely-present period pair
    m2 = next(f for f in result["findings"] if f["code"] == "M2_CROSSFOOT")
    assert m2["status"] == "pass"


def test_subcent_values_are_flagged_not_silently_absorbed():
    rows = _c_style_rows()
    rows[0]["r_c"] = 300.005  # not representable in minor units
    result = compute_movement_checks(rows, ALL_PAIRS)
    assert result["subcent_rounded_rows"] == ["100"]


# ═══════════════════════════════════════════════════════════════════════
# Findings never mutate
# ═══════════════════════════════════════════════════════════════════════


def test_findings_never_mutate_rows():
    rows = _b_style_rows()
    before = json.dumps(rows, sort_keys=True)
    compute_movement_checks(rows, ALL_PAIRS)
    compute_movement_checks(rows, None)  # inference path too
    assert json.dumps(rows, sort_keys=True) == before


def test_determinism_same_rows_same_result():
    rows = _c_style_rows()
    a = compute_movement_checks(rows, ALL_PAIRS)
    b = compute_movement_checks(copy.deepcopy(rows), dict(ALL_PAIRS))
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


# ═══════════════════════════════════════════════════════════════════════
# N7 discipline — the new engine modules are jurisdiction-blind
# ═══════════════════════════════════════════════════════════════════════


def test_new_engine_modules_carry_zero_jurisdiction_tokens():
    zz_re = re.compile(r"(?<![A-Za-z])[Zz][Zz](?![A-Za-z])")
    # RO/HU jurisdiction literals and RAS account-code literals an
    # engine movement pass must never hardcode.
    forbidden_literals = (
        '"RO"', "'RO'", '"HU"', "'HU'",
        '"121"', "'121'", '"4111"', "'4111'", '"391"', "'391'",
        '"491"', "'491'", 'startswith("8")', "startswith('8')",
    )
    for name in ("movements.py", "movement_review.py"):
        src = (REPO / "src" / "engine" / "passes" / name).read_text(
            encoding="utf-8"
        )
        assert not zz_re.search(src), "%s names the test jurisdiction" % name
        for lit in forbidden_literals:
            assert lit not in src, "%s hardcodes %s" % (name, lit)


def test_movements_module_top_level_imports_are_stdlib_only():
    """The by-path-load contract (engine.packs.schema lazy registration
    pattern): module-level imports must be stdlib only."""
    src = (REPO / "src" / "engine" / "passes" / "movements.py").read_text(
        encoding="utf-8"
    )
    for line in src.splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")) and not line[:1].isspace():
            assert "engine" not in stripped, (
                "module-level engine import breaks the by-path load "
                "contract: %s" % stripped
            )


# ═══════════════════════════════════════════════════════════════════════
# The pack-declared check channel (real zz pack, real CHECK_IMPLS)
# ═══════════════════════════════════════════════════════════════════════


def test_pack_declared_movement_check_executes_via_check_impls():
    pack = active_pack("ZZ")
    cfg = next(c for c in pack.checks if c.check_id == "movement_identities")
    assert cfg.impl == "builtin.movement_identities"
    assert cfg.impl in CHECK_IMPLS
    rows = _c_style_rows() + [_row("900", r_d=10.0, st_d=10.0, sf_d=10.0)]
    result = CHECK_IMPLS[cfg.impl](rows, ALL_PAIRS, params=cfg.params)
    assert result["schema"] == "movement_checks_v1"
    # the pack's own params carried the jurisdiction datum: ZZ's
    # off-balance class 9xx is excluded by prefix
    assert result["rows_excluded_by_prefix"] == 1
    assert result["convention"]["winner"] == "C"
    assert movement_checks_pass(result) is True


def test_check_impl_registration_is_idempotent():
    movements.register_movement_check_impl()
    movements.register_movement_check_impl()
    assert CHECK_IMPLS["builtin.movement_identities"] is not None


# ═══════════════════════════════════════════════════════════════════════
# The RO pack attach seam (env-gated, default OFF)
# ═══════════════════════════════════════════════════════════════════════


def _fake_parse_result():
    rows = _c_style_rows()
    return tbp.TrialBalanceParseResult(
        rows,
        extraction={"source_format": "saga_10_col"},
        source_anchor={
            "pairs": {
                "si": {}, "rl": {}, "rc": {}, "sf": {},
            },
            "anchor_status": "NO_ANCHOR",
        },
    )


def test_attach_movement_checks_default_off(monkeypatch):
    monkeypatch.delenv("MOVEMENT_CHECKS", raising=False)
    pack = RomaniaPack()
    result = pack.attach_movement_checks(_fake_parse_result())
    assert "movement_checks" not in result.source_anchor


def test_attach_movement_checks_env_on(monkeypatch):
    monkeypatch.setenv("MOVEMENT_CHECKS", "1")
    pack = RomaniaPack()
    parsed = _fake_parse_result()
    before = json.dumps(list(parsed), sort_keys=True)
    result = pack.attach_movement_checks(parsed)
    mc = result.source_anchor["movement_checks"]
    assert mc["schema"] == "movement_checks_v1"
    assert mc["convention"]["winner"] == "C"
    assert mc["layout_hint"]["source_format"] == "saga_10_col"
    # rows byte-identical — findings never mutate
    assert json.dumps(list(result), sort_keys=True) == before


def test_attach_movement_checks_noops_on_plain_lists(monkeypatch):
    monkeypatch.setenv("MOVEMENT_CHECKS", "1")
    pack = RomaniaPack()
    rows = _c_style_rows()
    assert pack.attach_movement_checks(rows) is rows


def test_full_parse_path_attaches_only_when_gated(monkeypatch):
    data = (FILES / "agras_tb_2025.xlsx").read_bytes()
    pack = RomaniaPack()
    monkeypatch.delenv("MOVEMENT_CHECKS", raising=False)
    off = pack.parse_trial_balance(data, "agras_tb_2025.xlsx")
    assert "movement_checks" not in off.source_anchor
    monkeypatch.setenv("MOVEMENT_CHECKS", "1")
    on = pack.parse_trial_balance(data, "agras_tb_2025.xlsx")
    mc = on.source_anchor["movement_checks"]
    assert mc["convention"]["winner"] == "C"
    assert movement_checks_pass(mc) is True


# ═══════════════════════════════════════════════════════════════════════
# AI movement review — scripted clients only
# ═══════════════════════════════════════════════════════════════════════


def _scripted_client(payload):
    text = json.dumps(payload)

    class _Messages:
        @staticmethod
        def create(**kwargs):
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text=text)]
            )

    return SimpleNamespace(messages=_Messages())


def test_movement_review_sanitizes_and_projects(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BREAKER_STATE_DIR", str(tmp_path))
    movement = compute_movement_checks(_c_style_rows(), ALL_PAIRS)
    client = _scripted_client({
        "flags": [
            {"pattern": "dormant-heavy-movement",
             "explanation_en": "account moved heavily then closed flat",
             "explanation_ro": "contul a rulat mult si a inchis pe zero",
             "citation": "M-class signal 5",
             "forged_status": "BALANCED"},          # stripped
            {"pattern": "", "explanation_en": "no pattern -> dropped"},
        ],
        "proposals": [
            {"rule_kind": "movement_conditioned_classification",
             "condition": {"pair": "rl", "comparison": "net_zero_closing"},
             "target": "other_operating_expenses",
             "rationale": "flow-through account",
             "citation": "rows 100",
             "forged_key": True},                    # stripped
            {"rule_kind": "some_other_kind",         # dropped entirely
             "condition": {"x": 1}, "target": "y"},
        ],
    })
    out = movement_review.run_movement_review(
        movement, _c_style_rows(), client_factory=lambda: client,
    )
    assert out["schema"] == "movement_review_v1"
    assert out["role"] == "movement_review"
    [flag] = out["flags"]
    assert set(flag) <= {"pattern", "explanation_en", "explanation_ro",
                         "citation"}
    assert "forged_status" not in flag
    [proposal] = out["proposals"]
    assert proposal["rule_kind"] == "movement_conditioned_classification"
    assert "forged_key" not in proposal
    assert proposal["condition"] == {"pair": "rl",
                                     "comparison": "net_zero_closing"}
    assert out["audit"], "per-attempt audit trail must be captured"


def test_movement_review_never_mutates_inputs(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BREAKER_STATE_DIR", str(tmp_path))
    movement = compute_movement_checks(_c_style_rows(), ALL_PAIRS)
    rows = _c_style_rows()
    before_m = json.dumps(movement, sort_keys=True)
    before_r = json.dumps(rows, sort_keys=True)
    movement_review.run_movement_review(
        movement, rows,
        client_factory=lambda: _scripted_client({"flags": [],
                                                 "proposals": []}),
    )
    assert json.dumps(movement, sort_keys=True) == before_m
    assert json.dumps(rows, sort_keys=True) == before_r


def test_movement_review_env_gate_default_off(monkeypatch):
    monkeypatch.delenv("AI_MOVEMENT_REVIEW", raising=False)
    called = []

    def factory():
        called.append(1)
        raise AssertionError("must not construct a client when disabled")

    out = movement_review.maybe_run_movement_review(
        {"schema": "movement_checks_v1", "findings": []}, [],
        client_factory=factory,
    )
    assert out is None
    assert called == []


def test_movement_review_degrades_to_none_on_failure(monkeypatch):
    monkeypatch.setenv("AI_MOVEMENT_REVIEW", "1")

    def broken_factory():
        raise RuntimeError("no credentials")

    out = movement_review.maybe_run_movement_review(
        {"schema": "movement_checks_v1", "findings": []}, [],
        client_factory=broken_factory,
    )
    assert out is None


def test_movement_review_unavailable_raises_typed(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BREAKER_STATE_DIR", str(tmp_path))

    def broken_factory():
        raise RuntimeError("boom")

    with pytest.raises(movement_review.MovementReviewUnavailable) as ei:
        movement_review.run_movement_review(
            {}, [], client_factory=broken_factory,
        )
    assert ei.value.reason == "client_unavailable"
