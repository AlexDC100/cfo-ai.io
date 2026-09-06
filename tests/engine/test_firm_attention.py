"""THE FIRM COCKPIT — attention items, gates FC2 / FC4 / FC5 / FC9 and the
kind-by-kind contract.

Every fixture under tests/engine/fixtures/firm/ is REAL ENGINE OUTPUT
(TC-1): the persisted envelope and assembled statements the pipeline
produces for a corpus trial balance, captured by
``tests/engine/fixtures/firm/capture.py`` and re-derived here so drift
is loud. Nothing in this file hand-builds an envelope.

GATES (each has a plant recorded in design_review/firm/GATES.md):

  FC2  DETERMINISM   same client data -> identical items, order and
                     severities; AI on or off; input order shuffled.
  FC4  MATERIALITY   the SAME absolute delta on a small and a large real
                     client grades to DIFFERENT severities.
  FC5  DEDUP         N items on one client -> ONE row with N reasons; the
                     same client handed twice is still ONE row (C7).
  FC9  PERFORMANCE   200 clients computed incrementally; the MEASURED p50
                     is printed AND held to a budget derived from it, and
                     a one-client change recomputes one. (The route-shaped
                     half — 12 periods per client through the real reads —
                     lives in test_firm_route.py.)
  C5   IMPORT ORDER  every module of the package imports FIRST in a fresh
                     process, and importing the package loads no AI
                     subsystem (the C9 measurement).

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import os
import re
import statistics
import subprocess
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from engine.api import _company_profile as CP
from engine.api import _finding_rank as R
from engine.firm import attention as FA
from engine.firm import calendar as CAL
from engine.firm import dedup, facts, pack as PK, severity as SV, suppress as SP
from engine.firm.model import ClientRecord, CovenantRecord, PeriodRecord

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "firm"
FIRM_PKG = REPO / "src" / "engine" / "firm"

CORPUS_CASES = ("saga_10_col_carniprod", "saga_10_col_agras",
                "saga_10_col_retail", "saga_10_col_realestate")
ALL_CASES = CORPUS_CASES + ("imbalance_03pct", "carniprod_filed_under_2017",
                            "synthetic_thin_equity", "synthetic_negative_equity")

#: Fixed dates: the fixtures end 2025-12-31 with a 25-day monthly close.
AS_OF_CURRENT = date(2026, 1, 10)      # December filed, deadline ahead -> current
AS_OF_STALE = date(2026, 3, 10)        # January and February unfiled -> stale


# ── Fixture book ─────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def cases() -> Dict[str, Dict[str, Any]]:
    out = {}
    for name in ALL_CASES:
        path = FIXTURES / (name + ".json")
        assert path.is_file(), "fixture %s missing — run capture.py" % path.name
        with open(str(path), encoding="utf-8") as fh:
            out[name] = json.load(fh)
    return out


def client_from(case: Dict[str, Any], client_id: str, name: Optional[str] = None,
                jurisdiction: str = "RO", period_end: Optional[str] = None,
                updated_at: str = "fx-1", covenants: Tuple[CovenantRecord, ...] = (),
                cadence_row: Optional[Dict[str, Any]] = None,
                extra_periods: Tuple[PeriodRecord, ...] = ()) -> ClientRecord:
    end = period_end or case["period_end"]
    period = PeriodRecord(
        period_id="%s:%s" % (client_id, end), period_end=end,
        currency=case["currency"], period_start=case["period_start"],
        source_document_id="doc:%s" % client_id, updated_at=updated_at,
        envelope=case["envelope"], statements=case["statements"],
        label=end)
    return ClientRecord(client_id=client_id, client_name=name or client_id,
                        jurisdiction=jurisdiction,
                        periods=(period,) + tuple(extra_periods),
                        cadence_row=cadence_row, covenants=covenants)


def compute(clients, as_of=AS_OF_CURRENT, **kw):
    return FA.compute_firm_attention(clients, as_of=as_of, **kw)


def items_of(report: FA.FirmAttentionReport, client_id: str) -> List[Any]:
    for row in report.rows:
        if row.client_id == client_id:
            return list(row.items)
    raise AssertionError("no row for %s" % client_id)


def gaps_of(report: FA.FirmAttentionReport, client_id: str) -> List[Any]:
    for row in report.rows:
        if row.client_id == client_id:
            return list(row.gaps)
    raise AssertionError("no row for %s" % client_id)


def kinds_of(report, client_id) -> List[str]:
    return [i.kind for i in items_of(report, client_id)]


def by_kind(report, client_id, kind) -> List[Any]:
    return [i for i in items_of(report, client_id) if i.kind == kind]


# ══════════════════════════════════════════════════════════════════════
# 0. Fixtures are real engine output, and still are
# ══════════════════════════════════════════════════════════════════════


def _load_capture():
    spec = importlib.util.spec_from_file_location("firm_capture", FIXTURES / "capture.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["firm_capture"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_tc1_fixtures_are_byte_identical_to_a_fresh_engine_capture(cases):
    """TC-1, mechanically: re-run the real pipeline over the same inputs
    and compare bytes. A fixture that drifted from the engine is a test
    against a belief."""
    capture = _load_capture()
    fresh = capture.build_all()
    assert set(fresh) == set(ALL_CASES) == set(cases)
    drift = []
    for name in ALL_CASES:
        if capture._dump(fresh[name]) != (FIXTURES / (name + ".json")).read_text(encoding="utf-8"):
            drift.append(name)
    assert not drift, ("FIRM FIXTURES DRIFT — regenerate with capture.py: %s"
                       % ", ".join(drift))


def test_fixtures_carry_a_served_envelope_the_gateway_accepts(cases):
    from engine.serving.facts import FactsGateway
    for name, case in cases.items():
        gw = FactsGateway.from_envelope(case["envelope"], currency=case["currency"])
        assert gw is not None, name
        assert gw.total_assets().amount_minor != 0, name


# ══════════════════════════════════════════════════════════════════════
# 1. The pack and the registry
# ══════════════════════════════════════════════════════════════════════


def test_pack_loads_and_every_enabled_kind_has_a_detector():
    pack = PK.load_attention_pack()
    FA.assert_full_coverage(pack)
    assert set(pack.enabled_kind_ids()) == set(FA.DETECTORS)


def test_radar_flag_is_declared_disabled_and_has_no_detector():
    """Gracefully ABSENT: declared, disabled with a reason, no stub."""
    pack = PK.load_attention_pack()
    spec = pack.kind("RADAR_FLAG")
    assert spec.enabled is False and spec.absent_reason
    assert "RADAR_FLAG" not in FA.DETECTORS
    assert any(a["kind"] == "RADAR_FLAG" for a in pack.absent_kinds())


def test_a_stub_detector_for_a_disabled_kind_is_refused(monkeypatch):
    pack = PK.load_attention_pack()
    monkeypatch.setitem(FA.DETECTORS, "RADAR_FLAG", lambda ctx: ([], []))
    with pytest.raises(FA.KindCoverageError) as exc:
        FA.assert_full_coverage(pack)
    assert "DISABLED" in str(exc.value)


def test_pack_refuses_an_override_for_an_unknown_profile(tmp_path):
    raw = _raw_pack()
    raw["kinds"][[k["kind"] for k in raw["kinds"]].index("CASH_RUNWAY")]["thresholds"][
        "by_profile"]["not_a_profile"] = {"runway_days_min": 1}
    with pytest.raises(PK.AttentionPackError) as exc:
        PK.AttentionPack(raw, origin="test", catalog=CP.load_catalog())
    assert "not_a_profile" in str(exc.value)


def test_pack_refuses_a_disabled_kind_without_an_absent_reason():
    raw = _raw_pack()
    entry = raw["kinds"][[k["kind"] for k in raw["kinds"]].index("RADAR_FLAG")]
    entry["absent_reason"] = ""
    with pytest.raises(PK.AttentionPackError) as exc:
        PK.AttentionPack(raw, origin="test", catalog=CP.load_catalog())
    assert "absent_reason" in str(exc.value)


def test_pack_refuses_a_cadence_block_two_sources_of_truth():
    raw = _raw_pack()
    raw["cadence"] = {"default": "monthly"}
    with pytest.raises(PK.AttentionPackError) as exc:
        PK.AttentionPack(raw, origin="test", catalog=CP.load_catalog())
    assert "cadence.yaml" in str(exc.value)


def test_pack_refuses_an_unknown_materiality_basis():
    raw = _raw_pack()
    raw["kinds"][[k["kind"] for k in raw["kinds"]].index("IMBALANCED")]["materiality"] = "headcount"
    with pytest.raises(PK.AttentionPackError) as exc:
        PK.AttentionPack(raw, origin="test", catalog=CP.load_catalog())
    assert "headcount" in str(exc.value)


def _raw_pack() -> Dict[str, Any]:
    import yaml
    with open(str(PK.packs_dir() / PK.ATTENTION_PACK_NAME), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


# ── No name branches, no AI, in the whole package (the profiles pack's
#    no-name-branch rule and the AI-first reader's jurisdiction-blindness
#    rule, applied to this package) ─────────────────────────────────────

_GUARDED_FILES = tuple(sorted(p for p in FIRM_PKG.glob("*.py")
                              if p.name in ("attention.py", "severity.py", "dedup.py",
                                            "suppress.py", "facts.py", "pack.py",
                                            "calendar.py", "model.py", "_deps.py")))
_JURISDICTION_LITERAL = re.compile(r"""["'](?:RO|HU|ZZ)["']""")
_JURISDICTION_COMPARE = re.compile(r"\bjurisdiction\s*(?:==|!=)|(?:==|!=)\s*jurisdiction\b")


def _guarded_tokens() -> set:
    cat = CP.load_catalog()
    tokens = set(p.id for p in cat.structural_profiles)
    tokens |= set(b.id for b in cat.size_bands)
    tokens |= set(f.id for f in cat.financing_contexts)
    return tokens


def _prose_nodes(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            out.add(id(node.value))
    return out


def _quoted_hits(source: str, tokens: set) -> List[Tuple[int, str]]:
    tree = ast.parse(source)
    prose = _prose_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and id(node) not in prose and node.value.strip() in tokens:
            hits.append((node.lineno, node.value))
    return hits


def _name_compares(source: str) -> List[int]:
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left] + list(node.comparators)
        names = []
        for o in operands:
            if isinstance(o, ast.Name):
                names.append(o.id)
            elif isinstance(o, ast.Attribute):
                names.append(o.attr)
        has_string = any(isinstance(o, ast.Constant) and isinstance(o.value, str)
                         for o in operands)
        if has_string and any(n in ("profile", "profile_id", "structure", "size_band",
                                    "composite_id", "financing", "jurisdiction",
                                    "client_name", "firm_name", "client_id") for n in names):
            hits.append(node.lineno)
    return hits


def test_n7_no_profile_client_or_jurisdiction_branch_in_the_firm_package():
    assert len(_GUARDED_FILES) >= 9, "the firm package walk collapsed: %r" % [
        p.name for p in _GUARDED_FILES]
    tokens = _guarded_tokens()
    violations = []
    for path in _GUARDED_FILES:
        source = path.read_text(encoding="utf-8")
        for lineno, value in _quoted_hits(source, tokens):
            violations.append("%s:%d quotes profile id %r" % (path.name, lineno, value))
        for lineno in _name_compares(source):
            violations.append("%s:%d compares an identity against a string literal"
                              % (path.name, lineno))
        for lineno, line in enumerate(source.splitlines(), 1):
            if _JURISDICTION_LITERAL.search(line) or _JURISDICTION_COMPARE.search(line):
                violations.append("%s:%d jurisdiction literal/branch: %s"
                                  % (path.name, lineno, line.strip()[:80]))
            if re.search(r"\bimport\s+anthropic\b|\bfrom\s+anthropic\b|engine\.ai\b", line):
                violations.append("%s:%d imports an AI subsystem: %s"
                                  % (path.name, lineno, line.strip()[:80]))
    assert not violations, ("name-branch violation — identities are DATA keys in "
                            "packs/firm/*.yaml, never branches:\n" + "\n".join(violations))


def test_n7_guard_is_not_vacuous():
    tokens = _guarded_tokens()
    assert _quoted_hits('x = "property_rental"\n', tokens)
    assert _name_compares('if profile_id == "property_rental":\n    pass\n')
    assert _name_compares('if client.jurisdiction == "XX":\n    pass\n')
    assert _JURISDICTION_LITERAL.search('cal = load("RO")')


# ══════════════════════════════════════════════════════════════════════
# 2. FC2 — DETERMINISM
# ══════════════════════════════════════════════════════════════════════


def _book(cases) -> List[ClientRecord]:
    """Six real clients, one of them with a declared covenant and one with
    a suppression-able item, so the board carries every kind that can
    fire on this data."""
    covenant = CovenantRecord(covenant_id="bcr-net-assets", label="Net assets floor",
                              metric="equity", comparator=">=", limit=23_500_000.0,
                              headroom_warn_share=0.05, test_date="2026-02-15",
                              source="BCR facility agreement 2024")
    return [
        client_from(cases["saga_10_col_carniprod"], "c-carniprod", "Carniprod"),
        client_from(cases["saga_10_col_agras"], "c-agras", "Agras", covenants=(covenant,)),
        client_from(cases["saga_10_col_retail"], "c-retail", "Retail"),
        client_from(cases["saga_10_col_realestate"], "c-realestate", "RealEstate"),
        client_from(cases["imbalance_03pct"], "c-imbalanced", "Imbalanced"),
        client_from(cases["synthetic_negative_equity"], "c-negeq", "NegEq"),
        client_from(cases["carniprod_filed_under_2017"], "c-misfiled", "Misfiled",
                    period_end="2017-12-31"),
    ]


def _bytes(report: FA.FirmAttentionReport) -> str:
    return json.dumps(report.to_payload(), sort_keys=True, ensure_ascii=False)


def test_fc2_same_data_same_items_same_order_same_severities(cases, monkeypatch):
    """Two fresh computations, one with an AI key in the environment and
    one without, over a shuffled input order — byte-identical."""
    book = _book(cases)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AI_ADVISORY_ENABLED", raising=False)
    first = _bytes(compute(book, as_of=AS_OF_STALE, cache=facts.AttentionCache()))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-planted-not-a-real-key")
    monkeypatch.setenv("AI_ADVISORY_ENABLED", "1")
    shuffled = list(reversed(book))
    second = _bytes(compute(shuffled, as_of=AS_OF_STALE, cache=facts.AttentionCache()))
    third = _bytes(compute(book, as_of=AS_OF_STALE, cache=facts.AttentionCache()))
    assert first == second == third, (
        "FC2 DETERMINISM VIOLATED — the same client data produced different items, "
        "order or severities across runs (AI on/off, input shuffled)")
    payload = json.loads(first)
    assert payload["counts"]["items"] >= 12, "FC2 ran over a near-empty board"
    assert payload["counts"]["clients_with_items"] >= 6


def test_fc2_the_facts_stage_is_deterministic_per_client(cases):
    pack = PK.load_attention_pack()
    client = client_from(cases["saga_10_col_agras"], "c-agras")
    a = facts.build_client_facts(client, pack.cash_row_ids, pack.fingerprint())
    b = facts.build_client_facts(client, pack.cash_row_ids, pack.fingerprint())
    assert a.snapshot_key == b.snapshot_key
    assert [p.money["total_assets"].value for p in a.periods] == \
           [p.money["total_assets"].value for p in b.periods]
    assert [tuple(sorted(p.gaps)) for p in a.periods] == [tuple(sorted(p.gaps)) for p in b.periods]


def test_fc2_the_only_time_input_is_as_of_and_it_is_explicit(cases):
    book = _book(cases)
    with pytest.raises(TypeError):
        FA.compute_firm_attention(book, as_of="2026-03-10")  # type: ignore[arg-type]
    source = "\n".join(p.read_text(encoding="utf-8") for p in _GUARDED_FILES)
    assert "date.today()" not in source and "datetime.now(" not in source, (
        "a clock read inside engine.firm makes the board non-reproducible")


# ══════════════════════════════════════════════════════════════════════
# 3. FC4 — MATERIALITY: same delta, small vs large client, different grade
# ══════════════════════════════════════════════════════════════════════

SAME_DELTA = 250_000.0   # RON — the absolute amount at stake on both clients


def _gateway_assets(case) -> float:
    from engine.serving.facts import FactsGateway
    gw = FactsGateway.from_envelope(case["envelope"], currency=case["currency"])
    return gw.total_assets().to_float()


def test_fc4_same_absolute_delta_grades_differently_on_small_and_large_client(cases):
    """The severity function alone, fed each client's OWN served total
    assets (agras ~39M vs carniprod ~126M RON) and the same amount."""
    pack = PK.load_attention_pack()
    policy = R.MaterialityPolicy.from_pack()
    spec = pack.kind("IMBALANCED")
    small_assets = _gateway_assets(cases["saga_10_col_agras"])
    large_assets = _gateway_assets(cases["saga_10_col_carniprod"])
    assert large_assets > 2.5 * small_assets, "the pair is not small-vs-large"
    small_v, small_r = SV.assess(policy, "total_assets", "total assets", small_assets,
                                 SAME_DELTA, "RON")
    large_v, large_r = SV.assess(policy, "total_assets", "total assets", large_assets,
                                 SAME_DELTA, "RON")
    assert small_r is None and large_r is None
    small = SV.grade(spec, pack.severity, materiality=small_v)
    large = SV.grade(spec, pack.severity, materiality=large_v)
    assert small_v.tier != large_v.tier, (small_v.statement(), large_v.statement())
    assert small.severity != large.severity, (
        "FC4 MATERIALITY VIOLATED — the same %.0f RON delta graded %r on the small "
        "client and %r on the large client; severity is not materiality-aware"
        % (SAME_DELTA, small.severity, large.severity))
    assert pack.severity.index(small.severity) > pack.severity.index(large.severity)


def test_fc4_end_to_end_one_covenant_two_real_clients_two_severities(cases):
    """The same covenant headroom (SAME_DELTA) declared on both real clients,
    through the whole board."""
    small_equity = _gateway_equity(cases["saga_10_col_agras"])
    large_equity = _gateway_equity(cases["saga_10_col_carniprod"])

    def cov(equity):
        return (CovenantRecord(covenant_id="fc4", label="Net assets floor", metric="equity",
                               comparator=">=", limit=equity - SAME_DELTA,
                               headroom_warn_share=0.05),)

    small = client_from(cases["saga_10_col_agras"], "c-small", covenants=cov(small_equity))
    large = client_from(cases["saga_10_col_carniprod"], "c-large", covenants=cov(large_equity))
    report = compute([small, large])
    s_items = by_kind(report, "c-small", "COVENANT_RISK")
    l_items = by_kind(report, "c-large", "COVENANT_RISK")
    assert len(s_items) == 1 and len(l_items) == 1, (kinds_of(report, "c-small"),
                                                     kinds_of(report, "c-large"))
    # The gate's own claim comes FIRST, so a plant that disables the
    # materiality grade fails on THIS message and not on a TypeError
    # three lines down (a red for the wrong reason is not evidence).
    assert s_items[0].severity != l_items[0].severity, (
        "FC4 MATERIALITY VIOLATED — identical covenant headroom of %.0f RON graded "
        "%r on the small client and %r on the large one"
        % (SAME_DELTA, s_items[0].severity, l_items[0].severity))
    for item in (s_items[0], l_items[0]):
        assert item.materiality is not None, (
            "FC4 MATERIALITY VIOLATED — the item was never materiality-graded "
            "(refusal: %r)" % item.materiality_refusal)
        assert abs(item.materiality["amount"] - SAME_DELTA) < 1.0
        assert item.materiality["basis_id"] == "total_assets"
        assert item.severity_breakdown["materiality"]["tier"] in ("material", "info",
                                                                   "immaterial", "saturated")


def _gateway_equity(case) -> float:
    from engine.serving.facts import FactsGateway
    gw = FactsGateway.from_envelope(case["envelope"], currency=case["currency"])
    return gw.equity().to_float()


def test_fc4_materiality_refuses_on_an_unknown_denominator_and_caps_the_grade():
    pack = PK.load_attention_pack()
    policy = R.MaterialityPolicy.from_pack()
    verdict, refusal = SV.assess(policy, "total_assets", "total assets", None, 50_000.0, "RON")
    assert verdict is None and refusal and "undefined" in refusal
    graded = SV.grade(pack.kind("NEGATIVE_EQUITY"), pack.severity,
                      materiality=None, materiality_refusal=refusal)
    assert graded.severity == pack.severity.refused_cap
    assert graded.breakdown["materiality"]["tier"] == "refused"


# ══════════════════════════════════════════════════════════════════════
# 4. FC5 — DEDUP: N items on one client -> ONE row with N reasons
# ══════════════════════════════════════════════════════════════════════


def test_fc5_five_items_on_one_client_is_one_row_with_five_reasons(cases):
    """The misfiled Carniprod file, two months stale: mismatch + stale +
    missing periods + deadlines + the finding — many kinds, one row."""
    misfiled = client_from(cases["carniprod_filed_under_2017"], "c-misfiled", "Misfiled",
                           period_end="2017-12-31")
    report = compute([misfiled, client_from(cases["saga_10_col_agras"], "c-agras")],
                     as_of=AS_OF_STALE)
    rows = [r for r in report.rows if r.client_id == "c-misfiled"]
    assert len(rows) == 1, "FC5 DEDUP VIOLATED — %d rows for one client" % len(rows)
    row = rows[0]
    assert len(row.items) >= 5, kinds_of(report, "c-misfiled")
    assert len(row.reasons()) == len(row.items)
    assert len(set(row.reasons())) == len(row.reasons()), "duplicate reasons on one row"
    assert len(set(i.kind for i in row.items)) >= 4, "five items of one kind is not the test"
    payload = row.to_payload()
    assert payload["item_count"] == len(row.items) == len(payload["reasons"])
    assert payload["top_reason"] == row.items[0].reason
    # Every client passed is exactly one row, whether or not it has items.
    assert sorted(r.client_id for r in report.rows) == ["c-agras", "c-misfiled"]


def test_fc5_the_same_client_handed_twice_is_still_one_row(cases):
    """C7: two ClientRecords with ONE client_id. Without the input guard,
    group_by_client emitted a row PER RECORD, each carrying the merged
    items of both. The first record in input order wins; the drop is
    recorded on the payload, never silent."""
    first = client_from(cases["carniprod_filed_under_2017"], "c-dup", "Dup (misfiled)",
                        period_end="2017-12-31")
    second = client_from(cases["saga_10_col_agras"], "c-dup", "Dup (agras)")
    report = compute([first, second], as_of=AS_OF_STALE)
    rows = [r for r in report.rows if r.client_id == "c-dup"]
    assert len(rows) == 1, ("FC5 DEDUP VIOLATED — the same client_id handed as 2 records "
                            "produced %d rows" % len(rows))
    alone = compute([first], as_of=AS_OF_STALE)
    assert [i.to_payload() for i in rows[0].items] == [i.to_payload() for i in items_of(alone, "c-dup")], (
        "FC5 DEDUP VIOLATED — the surviving row does not carry the FIRST record's items alone")
    assert rows[0].client_name == "Dup (misfiled)"
    payload = report.to_payload()
    dropped = payload["duplicate_clients"]
    assert [d["client_id"] for d in dropped] == ["c-dup"] and dropped[0]["position"] == 1, dropped
    assert dropped[0]["client_name"] == "Dup (agras)" and "dropped" in dropped[0]["disposition"]
    assert payload["counts"]["duplicate_clients"] == 1 and payload["counts"]["clients"] == 1
    # Input order decides which record wins — and the payload says so.
    swapped = compute([second, first], as_of=AS_OF_STALE)
    assert [r.client_name for r in swapped.rows] == ["Dup (agras)"]
    assert swapped.to_payload()["duplicate_clients"][0]["client_name"] == "Dup (misfiled)"
    # No duplicates -> the field is present and empty, never absent.
    assert compute([first], as_of=AS_OF_STALE).to_payload()["duplicate_clients"] == []


def test_fc5_rows_rank_by_top_item_then_nearest_deadline(cases):
    pack = PK.load_attention_pack()
    report = compute(_book(cases), as_of=AS_OF_STALE)
    ranks = [pack.severity.index(r.top_severity) if r.top_severity else -1 for r in report.rows]
    assert ranks == sorted(ranks, reverse=True), [(r.client_id, r.top_severity) for r in report.rows]
    for row in report.rows:
        sev = [i.severity_rank() for i in row.items]
        assert sev == sorted(sev), (row.client_id, [i.kind for i in row.items])
        same = [i for i in row.items if i.severity == row.top_severity]
        dues = [i.days_to_due if i.days_to_due is not None else 10 ** 6 for i in same]
        assert dues == sorted(dues)


# ══════════════════════════════════════════════════════════════════════
# 5. The kinds, one by one, on real data
# ══════════════════════════════════════════════════════════════════════


def test_missing_file_a_period_row_without_a_trial_balance_escalates_toward_the_deadline(cases):
    base = client_from(cases["saga_10_col_agras"], "c-agras")
    hole = PeriodRecord(period_id="c-agras:2026-01-31", period_end="2026-01-31",
                        currency="RON", period_start="2026-01-01",
                        source_document_id=None, updated_at="fx-2", envelope=None)
    client = ClientRecord("c-agras", "Agras", "RO", periods=base.periods + (hole,))
    far = by_kind(compute([client], as_of=date(2026, 2, 3)), "c-agras", "MISSING_FILE")
    near = by_kind(compute([client], as_of=date(2026, 2, 24)), "c-agras", "MISSING_FILE")
    late = by_kind(compute([client], as_of=date(2026, 3, 3)), "c-agras", "MISSING_FILE")
    jan = lambda items: [i for i in items if i.scope_key == "period:2026-01-31"]  # noqa: E731
    assert jan(far) and jan(near) and jan(late)
    assert jan(far)[0].due_at == "2026-02-25"
    pack = PK.load_attention_pack()
    idx = pack.severity.index
    assert idx(jan(far)[0].severity) < idx(jan(near)[0].severity) < idx(jan(late)[0].severity)
    assert jan(late)[0].days_to_due < 0
    assert any(e.unit == "date" for e in jan(far)[0].evidence)


def test_missing_file_expected_unfiled_periods_come_from_the_cadence(cases):
    client = client_from(cases["saga_10_col_agras"], "c-agras")
    items = by_kind(compute([client], as_of=AS_OF_STALE), "c-agras", "MISSING_FILE")
    scopes = sorted(i.scope_key for i in items)
    assert "period:2026-01-31" in scopes, scopes
    assert all(i.due_at for i in items)


def test_missing_file_is_absent_when_the_client_is_current(cases):
    client = client_from(cases["saga_10_col_agras"], "c-agras")
    assert not by_kind(compute([client], as_of=AS_OF_CURRENT), "c-agras", "MISSING_FILE")


def test_stale_period_fires_with_the_age_and_the_cadence(cases):
    client = client_from(cases["saga_10_col_agras"], "c-agras")
    assert not by_kind(compute([client], as_of=AS_OF_CURRENT), "c-agras", "STALE_PERIOD")
    stale = by_kind(compute([client], as_of=AS_OF_STALE), "c-agras", "STALE_PERIOD")
    assert len(stale) == 1
    item = stale[0]
    assert "monthly" in item.reason
    assert item.severity_breakdown["age"]["days_over_budget"] > 0
    units = dict((e.fact, e.unit) for e in item.evidence)
    assert units["latest_period_end"] == "date" and units["age_days"] == "days"


def test_stale_period_quarterly_cadence_is_read_from_the_stored_row(cases):
    client = client_from(cases["saga_10_col_agras"], "c-agras",
                         cadence_row={"cadence": "quarterly"})
    report = compute([client], as_of=date(2026, 2, 20))
    assert not by_kind(report, "c-agras", "STALE_PERIOD")
    stale = by_kind(compute([client], as_of=date(2026, 5, 10)), "c-agras", "STALE_PERIOD")
    assert len(stale) == 1 and "quarterly" in stale[0].reason


def test_period_mismatch_surfaces_the_production_audit_case(cases):
    """A 2025 trial balance confirmed under 2017-12 — the real record
    the persist stage wrote, read back firm-wide."""
    client = client_from(cases["carniprod_filed_under_2017"], "c-misfiled",
                         period_end="2017-12-31")
    items = by_kind(compute([client]), "c-misfiled", "PERIOD_MISMATCH")
    assert len(items) == 1
    ev = dict((e.fact, e.text) for e in items[0].evidence)
    assert ev["stored_period_end"] == "2017-12-31"
    assert ev["detected_period_end"] == "2025-12-31"
    assert ev["detection_signal"] == "filename"
    assert items[0].severity == "high"
    clean = client_from(cases["saga_10_col_carniprod"], "c-carniprod")
    assert not by_kind(compute([clean]), "c-carniprod", "PERIOD_MISMATCH")


def test_imbalanced_fires_above_the_auto_reconcile_gate_and_not_on_a_balanced_book(cases):
    imb = client_from(cases["imbalance_03pct"], "c-imb")
    ok = client_from(cases["saga_10_col_carniprod"], "c-ok")
    report = compute([imb, ok])
    items = by_kind(report, "c-imb", "IMBALANCED")
    assert len(items) == 1 and not by_kind(report, "c-ok", "IMBALANCED")
    item = items[0]
    ev = dict((e.fact, e) for e in item.evidence)
    assert ev["difference"].unit == "money" and ev["difference"].currency == "RON"
    assert ev["difference"].provenance["snapshot_id"]
    assert ev["imbalance_share_pct"].value > PK.load_attention_pack().auto_reconcile_gate_share
    assert "awaiting mapping" in item.reason
    assert item.materiality is not None and item.materiality["basis_id"] == "total_assets"


def test_critical_finding_carries_the_headline_and_the_cited_facts(cases):
    """Whichever real fixture carries a critical finding — the engine
    decides, this test only asserts the carry-through — and that a
    fixture WITHOUT one stays quiet with a computed (not gapped) result."""
    report = compute(_book(cases))
    fired = [(row.client_id, i) for row in report.rows for i in row.items
             if i.kind == "CRITICAL_FINDING"]
    assert fired, "no fixture produced a critical finding — the carry-through is untested"
    for client_id, item in fired:
        assert item.severity == "critical"
        assert item.reason and item.action
        rule = [e for e in item.evidence if e.fact == "rule_key"][0].text
        assert rule
        assert any(e.unit == "money" and e.provenance["snapshot_id"] for e in item.evidence), rule
    quiet = [row for row in report.rows if not any(i.kind == "CRITICAL_FINDING" for i in row.items)]
    assert quiet
    for row in quiet:
        assert not any(g.kind == "CRITICAL_FINDING" for g in row.gaps), row.gaps


def test_covenant_risk_emits_nothing_and_says_so_when_none_is_declared(cases):
    report = compute([client_from(cases["saga_10_col_agras"], "c-agras")])
    assert not by_kind(report, "c-agras", "COVENANT_RISK")
    absent = dict((a["kind"], a["reason"]) for a in report.to_payload()["kinds_absent"])
    assert "COVENANT_RISK" in absent and "no covenant" in absent["COVENANT_RISK"]
    assert "RADAR_FLAG" in absent


def test_covenant_risk_breach_and_thin_headroom_are_graded_and_dated(cases):
    equity = _gateway_equity(cases["saga_10_col_agras"])
    breach = CovenantRecord("breach", "Net assets floor", "equity", ">=", equity + 1_000_000.0,
                            headroom_warn_share=0.05, test_date="2026-01-31")
    thin = CovenantRecord("thin", "Net assets floor", "equity", ">=", equity - 100_000.0,
                          headroom_warn_share=0.05, test_date="2026-03-31")
    wide = CovenantRecord("wide", "Net assets floor", "equity", ">=", equity * 0.5,
                          headroom_warn_share=0.05)
    client = client_from(cases["saga_10_col_agras"], "c-agras", covenants=(breach, thin, wide))
    items = dict((i.scope_key, i) for i in by_kind(compute([client]), "c-agras", "COVENANT_RISK"))
    assert set(items) == {"covenant:breach", "covenant:thin"}
    assert items["covenant:breach"].severity_breakdown["breach"]["step"] == 1
    assert items["covenant:breach"].days_to_due == 21
    assert "breach" not in items["covenant:thin"].severity_breakdown
    ev = dict((e.fact, e) for e in items["covenant:thin"].evidence)
    assert ev["equity"].unit == "money" and ev["covenant_limit"].provenance["source"].startswith("covenant:")


def test_cash_runway_is_profile_aware_and_reads_cash_through_the_gateway(cases):
    """Carniprod holds days of cash; the real-estate vehicle holds a year."""
    report = compute([client_from(cases["saga_10_col_carniprod"], "c-carniprod"),
                      client_from(cases["saga_10_col_realestate"], "c-re")])
    tight = by_kind(report, "c-carniprod", "CASH_RUNWAY")
    assert len(tight) == 1 and not by_kind(report, "c-re", "CASH_RUNWAY")
    item = tight[0]
    ev = dict((e.fact, e) for e in item.evidence)
    assert ev["cash"].unit == "money" and ev["cash"].provenance["line_id"]
    assert ev["cash_runway_days"].unit == "days" and ev["cash_runway_days"].value < ev["runway_floor_days"].value
    assert ev["runway_floor_days"].provenance["source"].startswith("attention.yaml#kinds.CASH_RUNWAY.thresholds")
    assert "days of expenses" in item.reason
    gaps = [g for g in gaps_of(report, "c-re") if g.kind == "CASH_RUNWAY"]
    assert not gaps, gaps


def test_cash_runway_threshold_is_tuned_per_profile_from_the_pack():
    pack = PK.load_attention_pack()
    cat = CP.load_catalog()
    tuned = [p.id for p in cat.structural_profiles
             if pack.threshold("CASH_RUNWAY", "runway_days_min", p.id).tuned]
    untuned = [p.id for p in cat.structural_profiles
               if not pack.threshold("CASH_RUNWAY", "runway_days_min", p.id).tuned]
    assert tuned and untuned, "the pack tunes no profile, or every profile"
    a = pack.threshold("CASH_RUNWAY", "runway_days_min", tuned[0])
    b = pack.threshold("CASH_RUNWAY", "runway_days_min", untuned[0])
    assert a.value != b.value and "by_profile" in a.source and "default" in b.source


def test_negative_equity_cites_the_statute_and_grades_negative_above_thin(cases):
    report = compute([client_from(cases["synthetic_negative_equity"], "c-neg"),
                      client_from(cases["synthetic_thin_equity"], "c-thin"),
                      client_from(cases["saga_10_col_carniprod"], "c-ok")])
    neg = by_kind(report, "c-neg", "NEGATIVE_EQUITY")
    thin = by_kind(report, "c-thin", "NEGATIVE_EQUITY")
    assert len(neg) == 1 and len(thin) == 1 and not by_kind(report, "c-ok", "NEGATIVE_EQUITY")
    assert "153^24" in neg[0].reason and "Legea 31/1990" in neg[0].reason
    assert neg[0].severity == "critical"
    assert neg[0].severity_rank() < thin[0].severity_rank()
    ev = dict((e.fact, e) for e in neg[0].evidence)
    assert ev["equity"].value < 0 and ev["share_capital"].value > 0
    assert ev["equity_to_capital_ratio"].unit == "ratio"
    assert neg[0].materiality is not None


def test_deadline_items_come_from_the_jurisdiction_calendar_and_are_absent_without_one(cases):
    ro = client_from(cases["saga_10_col_agras"], "c-ro", jurisdiction="RO")
    zz = client_from(cases["saga_10_col_agras"], "c-zz", jurisdiction="ZZ")
    report = compute([ro, zz], as_of=AS_OF_CURRENT)
    ro_items = by_kind(report, "c-ro", "DEADLINE")
    assert ro_items and all(i.due_at and i.days_to_due is not None for i in ro_items)
    assert any("D300" in i.reason for i in ro_items)
    assert not by_kind(report, "c-zz", "DEADLINE")
    gap = [g for g in gaps_of(report, "c-zz") if g.kind == "DEADLINE"]
    assert gap and "no fiscal calendar" in gap[0].reason


def test_calendar_resolves_by_name_and_computes_due_dates_without_a_clock():
    cal = CAL.load_calendar("RO")
    assert cal is not None and CAL.load_calendar("ZZ") is None
    tb = cal.due_for_period("trial_balance_close", date(2025, 12, 31))
    assert tb is not None and tb.due_at == date(2026, 1, 25)
    window = cal.deadlines_in_window(date(2026, 1, 10), 45)
    assert [d.due_at for d in window] == sorted(d.due_at for d in window)
    assert all(date(2026, 1, 10) <= d.due_at <= date(2026, 2, 24) for d in window)
    assert all(d.role == CAL.ROLE_FILING for d in window)


# ══════════════════════════════════════════════════════════════════════
# 6. Evidence, provenance, suppression
# ══════════════════════════════════════════════════════════════════════


def test_every_item_carries_typed_evidence_with_provenance(cases):
    report = compute(_book(cases), as_of=AS_OF_STALE)
    seen_money = 0
    for row in report.rows:
        for item in row.items:
            assert item.evidence, (row.client_id, item.kind)
            for e in item.evidence:
                assert e.unit in ("money", "ratio", "percent", "days", "count", "date", "text")
                assert (e.value is None) != (e.text is None), e
                assert e.provenance.get("source"), e
                if e.unit == "money":
                    seen_money += 1
                    assert e.currency == "RON" and e.provenance["period_id"]
                    assert e.provenance["snapshot_id"] or e.provenance["source"].startswith("covenant:")
            assert item.source.startswith("attention.yaml#kinds.")
            assert item.severity_breakdown["result"] == item.severity
    assert seen_money >= 8, "the board cited almost no money facts"


def test_every_cited_money_fact_is_declared_money_in_the_unit_registry(cases):
    """The rule the metric-declared census enforces, asserted on the
    board's OWN output: a money evidence fact whose name the registry
    does not know would resolve to UNIT_UNKNOWN — a refusal — at render."""
    from engine.api import _ratio_units
    from engine.firm.facts import DECLARED_MONEY_FACTS, SERVED_MONEY_FACTS
    covenant = CovenantRecord("c", "L", "equity", ">=",
                              _gateway_equity(cases["saga_10_col_agras"]) - 1.0,
                              headroom_warn_share=0.05)
    book = _book(cases) + [client_from(cases["saga_10_col_agras"], "c-cov", covenants=(covenant,))]
    report = compute(book, as_of=AS_OF_STALE)
    cited = set()
    own = set()   # cited by this package's own detectors (not carried from a finding)
    for row in report.rows:
        for item in row.items:
            for e in item.evidence:
                if e.unit == "money":
                    cited.add(e.fact)
                    if item.kind != "CRITICAL_FINDING":
                        own.add(e.fact)
    assert cited >= {"cash", "difference", "equity", "share_capital", "total_assets",
                     "expenses", "covenant_limit"}, cited
    undeclared = sorted(f for f in cited if _ratio_units.unit_for_fact(f) != _ratio_units.UNIT_MONEY)
    assert not undeclared, "money evidence cited under undeclared names: %r" % undeclared
    # A CRITICAL_FINDING carries the finding engine's own cited facts
    # (declared by that engine's gate); everything ELSE must come from
    # this package's registry, which the metric-declared census reads.
    registry = set(n for n, _ in SERVED_MONEY_FACTS) | set(DECLARED_MONEY_FACTS)
    assert own <= registry, "cited money outside the package's own registry: %r" % sorted(own - registry)
    for name in registry:
        assert _ratio_units.unit_for_fact(name) == _ratio_units.UNIT_MONEY, name


def test_no_money_figure_is_smuggled_into_prose(cases):
    """Money travels typed; a currency label beside digits in a reason is
    the Critical-461 defect in a new coat."""
    rx = re.compile(r"\b(RON|EUR|USD|HUF)\s*-?\d|\d[\d,.]{3,}\s*(RON|EUR|USD|HUF)\b")
    report = compute(_book(cases), as_of=AS_OF_STALE)
    for row in report.rows:
        for item in row.items:
            assert not rx.search(item.reason), item.reason
            assert not rx.search(item.action), item.action


def test_suppression_hides_a_non_critical_item_with_its_reason_and_never_a_critical_one(cases):
    book = [client_from(cases["saga_10_col_carniprod"], "c-carniprod"),
            client_from(cases["synthetic_negative_equity"], "c-neg")]
    index = SP.SuppressionIndex([
        SP.Suppression("c-carniprod", R.Dismissal(rule_id="CASH_RUNWAY", scope_key="*",
                                                  reason="bridge facility signed 2026-01",
                                                  dismissed_by="u1", dismissed_at="t1")),
        SP.Suppression("c-neg", R.Dismissal(rule_id="NEGATIVE_EQUITY", scope_key="*",
                                            reason="recapitalisation voted",
                                            dismissed_by="u1", dismissed_at="t1")),
        SP.Suppression("c-neg", R.Dismissal(rule_id="CASH_RUNWAY", scope_key="*", reason="")),
    ])
    report = compute(book, suppressions=index)
    assert not by_kind(report, "c-carniprod", "CASH_RUNWAY")
    hidden = [i for i in report.suppressed if i.client_id == "c-carniprod"]
    assert hidden and hidden[0].suppression["reason"] == "bridge facility signed 2026-01"
    neg = by_kind(report, "c-neg", "NEGATIVE_EQUITY")
    assert len(neg) == 1 and neg[0].suppressed_but_retained is True
    assert neg[0].suppression["reason"] == "recapitalisation voted"
    audit = report.to_payload()["suppression_audit"]
    assert any(a["retained"] for a in audit) and any(not a["retained"] for a in audit)
    assert index.rejected() and index.rejected()[0]["reason"] == ""
    # The reasonless suppression was ignored: the item is still there.
    assert by_kind(report, "c-neg", "CASH_RUNWAY") or not [
        g for g in gaps_of(report, "c-neg") if g.kind == "CASH_RUNWAY"]


def test_a_gap_is_recorded_when_a_kind_cannot_be_evaluated(cases):
    empty = ClientRecord("c-empty", "Empty", "RO", periods=())
    report = compute([empty], as_of=AS_OF_STALE)
    gaps = gaps_of(report, "c-empty")
    assert {g.kind for g in gaps} >= {"IMBALANCED", "CRITICAL_FINDING", "CASH_RUNWAY",
                                      "NEGATIVE_EQUITY", "STALE_PERIOD"}
    assert by_kind(report, "c-empty", "MISSING_FILE"), "never-filed client owes its periods"


# ══════════════════════════════════════════════════════════════════════
# 7. FC9 — PERFORMANCE, incremental, measured
# ══════════════════════════════════════════════════════════════════════

FC9_CLIENTS = 200

#: BUDGETS — derived from the measurement (TC-3), not negotiated. Reference
#: host 2026-09-04 (Python 3.9, macOS, this suite and the critics' probe):
#: cold facts p50 4.9–5.6 ms/client (gateway + profile + findings run),
#: warm open 0.37–0.54 ms/client, incremental (1 changed) 78–110 ms. ~4-5x
#: headroom for a slower CI host. Printed beside the measurement. A 50 ms
#: sleep planted in build_client_facts (the critics' slowplant) moves the
#: cold p50 to ~55 ms and REDs this gate; a cache that is never trusted
#: moves the warm open to the cold cost and REDs it twice.
FC9_BUDGET_COLD_P50_MS = 25.0
FC9_BUDGET_WARM_MS_PER_CLIENT = 2.5
FC9_BUDGET_INCREMENTAL_MS = 750.0


def _fleet(cases, n: int = FC9_CLIENTS) -> List[ClientRecord]:
    out = []
    for i in range(n):
        case = cases[CORPUS_CASES[i % len(CORPUS_CASES)]]
        out.append(client_from(case, "fleet-%03d" % i, "Client %03d" % i,
                               updated_at="v1"))
    return out


def test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured(cases, capsys):
    fleet = _fleet(cases)
    cache = facts.AttentionCache()
    pack = PK.load_attention_pack()

    # Cold: every client is a miss. Per-client timings for the p50.
    per_client = []
    t0 = time.perf_counter()
    for client in fleet:
        t = time.perf_counter()
        cache.get_or_build(client, facts.snapshot_key(client, pack.fingerprint()),
                           lambda c=client: facts.build_client_facts(
                               c, pack.cash_row_ids, pack.fingerprint()))
        per_client.append(time.perf_counter() - t)
    cold_total = time.perf_counter() - t0
    assert cache.misses == FC9_CLIENTS and cache.hits == 0

    # Warm open: nothing changed -> zero recomputation, the cheap half only.
    cache.reset_counters()
    t0 = time.perf_counter()
    warm = compute(fleet, as_of=AS_OF_STALE, cache=cache, pack=pack)
    warm_total = time.perf_counter() - t0
    assert cache.misses == 0 and cache.hits == FC9_CLIENTS, (
        "FC9 NOT INCREMENTAL — opening an unchanged board recomputed %d client(s)"
        % cache.misses)

    # One client changes: exactly one recompute, and its board reflects it.
    changed = fleet[7]
    swapped = client_from(cases["imbalance_03pct"], changed.client_id, changed.client_name,
                          updated_at="v2")
    fleet2 = list(fleet)
    fleet2[7] = swapped
    cache.reset_counters()
    t0 = time.perf_counter()
    incremental = compute(fleet2, as_of=AS_OF_STALE, cache=cache, pack=pack)
    inc_total = time.perf_counter() - t0
    assert cache.misses == 1 and cache.hits == FC9_CLIENTS - 1, (
        "FC9 NOT INCREMENTAL — one client changed; expected exactly 1 recompute, got %d "
        "(0 = the cache served STALE facts for a changed snapshot; %d = a full recompute)"
        % (cache.misses, FC9_CLIENTS))
    assert by_kind(incremental, changed.client_id, "IMBALANCED"), (
        "FC9 STALE — the changed client's new snapshot was not reflected")
    assert not by_kind(warm, changed.client_id, "IMBALANCED")
    untouched = [r.client_id for r in warm.rows if r.client_id != changed.client_id]
    assert [r.client_id for r in incremental.rows if r.client_id != changed.client_id] == untouched

    p50_cold = statistics.median(per_client) * 1000.0
    p95_cold = sorted(per_client)[int(0.95 * len(per_client)) - 1] * 1000.0
    warm_per_client = warm_total * 1000.0 / FC9_CLIENTS
    inc_ms = inc_total * 1000.0
    with capsys.disabled():
        print("\n[FC9] %d clients — cold facts: p50=%.1fms p95=%.1fms/client [budget p50 "
              "%.0fms], total=%.2fs; warm open (0 changed): %.0fms total, %.2fms/client "
              "[budget %.1fms/client]; incremental (1 changed): %.0fms total [budget %.0fms], "
              "misses=1 hits=%d"
              % (FC9_CLIENTS, p50_cold, p95_cold, FC9_BUDGET_COLD_P50_MS, cold_total,
                 warm_total * 1000.0, warm_per_client, FC9_BUDGET_WARM_MS_PER_CLIENT,
                 inc_ms, FC9_BUDGET_INCREMENTAL_MS, FC9_CLIENTS - 1))
    assert warm_total < cold_total, "the warm open was not cheaper than the cold build"
    assert inc_total < cold_total
    assert p50_cold <= FC9_BUDGET_COLD_P50_MS, (
        "FC9 OVER BUDGET — cold facts p50 %.1f ms/client exceeds the %.0f ms budget "
        "(reference host: 5.5 ms). The expensive half got slower: an extra pass per "
        "client, a repeated findings run, or a sleep." % (p50_cold, FC9_BUDGET_COLD_P50_MS))
    assert warm_per_client <= FC9_BUDGET_WARM_MS_PER_CLIENT, (
        "FC9 OVER BUDGET — warm open %.2f ms/client exceeds the %.1f ms budget (reference "
        "host: 0.45 ms). The cheap half is no longer cheap, or the cache is not trusted."
        % (warm_per_client, FC9_BUDGET_WARM_MS_PER_CLIENT))
    assert inc_ms <= FC9_BUDGET_INCREMENTAL_MS, (
        "FC9 OVER BUDGET — a one-client change cost %.0f ms, budget %.0f (reference host: "
        "~90 ms)" % (inc_ms, FC9_BUDGET_INCREMENTAL_MS))


def test_fc9_the_cache_key_changes_with_the_snapshot_and_not_with_the_day(cases):
    pack = PK.load_attention_pack()
    a = client_from(cases["saga_10_col_agras"], "c-a", updated_at="v1")
    b = client_from(cases["saga_10_col_agras"], "c-a", updated_at="v2")
    assert facts.snapshot_key(a, pack.fingerprint()) != facts.snapshot_key(b, pack.fingerprint())
    assert facts.snapshot_key(a, pack.fingerprint()) == facts.snapshot_key(
        client_from(cases["saga_10_col_agras"], "c-a", updated_at="v1"), pack.fingerprint())
    assert facts.snapshot_key(a, "other-pack") != facts.snapshot_key(a, pack.fingerprint())


# ══════════════════════════════════════════════════════════════════════
# 8. C5 — every module imports FIRST; the package loads no AI subsystem
# ══════════════════════════════════════════════════════════════════════

#: Production Supabase / model keys are stripped from every subprocess —
#: an import that reached for them would be a defect in its own right.
_STRIPPED_ENV = ("ANTHROPIC_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY",
                 "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")


def _fresh_process(code: str, extra_env: Optional[Dict[str, str]] = None
                   ) -> subprocess.CompletedProcess:
    env = dict((k, v) for k, v in os.environ.items() if k not in _STRIPPED_ENV)
    env["PYTHONPATH"] = str(REPO / "src")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra_env or {})
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                          env=env, timeout=180, cwd=str(REPO))


