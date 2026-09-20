"""The credit model is a PURE function, and the extraction changed nothing.

`engine.ratios.credit_model.compute_period_metrics` holds the arithmetic
`pipeline.stage_compute` used to carry inline (headline figures, ratio
rows, Altman Z'' with X1..X4, seven credit sub-scores, the composite).
It exists so the SAME function can later be run on a prior period's
served statements at serve time. That only works if it is pure — a
function that reaches for a database cannot run over a payload — and if
moving it changed no number.

THE GOLDEN. `fixtures/credit_model/stage_compute_rows_pre_extraction.json`
is what `stage_compute` INSERTED into `calculated_metrics` at cfd2117,
before the extraction, captured with a recording admin double (nothing
written). Seven cases:
  · the Scandia FY2025 regression baseline
    (src/engine/country_packs/ro_romania/fixtures/regression_baselines/)
  · four corpus books as the real engine assembles them
    (tests/engine/fixtures/firm/saga_10_col_{agras,carniprod,realestate,retail})
  · synthetic_negative_equity (declared synthetic TB, real engine output)
  · agras with every balanceSheet leaf zeroed — the `total_assets <= 0`
    branch, where no Altman and no composite may be emitted
The ONE deliberate difference from the golden is the trailing
`credit_model_revision` row this wave adds; it is asserted by value.

WHAT THIS REDS ON, after the repair (TC-11):
  · any change to what a row carries — a weight, a sub-score mapping, an
    Altman coefficient, a rounding, a ratio's operands, a row's unit,
    direction or position — on any of the seven cases;
  · an I/O call re-added to `compute_period_metrics` (the Supabase admin
    and per-user clients are stubbed to raise), or an import of a client
    module into `engine/ratios/credit_model.py`;
  · `stage_compute` inserting anything other than exactly the pure rows
    plus `period_id` / `org_id`, or doing arithmetic of its own;
  · the revision row going missing or changing shape without the golden
    being deliberately recaptured.

WHAT IT CANNOT SEE (TC-13 scope): whether the numbers are RIGHT — only
that they are the numbers production has persisted since cfd2117; the
`get_period` composition of the credit block (that is
test_credit_ladder_single_source.py for the ladder, and B2's gates for
the serve-time switch); any module other than `engine/ratios/credit_model.py`
for the import scan.
"""

from __future__ import annotations

import ast
import contextlib
import json
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "tests" / "engine" / "fixtures" / "credit_model" / "stage_compute_rows_pre_extraction.json"
MODULE = REPO / "src" / "engine" / "ratios" / "credit_model.py"

ROW_KEYS = ("name", "value", "unit", "direction")


def _golden() -> Dict[str, Any]:
    return json.loads(GOLDEN.read_text("utf-8"))


