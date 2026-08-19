"""RECONCILIATION FLOW suite (docs/CANONICAL_BS_V2_CONTRACT.md addendum
+ AUTO-RECONCILE addendum, revised operator spec 2026-08-19).

Every case runs through the REAL production composition — TB rows →
`TrialBalanceParseResult` → `attach_closing_result` →
`RomaniaPack.assemble_parsed_tb` (the same code object stage_extract +
stage_map compose) — then exercises the real stage / serve / apply
functions in `engine.api._reconcile` and `engine.api.pipeline`:

  · `auto_reconcile_envelope` + `carry_forward_reconciliation` — the
    AUTOMATIC persist-seam stage `pipeline.stage_persist` calls between
    the canonical build and the single envelope write;
  · `stage_persist` itself — run END TO END against a fake Supabase
    admin client (two tests), proving the auto stage + carry-forward
    are wired at the real seam, not mirrored;
  · `served_canonical_bs`  — the pure serve-path (stored-entry
    application + needs_review / reconcile_offer stamps) that
    `_apply_envelope_truth_to_statements` calls;
  · `_apply_envelope_truth_to_statements` — the REAL /api/period serve
    hook, exercised directly for the P&L-placement line on
    `statements.assembled_pl`;
  · `perform_reconcile` / `perform_undo` — the orchestration the two
    POST routes wrap around Supabase I/O (reconcile is now an
    ops/manual trigger; undo also writes the suppression entry);
  · `validate_proposal` — the deterministic validator gate.

Locked properties: the validator accepts ONLY exact 0-cent closes;
RECONCILED is never BALANCED; source cents are never overwritten (the
persisted canonical_bs stays byte-identical); a freshly-persisted
sub-threshold period is ALREADY RECONCILED on first serving (the client
never sees an intermediate unreconciled state); auto failure yields an
honest MINOR_DRIFT + needs_review — never a fabricated proposal, never
a fake zero; `reconcile_offer` is true ONLY in that needs-review state;
undo suppresses re-auto-reconcile for the same content_hash + versions;
same-file re-persist carries the reconciliation forward (no flicker);
serving is idempotent / byte-identical (hard-refresh stability);
hash-mismatched stored entries are ignored, never deleted. No network
anywhere in this file.
"""

from __future__ import annotations

import contextlib
import copy
import json
import sys
from typing import Any, Dict, List, Optional

import pytest

from engine.api import _reconcile
from engine.country_packs.ro_romania import trial_balance_parser as tbp

CONTENT_HASH = "sha256-fixture-A"


# ── Envelope builder (mirrors test_identity_property._run + the
# stage_persist provenance stamp) ──────────────────────────────────────


def _row(code: str, **fields: float) -> Dict[str, float]:
    row = {"cont": code, "nume_cont": "Cont %s" % code,
           "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
           "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    row.update(fields)
    return row


def _assembled_for(pack, rows: List[Dict]) -> Dict:
    """Real parse-shape + assemble; returns the FULL assembled dict
    (statements + lineItems + assembled_canonical_v1) — what stage_map
    hands to stage_persist."""
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction={
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB_reconcile",
            "header_row_index": 0,
        },
        source_anchor=tbp.compute_source_anchor(
            rows, file_totals=None, pairs_present=None, totals_row_index=None,
        ),
    )
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Reconcile TB", period_label="REC",
    )
    return assembled


def _envelope_for(pack, rows: List[Dict], content_hash: str = CONTENT_HASH) -> Dict:
    """The assembled_canonical_v1 envelope with the provenance stamp
    stage_persist would add."""
    envelope = _assembled_for(pack, rows)["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-1",
        "original_filename": "balanta_reconcile.xlsx",
        "content_hash": content_hash,
        "written_at": "2026-08-19T00:00:00+00:00",
    }
    return envelope


def _dumps(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def _ai_sentinel(monkeypatch):
    """A sentinel that fails the test if the AI path is imported or
    called: `anthropic` is unimportable AND `_ai_propose` records every
    invocation before raising. Returns the call list — assert it stays
    empty."""
    calls: List[int] = []

    def _fail(cbs):  # noqa: ANN001 — production signature
        calls.append(1)
        raise AssertionError("AI must not be consulted on this path")

    monkeypatch.setitem(sys.modules, "anthropic", None)
    monkeypatch.setattr(_reconcile, "_ai_propose", _fail)
    return calls


# ── Fixture TBs ────────────────────────────────────────────────────────


@pytest.fixture()
def balanced_env(pack):
    """Exact-zero source: difference 0.00, BALANCED by construction."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1000.00),
        _row("1012", sf_c=1000.00),
    ])


ROUNDING_ROWS = [
    _row("212", sf_d=3000.00),    # buildings → non_current_assets
    _row("5121", sf_d=1000.00),   # bank → current_assets
    _row("1012", sf_c=2000.00),   # share capital → equity
    _row("401", sf_c=1998.40),    # trade payables → current_liabilities
]


@pytest.fixture()
def rounding_env(pack):
    """0.04% drift (1.60 RON on a 4,000 RON sheet) across 4 touched
    sections — the R1 rounding-cents diagnosis territory."""
    return _envelope_for(pack, ROUNDING_ROWS)


@pytest.fixture()
def unmapped_env(pack):
    """A single UNMAPPED account (413 — no rule in the legacy table)
    whose balance equals the difference to the cent: R2 territory."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),      # unmapped; also the source gap
        _row("1012", sf_c=1_000_000.00),
    ])


