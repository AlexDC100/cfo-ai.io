"""ONE letter ladder: the letter a composite earns and the rungs served beside it.

`GET /api/period/{id}` serves `assembled_metrics.credit.letter_grade`
(minted by `pipeline._composite_to_letter_grade`) and, next to it,
`letter_grade_bands` — the rungs the FE prints and reads to place the
composite. Until 2026-09-13 those were two copies in pipeline.py (an
if-chain and a literal list) that happened to agree; a rung moved in one
would have served a letter that contradicts the ladder printed beside it.
Both now read `engine.ratios.credit_model.CREDIT_LETTER_LADDER`.

WHAT THIS REDS ON, after the repair (TC-11):
  · a literal ladder re-typed anywhere in `src/engine/api/pipeline.py` or
    `src/engine/ratios/` — any list/tuple/dict display or if-chain that
    carries two or more of the ladder's grade strings, other than the one
    `CREDIT_LETTER_LADDER` assignment;
  · `_composite_to_letter_grade` or the served `letter_grade_bands` no
    longer following the constant when it is replaced (behavioural: the
    constant is swapped for a different ladder and both consumers,
    including the REAL `get_period` route, must follow it);
  · the served letter disagreeing with the served rungs for the composite
    served beside them.

SCOPE (TC-13): pipeline.py and engine/ratios only. The FE mirror in
`CreditScoreCard.tsx` and any public-company rating ladder elsewhere are
not read here.
"""

from __future__ import annotations

import ast
import contextlib
import json
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
PIPELINE = REPO / "src" / "engine" / "api" / "pipeline.py"
RATIOS = REPO / "src" / "engine" / "ratios"
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"

PATCHED = ((95, "ZZ-TOP"), (33, "ZZ-MID"), (0, "ZZ-LOW"))


def _grades() -> List[str]:
    from engine.ratios import credit_model as CM

    return [g for _, g in CM.CREDIT_LETTER_LADDER]


def _scanned_files() -> List[Path]:
    files = [PIPELINE] + sorted(RATIOS.rglob("*.py"))
    assert PIPELINE.is_file() and (RATIOS / "credit_model.py").is_file()
    return files


def _literal_ladders(text: str, label: str, grades: List[str]) -> List[str]:
    """Every node that states two or more ladder grades as string
    constants — a list/tuple/dict display, or an if-chain returning them —
    except the one `CREDIT_LETTER_LADDER` assignment."""
    tree = ast.parse(text)
    grade_set = set(grades)
    exempt: set = set()
    for node in ast.walk(tree):
        targets: List[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        if any(isinstance(t, ast.Name) and t.id == "CREDIT_LETTER_LADDER" for t in targets):
            exempt.update(id(n) for n in ast.walk(node))
    found = []
    for node in ast.walk(tree):
        if id(node) in exempt:
            continue
        if isinstance(node, ast.If):
            consts = {
                n.value.value for n in ast.walk(node)
                if isinstance(n, ast.Return) and isinstance(n.value, ast.Constant)
                and n.value.value in grade_set
            }
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # a flat chain of sibling `if c >= 90: return "AAA"` statements
            consts = {
                s.body[0].value.value for s in node.body
                if isinstance(s, ast.If) and s.body and isinstance(s.body[0], ast.Return)
                and isinstance(s.body[0].value, ast.Constant) and s.body[0].value.value in grade_set
            }
        elif isinstance(node, (ast.List, ast.Tuple, ast.Dict, ast.Set)):
            consts = {
                n.value for n in ast.walk(node)
                if isinstance(n, ast.Constant) and n.value in grade_set
            }
        else:
            continue
        if len(consts) >= 2:
            found.append("%s:%d %s %s" % (label, node.lineno, type(node).__name__, sorted(consts)))
    return found


def test_there_is_exactly_one_literal_ladder():
    grades = _grades()
    assert len(grades) >= 5 and len(set(grades)) == len(grades), grades
    copies = [
        hit for f in _scanned_files()
        for hit in _literal_ladders(f.read_text("utf-8"), str(f.relative_to(REPO)), grades)
    ]
    assert not copies, (
        "a second literal copy of the credit letter ladder exists — read "
        "engine.ratios.credit_model.CREDIT_LETTER_LADDER instead:\n  "
        + "\n  ".join(copies)
    )


def test_the_scan_sees_each_ladder_shape():
    """Non-vacuity (TC-3): each shape a copy has taken in this repo is
    found when it is NOT the exempt constant."""
    grades = _grades()
    shapes = {
        "if-chain": (
            "def f(c):\n"
            "    if c >= 90: return 'AAA'\n"
            "    if c >= 80: return 'AA'\n"
            "    return 'CC'\n"
        ),
        "served list": "BANDS = [{'min': 90, 'grade': 'AAA'}, {'min': 80, 'grade': 'AA'}]\n",
        "renamed constant": "OTHER_LADDER = ((90, 'AAA'), (80, 'AA'))\n",
    }
    for shape, text in shapes.items():
        assert _literal_ladders(text, shape, grades), "the scan misses a %s" % shape
    real = (RATIOS / "credit_model.py").read_text("utf-8")
    assert not _literal_ladders(real, "credit_model.py", grades)
    assert _literal_ladders(
        real.replace("CREDIT_LETTER_LADDER: Tuple", "UNEXEMPT: Tuple", 1), "probe", grades
    ), "the scan cannot see the real ladder once it is not the exempt constant"


def test_the_helper_follows_the_constant(monkeypatch):
    from engine.api import pipeline as P
    from engine.ratios import credit_model as CM

    # -5 is outside the pack's composite range: no letter, on either ladder
    # (R-RANGE: a letter is never minted from an out-of-range composite).
    before = [P._composite_to_letter_grade(c) for c in (96, 50, 10, -5)]
    assert before[-1] is None, before
    monkeypatch.setattr(CM, "CREDIT_LETTER_LADDER", PATCHED)
    assert [P._composite_to_letter_grade(c) for c in (96, 50, 10, -5)] == [
        "ZZ-TOP", "ZZ-MID", "ZZ-LOW", None
    ]
    assert CM.letter_grade_bands() == [{"min": m, "grade": g} for m, g in PATCHED]
    monkeypatch.undo()
    assert [P._composite_to_letter_grade(c) for c in (96, 50, 10, -5)] == before


# ── the REAL get_period route ─────────────────────────────────────────


class _Db:
    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]) -> None:
        self.tables = tables

    def select(self, table: str, *, filters: Any = None, columns: str = "*",
               limit: Any = None, order: Any = None, single: bool = False, **_k: Any):
        out = []
        for row in self.tables.get(table, []):
            ok = True
            for key, value in (filters or {}).items():
                value = str(value)
                if value.startswith("eq.") and str(row.get(key)) != value[3:]:
                    ok = False
                elif value == "is.null" and row.get(key) is not None:
                    ok = False
            if ok:
                out.append(dict(row))
        return out[:limit] if limit else out

    def insert(self, *_a: Any, **_k: Any):
        return []

    def update(self, *_a: Any, **_k: Any) -> None:
        return None

    def delete(self, *_a: Any, **_k: Any) -> None:
        return None