def _case_input(case: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    fx = json.loads((REPO / case["source"]).read_text("utf-8"))
    if case["statements_path"] == "assembled.statements":
        statements = fx["assembled"]["statements"]
    else:
        statements = fx["statements"]
    sq: Dict[str, Any] = {}
    if case.get("source_data_quality"):
        sq = (fx.get("envelope") or {}).get("source_data_quality") or {}
    if case.get("derive") == "zero_balance_sheet":
        statements = dict(statements)
        statements["balanceSheet"] = {k: 0.0 for k in statements["balanceSheet"]}
    elif case.get("derive"):
        raise AssertionError("unknown derivation %r" % case["derive"])
    return statements, sq


CASES = sorted(_golden()["cases"].items())
CASE_IDS = [name for name, _ in CASES]


def _dump(rows: List[Dict[str, Any]]) -> str:
    return json.dumps(rows, sort_keys=True)


def _revision_row() -> Dict[str, Any]:
    from engine.ratios import credit_model as CM

    return {
        "name": "credit_model_revision",
        "value": CM.CREDIT_MODEL_REVISION,
        "unit": "revision",
        "direction": "neutral",
    }


class _Forbidden(RuntimeError):
    pass


@contextlib.contextmanager
def _raising(*_a: Any, **_k: Any) -> Iterator[None]:
    raise _Forbidden("the credit model opened a Supabase client")
    yield  # pragma: no cover


@pytest.fixture
def io_forbidden(monkeypatch):
    from engine.api import _supabase

    monkeypatch.setattr(_supabase, "admin", _raising)
    monkeypatch.setattr(_supabase, "per_user", _raising)
    yield


# ── non-vacuity (TC-3) ────────────────────────────────────────────────


def test_the_golden_is_not_vacuous():
    golden = _golden()
    cases = golden["cases"]
    assert "scandia_fy2025_baseline" in cases
    corpus = [n for n in cases if n.startswith("saga_10_col_") and not cases[n].get("derive")]
    assert len(corpus) >= 2, corpus
    with_altman = [n for n, c in cases.items() if any(r["name"] == "altman_z_score" for r in c["rows"])]
    without_altman = [n for n, c in cases.items() if not any(r["name"] == "altman_z_score" for r in c["rows"])]
    assert len(with_altman) >= 3, with_altman
    assert without_altman == ["saga_10_col_agras_zero_balance_sheet"], without_altman
    composites = {
        n: next(r["value"] for r in c["rows"] if r["name"] == "credit_composite")
        for n, c in cases.items() if n in with_altman
    }
    assert len(set(composites.values())) >= 3, (
        "the cases do not distinguish composites, so a perturbed weight "
        "could agree by accident: %r" % composites
    )
    for name, case in cases.items():
        assert all(r["name"] != "credit_model_revision" for r in case["rows"]), (
            "%s: the golden is supposed to predate the revision stamp" % name
        )


# ── the pure function, with I/O forbidden ─────────────────────────────


@pytest.mark.parametrize("name,case", CASES, ids=CASE_IDS)
def test_pure_rows_are_the_pre_extraction_rows_byte_for_byte(name, case, io_forbidden):
    from engine.ratios import credit_model as CM

    statements, sq = _case_input(case)
    rows = CM.compute_period_metrics(statements, source_data_quality=sq)

    expected = [{k: r[k] for k in ROW_KEYS} for r in case["rows"]]
    assert rows[-1] == _revision_row(), rows[-1]
    got, want = _dump(rows[:-1]), _dump(expected)
    if got != want:
        by_name = {r["name"]: r for r in expected}
        diffs = [
            "%s: pure %r vs persisted %r" % (r["name"], r, by_name.get(r["name"]))
            for r in rows[:-1] if by_name.get(r["name"]) != r
        ]
        missing = [n for n in by_name if n not in {r["name"] for r in rows}]
        raise AssertionError(
            "[%s] compute_period_metrics drifted from what stage_compute persisted "
            "before the extraction:\n  %s\n  missing: %r"
            % (name, "\n  ".join(diffs[:12]) or "(order changed)", missing)
        )


def test_the_pure_function_does_not_mutate_its_input(io_forbidden):
    from engine.ratios import credit_model as CM

    name, case = CASES[0]
    statements, sq = _case_input(case)
    before = json.dumps([statements, sq], sort_keys=True)
    CM.compute_period_metrics(statements, source_data_quality=sq)
    assert json.dumps([statements, sq], sort_keys=True) == before


def test_the_credit_model_imports_no_client():
    """Stubbing Supabase catches a Supabase call; this catches the other
    ways out (an HTTP client, a clock, a file). Scope: this one module."""
    tree = ast.parse(MODULE.read_text("utf-8"))
    # `decimal` and `math` are arithmetic. `engine.ratios.credit_pack` is the ONE module
    # allowed to open a file on the model's behalf — the pack data the X4
    # materiality is read from (ruling R-D4, TC-10) — and it is held below
    # to that: yaml + the path to the pack, no client, no clock.
    allowed = {"__future__", "logging", "typing", "decimal", "math", "engine.ratios.credit_pack"}
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            imported.add(mod if mod == "engine.ratios.credit_pack" else
                         mod.split(".")[0] if node.level == 0 else "." * node.level)
    assert imported <= allowed, "credit_model imports %r" % sorted(imported - allowed)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert not names & {"open", "_supabase", "admin", "per_user", "httpx", "requests"}, (
        names & {"open", "_supabase", "admin", "per_user", "httpx", "requests"}
    )
    pack_tree = ast.parse((MODULE.parent / "credit_pack.py").read_text("utf-8"))
    pack_imports = set()
    for node in ast.walk(pack_tree):
        if isinstance(node, ast.Import):
            pack_imports.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            pack_imports.add((node.module or "").split(".")[0])
    assert pack_imports <= {"__future__", "functools", "os", "decimal", "pathlib", "typing", "yaml"}, (
        "credit_pack imports %r" % sorted(pack_imports))


# ── stage_compute persists exactly the pure rows ──────────────────────


class _Recorder:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, Any, Any]] = []

    def delete(self, table: str, filters: Any = None) -> None:
        self.calls.append(("delete", table, filters))

    def insert(self, table: str, rows: Any, returning: bool = True) -> None:
        self.calls.append(("insert", table, rows))


