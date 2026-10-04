"""A REAL RESTART for the laws of tests/engine/test_rerun_restart.py.

What is durable at one instant — the store's tables and its storage — is
pickled at the moment the first process "dies" (a `BaseException` raised
right after a write was stored, so no `except Exception` and no failure
handler runs before the freeze), and a SECOND python process continues over
it: fresh imports, a second `create_app()`, every in-process registry empty.
No law clears a dict by hand to play a restart.

The second process is `python -m pytest tests/engine/rerun_restart_child.py`
(not collected by the suite: its name does not match `test_*.py`). It is told
what to do by a list of JSON steps and reports what it saw as JSON.

HONESTY OF THE HARNESS (each is asserted, here or in the child):
  · the child imports the engine of THE TREE UNDER TEST — `PYTHONPATH` is the
    `src` directory of the `engine` package this process imported, never the
    main checkout an editable install points at;
  · the child starts with empty registries (asserted before it thaws);
  · the store the child reads is the one frozen AT THE KILL — the freeze is
    the last thing that happens before the exception leaves the write, so
    nothing a `finally` of the dying process wrote is in it.
"""
from __future__ import annotations

import json
import os
import pickle
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

#: Environment of the second process.
ENV_STORE = "RERUN_RESTART_STORE"
ENV_STEPS = "RERUN_RESTART_STEPS"
ENV_OUT = "RERUN_RESTART_OUT"
ENV_TREE = "RERUN_RESTART_TREE"

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CHILD = HERE / "rerun_restart_child.py"

#: The rows a run persists under a period id (named here, not read from the
#: engine).
PERIOD_TABLES = ("statement_line_items", "calculated_metrics", "alerts", "recommendations",
                 "briefings", "valuations")


class Kill(BaseException):
    """The process dies here. A `BaseException`: no `except Exception` of
    the engine catches it, so no failure handler tidies the store first."""


def freeze(gw: Any, path: Any) -> None:
    """What is DURABLE at this instant: the tables and the storage."""
    with open(str(path), "wb") as f:
        pickle.dump({"tables": gw.db.tables, "storage": gw.db.storage, "columns": gw.db.columns,
                     "auto_ids": gw.db._auto_ids}, f)


def thaw(gw: Any, path: Any) -> None:
    with open(str(path), "rb") as f:
        state = pickle.load(f)
    gw.db.tables = state["tables"]
    gw.db.storage = state["storage"]
    gw.db.columns = state["columns"]
    gw.db._auto_ids = state["auto_ids"]


def frozen_tables(path: Any) -> Dict[str, List[Dict[str, Any]]]:
    with open(str(path), "rb") as f:
        return pickle.load(f)["tables"]


def kill_after(gw: Any, monkeypatch: Any, store_path: Any, op: str, table: str, *,
               when: Optional[Callable[[Any, Dict[str, Any]], bool]] = None, nth: int = 1) -> Dict[str, Any]:
    """The process dies right AFTER the nth `op` on `table` that `when(payload,
    filters)` accepts was STORED — the store is frozen at that instant."""
    seen = {"n": 0, "fired": False}
    real = getattr(gw.db, op)

    def call(tbl: str, *args: Any, **kwargs: Any) -> Any:
        out = real(tbl, *args, **kwargs)
        if tbl == table and not seen["fired"]:
            payload = args[0] if args else None
            if when is None or when(payload, dict(kwargs.get("filters") or {})):
                seen["n"] += 1
                if seen["n"] == nth:
                    seen["fired"] = True
                    freeze(gw, store_path)
                    raise Kill("killed after %s %s #%d" % (op, table, nth))
        return out

    monkeypatch.setattr(gw.db, op, call)
    return seen


def kill_when(gw: Any, monkeypatch: Any, store_path: Any, module: Any, name: str) -> Dict[str, Any]:
    """The process dies when `module.name` is CALLED (before it does
    anything) — the store frozen at that instant."""
    seen = {"fired": False}

    def call(*args: Any, **kwargs: Any) -> Any:
        seen["fired"] = True
        freeze(gw, store_path)
        raise Kill("killed entering %s" % name)

    monkeypatch.setattr(module, name, call)
    return seen


def engine_src() -> str:
    """The `src` directory of the `engine` package THIS process imported —
    what the second process must import too."""
    import engine

    return str(Path(engine.__file__).resolve().parents[1])