#: The fresh-process board over REAL clients (the agras and carniprod
#: corpus fixtures, eager envelope + statements — the critics' harness
#: shape). Prints one JSON line: what each client's row carries, which AI
#: modules were loaded at import and after the compute, and — measured
#: AFTER the compute, so it cannot mask it — what touching the AI seam
#: (`_reconcile.AI_MODEL`, the one registry read) does.
_REAL_BOARD_CODE = r"""
import json, sys
from datetime import date
from engine.firm import attention as FA
def ai(): return sorted(m for m in sys.modules if m == 'anthropic' or m.startswith('anthropic.') or m.startswith('engine.ai'))
after_import = ai()
from engine.firm.model import ClientRecord, PeriodRecord
clients = []
for org_id, name, fx in (('org-agras', 'Agras SA', 'saga_10_col_agras'),
                         ('org-carni', 'Carniprod SRL', 'saga_10_col_carniprod')):
    with open(%(fixtures)r + '/' + fx + '.json', encoding='utf-8') as fh:
        case = json.load(fh)
    period = PeriodRecord('%%s:%%s' %% (org_id, case['period_end']), case['period_end'], case['currency'],
                          case['period_start'], 'doc:' + org_id, 'v1',
                          envelope=case['envelope'], statements=case['statements'])
    clients.append(ClientRecord(org_id, name, 'RO', periods=(period,)))
try:
    report = FA.compute_firm_attention(clients, as_of=date(2026, 1, 10))
except Exception as exc:
    print(json.dumps({'board': 'DEAD', 'error': '%%s: %%s' %% (type(exc).__name__, exc),
                      'after_import': after_import, 'after_compute': ai()}))
    raise SystemExit(0)
after_compute = ai()
rows = dict((r.client_id, {'kinds': sorted(i.kind for i in r.items),
                           'gaps': [g.reason for g in r.gaps]}) for r in report.rows)
try:
    from engine.api import _reconcile
    seam = 'resolved: %%s' %% _reconcile.AI_MODEL
except Exception as exc:
    seam = '%%s: %%s' %% (type(exc).__name__, exc)
print(json.dumps({'board': 'RENDERED', 'rows': rows, 'counts': report.counts(),
                  'after_import': after_import, 'after_compute': after_compute,
                  'after_seam': ai(), 'seam': seam,
                  'reconcile_loaded': 'engine.api._reconcile' in sys.modules,
                  'server_loaded': 'engine.api.server' in sys.modules}))
""" % {"fixtures": str(FIXTURES)}


