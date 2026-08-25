"""DUAL-PATH CONSENSUS suite (Lane 3 — Part C).

Covers, per the mission's E-gates:

  E3  any value disagreement between two readings surfaces as
      needs-review atoms — never silent;
  E4  the SERVED values on a consensus-probed period are byte-identical
      to a classic-only run — the mapped reading never replaces classic;
  E9  a mechanical_mapped extraction may keep BALANCED ONLY behind the
      three-leg predicate (full dual consensus AND totals-row exact AND
      movement checks) — each leg removed forfeits it (fail closed);
  C2  end-to-end: a classic-parser-unreadable file (scandia_sibiu)
      flows through the dual-map lane with SCRIPTED interpreters →
      BALANCED + dual-verified disclosure + persisted consensus block;
  correlated-misread kill seed: both framings agree on the same wrong
      reading; the totals third leg catches it on a file that carries
      its own totals row;
  gates-off inertness: without the env gates the pipeline hooks are
      no-ops (the golden corpus proves byte-identity separately).

NO model calls anywhere: interpreters are scripted functions injected
via the lane's ``interpret_fn`` seam (the ai_lane pattern).
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import sys
from typing import Any, Dict, List, Optional, Tuple

import pytest

from engine.consensus import compare_readings, eligible_from_block, three_leg_verdict
from engine.consensus import lane as consensus_lane
from engine.consensus import persist as consensus_persist
from engine.consensus.selfcheck import (
    CUMULATIVE_MOVEMENTS,
    CUMULATIVE_WITH_OPENING,
    movement_leg,
    totals_leg_from_anchor,
)
from engine.consensus.verdict import LEG_DUAL, LEG_MOVEMENTS, LEG_TOTALS
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.interp.structmap import ColumnSpec, NumberLocale, StructuralMap

CONTENT_HASH = "c0ffee00" * 8


# ── helpers ────────────────────────────────────────────────────────────


def _row(code: str, **fields: float) -> Dict[str, Any]:
    row = {"cont": code, "nume_cont": "Cont %s" % code,
           "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
           "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    row.update(fields)
    return row


def _green_consensus() -> Dict[str, Any]:
    verdict = three_leg_verdict(
        dual_map_full_consensus=True,
        totals_row_exact=True,
        movement_checks_pass=True,
    )
    return {
        "schema": "consensus_v1",
        "mode": "dual_map",
        "consensus_pct": 100.0,
        "atoms_compared": 4,
        "disagreements": [],
        "structural": {"row_count_a": 2, "row_count_b": 2, "aligned": True},
        "totals_match": "MATCHED",
        "legs": verdict["legs"],
        "eligible_balanced": verdict["eligible_balanced"],
        "needs_review": [],
    }


def _consensus_with_leg_failed(leg_name: str) -> Dict[str, Any]:
    block = _green_consensus()
    for leg in block["legs"]:
        if leg["leg"] == leg_name:
            leg["pass"] = False
    block["eligible_balanced"] = False
    return block


def _envelope_for(pack, rows: List[Dict], extraction: Dict[str, Any],
                  content_hash: str = CONTENT_HASH) -> Dict:
    """Real parse-shape + assemble (the stage_extract + stage_map
    composition), with a caller-chosen extraction stamp — the
    test_reconciliation harness pattern."""
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction=extraction,
        source_anchor=tbp.compute_source_anchor(
            rows, file_totals=None, pairs_present=None, totals_row_index=None,
        ),
    )
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Consensus TB", period_label="CONS",
    )
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-1",
        "original_filename": "balanta_consensus.xlsx",
        "content_hash": content_hash,
        "written_at": "2026-08-25T00:00:00+00:00",
    }
    return envelope


BALANCED_ROWS = [
    _row("5121", sf_d=1000.00, st_d=1000.00),
    _row("1012", sf_c=1000.00, st_c=1000.00),
]


def _mechanical_extraction(consensus: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    extraction: Dict[str, Any] = {
        "method": "mechanical_mapped",
        "parser_version": "map_guided_v1",
        "source_format": "map_guided",
        "number_locale": "anglo",
        "sheet": "Sheet1",
        "header_row_index": 0,
    }
    if consensus is not None:
        extraction["consensus"] = consensus
    return extraction


# ── verdict.py units ───────────────────────────────────────────────────


class TestVerdict:
    def test_all_three_legs_green_is_eligible(self):
        v = three_leg_verdict(
            dual_map_full_consensus=True, totals_row_exact=True,
            movement_checks_pass=True,
        )
        assert v["eligible_balanced"] is True
        assert [leg["pass"] for leg in v["legs"]] == [True, True, True]

    @pytest.mark.parametrize("kwargs", [
        {"dual_map_full_consensus": False, "totals_row_exact": True, "movement_checks_pass": True},
        {"dual_map_full_consensus": True, "totals_row_exact": False, "movement_checks_pass": True},
        {"dual_map_full_consensus": True, "totals_row_exact": True, "movement_checks_pass": False},
    ])
    def test_any_leg_failed_is_ineligible(self, kwargs):
        assert three_leg_verdict(**kwargs)["eligible_balanced"] is False

    def test_movement_none_fails_closed(self):
        v = three_leg_verdict(
            dual_map_full_consensus=True, totals_row_exact=True,
            movement_checks_pass=None,
        )
        assert v["eligible_balanced"] is False
        movement = [leg for leg in v["legs"] if leg["leg"] == LEG_MOVEMENTS][0]
        assert movement["pass"] is None  # recorded honestly, fails closed

    def test_eligible_from_block_fail_closed_shapes(self):
        assert eligible_from_block(None) is False
        assert eligible_from_block({}) is False
        assert eligible_from_block({"legs": "green"}) is False
        assert eligible_from_block({"legs": [{"leg": LEG_DUAL, "pass": True}]}) is False
        assert eligible_from_block(_green_consensus()) is True
        assert eligible_from_block(_consensus_with_leg_failed(LEG_TOTALS)) is False


# ── compare.py units ───────────────────────────────────────────────────


class TestCompare:
    def test_identical_readings_full_consensus(self):
        rows = [_row("5121", sf_d=10.01), _row("401", sf_c=10.01)]
        cmp = compare_readings(rows, copy.deepcopy(rows))
        assert cmp["consensus_pct"] == 100.0
        assert cmp["atoms_compared"] == 2
        assert cmp["disagreements"] == []
        assert cmp["structural"]["aligned"] is True

    def test_value_disagreement_is_reported_in_cents(self):
        rows_a = [_row("5121", sf_d=10.01)]
        rows_b = [_row("5121", sf_d=10.02)]
        cmp = compare_readings(rows_a, rows_b)
        assert cmp["consensus_pct"] < 100.0
        assert len(cmp["disagreements"]) == 1
        d = cmp["disagreements"][0]
        assert (d["code"], d["field"]) == ("5121", "sf_d")
        assert (d["classic_cents"], d["mapped_cents"]) == (1001, 1002)

    def test_zero_atoms_are_pruned(self):
        rows_a = [_row("5121", sf_d=5.00)]  # every other field is 0/0
        cmp = compare_readings(rows_a, copy.deepcopy(rows_a))
        assert cmp["atoms_compared"] == 1  # only the value-bearing atom

    def test_misalignment_is_refused_not_diffed(self):
        rows_a = [_row("5121", sf_d=1.0), _row("401", sf_c=1.0)]
        rows_b = [_row("5121", sf_d=1.0)]
        cmp = compare_readings(rows_a, rows_b)
        assert cmp["structural"]["aligned"] is False
        assert cmp["atoms_compared"] == 0
        assert cmp["consensus_pct"] == 0.0

        rows_c = [_row("5121", sf_d=1.0), _row("404", sf_c=1.0)]
        cmp2 = compare_readings(rows_a, rows_c)
        assert cmp2["structural"]["aligned"] is False

    def test_source_refs_attach_to_disagreements(self):
        rows_a = [_row("5121", sf_d=10.01)]
        rows_b = [_row("5121", sf_d=10.02)]
        cmp = compare_readings(
            rows_a, rows_b,
            source_refs={"sheet": "TB", "rows": [7], "cols": {"sf_d": 8}},
        )
        assert cmp["disagreements"][0]["source_ref"] == {
            "sheet": "TB", "row": 7, "col": 8,
        }


# ── selfcheck.py units ─────────────────────────────────────────────────


class TestSelfCheck:
    def test_totals_leg_matched_passes(self):
        assert totals_leg_from_anchor({"anchor_status": "MATCHED"}, []) == ("MATCHED", True)

    def test_totals_leg_diverged_fails(self):
        assert totals_leg_from_anchor({"anchor_status": "DIVERGED"}, []) == ("DIVERGED", False)

    def test_totals_leg_no_anchor_degrades_to_extracted_balance(self):
        balanced = [_row("5121", sf_d=5.0), _row("401", sf_c=5.0)]
        unbalanced = [_row("5121", sf_d=5.0), _row("401", sf_c=1.0)]
        assert totals_leg_from_anchor({"anchor_status": "NO_ANCHOR"}, balanced) == (
            "NO_ANCHOR", True,
        )
        assert totals_leg_from_anchor(None, unbalanced) == ("NO_ANCHOR", False)

    def test_movement_identity_with_opening_semantics(self):
        rows = [
            _row("117", si_d=100.0, st_d=100.0, sf_d=100.0),
            _row("704", st_d=50.0, st_c=50.0),
        ]
        assert movement_leg(rows, cumulative_semantics=CUMULATIVE_WITH_OPENING) is True
        rows[0]["sf_d"] = 99.0
        assert movement_leg(rows, cumulative_semantics=CUMULATIVE_WITH_OPENING) is False

    def test_movement_identity_movements_only_semantics(self):
        rows = [_row("5121", si_d=100.0, st_d=40.0, st_c=15.0, sf_d=125.0)]
        assert movement_leg(rows, cumulative_semantics=CUMULATIVE_MOVEMENTS) is True
        rows[0]["sf_d"] = 100.0
        assert movement_leg(rows, cumulative_semantics=CUMULATIVE_MOVEMENTS) is False

    def test_movement_unknown_semantics_or_synthesized_sf_is_none(self):
        rows = [_row("5121", st_d=1.0, sf_d=1.0)]
        assert movement_leg(rows, cumulative_semantics=None) is None
        assert movement_leg(
            rows, cumulative_semantics=CUMULATIVE_WITH_OPENING, synthesized_sf=True,
        ) is None


# ── E9 — the mechanical_mapped cap in the status ladder (RED-FIRST) ────


class TestE9StatusLadder:
    def test_mechanical_mapped_without_consensus_is_capped(self, pack):
        """THE red test for the E9 gap: today a mechanical_mapped
        BALANCED envelope passes UNCAPPED with no consensus verdict at
        all. After the fix it must fail closed to MINOR_DRIFT."""
        env = _envelope_for(pack, BALANCED_ROWS, _mechanical_extraction(None))
        cbs = env["canonical_bs"]
        assert cbs["extraction"]["method"] == "mechanical_mapped"
        assert abs(cbs["difference"]) <= 1.0  # ladder alone says BALANCED
        assert cbs["status"] == "MINOR_DRIFT"

    def test_mechanical_mapped_with_three_green_legs_is_balanced(self, pack):
        env = _envelope_for(
            pack, BALANCED_ROWS, _mechanical_extraction(_green_consensus()),
        )
        cbs = env["canonical_bs"]
        assert cbs["status"] == "BALANCED"
        # The block is emitted top-level and popped out of extraction.
        assert cbs["consensus"]["eligible_balanced"] is True
        assert "consensus" not in cbs["extraction"]

    @pytest.mark.parametrize("leg", [LEG_DUAL, LEG_TOTALS, LEG_MOVEMENTS])
    def test_each_leg_removed_forfeits_balanced(self, pack, leg):
        env = _envelope_for(
            pack, BALANCED_ROWS,
            _mechanical_extraction(_consensus_with_leg_failed(leg)),
        )
        assert env["canonical_bs"]["status"] == "MINOR_DRIFT"

    def test_llm_cap_is_untouched_even_with_green_consensus(self, pack):
        extraction = {
            "method": "llm", "parser_version": "x", "source_format": "llm_freeform",
            "consensus": _green_consensus(),
        }
        env = _envelope_for(pack, BALANCED_ROWS, extraction)
        assert env["canonical_bs"]["status"] == "MINOR_DRIFT"

    def test_deterministic_ladder_unchanged_with_no_consensus(self, pack):
        extraction = {
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB",
            "header_row_index": 0,
        }
        env = _envelope_for(pack, BALANCED_ROWS, extraction)
        cbs = env["canonical_bs"]
        assert cbs["status"] == "BALANCED"
        assert "consensus" not in cbs

    def test_identity_holds_is_falsifiable_for_mechanical_mapped(self, pack):
        """RED-FIRST for the :1496 premise: a mechanical_mapped read of a
        balanced source with a nonzero partition difference must emit
        identity_holds == False (today the premise is deterministic-only,
        so the invariant is vacuously True — the exact falsifiability
        loss the map warned about)."""
        rows = [
            _row("5121", sf_d=1000.00),
            _row("1012", sf_c=999.50),  # SF pair balanced within 1 RON
        ]
        env = _envelope_for(pack, rows, _mechanical_extraction(None))
        cbs = env["canonical_bs"]
        assert abs(cbs["difference"]) > 0
        assert cbs["invariants"]["identity_holds"] is False

    def test_identity_holds_true_on_exact_mechanical_mapped(self, pack):
        env = _envelope_for(
            pack, BALANCED_ROWS, _mechanical_extraction(_green_consensus()),
        )
        assert env["canonical_bs"]["invariants"]["identity_holds"] is True


# ── trust surface (serving/status.py) — RED-FIRST ──────────────────────


class TestTrustDisclosure:
    def _served(self, pack, rows, extraction):
        from engine.api import _reconcile
        env = _envelope_for(pack, rows, extraction)
        return _reconcile.served_canonical_bs(env)

    def test_no_consensus_no_trust_key(self, pack):
        from engine.serving.status import present_status
        served = self._served(pack, BALANCED_ROWS, {
            "method": "deterministic", "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col", "number_locale": "anglo",
            "sheet": "TB", "header_row_index": 0,
        })
        p = present_status(served)
        assert "trust_disclosure" not in p
        assert served["status_presentation"] == p

    def test_deterministic_full_consensus_discloses_ai_verified(self, pack):
        from engine.serving.status import present_status
        cbs = {
            "status": "BALANCED",
            "extraction": {"method": "deterministic"},
            "consensus": _green_consensus(),
        }
        p = present_status(cbs)
        td = p["trust_disclosure"]
        assert td["key"] == "bs.trust.machine_ai_verified_full"
        assert td["en"] == "Machine-computed · AI-verified (full)"
        assert td["ro"]

    def test_mechanical_mapped_e9_discloses_dual_verified(self, pack):
        served = self._served(
            pack, BALANCED_ROWS, _mechanical_extraction(_green_consensus()),
        )
        assert served["status"] == "BALANCED"
        td = served["status_presentation"]["trust_disclosure"]
        assert td["key"] == "bs.trust.structure_ai_dual_verified"
        assert td["en"] == (
            "Structure AI-interpreted · numbers machine-read · dual-verified"
        )
        assert td["ro"]

    def test_non_eligible_consensus_stays_undisclosed(self, pack):
        from engine.serving.status import present_status
        cbs = {
            "status": "MINOR_DRIFT",
            "extraction": {"method": "mechanical_mapped"},
            "consensus": _consensus_with_leg_failed(LEG_MOVEMENTS),
        }
        assert "trust_disclosure" not in present_status(cbs)


# ── C1: E3 + E4 on agras (classic vs planted-corrupt mapped read) ──────


def _agras_bytes(repo_root) -> bytes:
    return (repo_root / "files" / "agras_tb_2025.xlsx").read_bytes()


def _agras_map(**overrides: Any) -> StructuralMap:
    """The 20-col extended agras layout: first ten columns are the
    identity + four D/C pairs; the cumulative pair is 'Rulaj cumulat'
    (movements-only — the semantic the classic parser conflates)."""
    columns = overrides.pop("columns", None) or (
        ColumnSpec(0, "account_code"),
        ColumnSpec(1, "account_name"),
        ColumnSpec(2, "opening_debit"),
        ColumnSpec(3, "opening_credit"),
        ColumnSpec(4, "movement_period_debit"),
        ColumnSpec(5, "movement_period_credit"),
        ColumnSpec(6, "movement_cumulative_debit"),
        ColumnSpec(7, "movement_cumulative_credit"),
        ColumnSpec(8, "closing_debit"),
        ColumnSpec(9, "closing_credit"),
    )
    return StructuralMap(
        header_row_index=0,
        columns=columns,
        account_code_col=0,
        sheet=None,
        number_locale=NumberLocale(thousands_sep=None, decimal_sep="."),
        currency="RON",
        **overrides,
    )


def _scripted_interpret(smap_by_framing: Dict[str, StructuralMap]):
    calls: List[str] = []

    def interpret(content, filename, *, jurisdiction, framing, client_factory=None):
        calls.append(framing)
        smap = smap_by_framing[framing]
        return smap, {
            "role": "structural_interpreter_%s" % framing,
            "framing": framing,
            "model_id": "scripted-model",
            "prompt_version": "scripted_v1",
            "map_version": smap.map_version,
            "map_hash": smap.map_hash,
        }

    interpret.calls = calls
    return interpret


class TestC1AgrasConsensus:
    def test_clean_map_reaches_full_consensus_with_classic(self, pack, repo_root):
        content = _agras_bytes(repo_root)
        classic = pack.parse_trial_balance(content, "agras_tb_2025.xlsx")
        block = consensus_lane.run_c1_consensus(
            content, "agras_tb_2025.xlsx", "RO", classic,
            interpret_fn=_scripted_interpret({"a": _agras_map()}),
        )
        assert block is not None
        assert block["mode"] == "classic_vs_mapped"
        assert block["structural"]["aligned"] is True
        assert block["consensus_pct"] == 100.0
        assert block["disagreements"] == []
        assert block["needs_review"] == []

    def test_e3_e4_planted_map_corruption(self, pack, repo_root, monkeypatch):
        """Map-side corruption (closing pair misbound onto the cumulative
        columns): E3 — every disagreement becomes a needs-review atom
        carrying BOTH readings; E4 — the SERVED values stay byte-identical
        to a classic-only run (the consensus block is the only delta)."""
        from engine.api import _reconcile

        content = _agras_bytes(repo_root)
        classic = pack.parse_trial_balance(content, "agras_tb_2025.xlsx")

        corrupt_columns = (
            ColumnSpec(0, "account_code"),
            ColumnSpec(1, "account_name"),
            ColumnSpec(2, "opening_debit"),
            ColumnSpec(3, "opening_credit"),
            ColumnSpec(4, "movement_period_debit"),
            ColumnSpec(5, "movement_period_credit"),
            ColumnSpec(6, "movement_cumulative_debit"),
            ColumnSpec(7, "movement_cumulative_credit"),
            ColumnSpec(6, "closing_debit"),    # ← misbound: reads rulaj cumulat
            ColumnSpec(7, "closing_credit"),   # ← as the closing pair
        )
        block = consensus_lane.run_c1_consensus(
            content, "agras_tb_2025.xlsx", "RO", classic,
            interpret_fn=_scripted_interpret(
                {"a": _agras_map(columns=corrupt_columns)}
            ),
        )
        assert block is not None
        assert block["disagreements"], "planted corruption must surface"
        assert block["consensus_pct"] < 100.0
        # E3 — atoms in the ai_lane shape, both readings named.
        assert block["needs_review"]
        atom = block["needs_review"][0]
        assert atom["reason"] == "consensus_disagreement"
        assert atom["line_id"] is None
        assert "A=" in atom["rationale"] and "B=" in atom["rationale"]
        assert atom["section"] in ("current_assets", "current_liabilities")
        # served amount == the CLASSIC reading of that cell
        d = block["disagreements"][0]
        assert atom["amount"] == d["classic_cents"] / 100.0
        assert eligible_from_block(block) is False

        # E4 — attach the block; served values byte-identical to classic.
        _tb, _shaped, assembled = pack.assemble_parsed_tb(
            classic, company_name="Agras", period_label="FY2025",
        )
        provenance = {
            "source_document_id": "doc-agras",
            "original_filename": "agras_tb_2025.xlsx",
            "content_hash": CONTENT_HASH,
            "written_at": "2026-08-25T00:00:00+00:00",
        }
        env_classic = copy.deepcopy(assembled["assembled_canonical_v1"])
        env_classic["provenance"] = dict(provenance)
        env_probed = copy.deepcopy(assembled["assembled_canonical_v1"])
        env_probed["provenance"] = dict(provenance)
        assert consensus_persist.attach_consensus(env_probed, block) is True

        served_classic = _reconcile.served_canonical_bs(env_classic)
        served_probed = _reconcile.served_canonical_bs(env_probed)
        probed_minus_consensus = {
            k: v for k, v in served_probed.items() if k != "consensus"
        }
        assert json.dumps(probed_minus_consensus, sort_keys=True) == json.dumps(
            served_classic, sort_keys=True,
        ), "E4 violated: consensus probe changed served values"
        assert served_probed["consensus"]["disagreements"]


# ── C2: sibiu end-to-end through the dual-map lane ─────────────────────


def _sibiu_bytes(repo_root) -> bytes:
    return (repo_root / "files" / "scandia_sibiu_tb_2019.xlsx").read_bytes()


def _sibiu_balanced_bytes(repo_root) -> bytes:
    """The sibiu fixture, closed to a balanced source. The RAW file is
    genuinely imbalanced (Σsf_d − Σsf_c = −12,253.38 RON — a source-data
    fact, verified over every row): honest BALANCED is impossible on it,
    so the full E9 BALANCED path is proven on this in-memory variant with
    one plug row that closes EVERY pair the full movement probe cross-
    foots — SF/Total-sume (+12,253.38) AND the raw file's own SI
    (−69,413.50) / rulaj (+1,392.75) extraction deficits — while keeping
    the winning convention-B identity (net st == net sf) true on the
    plug itself. Headers are untouched — the classic parser still cannot
    read it (the C2 premise)."""
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(_sibiu_bytes(repo_root)), data_only=True)
    ws = wb.worksheets[0]
    ws.append(["473101", "Decontari in curs (plug)",
               69413.50, 0.0, 0.0, 1392.75, 12253.38, 0.0, 12253.38, 0.0])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _sibiu_map() -> StructuralMap:
    """Sibiu's abbreviated-header layout ('Sold init D' … 'Total sume D'
    … 'Sold fin C') — classic-parser-unreadable, structurally plain."""
    return StructuralMap(
        header_row_index=0,
        columns=(
            ColumnSpec(0, "account_code"),
            ColumnSpec(1, "account_name"),
            ColumnSpec(2, "opening_debit"),
            ColumnSpec(3, "opening_credit"),
            ColumnSpec(4, "movement_period_debit"),
            ColumnSpec(5, "movement_period_credit"),
            ColumnSpec(6, "total_with_opening_debit"),
            ColumnSpec(7, "total_with_opening_credit"),
            ColumnSpec(8, "closing_debit"),
            ColumnSpec(9, "closing_credit"),
        ),
        account_code_col=0,
        sheet=None,
        number_locale=NumberLocale(thousands_sep=None, decimal_sep="."),
        currency="RON",
    )


class _FakeAdminClient:
    """Just enough Supabase-admin surface for stage_persist (the
    test_reconciliation pattern)."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Any] = []

    def select(self, table, *, filters=None, columns="*", limit=None,
               order=None, single=False):
        if table != "financial_periods":
            return []

        def _matches(row):
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if _matches(r)]

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-1"
            self.period_rows.append(new)
            return [new]
        return rows_list if returning else []

    def update(self, table, patch, *, filters):
        self.updates.append((table, copy.deepcopy(patch), dict(filters or {})))
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table, *, filters=None):
        return None