@pytest.fixture()
def dup_env(pack):
    """A duplicated totals row: (371, 250.00) appears TWICE and removing
    one copy closes the 250.00 difference exactly — R_DUP territory
    (R1 too large, no unmapped, no half-match side-flip)."""
    return _envelope_for(pack, [
        _row("5121", sf_d=500_000.00),
        _row("371", sf_d=250.00),
        _row("371", sf_d=250.00),
        _row("1012", sf_c=500_250.00),
    ])


@pytest.fixture()
def gate_env(pack):
    """0.3% drift — above the 0.1% reconcile gate."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("1012", sf_c=997_000.00),
    ])


@pytest.fixture()
def inconclusive_env(pack):
    """Drift inside the gate but with NO single deterministic cause:
    777.77 RON gap, two unmapped accounts (300 / 200) that neither match
    it nor half it — forces the AI proposal path."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),
        _row("4282", sf_d=200.00),
        _row("1012", sf_c=999_722.23),
    ])


@pytest.fixture()
def expense_cause_env(pack):
    """−777.77 drift with a class-6 leaf (609) present, so the result
    row (current_year_loss) exists; deterministic diagnosis finds no
    single cause → the (mocked) AI names 609 → P&L placement, expense
    side (diff < 0)."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("371", sf_d=500.00),
        _row("609", sf_d=200.00),
        _row("1012", sf_c=1_001_477.77),
    ])


@pytest.fixture()
def income_cause_env(pack):
    """+577.77 drift with a class-7 leaf (704) present, so the result
    row (current_year_profit) exists; the (mocked) AI names 704 → P&L
    placement, income side (diff > 0)."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_777.77),
        _row("704", sf_c=200.00),
        _row("1012", sf_c=1_000_000.00),
    ])


# ── Real serve hook (the /api/period path) ─────────────────────────────


def _serve_statements(envelope: Dict) -> Dict:
    """Run the REAL `_apply_envelope_truth_to_statements` serve hook —
    the one code object /api/period and the briefing rebuild share —
    against a period row carrying this envelope."""
    from engine.api.pipeline import _apply_envelope_truth_to_statements

    statements: Dict[str, Any] = {
        "assembled_bs": {},
        "assembled_pl": {"revenue": 0.0},
    }
    _apply_envelope_truth_to_statements(
        statements, {"assembled_canonical_v1": envelope}
    )
    return statements


# ── Fake Supabase admin client (stage_persist end-to-end) ──────────────


class _FakeAdminClient:
    """In-memory stand-in for _supabase.admin()'s client — just enough
    surface for stage_persist (select/insert/update/delete on
    financial_periods + documents + statement_line_items)."""

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


def _run_stage_persist(monkeypatch, fake: _FakeAdminClient, assembled: Dict) -> Dict:
    """Run the REAL pipeline.stage_persist against the fake DB and
    return the envelope it wrote to financial_periods."""
    from engine.api import pipeline

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    monkeypatch.setattr(pipeline._supabase, "admin", _fake_admin)
    doc = {
        "id": "doc-1",
        "org_id": "org-1",
        "original_filename": "balanta_reconcile_31.12.2025.xlsx",
        "content_hash": CONTENT_HASH,
    }
    parsed = {"period_end": "2025-12-31", "currency": "RON", "confidence": 0.9}
    period_id = pipeline.stage_persist(doc, parsed, assembled)
    assert period_id == "period-1"
    envelope_writes = [
        patch["assembled_canonical_v1"]
        for table, patch, _f in fake.updates
        if table == "financial_periods" and "assembled_canonical_v1" in patch
    ]
    assert envelope_writes, "stage_persist wrote no canonical envelope"
    return envelope_writes[-1]


# ── 1. Exact-zero source → auto stage is a strict no-op ────────────────


def test_balanced_source_auto_noop(balanced_env, monkeypatch):
    calls = _ai_sentinel(monkeypatch)
    before = _dumps(balanced_env["canonical_bs"])

    out = _reconcile.auto_reconcile_envelope(balanced_env)

    assert out["outcome"] == "balanced_noop"
    assert "reconciliation" not in balanced_env
    assert "reconciliation_auto" not in balanced_env
    assert _dumps(balanced_env["canonical_bs"]) == before
    assert calls == []

    served = _reconcile.served_canonical_bs(balanced_env)
    assert served["status"] == "BALANCED"
    assert served["difference"] == 0.0
    assert served["needs_review"] is False
    assert served["reconcile_offer"] is False


def test_balanced_source_post_refuses(balanced_env):
    with pytest.raises(_reconcile.ReconcileRejected) as exc:
        _reconcile.perform_reconcile(balanced_env, "user-1")
    codes = [d["code"] for d in exc.value.payload["diagnosis"]]
    assert "NOTHING_TO_RECONCILE" in codes


# ── 2. 0.04% rounding drift → auto-fixed AT PERSIST, R1, no AI ─────────