def _real_board(extra_env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    proc = _fresh_process(_REAL_BOARD_CODE, extra_env)
    assert proc.returncode == 0, proc.stderr[-2000:]
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _registry_without_the_role(tmp_path: Path) -> Path:
    """The packaged models.yaml with the ``reconcile_proposal`` role
    deleted — a registry that validates as MISSING A REQUIRED ROLE, the
    critics' plant. Every other role is intact, so nothing but that
    role's readers can be blamed."""
    import yaml
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text(encoding="utf-8"))
    assert "reconcile_proposal" in raw["roles"], sorted(raw["roles"])
    del raw["roles"]["reconcile_proposal"]
    path = tmp_path / "models_missing_reconcile_proposal.yaml"
    path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return path


def test_c5_no_firm_module_imports_engine_api_at_module_level():
    """The cycle: engine.api.__init__ -> server -> _firm_attention ->
    engine.firm. A module-level `engine.api` import inside this package
    re-enters a half-built module when a firm module is imported FIRST.
    engine.firm._deps defers every such import to first attribute access;
    this is the AST guard that keeps it that way (module level only —
    a function-level import IS the sanctioned deferral)."""
    files = sorted(FIRM_PKG.glob("*.py"))
    assert len(files) >= 11, "the firm package walk collapsed: %r" % [p.name for p in files]
    offenders = []
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            names = []  # type: List[str]
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                if name == "engine.api" or name.startswith("engine.api."):
                    offenders.append("%s:%d imports %s at module level" % (path.name, node.lineno, name))
    assert not offenders, ("C5 IMPORT CYCLE — a firm module imports engine.api at module level; "
                           "take a handle from engine.firm._deps instead:\n" + "\n".join(offenders))