class TestC2SibiuEndToEnd:
    def test_classic_parser_still_cannot_read_sibiu(self, pack, repo_root):
        """The C1/C2 boundary premise: sibiu raises ParseError."""
        with pytest.raises(tbp.ParseError):
            pack.parse_trial_balance(_sibiu_bytes(repo_root), "scandia_sibiu_tb_2019.xlsx")

    def test_raw_sibiu_fails_closed_to_minor_drift(self, repo_root):
        """The RAW sibiu file's closing pair does not balance (−12,253.38
        RON) — with no totals row to anchor against, the totals leg's
        explicit degradation fails and E9 fails closed: full dual
        consensus alone must NOT earn BALANCED on an imbalanced source."""
        from engine.api import pipeline

        parsed = consensus_lane.run_dual_map_lane(
            _sibiu_bytes(repo_root), "scandia_sibiu_tb_2019.xlsx", "RO",
            interpret_fn=_scripted_interpret({"a": _sibiu_map(), "b": _sibiu_map()}),
        )
        assert parsed is not None
        block = parsed["extraction"]["consensus"]
        assert block["consensus_pct"] == 100.0  # framings fully agree...
        legs = {leg["leg"]: leg["pass"] for leg in block["legs"]}
        assert legs[LEG_TOTALS] is False        # ...but the source doesn't close
        assert block["eligible_balanced"] is False
        assembled = pipeline.stage_map({"id": "doc-sibiu-raw"}, parsed, None)
        cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
        # The honest ladder on the real difference (−12,253.38 on a
        # ~2.4M-asset sheet lands beyond the 0.5% band → MATERIAL) —
        # the one thing E9 forbids is claiming BALANCED here.
        assert cbs["status"] == "MATERIAL_IMBALANCE"

    def test_dual_map_lane_end_to_end(self, pack, repo_root, monkeypatch):
        from engine.api import _reconcile, pipeline

        content = _sibiu_balanced_bytes(repo_root)
        interpret = _scripted_interpret({"a": _sibiu_map(), "b": _sibiu_map()})
        parsed = consensus_lane.run_dual_map_lane(
            content, "scandia_sibiu_tb_2019.xlsx", "RO",
            interpret_fn=interpret,
        )
        assert parsed is not None
        assert interpret.calls == ["a", "b"]
        assert parsed["extraction"]["method"] == "mechanical_mapped"
        block = parsed["extraction"]["consensus"]
        assert block["mode"] == "dual_map"
        assert block["consensus_pct"] == 100.0
        assert block["eligible_balanced"] is True
        assert block["totals_match"] == "NO_ANCHOR"  # sibiu has no totals row
        assert parsed["accounts"], "mapped accounts must reach the mapper"

        # stage_map: the REAL assemble path — consensus rides extraction.
        assembled = pipeline.stage_map(
            {"id": "doc-sibiu"}, parsed, None,
        )
        envelope = assembled["assembled_canonical_v1"]
        cbs = envelope["canonical_bs"]
        assert cbs["extraction"]["method"] == "mechanical_mapped"
        assert "consensus" not in cbs["extraction"]
        assert cbs["consensus"]["eligible_balanced"] is True
        assert cbs["status"] == "BALANCED"  # E9: earned, not assumed

        # Serving: trust disclosure + verbatim consensus.
        envelope["provenance"] = {
            "source_document_id": "doc-sibiu",
            "original_filename": "scandia_sibiu_tb_2019.xlsx",
            "content_hash": CONTENT_HASH,
            "written_at": "2026-08-25T00:00:00+00:00",
        }
        served = _reconcile.served_canonical_bs(envelope)
        assert served["status"] == "BALANCED"
        assert served["consensus"]["eligible_balanced"] is True
        td = served["status_presentation"]["trust_disclosure"]
        assert td["key"] == "bs.trust.structure_ai_dual_verified"

        # stage_persist end-to-end: the consensus block is persisted.
        fake = _FakeAdminClient()

        @contextlib.contextmanager
        def _fake_admin():
            yield fake

        monkeypatch.setattr(pipeline._supabase, "admin", _fake_admin)
        monkeypatch.setitem(sys.modules, "anthropic", None)
        doc = {
            "id": "doc-sibiu", "org_id": "org-1",
            "original_filename": "scandia_sibiu_tb_2019.xlsx",
            "content_hash": CONTENT_HASH,
        }
        period_id = pipeline.stage_persist(doc, parsed, assembled)
        assert period_id == "period-1"
        writes = [
            patch["assembled_canonical_v1"]
            for table, patch, _f in fake.updates
            if table == "financial_periods" and "assembled_canonical_v1" in patch
        ]
        assert writes, "no envelope persisted"
        persisted_cbs = writes[-1]["canonical_bs"]
        assert persisted_cbs["consensus"]["eligible_balanced"] is True
        assert persisted_cbs["status"] == "BALANCED"

    def test_disagreeing_framings_forfeit_balanced_and_flag_atoms(self, repo_root):
        """E3 on the C2 lane: framings that disagree on one column produce
        needs-review atoms and lose BALANCED (leg 1)."""
        content = _sibiu_bytes(repo_root)
        map_b_wrong = StructuralMap(
            header_row_index=0,
            columns=(
                ColumnSpec(0, "account_code"),
                ColumnSpec(1, "account_name"),
                ColumnSpec(2, "opening_debit"),
                ColumnSpec(3, "opening_credit"),
                ColumnSpec(4, "movement_period_debit"),
                ColumnSpec(5, "movement_period_credit"),
                ColumnSpec(6, "total_with_opening_debit"),
                ColumnSpec(7, "total_with_opening_credit"),
                ColumnSpec(6, "closing_debit"),   # ← framing B misreads closing
                ColumnSpec(7, "closing_credit"),
            ),
            account_code_col=0,
            number_locale=NumberLocale(thousands_sep=None, decimal_sep="."),
            currency="RON",
        )
        parsed = consensus_lane.run_dual_map_lane(
            content, "scandia_sibiu_tb_2019.xlsx", "RO",
            interpret_fn=_scripted_interpret({"a": _sibiu_map(), "b": map_b_wrong}),
        )
        assert parsed is not None
        block = parsed["extraction"]["consensus"]
        assert block["disagreements"]
        assert block["needs_review"]
        assert block["eligible_balanced"] is False
        legs = {leg["leg"]: leg["pass"] for leg in block["legs"]}
        assert legs[LEG_DUAL] is False
        # a disagreement atom names BOTH readings and carries a cell ref
        atom = block["needs_review"][0]
        assert "A=" in atom["rationale"] and "B=" in atom["rationale"]