def test_rounding_autofixed_at_persist_without_ai(pack, monkeypatch):
    """END TO END through the REAL stage_persist: the envelope hits the
    database already RECONCILED (the client can never fetch an
    unreconciled sub-threshold state) and the AI is never imported or
    called (sentinel would fail the test)."""
    calls = _ai_sentinel(monkeypatch)
    fake = _FakeAdminClient()
    written = _run_stage_persist(monkeypatch, fake, _assembled_for(pack, ROUNDING_ROWS))

    receipt = written["reconciliation"]
    assert receipt["origin"] == "deterministic"
    assert receipt["diagnosis_code"] == "R1_ROUNDING_CENTS"
    assert receipt["applied_by"] == "system:auto-reconcile"
    assert receipt["content_hash"] == CONTENT_HASH
    assert receipt["parser_version"] == tbp.PARSER_VERSION
    assert receipt["mapping_version"] == written["canonical_bs"]["mapping_version"]
    assert receipt["amount_cents"] == 160  # 0.04% of the 4,000 RON sheet
    assert receipt["placement"] == "balance_sheet"
    assert receipt["placement_detail"] == "bs"
    assert calls == []

    # The persisted canonical_bs keeps the honest source cents…
    assert written["canonical_bs"]["status"] == "MINOR_DRIFT"
    assert written["canonical_bs"]["difference"] == 1.60
    # …while the very first serving is already RECONCILED (real hook).
    statements = _serve_statements(written)
    cbs = statements["canonical_bs"]
    assert cbs["status"] == "RECONCILED"
    assert cbs["difference"] == 0.0
    assert cbs["needs_review"] is False
    assert cbs["reconcile_offer"] is False
    assert statements["assembled_bs"]["bs_balance_delta"] == 0.0


def test_fresh_drift_no_longer_offers(rounding_env):
    """REVISED reconcile_offer semantics: a sub-threshold drift the auto
    stage has not judged (legacy envelope) does NOT offer — the offer is
    reserved for the needs-review state. Stamps stay additive: nothing
    is persisted into the envelope's canonical_bs."""
    cbs = rounding_env["canonical_bs"]
    assert cbs["status"] == "MINOR_DRIFT"
    assert cbs["difference"] == 1.60  # 4,000.00 − 3,998.40, exact cents

    served = _reconcile.served_canonical_bs(rounding_env)
    assert served["reconcile_offer"] is False
    assert served["needs_review"] is False
    assert "reconcile_offer" not in rounding_env["canonical_bs"]
    assert "needs_review" not in rounding_env["canonical_bs"]


def test_rounding_drift_reconciles_with_complete_receipt(rounding_env):
    """The explicit ops/manual action (POST /reconcile) still works and
    the receipt is complete per the contract + addendum."""
    original_cbs_json = _dumps(rounding_env["canonical_bs"])

    updated, served = _reconcile.perform_reconcile(rounding_env, "user-1")

    # RECONCILED is a distinct state — never BALANCED — and the served
    # difference is exactly zero.
    assert served["status"] == "RECONCILED"
    assert served["status"] != "BALANCED"
    assert served["difference"] == 0.0
    assert served["reconcile_offer"] is False
    assert served["needs_review"] is False
    assert served["totals"]["assets"] == served["totals"]["equity_plus_liabilities"]

    # The synthetic adjusting entry, visibly marked.
    synthetic = [r for r in served["rows"] if r["id"] == _reconcile.SYNTHETIC_ROW_ID]
    assert len(synthetic) == 1
    row = synthetic[0]
    assert row["label"] == "Diferențe de reconciliere"
    assert row["synthetic"] is True
    assert row["leaf_ids"] == []
    assert row["account_codes"] == []
    assert row["amount"] == 1.60
    assert row["section"] == "current_liabilities"  # E+L side was short
    # Section subtotal absorbed the row (1,998.40 + 1.60).
    sections = {s["id"]: s["subtotal"] for s in served["sections"]}
    assert sections["current_liabilities"] == 2000.00

    # Receipt fields — complete per the contract + addendum.
    receipt = served["reconciliation"]
    assert receipt["content_hash"] == CONTENT_HASH
    assert receipt["original_difference"] == 1.60
    assert receipt["applied_delta"] == 1.60
    assert receipt["amount_cents"] == 160
    assert receipt["target_row_id"] == _reconcile.SYNTHETIC_ROW_ID
    assert receipt["origin"] == "deterministic"
    assert receipt["diagnosis_code"] == "R1_ROUNDING_CENTS"
    assert receipt["placement"] == "balance_sheet"
    assert receipt["placement_detail"] == "bs"
    assert receipt["parser_version"] == tbp.PARSER_VERSION
    assert receipt["mapping_version"] == rounding_env["canonical_bs"]["mapping_version"]
    assert receipt["applied_by"] == "user-1"
    assert receipt["applied_at"]
    assert receipt["reversible"] is True

    # Persisted shape: receipt stored NEXT TO canonical_bs; the source
    # cents themselves are byte-identical (never overwritten).
    assert updated["reconciliation"] == receipt
    assert _dumps(updated["canonical_bs"]) == original_cbs_json
    assert updated["canonical_bs"]["difference"] == 1.60
    assert updated["canonical_bs"]["status"] == "MINOR_DRIFT"


def test_reconcile_is_idempotent(rounding_env):
    updated, served_first = _reconcile.perform_reconcile(rounding_env, "user-1")
    again, served_again = _reconcile.perform_reconcile(updated, "user-2")
    # Same stored entry for the same source: nothing new to persist.
    assert again is updated
    assert _dumps(served_again) == _dumps(served_first)


# ── 3. Single unmapped account equals the delta → auto-fixed (R2) ──────