def test_c9_the_transitive_ai_load_is_measured_over_a_real_client_at_import_and_at_first_compute(capsys):
    """C9, MEASURED at both moments — over REAL CLIENTS (A1). The first
    cut of this test computed over an EMPTY list: no client, no facts,
    no gateway, so the compute path it measured was the pack loader. With
    one real client the facts stage runs the served reader
    (engine.serving.facts -> engine.api._reconcile), and _reconcile read
    the model registry AT IMPORT: `engine.ai` + `engine.ai.registry`
    loaded on a path that calls no model, and the board DEPENDED on
    models.yaml resolving. Now: the registry is read by the proposal
    seam on first touch (PEP 562 in _reconcile), the compute loads no AI
    module, and the seam — touched AFTER the measurement — is what loads
    the registry. Not vacuous: the rows carry items."""
    measured = _real_board()
    assert measured["board"] == "RENDERED", measured
    with capsys.disabled():
        print("\n[C9] engine.firm.attention over 2 real clients (%d items): AI modules after "
              "import = %d; after first compute = %d; after touching the AI seam = %d; "
              "engine.api.server loaded = %s; _reconcile loaded = %s"
              % (measured["counts"]["items"], len(measured["after_import"]),
                 len(measured["after_compute"]), len(measured["after_seam"]),
                 measured["server_loaded"], measured["reconcile_loaded"]))
    assert measured["counts"]["items"] >= 4 and set(measured["rows"]) == {"org-agras", "org-carni"}, (
        "vacuous: the real clients computed nothing: %s" % measured["counts"])
    assert "CASH_RUNWAY" in measured["rows"]["org-agras"]["kinds"], measured["rows"]
    assert measured["after_import"] == [], (
        "C9 — importing engine.firm.attention loaded an AI subsystem: %s" % measured["after_import"])
    assert measured["after_compute"] == [] and measured["server_loaded"] is False, (
        "C9 — the FIRST COMPUTE over a real client loaded the server / an AI subsystem "
        "(the served reader's import graph reaches the model registry again): %s "
        "(server loaded = %s)" % (measured["after_compute"], measured["server_loaded"]))
    # The measurement is not blind: the registry IS loadable, and the AI
    # seam is what loads it — after the board, never for it.
    assert measured["seam"].startswith("resolved: "), measured["seam"]
    assert "engine.ai.registry" in measured["after_seam"], measured["after_seam"]


