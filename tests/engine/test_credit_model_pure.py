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
The ONE deliberate difference from the golden at the extraction was the
trailing `credit_model_revision` row; it is asserted by value.

REVISION 3 — THE ONE EBITDA (owner ruling 2026-09-26). Every row built on
EBITDA or the operating result moved BY RULING (net 711 and net 72x inside,
767 financial), so the golden's law is split, not re-captured:
  · every row OUTSIDE `CM.DEFINITION_REVISED_METRICS` and the credit family
    is still the pre-extraction row byte for byte, in the same order — the
    ruling moved nothing else (measured: zero drift on all seven cases);
  · the three RETIRED rows (the gross 711 credit turnover and the totals on
    it) are gone, and nothing else is;
  · every one-EBITDA row is its formula over the ASSEMBLED definition, read
    by this file off `assembled_pl` (not through the model), refusal
    included — the Scandia baseline, persisted before the stock variation
    was measured, refuses the whole family and the composite with it;
  · on the book with no 711 and no 72x (retail) the one-EBITDA family IS
    the golden, byte for byte, apart from `total_operating_revenue`
    (redefined by the ruling: + other operating income, − 767);
  · on the four corpus books the credit figures are the INDEPENDENT
    measurement of the ruling (specs-durable/ebitda711/gatemap_credit_ruling
    .json, computed offline by its own script before this module changed).

WHAT THIS REDS ON, after the repair (TC-11):
  · any change to what a row outside the one-EBITDA family carries — a
    weight, a sub-score mapping, an Altman coefficient, a rounding, a
    ratio's operands, a row's unit, direction or position — on any of the
    seven cases;
  · a one-EBITDA row that is not its formula over the assembled definition
    (a second EBITDA — the EBITDA without 711/72x, the gross memo — under
    any name), a refused EBITDA served as a number or as 0, a retired row
    coming back, a credit figure off the independent measurement;
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


def _revised() -> set:
    """Every row whose definition the ruling moved: the one-EBITDA family,
    the retired rows and the credit family built on them."""
    from engine.ratios import credit_model as CM

    return (set(CM.DEFINITION_REVISED_METRICS) | set(CM.CREDIT_FAMILY_METRICS)
            | set(CM.REVISION_3_ADDED_METRICS))