def test_single_unmapped_match_autofixes_naming_the_account(unmapped_env, monkeypatch):
    calls = _ai_sentinel(monkeypatch)
    cbs = unmapped_env["canonical_bs"]
    assert cbs["difference"] == 300.00
    unmapped_codes = [u["code"] for u in cbs["unmapped"]]
    assert "413" in unmapped_codes

    proposal = _reconcile.run_deterministic_diagnosis(cbs)
    assert proposal is not None
    assert proposal["diagnosis_code"] == "R2_SINGLE_UNMAPPED_MATCH"
    assert proposal["target_account"] == "413"
    assert proposal["origin"] == "deterministic"

    out = _reconcile.auto_reconcile_envelope(unmapped_env)
    assert out["outcome"] == "accepted"
    assert calls == []

    served = _reconcile.served_canonical_bs(unmapped_env)
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    receipt = served["reconciliation"]
    assert receipt["diagnosis_code"] == "R2_SINGLE_UNMAPPED_MATCH"
    assert receipt["target_account"] == "413"  # the receipt NAMES the account
    assert "413" in receipt["rationale"]
    assert receipt["origin"] == "deterministic"
    assert receipt["applied_by"] == "system:auto-reconcile"
    assert receipt["placement"] == "balance_sheet"  # 413 is not class 6/7


# ── 4. R_DUP — duplicated totals row, deterministic, no AI ─────────────


def test_dup_totals_row_autofixes_without_ai(dup_env, monkeypatch):
    calls = _ai_sentinel(monkeypatch)
    cbs = dup_env["canonical_bs"]
    assert cbs["difference"] == 250.00
    d5 = [d for d in cbs["diagnosis"] if d["code"] == "D5_DUPLICATE_ROWS"]
    assert len(d5) == 1  # the build itself flagged the duplicated pair

    proposal = _reconcile.run_deterministic_diagnosis(cbs)
    assert proposal is not None
    assert proposal["diagnosis_code"] == "R_DUP_TOTALS_ROW"
    assert proposal["target_account"] == "371"
    assert proposal["origin"] == "deterministic"

    out = _reconcile.auto_reconcile_envelope(dup_env)
    assert out["outcome"] == "accepted"
    assert calls == []

    served = _reconcile.served_canonical_bs(dup_env)
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    assert served["reconciliation"]["diagnosis_code"] == "R_DUP_TOTALS_ROW"
    assert "371" in served["reconciliation"]["rationale"]


def test_dup_totals_row_requires_exact_match(pack, monkeypatch):
    """A duplicated pair whose amount does NOT equal the difference is
    not an R_DUP candidate — the diagnosis stays inconclusive rather
    than blaming the wrong row."""
    _ai_sentinel(monkeypatch)
    env = _envelope_for(pack, [
        _row("5121", sf_d=500_000.00),
        _row("371", sf_d=250.00),
        _row("371", sf_d=250.00),
        _row("1012", sf_c=500_100.00),   # difference 400.00 ≠ 250.00
    ])
    assert env["canonical_bs"]["difference"] == 400.00
    assert _reconcile.run_deterministic_diagnosis(env["canonical_bs"]) is None


# ── 5. AI path — accepted proposal closes exactly; bad one refused ─────


def test_ai_path_accept_closes_to_zero(inconclusive_env, monkeypatch):
    cbs = inconclusive_env["canonical_bs"]
    assert cbs["difference"] == 777.77
    assert _reconcile.run_deterministic_diagnosis(cbs) is None

    monkeypatch.setattr(
        _reconcile,
        "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": "413",
            "amount_cents": 77777,
            "rationale": "unbooked receivable adjustment",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )

    out = _reconcile.auto_reconcile_envelope(inconclusive_env)
    assert out["outcome"] == "accepted"
    assert out["origin"] == "llm_proposed"

    served = _reconcile.served_canonical_bs(inconclusive_env)
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    receipt = served["reconciliation"]
    assert receipt["origin"] == "llm_proposed"
    assert receipt["model"] == _reconcile.AI_MODEL
    assert receipt["prompt_version"] == _reconcile.PROMPT_VERSION
    assert receipt["applied_by"] == "system:auto-reconcile"


def test_ai_bad_proposal_rejected_needs_review(inconclusive_env, monkeypatch):
    """A proposal that does not close to EXACTLY 0 cents is refused by
    the validator: honest MINOR_DRIFT + needs_review, envelope's
    canonical_bs byte-identical, nothing reconciled."""
    before = _dumps(inconclusive_env["canonical_bs"])
    monkeypatch.setattr(
        _reconcile,
        "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": "413",
            "amount_cents": 77776,  # one cent off the 77,777-cent gap
            "rationale": "off by one",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )

    out = _reconcile.auto_reconcile_envelope(inconclusive_env)
    assert out["outcome"] == "needs_review"
    assert "reconciliation" not in inconclusive_env
    assert _dumps(inconclusive_env["canonical_bs"]) == before

    marker = inconclusive_env["reconciliation_auto"]
    assert marker["outcome"] == "needs_review"
    assert marker["content_hash"] == CONTENT_HASH
    assert marker["parser_version"] == tbp.PARSER_VERSION
    codes = [d["code"] for d in marker["diagnosis"]]
    assert "VALIDATOR_NONZERO_CLOSE" in codes

    served = _reconcile.served_canonical_bs(inconclusive_env)
    assert served["status"] == "MINOR_DRIFT"
    assert served["difference"] == 777.77
    assert served["needs_review"] is True
    assert served["reconcile_offer"] is True  # the ONE offering state