# ── correlated-misread kill seed (totals third leg) ────────────────────


def _kill_seed_xlsx() -> bytes:
    """A tiny synthetic TB WITH a totals row. The correlated misread:
    both framings mistake the 401 data row for a subtotal row, so the
    two mechanical reads AGREE 100% on a wrong (incomplete) extraction —
    only the file's own totals row can catch it."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Cont", "Denumire", "Sold init D", "Sold init C",
               "Rulaj D", "Rulaj C", "Sold fin D", "Sold fin C"])
    ws.append(["5121", "Banca", 800.0, 0.0, 0.0, 0.0, 800.0, 0.0])
    ws.append(["1012", "Capital", 0.0, 500.0, 0.0, 0.0, 0.0, 500.0])
    ws.append(["401", "Furnizori", 0.0, 300.0, 0.0, 0.0, 0.0, 300.0])
    ws.append(["TOTAL", "", 800.0, 800.0, 0.0, 0.0, 800.0, 800.0])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestCorrelatedMisreadKillSeed:
    def test_totals_leg_catches_agreeing_wrong_readings(self):
        content = _kill_seed_xlsx()
        wrong_map = StructuralMap(
            header_row_index=0,
            columns=(
                ColumnSpec(0, "account_code"),
                ColumnSpec(1, "account_name"),
                ColumnSpec(2, "opening_debit"),
                ColumnSpec(3, "opening_credit"),
                ColumnSpec(4, "movement_period_debit"),
                ColumnSpec(5, "movement_period_credit"),
                ColumnSpec(6, "closing_debit"),
                ColumnSpec(7, "closing_credit"),
            ),
            account_code_col=0,
            totals_row_indexes=(4,),
            subtotal_row_indexes=(3,),  # ← BOTH framings drop the 401 row
            number_locale=NumberLocale(thousands_sep=None, decimal_sep="."),
            currency="RON",
        )
        parsed = consensus_lane.run_dual_map_lane(
            content, "kill_seed.xlsx", "RO",
            interpret_fn=_scripted_interpret({"a": wrong_map, "b": wrong_map}),
        )
        assert parsed is not None
        block = parsed["extraction"]["consensus"]
        # The two framings AGREE — consensus alone would pass...
        assert block["consensus_pct"] == 100.0
        assert block["disagreements"] == []
        # ...but the file's own totals row catches the shared misread.
        assert block["totals_match"] == "DIVERGED"
        legs = {leg["leg"]: leg["pass"] for leg in block["legs"]}
        assert legs[LEG_TOTALS] is False
        assert block["eligible_balanced"] is False
        # And the builder can never claim BALANCED on a DIVERGED anchor.
        from engine.api import pipeline
        assembled = pipeline.stage_map({"id": "doc-kill"}, parsed, None)
        cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
        assert cbs["status"] == "MATERIAL_IMBALANCE"


# ── gates-off inertness ────────────────────────────────────────────────


class TestGatesOffInertness:
    def test_c2_hook_is_inert_without_env(self, monkeypatch):
        from engine.api import pipeline
        for var in (consensus_lane.ENV_STRUCTURAL_READER,
                    consensus_lane.ENV_SHADOW, consensus_lane.ENV_ENABLED):
            monkeypatch.delenv(var, raising=False)

        def _boom(*a, **k):  # any consensus work would be a gate leak
            raise AssertionError("consensus lane must not run with gates off")

        monkeypatch.setattr(consensus_lane, "run_dual_map_lane", _boom)
        monkeypatch.setattr(consensus_lane, "run_c1_consensus", _boom)
        assert pipeline._maybe_dual_map_lane(
            {"id": "d"}, b"bytes", "xlsx",
        ) is None
        assert pipeline._maybe_c1_consensus(
            {"id": "d"}, b"bytes", "xlsx", [],
        ) is None

    def test_c1_shadow_gate_logs_only(self, pack, repo_root, monkeypatch):
        """CONSENSUS_SHADOW=1 runs the probe but returns None — nothing
        reaches the parsed payload or the envelope."""
        from engine.api import pipeline

        monkeypatch.setenv(consensus_lane.ENV_SHADOW, "1")
        monkeypatch.delenv(consensus_lane.ENV_ENABLED, raising=False)
        calls: List[int] = []

        def _fake_c1(content, filename, jurisdiction, rows, **kw):
            calls.append(1)
            return {"schema": "consensus_v1", "legs": []}

        monkeypatch.setattr(consensus_lane, "run_c1_consensus", _fake_c1)
        out = pipeline._maybe_c1_consensus(
            {"id": "d", "original_filename": "x.xlsx"}, b"PK\x03\x04", "xlsx", [],
        )
        assert calls == [1]
        assert out is None  # shadow: log-only, never persisted

    def test_c1_enabled_gate_returns_block(self, monkeypatch):
        from engine.api import pipeline

        monkeypatch.setenv(consensus_lane.ENV_ENABLED, "1")
        block = {"schema": "consensus_v1", "legs": []}
        monkeypatch.setattr(
            consensus_lane, "run_c1_consensus",
            lambda *a, **k: dict(block),
        )
        out = pipeline._maybe_c1_consensus(
            {"id": "d", "original_filename": "x.xlsx"}, b"PK\x03\x04", "xlsx", [],
        )
        assert out == block

    def test_persist_attach_is_additive_only(self):
        env = {"canonical_bs": {"status": "BALANCED"}}
        assert consensus_persist.attach_consensus(env, {"schema": "consensus_v1"})
        assert env["canonical_bs"]["consensus"] == {"schema": "consensus_v1"}
        # second attach refuses (carry-forward wins)
        assert consensus_persist.attach_consensus(env, {"schema": "other"}) is False
        assert env["canonical_bs"]["consensus"] == {"schema": "consensus_v1"}
        # no canonical_bs / malformed → refused, never raises
        assert consensus_persist.attach_consensus({}, {"a": 1}) is False
        assert consensus_persist.attach_consensus(None, {"a": 1}) is False