# ══════════════════════════════════════════════════════════════════════
# 9. A1 — THE DEAD REGISTRY: the board renders every client, complete;
#    the AI seam states its absence loudly, where it is needed
# ══════════════════════════════════════════════════════════════════════


def _assert_board_complete_under(measured: Dict[str, Any], plant: str) -> None:
    assert measured["board"] == "RENDERED", (
        "A1 BOARD DEAD — %s took the deterministic board down: %s"
        % (plant, measured.get("error")))
    assert set(measured["rows"]) == {"org-agras", "org-carni"}, measured["rows"]
    # complete, not merely present: the served truth survived the plant
    assert "CASH_RUNWAY" in measured["rows"]["org-agras"]["kinds"], (
        "A1 — %s: agras lost its served facts (CASH_RUNWAY reads cash through the "
        "gateway): kinds=%s gaps=%s" % (plant, measured["rows"]["org-agras"]["kinds"],
                                         measured["rows"]["org-agras"]["gaps"]))
    for client_id, row in measured["rows"].items():
        assert not [g for g in row["gaps"] if "served reader raised" in g], (
            "A1 — %s: the served reader raised for %s: %s" % (plant, client_id, row["gaps"]))
    assert measured["after_compute"] == [], (
        "A1 — %s: the board's compute loaded an AI module: %s" % (plant, measured["after_compute"]))
    # The AI-dependent part is ABSENT and SAYS SO: the one registry read
    # raises the registry's own error at the seam, never a guessed model.
    assert measured["seam"].startswith("RegistryError: "), (
        "A1 — %s: the AI seam did not state the registry failure: %s" % (plant, measured["seam"]))