def test_ai_unavailable_needs_review_calm(inconclusive_env, monkeypatch):
    """No key / SDK absent → the auto stage skips silently to the
    honest MINOR_DRIFT + needs_review — a calm state, not an error."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "anthropic", None)

    out = _reconcile.auto_reconcile_envelope(inconclusive_env)
    assert out["outcome"] == "needs_review"
    assert "reconciliation" not in inconclusive_env
    marker = inconclusive_env["reconciliation_auto"]
    codes = [d["code"] for d in marker["diagnosis"]]
    assert "AI_UNAVAILABLE" in codes

    served = _reconcile.served_canonical_bs(inconclusive_env)
    assert served["status"] == "MINOR_DRIFT"
    assert served["needs_review"] is True
    assert served["reconcile_offer"] is True


def test_needs_review_marker_is_keyed_to_source(inconclusive_env, monkeypatch):
    """The marker only stamps needs_review for the SAME source+build —
    a re-scan of a different file serves plain MINOR_DRIFT."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    _reconcile.auto_reconcile_envelope(inconclusive_env)
    rescanned = copy.deepcopy(inconclusive_env)
    rescanned["provenance"]["content_hash"] = "sha256-DIFFERENT-FILE"
    served = _reconcile.served_canonical_bs(rescanned)
    assert served["needs_review"] is False
    assert served["reconcile_offer"] is False


# ── 6. 0.3% drift → the auto stage refuses; POST refuses too ───────────


def test_above_gate_auto_refuses_and_post_refuses(gate_env, monkeypatch):
    calls = _ai_sentinel(monkeypatch)
    cbs = gate_env["canonical_bs"]
    assert cbs["difference"] == 3000.00  # 0.3% of a 1M sheet

    out = _reconcile.auto_reconcile_envelope(gate_env)
    assert out["outcome"] == "above_gate"
    assert "reconciliation" not in gate_env
    assert "reconciliation_auto" not in gate_env  # not a needs-review case
    assert calls == []

    served = _reconcile.served_canonical_bs(gate_env)
    assert served["status"] == cbs["status"]  # untouched serving
    assert served["needs_review"] is False
    assert served["reconcile_offer"] is False

    with pytest.raises(_reconcile.ReconcileRejected) as exc:
        _reconcile.perform_reconcile(gate_env, "user-1")
    payload = exc.value.payload
    assert payload["status"] == "rejected"
    codes = [d["code"] for d in payload["diagnosis"]]
    assert "ABOVE_RECONCILE_GATE" in codes


def test_llm_extraction_is_out_of_auto_scope(rounding_env, monkeypatch):
    """LLM-extracted numbers have no trustworthy source cents to close
    against — the auto stage stays out (ops POST remains available)."""
    calls = _ai_sentinel(monkeypatch)
    rounding_env["canonical_bs"]["extraction"]["method"] = "llm"
    out = _reconcile.auto_reconcile_envelope(rounding_env)
    assert out["outcome"] == "llm_extraction"
    assert "reconciliation" not in rounding_env
    assert calls == []


# ── 7. Refresh stability + same-file carry-forward (no flicker) ────────


def test_serving_is_byte_identical_across_refreshes(rounding_env):
    out = _reconcile.auto_reconcile_envelope(rounding_env)
    assert out["outcome"] == "accepted"

    serve_1 = _reconcile.served_canonical_bs(rounding_env)
    serve_2 = _reconcile.served_canonical_bs(rounding_env)
    assert _dumps(serve_1) == _dumps(serve_2)
    assert serve_1["status"] == "RECONCILED"
    # Serving never mutates the persisted envelope.
    assert rounding_env["canonical_bs"]["status"] == "MINOR_DRIFT"


def test_unreconciled_serving_also_stable(rounding_env):
    serve_1 = _reconcile.served_canonical_bs(rounding_env)
    serve_2 = _reconcile.served_canonical_bs(rounding_env)
    assert _dumps(serve_1) == _dumps(serve_2)


def test_same_file_repersist_carries_reconciliation_forward(pack, monkeypatch):
    """END TO END through the REAL stage_persist twice: the re-scan of
    the SAME file replaces the envelope but carries the reconciliation
    forward (identical receipt, no re-application, no AI) — the served
    object never flickers through an unreconciled state."""
    calls = _ai_sentinel(monkeypatch)
    fake = _FakeAdminClient()

    first = _run_stage_persist(monkeypatch, fake, _assembled_for(pack, ROUNDING_ROWS))
    receipt_1 = first["reconciliation"]
    assert receipt_1["applied_by"] == "system:auto-reconcile"

    # Re-scan of the SAME file: fresh assembled, same content_hash.
    second = _run_stage_persist(monkeypatch, fake, _assembled_for(pack, ROUNDING_ROWS))
    receipt_2 = second["reconciliation"]

    # Carried forward — the SAME receipt, not a re-application (a
    # re-application would have archived the old receipt into history).
    assert receipt_2 == receipt_1
    assert "reconciliation_history" not in second
    assert calls == []

    # Both persisted envelopes serve byte-identically (provenance's
    # written_at differs, but the served canonical_bs does not).
    assert _dumps(_reconcile.served_canonical_bs(second)) == _dumps(
        _reconcile.served_canonical_bs(first)
    )
    assert _reconcile.served_canonical_bs(second)["status"] == "RECONCILED"


