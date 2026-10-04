"""THE SECOND PROCESS of tests/engine/test_rerun_restart.py.

Run only by path, by `rerun_restart_lib.second_process` (the file name does
not match `test_*.py`, so the suite never collects it; run by hand without
the environment it is skipped). A fresh interpreter: it proves its own
registries are EMPTY and that it imported the engine of the tree under test,
THEN thaws the store the first process froze at its kill, and runs the steps
it was given through the real app:

  {"op": "view", "org", "period"}          what a reader is served + what is stored
  {"op": "provider", "outcomes": [...]}    script the provider ("refuses", or {"body", "titles"})
  {"op": "retry", "org", "doc"}            the REAL POST /api/pipeline/retry, then the run it queued
  {"op": "ttl_elapsed"}                    fifteen minutes pass (the constant, not the clock)
  {"op": "another_documents_run", ...}     another month of the company uploaded and analysed
  {"op": "settle_orphans"}                 the quota sweep's settlement of every reservation the
                                           dead process left outstanding (what the meter was told)
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest

import rerun_restart_lib as R
import test_briefing_keep_last_good_writers as W
import test_rerun_ownership as O
import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures
from engine.api import _doc_dedupe
from engine.api import pipeline as P
from engine.workspaces.migration_plan import empty_live_periods

pytestmark = pytest.mark.skipif(not os.environ.get(R.ENV_STORE), reason="the second process only")


def _registries() -> Dict[str, Any]:
    """Everything this process remembers about runs — before it has done
    anything. A restart starts from nothing."""
    import engine

    return {
        "in_flight": dict(_doc_dedupe._IN_FLIGHT),
        "takeovers": dict(P._TAKEOVERS_BY_RUN),
        "periods_minted": dict(P._PERIODS_MINTED_BY_RUN),
        "staged_reruns": dict(P._STAGED_RERUNS),
        "has_a_rerun_carry": hasattr(P, "_RERUN_CARRY"),
        "engine_file": str(Path(engine.__file__).resolve()),
        "pid": os.getpid(),
    }


def test_the_second_process(app, gw, monkeypatch):
    registries = _registries()
    assert registries["in_flight"] == {} and registries["takeovers"] == {} and \
        registries["periods_minted"] == {} and registries["staged_reruns"] == {}, registries
    assert registries["has_a_rerun_carry"] is False, "the process still holds a re-run carry"
    tree = os.environ[R.ENV_TREE]
    assert registries["engine_file"].startswith(str(Path(tree).resolve())), (
        "the second process imported %s, not the tree under test %s" % (registries["engine_file"], tree))

    R.thaw(gw, os.environ[R.ENV_STORE])
    O._production_foreign_keys(gw, monkeypatch)
    report = {"registries": registries, "steps": []}  # type: Dict[str, Any]
    steps = json.loads(os.environ[R.ENV_STEPS])  # type: List[Dict[str, Any]]
    for step in steps:
        op = step["op"]
        if op == "provider":
            W._script_the_provider(monkeypatch, [
                RuntimeError(W.PROVIDER_ERROR_TEXT) if o == "refuses" else W._reply(o["body"], o["titles"])
                for o in step["outcomes"]])
            continue
        if op == "ttl_elapsed":
            # Fifteen minutes later: every staged row in the store is older
            # than the pass allows a live run to be.
            monkeypatch.setattr(P, "STAGED_RERUN_TTL_S", -1)
            continue
        entry = {"op": op, "label": step.get("label")}  # type: Dict[str, Any]
        if op == "view":
            entry["reader"] = R.reader_view(app, gw, step["org"], step["period"])
            entry["store"] = R.store_view(gw, step["org"])
            entry["empty_live_periods"] = [list(x) for x in empty_live_periods(gw.db.tables)]
        elif op == "retry":
            r = O._retry(app, step["org"], step["doc"])
            entry["status_code"], entry["body"] = r.status_code, r.json()
            if r.status_code == 202:
                assert gw.enqueued and gw.enqueued[-1] == step["doc"], gw.enqueued
                P._run_pipeline_sync(step["doc"])
            (doc,) = gw.docs(id=step["doc"])
            entry["document"] = {"status": doc["status"], "error": doc.get("error"),
                                 "period_id": doc.get("period_id")}
        elif op == "another_documents_run":
            # ANOTHER document of the same company: its November, uploaded on
            # the card and analysed (its narration scripted before this step).
            content = V.agras_workbook(period_line="Balanta de verificare la data de 30.11.2025")
            out = V.one_tap(app, content, "balanta_noiembrie.xlsx")
            doc = V.run_analysis(gw, out["commit"]["document_id"])
            entry["document"] = {"id": doc["id"], "status": doc["status"], "error": doc.get("error"),
                                 "period_id": doc.get("period_id"), "org_id": doc["org_id"]}
        elif op == "settle_orphans":
            # The quota ledger's sweep, for every reservation the first
            # process left OUTSTANDING (reserved, never committed or
            # released): `_settle_orphaned_reservation` — the function the
            # sweep hands each orphan to — and what the meter was told.
            outstanding = [dict(r) for r in gw.db.rows("document_quota_ledger")
                           if r.get("reserved_at") and not r.get("committed_at") and not r.get("released_at")]
            for row in outstanding:
                P._settle_orphaned_reservation(row)
            entry["outstanding"] = [r["document_id"] for r in outstanding]
            entry["committed"] = [list(x) for x in gw.meter.committed]
            entry["released"] = [list(x) for x in gw.meter.released]
        else:
            raise AssertionError("unknown step %r" % op)
        report["steps"].append(entry)
    with open(os.environ[R.ENV_OUT], "w", encoding="utf-8") as f:
        json.dump(report, f, default=str, ensure_ascii=False)