def test_a1_dead_registry_missing_role_the_board_renders_every_client_complete(tmp_path, capsys):
    """The critics' plant: models.yaml with the `reconcile_proposal` role
    gone. Before A1 this was `RuntimeError` at `_reconcile` import — a
    500 on every client, the whole board. Same shape as the Radar
    dead-model law: everything deterministic renders, the AI-dependent
    part is stated absent."""
    dead = _registry_without_the_role(tmp_path)
    measured = _real_board({"ENGINE_AI_MODELS_PATH": str(dead)})
    with capsys.disabled():
        print("\n[A1] registry missing `reconcile_proposal`: board %s, %d items over %d clients; "
              "AI seam -> %s" % (measured["board"], measured.get("counts", {}).get("items", 0),
                                 len(measured.get("rows", {})), measured.get("seam", "?")[:90]))
    _assert_board_complete_under(measured, "a registry missing the reconcile_proposal role")
    assert "reconcile_proposal" in measured["seam"], measured["seam"]


def test_a1_dead_registry_unreadable_file_the_board_renders_every_client_complete(tmp_path, capsys):
    """The other plant: ENGINE_AI_MODELS_PATH names a file that does not
    exist (an unreadable models.yaml). Same law."""
    dead = tmp_path / "models_that_does_not_exist.yaml"
    assert not dead.exists()
    measured = _real_board({"ENGINE_AI_MODELS_PATH": str(dead)})
    with capsys.disabled():
        print("\n[A1] registry file unreadable: board %s, %d items over %d clients; AI seam -> %s"
              % (measured["board"], measured.get("counts", {}).get("items", 0),
                 len(measured.get("rows", {})), measured.get("seam", "?")[:90]))
    _assert_board_complete_under(measured, "an unreadable models.yaml")


def test_a1_a_served_reader_that_raises_is_a_gap_on_the_period_never_a_dead_board(cases, monkeypatch):
    """The floor under the law, in-process: whatever the served reader
    raises (the registry once; a malformed envelope tomorrow), the facts
    stage records it as the period's `gateway` gap with the reason, the
    money kinds state their absence, and the client renders. Before A1
    the raise propagated out of build_client_facts — one bad period was
    the whole board."""
    def _raise(*_a, **_k):
        raise RuntimeError("served reader planted to raise")
    monkeypatch.setattr(facts.FactsGateway, "from_envelope", staticmethod(_raise))
    client = client_from(cases["saga_10_col_agras"], "c-raise")
    report = compute([client])
    assert [r.client_id for r in report.rows] == ["c-raise"]
    gaps = gaps_of(report, "c-raise")
    reasons = [g.reason for g in gaps]
    assert any("served reader raised" in r and "planted to raise" in r for r in reasons), reasons
    assert not by_kind(report, "c-raise", "CASH_RUNWAY"), "no served facts, no money item"
    built = facts.build_period_facts(client.periods[0], ("cash",))
    assert "planted to raise" in built.gaps["gateway"] and built.money == {}