def test_carry_forward_drops_on_hash_or_version_change(pack, rounding_env):
    _reconcile.auto_reconcile_envelope(rounding_env)
    assert "reconciliation" in rounding_env

    # Different file → dropped.
    fresh = _envelope_for(pack, ROUNDING_ROWS, content_hash="sha256-OTHER")
    assert _reconcile.carry_forward_reconciliation(fresh, rounding_env) == "dropped_stale"
    assert "reconciliation" not in fresh

    # Same file but a mapping bump → dropped.
    fresh_2 = _envelope_for(pack, ROUNDING_ROWS)
    old_bumped = copy.deepcopy(rounding_env)
    old_bumped["canonical_bs"]["mapping_version"] = "ro_omfp1802_v1_OLD"
    assert _reconcile.carry_forward_reconciliation(fresh_2, old_bumped) == "dropped_stale"
    assert "reconciliation" not in fresh_2

    # Same file, same versions → carried.
    fresh_3 = _envelope_for(pack, ROUNDING_ROWS)
    assert _reconcile.carry_forward_reconciliation(fresh_3, rounding_env) == "carried"
    assert fresh_3["reconciliation"] == rounding_env["reconciliation"]


# ── 8. Undo → raw truth + suppression; auto never re-applies ───────────


def test_undo_restores_raw_writes_suppression_and_blocks_auto(rounding_env, monkeypatch):
    out = _reconcile.auto_reconcile_envelope(rounding_env)
    assert out["outcome"] == "accepted"
    assert _reconcile.served_canonical_bs(rounding_env)["status"] == "RECONCILED"

    undone, restored = _reconcile.perform_undo(rounding_env, "user-2")

    # The TRUE source imbalance, rendered honestly.
    assert restored["status"] == "MINOR_DRIFT"
    assert restored["difference"] == 1.60
    assert restored["needs_review"] is False
    assert restored["reconcile_offer"] is False  # user's explicit choice
    assert "reconciliation" not in restored
    assert not any(
        r["id"] == _reconcile.SYNTHETIC_ROW_ID for r in restored["rows"]
    )

    # The stored entry is archived, never erased.
    assert "reconciliation" not in undone
    history = undone["reconciliation_history"]
    assert len(history) == 1
    archived = history[0]
    assert archived["content_hash"] == CONTENT_HASH
    assert archived["undone_by"] == "user-2"
    assert archived["undone_at"]
    assert archived["applied_by"] == "system:auto-reconcile"

    # The suppression entry — the full key the auto stage honors.
    suppressed = undone["reconciliation_suppressed"]
    assert len(suppressed) == 1
    entry = suppressed[0]
    assert entry["content_hash"] == CONTENT_HASH
    assert entry["parser_version"] == tbp.PARSER_VERSION
    assert entry["mapping_version"] == undone["canonical_bs"]["mapping_version"]
    assert entry["suppressed_by"] == "user-2"
    assert entry["suppressed_at"]

    # A subsequent auto-stage run does NOT re-apply.
    calls = _ai_sentinel(monkeypatch)
    again = _reconcile.auto_reconcile_envelope(undone)
    assert again["outcome"] == "suppressed"
    assert "reconciliation" not in undone
    assert calls == []
    assert _reconcile.served_canonical_bs(undone)["status"] == "MINOR_DRIFT"


def test_undo_suppression_survives_same_file_repersist(pack, monkeypatch):
    """Undo → suppression carried forward by a SAME-file re-persist →
    the auto stage still refuses (through the REAL stage seam helpers)."""
    _ai_sentinel(monkeypatch)
    envelope = _envelope_for(pack, ROUNDING_ROWS)
    _reconcile.auto_reconcile_envelope(envelope)
    undone, _restored = _reconcile.perform_undo(envelope, "user-2")

    fresh = _envelope_for(pack, ROUNDING_ROWS)
    assert _reconcile.carry_forward_reconciliation(fresh, undone) == "carried"
    assert "reconciliation" not in fresh              # nothing to re-apply…
    assert fresh["reconciliation_suppressed"]         # …and the block came along
    assert _reconcile.auto_reconcile_envelope(fresh)["outcome"] == "suppressed"


def test_suppression_clears_on_version_bump(rounding_env, monkeypatch):
    """A version bump changes the snapshot key, so the suppression stops
    matching and the auto stage may run again (spec: suppression clears
    on file/version change)."""
    _reconcile.auto_reconcile_envelope(rounding_env)
    undone, _ = _reconcile.perform_undo(rounding_env, "user-2")
    bumped = copy.deepcopy(undone)
    # Any version OTHER than the current one (was the literal
    # "tb_parser_v5", which stopped being a bump when the real parser
    # reached v5 — hypothesis-suite session, 2026-08-19).
    bumped["canonical_bs"]["extraction"]["parser_version"] = (
        tbp.PARSER_VERSION + "-bumped"
    )
    calls = _ai_sentinel(monkeypatch)
    out = _reconcile.auto_reconcile_envelope(bumped)
    assert out["outcome"] == "accepted"
    assert calls == []