@pytest.mark.parametrize("name,case", CASES, ids=CASE_IDS)
def test_stage_compute_inserts_exactly_the_pure_rows(name, case, monkeypatch):
    from engine.api import pipeline as P
    from engine.ratios import credit_model as CM

    statements, sq = _case_input(case)
    monkeypatch.setattr(P._supabase, "admin", _raising)
    pure = CM.compute_period_metrics(statements, source_data_quality=sq)

    recorder = _Recorder()

    @contextlib.contextmanager
    def _admin(*_a: Any, **_k: Any) -> Iterator[_Recorder]:
        yield recorder

    monkeypatch.setattr(P._supabase, "admin", _admin)
    returned = P.stage_compute(
        {"org_id": "org-gate"},
        {"statements": statements, "source_data_quality": sq},
        "period-gate",
    )

    assert recorder.calls[0] == ("delete", "calculated_metrics", {"period_id": "eq.period-gate"})
    assert len(recorder.calls) == 2 and recorder.calls[1][:2] == ("insert", "calculated_metrics")
    inserted = recorder.calls[1][2]
    assert _dump(returned) == _dump(pure)
    assert _dump(inserted) == _dump(
        [{"period_id": "period-gate", "org_id": "org-gate", **r} for r in pure]
    )
    # ...and those are the rows production persisted before the
    # extraction, plus the one deliberate revision row.
    assert _dump(inserted[:-1]) == _dump(case["rows"])
    assert inserted[-1] == {"period_id": "period-gate", "org_id": "org-gate", **_revision_row()}


# ── the interest-coverage basis is the methodology's, by operands ────────


def test_interest_coverage_divides_ebit_and_ebitda_to_interest_divides_ebitda(io_forbidden):
    """Interest coverage = EBIT / interest expense (CLAUDE.md Appendix A,
    section 5: "Interest coverage | EBIT / Interest expense"); EBITDA /
    interest is the SEPARATE `ebitda_to_interest` row. Until 2026-09-19 both
    rows divided EBITDA and printed one figure under two names (17.70x twice
    on the Scandia FY2025 baseline; EBIT gives 13.27x). The golden above
    pins the figures; this reds by OPERANDS, so a re-captured golden cannot
    quietly carry the EBITDA basis back in.

    Reds on: an `interest_coverage` row that is not round(operating_profit /
    interest, 4); an `ebitda_to_interest` row that is not
    round(ebitda_statutory / interest, 4); the two rows agreeing on any
    interest-paying book whose EBIT and statutory EBITDA differ (D&A > 0);
    fewer than three such books (vacuity). Cannot see: the served route
    (test_ratio_table's operand check) or the FE labels (ratio-byte-match).
    """
    from engine.ratios import credit_model as CM

    distinct = []
    failures = []
    for name, case in CASES:
        statements, sq = _case_input(case)
        interest = statements["incomeStatement"]["interestExpense"]
        rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(statements, source_data_quality=sq)}
        ebit, ebitda_stat = rows["operating_profit"], rows["ebitda_statutory"]
        if not interest:
            if rows["interest_coverage"] is not None or rows["ebitda_to_interest"] is not None:
                failures.append("%s: no interest expense yet a coverage figure is served" % name)
            continue
        if rows["interest_coverage"] != round(ebit / interest, 4):
            failures.append("%s: interest_coverage %r is not EBIT / interest = %r (EBITDA / interest would be %r)"
                            % (name, rows["interest_coverage"], round(ebit / interest, 4), round(ebitda_stat / interest, 4)))
        if rows["ebitda_to_interest"] != round(ebitda_stat / interest, 4):
            failures.append("%s: ebitda_to_interest %r is not statutory EBITDA / interest = %r"
                            % (name, rows["ebitda_to_interest"], round(ebitda_stat / interest, 4)))
        if ebit != ebitda_stat:
            distinct.append(name)
            if rows["interest_coverage"] == rows["ebitda_to_interest"]:
                failures.append("%s: interest_coverage and ebitda_to_interest print one figure %r under two names"
                                % (name, rows["interest_coverage"]))
    assert not failures, "\n  ".join(failures)
    assert len(distinct) >= 3, "vacuous: interest-paying books with D&A: %r" % distinct