def second_process(store_path: Any, steps: List[Dict[str, Any]], tmp_path: Any, *,
                   timeout: int = 420) -> Dict[str, Any]:
    """Run `steps` in a FRESH interpreter over the frozen store; returns what
    it reported."""
    out = Path(str(tmp_path)) / ("child_%s.json" % Path(str(store_path)).stem)
    src = engine_src()
    env = dict(os.environ)
    env.update({"PYTHONPATH": src, "PYTHONDONTWRITEBYTECODE": "1", ENV_STORE: str(store_path),
                ENV_OUT: str(out), ENV_STEPS: json.dumps(steps), ENV_TREE: src})
    cp = subprocess.run(
        [sys.executable, "-m", "pytest", str(CHILD), "-x", "-q", "-p", "no:cacheprovider",
         "-o", "addopts=", "--tb=short"],
        env=env, cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True, timeout=timeout)
    if cp.returncode != 0 or not out.exists():
        raise AssertionError("the second process failed (exit %s):\n%s" % (cp.returncode, cp.stdout[-6000:]))
    report = json.loads(out.read_text(encoding="utf-8"))
    if "1 passed" not in cp.stdout:
        raise AssertionError("the second process did not run its one test:\n%s" % cp.stdout[-2000:])
    return report


# ── what a reader is served, and what is stored ───────────────────────


def reader_view(app: Any, gw: Any, org_id: str, period_id: str) -> Dict[str, Any]:
    """What a READER is served of one company's month: the Docs panel's
    feed, the year tiles, and the month's page — briefing, recommendations
    (with what a user set on them), alerts, the statements' revenue and the
    source document. JSON-shaped, so two processes' views compare equal."""
    import test_workspace_v2_gates as V

    http = V._http(app)
    panel = http.get("/api/org/periods-with-documents", headers=V._headers(V.USER, org_id)).json()
    tiles = http.get("/api/companies/%s/years" % org_id, headers=V._headers(V.USER)).json()
    r = http.get("/api/period/%s" % period_id, headers=V._headers(V.USER, org_id))
    body = r.json() if r.status_code == 200 else {}
    income = (body.get("statements") or {}).get("incomeStatement") or {}
    view = {
        "panel": [{"period_id": p["period_id"],
                   "documents": [[d["id"], d["status"], d.get("error")] for d in p["documents"]]}
                  for p in panel.get("periods", [])],
        "active_period_id": panel.get("active_period_id"),
        "tiles": [[t["period_id"], t["year"], t["turnover"]] for t in tiles],
        "period_status": r.status_code,
        "briefing": body.get("briefing"),
        "recommendations": sorted(
            [x["id"], x["title"], x.get("status"), x.get("owner"), x.get("due_date")]
            for x in body.get("recommendations", [])),
        "alerts": sorted(a["alert_key"] for a in body.get("alerts", [])),
        "revenue": income.get("revenue"),
        "line_items": len(body.get("line_items", [])),
        "metrics": len(body.get("metrics", [])),
        "source_document": ((body.get("period") or {}).get("source_document") or {}).get("id"),
    }
    return json.loads(json.dumps(view, default=str))


def store_view(gw: Any, org_id: str) -> Dict[str, Any]:
    """What is STORED for one company: its period rows (which is staged,
    which is committed), what sits under each, its documents, and every row
    left under a period id that no longer exists."""
    periods = [p for p in gw.db.rows("financial_periods") if p["org_id"] == org_id]
    known = set(str(p["id"]) for p in gw.db.rows("financial_periods"))

    def count(table: str, period_id: str) -> int:
        return sum(1 for x in gw.db.rows(table) if str(x.get("period_id")) == str(period_id))

    def marker(p: Dict[str, Any]) -> Any:
        envelope = p.get("assembled_canonical_v1")
        return envelope.get("staged_rerun") if isinstance(envelope, dict) else None

    view = {
        "periods": [{"id": p["id"], "source": p.get("source_document_id"),
                     "period_end": str(p.get("period_end"))[:10], "marker": marker(p),
                     "rows": dict((t, count(t, p["id"])) for t in PERIOD_TABLES),
                     "briefing": [[b["body"], b.get("stale_reason")] for b in gw.db.rows("briefings")
                                  if b["period_id"] == p["id"]],
                     "recommendations": sorted(
                         [x["id"], x["title"], x.get("status"), x.get("owner"), x.get("due_date"),
                          x.get("target_id")]
                         for x in gw.db.rows("recommendations") if x.get("period_id") == p["id"])}
                    for p in sorted(periods, key=lambda p: str(p["id"]))],
        "documents": [{"id": d["id"], "status": d["status"], "period_id": d.get("period_id"),
                       "deleted": bool(d.get("deleted_at")), "error": d.get("error")}
                      for d in gw.db.rows("documents") if d["org_id"] == org_id],
        "strays": dict((t, sorted(set(str(x.get("period_id")) for x in gw.db.rows(t)
                                      if str(x.get("period_id")) not in known)))
                       for t in PERIOD_TABLES),
    }
    return json.loads(json.dumps(view, default=str))