def test_explicit_reconcile_clears_suppression(rounding_env):
    """POST /reconcile stays mounted as the ops/manual trigger; an
    explicit call overrides (and clears) the undo-suppression."""
    _reconcile.auto_reconcile_envelope(rounding_env)
    undone, _ = _reconcile.perform_undo(rounding_env, "user-2")
    assert undone["reconciliation_suppressed"]

    updated, served = _reconcile.perform_reconcile(undone, "ops-user")
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    assert updated["reconciliation"]["applied_by"] == "ops-user"
    assert "reconciliation_suppressed" not in updated


def test_undo_without_reconciliation_refuses(rounding_env):
    with pytest.raises(_reconcile.ReconcileRejected) as exc:
        _reconcile.perform_undo(rounding_env, "user-1")
    codes = [d["code"] for d in exc.value.payload["diagnosis"]]
    assert "NOTHING_TO_UNDO" in codes


# ── 9. Hash mismatch (re-scan of a different file) ignores the entry ───


def test_hash_mismatch_ignores_stored_entry(rounding_env):
    _reconcile.auto_reconcile_envelope(rounding_env)

    rescanned = copy.deepcopy(rounding_env)
    rescanned["provenance"]["content_hash"] = "sha256-DIFFERENT-FILE"

    served = _reconcile.served_canonical_bs(rescanned)
    # Original serving — the stored entry is not applied…
    assert served["status"] == "MINOR_DRIFT"
    assert served["difference"] == 1.60
    assert "reconciliation" not in served
    assert not any(
        r["id"] == _reconcile.SYNTHETIC_ROW_ID for r in served["rows"]
    )
    # …no needs-review state exists for the new source (auto has not
    # judged it yet — reconcile_offer stays false under the revised
    # semantics)…
    assert served["needs_review"] is False
    assert served["reconcile_offer"] is False
    # …and the stored entry is NOT deleted.
    assert rescanned["reconciliation"]["content_hash"] == CONTENT_HASH


# ── 10. Placement rule — 6/7-cause → P&L; anything else → BS ───────────


def test_placement_6xx_cause_lands_pl_other_expense(expense_cause_env, monkeypatch):
    cbs = expense_cause_env["canonical_bs"]
    assert cbs["difference"] == -777.77
    assert _reconcile.run_deterministic_diagnosis(cbs) is None
    loss_before = next(
        r["amount"] for r in cbs["rows"] if r["id"] == "current_year_loss"
    )
    assert loss_before == -200.00

    monkeypatch.setattr(
        _reconcile,
        "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": "609",   # class 6 → P&L placement
            "amount_cents": -77777,
            "rationale": "609 charge missing from the closing result",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )
    out = _reconcile.auto_reconcile_envelope(expense_cause_env)
    assert out["outcome"] == "accepted"
    assert out["placement"] == "pnl"

    served = _reconcile.served_canonical_bs(expense_cause_env)
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    receipt = served["reconciliation"]
    assert receipt["placement"] == "pnl"
    assert receipt["placement_detail"] == "pl_other_expense"  # diff < 0
    assert receipt["target_row_id"] == "current_year_loss"

    # The delta reaches the BS through the RESULT row (leaf note), and
    # no synthetic BS row exists on this placement.
    loss_row = next(r for r in served["rows"] if r["id"] == "current_year_loss")
    assert loss_row["amount"] == -977.77
    assert loss_row["reconciliation_delta"] == -777.77
    assert loss_row["reconciliation_note"] == "Diferențe de reconciliere"
    assert not any(r["id"] == _reconcile.SYNTHETIC_ROW_ID for r in served["rows"])
    # Extracted leaves themselves are untouched.
    assert loss_row["leaf_ids"] == ["609"]
    assert expense_cause_env["canonical_bs"]["rows"] != served["rows"]

    # The P&L serving carries the visible line (REAL /api/period hook).
    statements = _serve_statements(expense_cause_env)
    line = statements["assembled_pl"]["reconciliation_adjustment"]
    assert line["label"] == "Diferențe de reconciliere"
    assert line["placement"] == "pl_other_expense"
    assert line["amount"] == -777.77   # signed effect on the result
    assert line["synthetic"] is True
    assert statements["canonical_bs"]["status"] == "RECONCILED"


def test_placement_7xx_cause_lands_pl_other_income(income_cause_env, monkeypatch):
    cbs = income_cause_env["canonical_bs"]
    assert cbs["difference"] == 577.77
    assert _reconcile.run_deterministic_diagnosis(cbs) is None

    monkeypatch.setattr(
        _reconcile,
        "_ai_propose",
        lambda cbs: {
            "origin": "llm_proposed",
            "diagnosis_code": "R4_AI_PROPOSAL",
            "target_account": "704",   # class 7 → P&L placement
            "amount_cents": 57777,
            "rationale": "704 revenue missing from the closing result",
            "model": _reconcile.AI_MODEL,
            "prompt_version": _reconcile.PROMPT_VERSION,
        },
    )
    out = _reconcile.auto_reconcile_envelope(income_cause_env)
    assert out["outcome"] == "accepted"

    served = _reconcile.served_canonical_bs(income_cause_env)
    assert served["status"] == "RECONCILED"
    assert served["difference"] == 0.0
    receipt = served["reconciliation"]
    assert receipt["placement"] == "pnl"
    assert receipt["placement_detail"] == "pl_other_income"  # diff > 0
    profit_row = next(r for r in served["rows"] if r["id"] == "current_year_profit")
    assert profit_row["amount"] == 777.77  # 200.00 + 577.77
    assert profit_row["reconciliation_delta"] == 577.77

    line = _serve_statements(income_cause_env)["assembled_pl"][
        "reconciliation_adjustment"
    ]
    assert line["placement"] == "pl_other_income"
    assert line["amount"] == 577.77