def _served_credit(monkeypatch, book: str = "saga_10_col_agras") -> Dict[str, Any]:
    from engine.api import pipeline as P
    from engine.ratios import credit_model as CM

    fx = json.loads((FIRM / f"{book}.json").read_text("utf-8"))
    pid, org = "p-ladder", "o-ladder"
    rows = CM.compute_period_metrics(
        fx["statements"], (fx.get("envelope") or {}).get("source_data_quality")
    )
    db = _Db({
        "financial_periods": [{
            "id": pid, "org_id": org, "period_end": fx["period_end"],
            "period_start": fx["period_start"], "currency": fx["currency"],
            "source_document_id": None, "assembled_canonical_v1": fx["envelope"],
        }],
        "statement_line_items": [dict(li, period_id=pid, org_id=org) for li in fx["line_items"]],
        "calculated_metrics": [dict(r, period_id=pid, org_id=org) for r in rows],
        "organizations": [{"id": org, "name": "Ladder SRL", "industry_key": None,
                           "industry_display_name": None}],
    })

    @contextlib.contextmanager
    def _client(*_a: Any, **_k: Any) -> Iterator[_Db]:
        yield db

    monkeypatch.setattr(P._supabase, "admin", _client)
    monkeypatch.setattr(P._supabase, "per_user", _client)
    app = FastAPI()
    app.include_router(P.build_router())
    resp = TestClient(app).get(f"/api/period/{pid}", headers={"Authorization": "Bearer test"})
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()["assembled_metrics"]["credit"]


def _letter_off(bands: List[Dict[str, Any]], composite: float) -> str:
    for band in bands:
        if composite >= band["min"]:
            return band["grade"]
    return bands[-1]["grade"]


def test_the_served_rungs_are_the_constant(monkeypatch):
    from engine.ratios import credit_model as CM

    credit = _served_credit(monkeypatch)
    assert credit["composite_score"] is not None, "non-vacuity: the book earns no composite"
    assert credit["letter_grade_bands"] == [
        {"min": m, "grade": g} for m, g in CM.CREDIT_LETTER_LADDER
    ]
    assert credit["letter_grade"] == _letter_off(credit["letter_grade_bands"], credit["composite_score"])


def test_the_served_rungs_and_letter_follow_a_replaced_constant(monkeypatch):
    from engine.ratios import credit_model as CM

    monkeypatch.setattr(CM, "CREDIT_LETTER_LADDER", PATCHED)
    credit = _served_credit(monkeypatch)
    assert credit["letter_grade_bands"] == [{"min": m, "grade": g} for m, g in PATCHED], (
        "get_period serves rungs that do not come from CREDIT_LETTER_LADDER: %r"
        % (credit["letter_grade_bands"],)
    )
    assert credit["letter_grade"] == _letter_off(credit["letter_grade_bands"], credit["composite_score"])
    assert credit["letter_grade"].startswith("ZZ-")
