"""G4 — NO PERIOD WITHOUT AN ANALYSED SOURCE DOCUMENT: one writer, nowhere else.

Production (2026-09-21) carried `financial_periods` rows with no document
behind them: a current-month row per workspace per month (2026-05 … 2026-09),
a 2021, "current month" rows. The creators were in the BROWSER, not the
engine — `financial_periods` has a member INSERT policy, so the frontend
wrote rows straight through RLS:

  · `useEnsureCurrentPeriod` (mounted in AppShell, i.e. on EVERY page) made
    an empty current-month period in every workspace that lacked one;
  · `createEmptyPeriod` behind "Add period" (no file), the undo of an empty
    delete, and the attach flow's "create the container first".

All of them are gone. The one remaining writer is the pipeline's
`stage_persist`, which runs once the document has been read, and a run that
fails afterwards removes the row it inserted
(`pipeline._rollback_period_of_failed_run`, driven in
test_workspace_uploads.py). No DDL can take the INSERT policy away from the
client (none is shipped with this change), so this gate is the lock.

WHAT IT REDS ON (TC-11):
  · any frontend or edge-function source (tests excluded) that inserts or
    upserts into `financial_periods` through a Supabase client chain;
  · any engine / script source that inserts or upserts `financial_periods`
    outside `stage_persist`, or a SQL function in supabase/ that does;
  · the hook file coming back, or AppShell calling it;
  · the scan going vacuous — it must find the one sanctioned site and walk
    the whole frontend.

PLANT: add `sb.from("financial_periods").insert({org_id})` to any .ts under
frontend/lib → red, naming the file and line.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import List, Tuple

REPO = Path(__file__).resolve().parents[2]
FRONTEND = REPO / "frontend"
EDGE_FUNCTIONS = REPO / "supabase" / "functions"

_FROM_PERIODS = re.compile(r"""\.from\(\s*["'`]financial_periods["'`]\s*\)""")
_WRITE = re.compile(r"\.(insert|upsert)\s*\(")


def _frontend_sources() -> List[Path]:
    out = []  # type: List[Path]
    for root in (FRONTEND, EDGE_FUNCTIONS):
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix not in (".ts", ".tsx", ".js", ".jsx"):
                continue
            parts = set(path.parts)
            if "__tests__" in parts or "node_modules" in parts or ".test." in path.name:
                continue
            out.append(path)
    return out


def _client_period_writes(text: str) -> List[int]:
    """Line numbers of `.from("financial_periods")` chains that write. The
    chain is read up to its statement end (`;`) or 400 characters."""
    hits = []  # type: List[int]
    for m in _FROM_PERIODS.finditer(text):
        tail = text[m.end():m.end() + 400]
        end = tail.find(";")
        chain = tail if end < 0 else tail[:end]
        if _WRITE.search(chain):
            hits.append(text.count("\n", 0, m.start()) + 1)
    return hits


def test_no_client_source_writes_a_period():
    sources = _frontend_sources()
    assert len(sources) >= 300, "VACUOUS — only %d frontend sources scanned" % len(sources)
    readers = 0
    offenders = []  # type: List[str]
    for path in sources:
        text = path.read_text(encoding="utf-8", errors="replace")
        if _FROM_PERIODS.search(text):
            readers += 1
        for line in _client_period_writes(text):
            offenders.append("%s:%d" % (path.relative_to(REPO), line))
    assert readers >= 1, "VACUOUS — no frontend source reads financial_periods; the scan is broken"
    assert not offenders, (
        "G4 VIOLATED — client code creates financial_periods rows (a period with no analysed "
        "file behind it). Upload with periodEndHint instead; the engine creates the period "
        "when the file is analysed:\n  " + "\n  ".join(offenders))


def test_the_scan_sees_a_planted_client_insert():
    """The detector itself, on the three shapes a client write takes."""
    planted = (
        ('const { data } = await sb\n  .from("financial_periods")\n  .insert({ org_id: o })\n  .select("id");\n', [2]),
        ("await client.from('financial_periods').upsert(row, { onConflict: 'id' });\n", [1]),
        ('sb.from(`financial_periods`).insert(x)\n', [1]),
    )
    for text, lines in planted:
        assert _client_period_writes(text) == lines, text
    assert _client_period_writes('sb.from("financial_periods").select("id").eq("org_id", o);') == []
    assert _client_period_writes('sb.from("financial_periods").delete().eq("id", p);') == []


def _engine_period_writes() -> List[Tuple[str, str, int]]:
    """(file, enclosing function, line) of every `<x>.insert|upsert(
    "financial_periods", …)` call under src/ and scripts/."""
    out = []  # type: List[Tuple[str, str, int]]
    for root in (REPO / "src", REPO / "scripts"):
        for path in sorted(root.rglob("*.py")):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:
                continue
            parents = {}
            for node in ast.walk(tree):
                for child in ast.iter_child_nodes(node):
                    parents[child] = node
            for node in ast.walk(tree):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in ("insert", "upsert") and node.args
                        and isinstance(node.args[0], ast.Constant)
                        and node.args[0].value == "financial_periods"):
                    continue
                fn = node
                while fn in parents and not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    fn = parents[fn]
                name = fn.name if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) else "<module>"
                out.append((str(path.relative_to(REPO)), name, node.lineno))
    return out


def test_the_only_engine_writer_is_stage_persist():
    writes = _engine_period_writes()
    sanctioned = [w for w in writes if w[0] == "src/engine/api/pipeline.py" and w[1] == "stage_persist"]
    assert sanctioned, "VACUOUS — the scan no longer finds stage_persist's insert: %s" % writes
    others = [w for w in writes if w not in sanctioned]
    assert not others, (
        "G4 VIOLATED — a financial_periods row is created outside stage_persist:\n  "
        + "\n  ".join("%s:%d (in %s)" % (f, line, fn) for f, fn, line in others))


def test_no_sql_function_creates_a_period():
    offenders = []  # type: List[str]
    for path in sorted((REPO / "supabase").rglob("*.sql")):
        text = path.read_text(encoding="utf-8", errors="replace")
        bare = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
        if re.search(r"insert\s+into\s+(?:public\.)?financial_periods\b", bare, re.I):
            offenders.append(str(path.relative_to(REPO)))
    assert not offenders, "G4 VIOLATED — SQL inserts financial_periods rows: %s" % offenders


def test_the_current_month_container_hook_is_gone():
    assert not (FRONTEND / "hooks" / "useEnsureCurrentPeriod.ts").exists()
    shell = (FRONTEND / "components" / "cfo" / "AppShell.tsx").read_text(encoding="utf-8")
    code = "\n".join(line.split("//", 1)[0] for line in shell.splitlines())
    assert "useEnsureCurrentPeriod(" not in code and "createEmptyPeriod" not in code
    org_periods = (FRONTEND / "lib" / "orgPeriods.ts").read_text(encoding="utf-8")
    assert "export async function createEmptyPeriod" not in org_periods