def test_placement_bs_cause_stays_on_balance_sheet(unmapped_env):
    """A non-6/7 cause (unmapped 413) keeps the balance-sheet line and
    the P&L serving carries NO reconciliation line."""
    out = _reconcile.auto_reconcile_envelope(unmapped_env)
    assert out["outcome"] == "accepted"

    served = _reconcile.served_canonical_bs(unmapped_env)
    receipt = served["reconciliation"]
    assert receipt["placement"] == "balance_sheet"
    assert receipt["placement_detail"] == "bs"
    assert receipt["target_row_id"] == _reconcile.SYNTHETIC_ROW_ID
    synthetic = [r for r in served["rows"] if r.get("synthetic") is True]
    assert len(synthetic) == 1
    assert synthetic[0]["label"] == "Diferențe de reconciliere"

    statements = _serve_statements(unmapped_env)
    assert "reconciliation_adjustment" not in statements["assembled_pl"]
    assert statements["canonical_bs"]["status"] == "RECONCILED"


# ── Validator: exact-zero closes only, 0.1% amount gate ────────────────


def test_validator_rejects_non_exact_close(rounding_env):
    cbs = rounding_env["canonical_bs"]
    wrong = {
        "origin": "llm_proposed",
        "diagnosis_code": "R4_AI_PROPOSAL",
        "target_account": "401",
        "amount_cents": 159,  # one cent off the 160-cent difference
        "rationale": "off by one",
    }
    with pytest.raises(_reconcile.ReconcileRejected) as exc:
        _reconcile.validate_proposal(cbs, wrong)
    codes = [d["code"] for d in exc.value.payload["diagnosis"]]
    assert "VALIDATOR_NONZERO_CLOSE" in codes


def test_validator_rejects_amount_above_gate(rounding_env):
    cbs = rounding_env["canonical_bs"]
    huge = {
        "origin": "llm_proposed",
        "diagnosis_code": "R4_AI_PROPOSAL",
        "target_account": "401",
        "amount_cents": 100_000,  # 1,000 RON on a 4,000 RON sheet
        "rationale": "way past the gate",
    }
    with pytest.raises(_reconcile.ReconcileRejected) as exc:
        _reconcile.validate_proposal(cbs, huge)
    codes = [d["code"] for d in exc.value.payload["diagnosis"]]
    assert "VALIDATOR_AMOUNT_ABOVE_GATE" in codes


def test_validator_accepts_exact_close(rounding_env):
    cbs = rounding_env["canonical_bs"]
    exact = {
        "origin": "llm_proposed",
        "diagnosis_code": "R4_AI_PROPOSAL",
        "target_account": "401",
        "amount_cents": 160,
        "rationale": "exact",
    }
    assert _reconcile.validate_proposal(cbs, exact) == 160


def test_validator_exact_close_holds_for_pl_placement(expense_cause_env):
    cbs = expense_cause_env["canonical_bs"]
    proposal = {
        "origin": "llm_proposed",
        "diagnosis_code": "R4_AI_PROPOSAL",
        "target_account": "609",
        "amount_cents": -77777,
        "rationale": "exact, P&L side",
    }
    assert (
        _reconcile.validate_proposal(cbs, proposal, placement=_reconcile.PLACEMENT_PL)
        == -77777
    )
    with pytest.raises(_reconcile.ReconcileRejected):
        _reconcile.validate_proposal(
            cbs,
            {**proposal, "amount_cents": -77778},
            placement=_reconcile.PLACEMENT_PL,
        )


# ── Routes are mounted on the pipeline router ──────────────────────────


def test_reconcile_routes_mounted():
    from engine.api.pipeline import build_router

    paths = {route.path for route in build_router().routes}
    assert "/api/period/{period_id}/reconcile" in paths
    assert "/api/period/{period_id}/reconcile/undo" in paths


def test_serve_preserves_ai_lane_needs_review_array():
    """Verifier NO-GO regression (2026-08-19): served_canonical_bs used to
    overwrite the AI lane's needs_review ARRAY (low-confidence mapping
    queue) with this stage's boolean, silencing the FE panel on every
    real serving. The array must survive the serve path verbatim."""
    from engine.api import _reconcile

    entries = [
        {"code": "466", "label": "Egyéb kötelezettség", "amount": 400000.0,
         "confidence": 0.62, "rationale": "ambiguous mapping"},
    ]
    envelope = {
        "provenance": {"content_hash": "h1"},
        "canonical_bs": {
            "schema": "bs_v2",
            "status": "MINOR_DRIFT",
            "difference": 12.0,
            "totals": {"assets": 100000.0, "equity_plus_liabilities": 99988.0},
            "extraction": {"method": "llm"},
            "needs_review": list(entries),
            "rows": [], "sections": [], "diagnosis": [],
        },
    }
    served = _reconcile.served_canonical_bs(envelope)
    assert served["needs_review"] == entries, served["needs_review"]
    # The auto-reconcile boolean semantics still apply when the stored
    # value is NOT an array (deterministic-lane envelopes).
    envelope["canonical_bs"]["needs_review"] = False
    served2 = _reconcile.served_canonical_bs(envelope)
    assert isinstance(served2["needs_review"], bool)