def _untouched(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    keep = _revised()
    return [{k: r[k] for k in ROW_KEYS} for r in rows if r["name"] not in keep]


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
    """Every row the ruling did not move, byte for byte and in order; the
    retired rows gone and nothing else."""
    from engine.ratios import credit_model as CM

    statements, sq = _case_input(case)
    rows = CM.compute_period_metrics(statements, source_data_quality=sq)

    assert rows[-1] == _revision_row(), rows[-1]
    assert CM.CREDIT_MODEL_REVISION == 3
    names = {r["name"] for r in rows}
    gone = sorted(r["name"] for r in case["rows"] if r["name"] not in names)
    assert gone == sorted(CM.RETIRED_METRICS), (name, gone)
    assert not names & set(CM.RETIRED_METRICS), names & set(CM.RETIRED_METRICS)
    expected = _untouched(case["rows"])
    got, want = _dump(_untouched(rows[:-1])), _dump(expected)
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
    # `engine.country_packs.ro_romania.stock_variation` (revision 3) is the
    # one-EBITDA refusal vocabulary — pure, held below to `typing` alone.
    engine_modules = {"engine.ratios.credit_pack", "engine.country_packs.ro_romania"}
    allowed = {"__future__", "logging", "typing", "decimal", "math"} | engine_modules
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            imported.add(mod if mod in engine_modules else
                         mod.split(".")[0] if node.level == 0 else "." * node.level)
    # ...and the model reads only its refusal vocabulary from it (never
    # `measure`, whose lazy chart import is the persist path's).
    used = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
            and isinstance(n.value, ast.Name) and n.value.id == "_stock_variation"}
    assert used <= {"refusal_text", "REASON_PREDATES"}, sorted(used)
    sv_tree = ast.parse((REPO / "src" / "engine" / "country_packs" / "ro_romania"
                         / "stock_variation.py").read_text("utf-8"))
    sv_imports = set()
    for node in ast.walk(sv_tree):
        if isinstance(node, ast.Import):
            sv_imports.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            sv_imports.add((node.module or "").split(".")[0] if node.level == 0
                           else "." * node.level + (node.module or ""))
    assert sv_imports <= {"__future__", "typing", "."}, "stock_variation imports %r" % sorted(sv_imports)
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
    # ...and, outside the rows the ruling moved, those are the rows
    # production persisted before the extraction, plus the revision row.
    assert _dump(_untouched(inserted[:-1])) == _dump(_untouched(case["rows"]))
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
    round(ebitda / interest, 4) (revision 3: the one EBITDA, of which
    `ebitda_statutory` is an alias); the two rows agreeing on any
    interest-paying book whose EBIT and EBITDA differ (D&A > 0); a coverage
    figure served on a book whose EBITDA is refused; fewer than three such
    books (vacuity). Cannot see: the served route (test_ratio_table's
    operand check) or the FE labels (ratio-byte-match).
    """
    from engine.ratios import credit_model as CM

    distinct = []
    failures = []
    for name, case in CASES:
        statements, sq = _case_input(case)
        interest = statements["incomeStatement"]["interestExpense"]
        rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(statements, source_data_quality=sq)}
        ebit, ebitda_stat = rows["operating_profit"], rows["ebitda_statutory"]
        if ebitda_stat != rows["ebitda"]:
            failures.append("%s: ebitda_statutory %r is not the one EBITDA %r" % (name, ebitda_stat, rows["ebitda"]))
        if ebit is None or ebitda_stat is None:
            if rows["interest_coverage"] is not None or rows["ebitda_to_interest"] is not None:
                failures.append("%s: the one EBITDA is refused yet a coverage figure is served" % name)
            continue
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


# ── revision 3: THE ONE EBITDA, by operands and by independent measurement ──


def _apl_reading(statements: Dict[str, Any]) -> Dict[str, Any]:
    """THIS FILE'S reading of the one definition off the served
    `assembled_pl` — never through the model — so the two agree by
    measurement. A block assembled before the ruling reads as refused when
    the book posts to 711 (its gross memo is not the variation)."""
    apl = statements.get("assembled_pl") or {}
    if "ebitda_definition" in apl:
        refused = bool(apl.get("ebitda_refusal"))
        return {"refused": refused,
                "ebitda": None if refused else apl["ebitda"],
                "ebit": None if refused else apl["operating_result"],
                "gross_profit": None if refused else apl["gross_profit"],
                "before": apl["ebitda_before_stock_variation"],
                "net_711": (apl.get("inventory_variation") or {}).get("value"),
                "net_72x": (apl.get("capitalized_own_work") or {}).get("value")}
    pl = statements["incomeStatement"]
    before = (pl["revenue"] - pl["costOfGoodsSold"] - pl["operatingExpenses"] + pl["otherIncome"])
    refused = abs(float(pl.get("inventoryVariationMemo") or 0)) >= 0.005
    cap = float(pl.get("capitalizedOwnWork") or 0)
    return {"refused": refused,
            "ebitda": None if refused else before + cap,
            "ebit": None if refused else before + cap - pl["depreciationAmortization"],
            "gross_profit": None if refused else pl["revenue"] - pl["costOfGoodsSold"],
            "before": before, "net_711": None if refused else 0.0, "net_72x": cap}


def _r(v: Any, places: int) -> Any:
    return None if v is None else round(v, places)


@pytest.mark.parametrize("name,case", CASES, ids=CASE_IDS)
def test_every_one_ebitda_row_is_the_assembled_definition(name, case, io_forbidden):
    """Each one-EBITDA row, by operands, over the assembled definition — and
    EBITDA = the build-up + net 711 + net 72x, one identity, to the cent."""
    from engine.ratios import credit_model as CM

    statements, sq = _case_input(case)
    rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(statements, source_data_quality=sq)}
    a = _apl_reading(statements)
    pl = statements["incomeStatement"]
    revenue, interest = pl["revenue"], pl["interestExpense"]
    bs = statements["balanceSheet"]
    debt = bs["shortTermDebt"] + bs["longTermDebt"]

    def div(n: Any, d: Any) -> Any:
        return None if n is None or d in (None, 0) else round(n / d, 4)

    want = {
        "ebitda": _r(a["ebitda"], 2), "ebitda_cash": _r(a["ebitda"], 2),
        "ebitda_statutory": _r(a["ebitda"], 2), "operating_profit": _r(a["ebit"], 2),
        "gross_profit": _r(a["gross_profit"], 2), "inventory_variation": _r(a["net_711"], 2),
        "ebitda_before_stock_variation": _r(a["before"], 2),
        "ebitda_margin": div(a["ebitda"], revenue), "gross_margin": div(a["gross_profit"], revenue),
        "operating_margin": div(a["ebit"], revenue), "debt_to_ebitda": div(debt, a["ebitda"]),
        "net_debt_to_ebitda": div(debt - bs["cash"], a["ebitda"]),
        "interest_coverage": div(a["ebit"], interest), "ebitda_to_interest": div(a["ebitda"], interest),
        "dscr": div(a["ebitda"], interest + bs["shortTermDebt"]),
        "dscr_with_lt_principal": div(a["ebitda"], interest + bs["longTermDebt"] / 8.0),
    }
    apl = statements.get("assembled_pl") or {}
    if "total_operating_expense" in apl:
        # the margin rule's activity basis, as the assembly states it
        want["total_operating_expense"] = round(apl["total_operating_expense"], 2)
    bad = ["%s: served %r, the definition gives %r" % (k, rows.get(k), v)
           for k, v in want.items() if rows.get(k) != v]
    assert not bad, "[%s] %s" % (name, "\n  ".join(bad))
    if a["refused"]:
        for k in ("core_ebitda", "core_ebitda_margin", "adjusted_ebitda", "roic", "altman_x3",
                  "credit_composite"):
            assert rows.get(k) is None, (name, k, rows.get(k))
    else:
        assert abs(a["before"] + a["net_711"] + a["net_72x"] - a["ebitda"]) < 0.01, (name, a)


def test_a_refused_ebitda_refuses_the_composite_with_the_stock_variation_cause(io_forbidden):
    """The Scandia baseline's persisted envelope predates the measurement:
    the one EBITDA refuses, and with it Altman, coverage, DSCR and leverage,
    each naming the cause — never the EBITDA without 711 in its place."""
    from engine.ratios import credit_model as CM

    case = dict(CASES)["scandia_fy2025_baseline"]
    statements, sq = _case_input(case)
    rows = CM.compute_period_metrics(statements, source_data_quality=sq)
    block = CM.credit_block(rows, statements=statements)
    assert block["composite"] is None and block["letter"] is None
    refused = {k: v["code"] for k, v in block["refused_subscores"].items()}
    assert refused == {"altman": CM.EBITDA_REFUSED, "leverage": CM.EBITDA_REFUSED,
                       "coverage": CM.EBITDA_REFUSED, "dscr": CM.EBITDA_REFUSED}, refused
    for comp in block["refused_subscores"].values():
        assert comp["ebitda_refusal"]["code"] == "period_predates_stock_variation_measurement", comp
        assert comp["ebitda_refusal"]["text_en"] in comp["text"]
    assert block["reason"]["code"] == CM.CREDIT_COMPONENT_UNDEFINED


#: THE INDEPENDENT REFEREE. specs-durable/ebitda711/gatemap_credit_ruling.json
#: (2026-09-26): the ruling's credit figures measured OFFLINE by
#: gatemap_credit_ruling.py on the corpus books, with net 711 = the 121
#: bridge and 722 inside EBIT / EBITDA — before this module was changed.
#: Ratios as the rows store them (4 dp; the margin as a fraction).
RULED = {
    "saga_10_col_agras": {"credit_composite": 81.0, "altman_z_score": 6.19, "ebitda_margin": 0.1069,
                          "interest_coverage": 31.9962, "dscr": 4.7819, "debt_to_ebitda": 0.3072},
    "saga_10_col_carniprod": {"credit_composite": 79.3, "altman_z_score": 6.39, "ebitda_margin": 0.0548,
                              "interest_coverage": None, "dscr": None, "debt_to_ebitda": 0.0},
    "saga_10_col_realestate": {"credit_composite": 41.5, "altman_z_score": 4.81,
                               "interest_coverage": 0.4221, "dscr": 0.1112, "debt_to_ebitda": 33.6679},
    "saga_10_col_retail": {"credit_composite": 20.6, "altman_z_score": 0.79, "ebitda_margin": 0.0286,
                           "interest_coverage": 0.3249, "dscr": 0.9349, "debt_to_ebitda": 12.3084},
}


def test_the_credit_rows_are_the_independent_measurement_of_the_ruling(io_forbidden):
    from engine.ratios import credit_model as CM

    cases = dict(CASES)
    bad = []
    for name, ruled in sorted(RULED.items()):
        statements, sq = _case_input(cases[name])
        rows = {r["name"]: r["value"] for r in CM.compute_period_metrics(statements, source_data_quality=sq)}
        for k, v in ruled.items():
            if rows.get(k) != v:
                bad.append("%s %s: %r, measured %r" % (name, k, rows.get(k), v))
    assert not bad, "\n  ".join(bad)


def test_with_no_711_and_no_72x_the_ruling_moves_nothing(io_forbidden):
    """Retail posts no 711 and no 72x (measured): the one-EBITDA family IS
    the pre-ruling golden, byte for byte — the ruling adds nothing where
    there is nothing to add. `total_operating_revenue` alone moves (the
    ruling's own redefinition: + other operating income, − 767)."""
    from engine.ratios import credit_model as CM

    case = dict(CASES)["saga_10_col_retail"]
    statements, sq = _case_input(case)
    apl = statements["assembled_pl"]
    assert apl["inventory_variation"]["value"] == 0.0 and apl["capitalized_own_work"]["value"] == 0.0
    rows = {r["name"]: {k: r[k] for k in ROW_KEYS}
            for r in CM.compute_period_metrics(statements, source_data_quality=sq)}
    golden = {r["name"]: {k: r[k] for k in ROW_KEYS} for r in case["rows"]}
    moved = sorted(n for n in golden if n in rows and rows[n] != golden[n])
    # The inventory-days ruling (owner spec 2026-09-26, inventory days) revised dio, ccc
    # and inventory_turnover on EVERY book — a different ruling, held by the
    # inventory-days gate — so they are named here, not hidden.
    inventory_ruling = sorted(CM.INVENTORY_DAYS_REVISED_METRICS)
    assert moved == sorted(["total_operating_revenue"] + inventory_ruling), moved
