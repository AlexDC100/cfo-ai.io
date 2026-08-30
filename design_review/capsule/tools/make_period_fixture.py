#!/usr/bin/env python3
"""THE GROUNDED NUMERIC DEMO — the fixture producer.

Runs a REAL Romanian trial balance through the REAL engine and writes the
EXACT payload `GET /api/period/{id}` returns, so the Capsule demo can be
driven against a real number instead of a hand-typed one.

WHAT IS REAL HERE, STATED PRECISELY
-----------------------------------
  · the input               a real .xlsx trial balance from `files/`
  · the parse               RomaniaPack.parse_trial_balance (no AI)
  · the assemble            RomaniaPack.assemble_parsed_tb
  · the persist             pipeline.stage_persist, the production seam
  · the metrics             pipeline.stage_compute, the production seam
  · the response body       the REAL `get_period` route handler, reached
                            through FastAPI's TestClient against the REAL
                            app object — not a reimplementation of it

WHAT IS STOOD IN, AND ONLY THIS
-------------------------------
  · Supabase                an in-memory table store. `stage_persist` and
                            `get_period` both talk to it through the same
                            `_supabase.admin` / `_supabase.per_user` seam
                            they use in production. Nothing about the
                            NUMBERS passes through the substitution — the
                            store hands back exactly the rows the pipeline
                            wrote.
  · the JWT                 `_require_jwt` is bypassed. It gates access,
                            not arithmetic.

NO MODEL IS CONSULTED. `sys.modules["anthropic"] = None` for the whole run
(the ai-sentinel pattern from tests/engine/test_reconciliation.py), so any
attempt to reach a model raises ImportError instead of silently costing a
token. The narrate / council stages are never invoked.

Usage:
  .venv/bin/python design_review/capsule/tools/make_period_fixture.py \
      --input files/prod_scandia_frozen_31.12.2025.xlsx \
      --company "Scandia Food SRL" \
      --out design_review/capsule/fixtures/period-scandia-fy2025.json
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:8]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    raise SystemExit("could not locate repo root (no pyproject.toml)")


REPO = _repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# ── AI SENTINEL ────────────────────────────────────────────────────────
# Installed BEFORE the engine imports. Any real SDK import now raises
# ImportError rather than reaching the network. This producer is a
# deterministic-lane run; if a model is ever consulted the run dies loudly.
sys.modules["anthropic"] = None  # type: ignore[assignment]

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.api import pipeline as _pipeline  # noqa: E402
from engine.core.country_pack_registry import get_pack  # noqa: E402


PERIOD_ID = "3f2a1c88-0000-4000-8000-0000000c0ffe"  # uuid-shaped: the FE
# routes `?period=<uuid>` through fetchPeriodFromApi rather than the
# sample resolver, which is the whole point — the demo must exercise the
# real network path, not the demo-sample path.
ORG_ID = "3f2a1c88-0000-4000-8000-0000000000aa"
DOC_ID = "3f2a1c88-0000-4000-8000-0000000000bb"


class MemoryStore:
    """An in-memory stand-in for Supabase, driven through the SAME
    `select/insert/update/delete` surface `stage_persist`, `stage_compute`
    and `get_period` all use. It stores rows verbatim: whatever the
    pipeline writes is exactly what the endpoint reads back."""

    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {}

    # -- helpers --------------------------------------------------------
    def _rows(self, table: str) -> List[Dict[str, Any]]:
        return self.tables.setdefault(table, [])

    @staticmethod
    def _match(row: Dict[str, Any], filters: Optional[Dict[str, Any]]) -> bool:
        for key, raw in (filters or {}).items():
            value = str(raw)
            if value.startswith("eq."):
                if str(row.get(key)) != value[3:]:
                    return False
            elif value == "is.null":
                if row.get(key) is not None:
                    return False
            elif value == "not.is.null":
                if row.get(key) is None:
                    return False
            elif value.startswith("in."):
                allowed = value[3:].strip("()").split(",")
                if str(row.get(key)) not in allowed:
                    return False
            else:  # an operator this producer has not needed yet
                raise NotImplementedError(
                    "MemoryStore filter %r=%r not supported" % (key, raw)
                )
        return True

    # -- the client surface --------------------------------------------
    def select(self, table: str, *, filters: Optional[Dict[str, Any]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False):
        out = [copy.deepcopy(r) for r in self._rows(table) if self._match(r, filters)]
        if limit is not None:
            out = out[:limit]
        return out

    def insert(self, table: str, rows: Any, returning: bool = True):
        rows_list = rows if isinstance(rows, list) else [rows]
        stored = []
        for row in rows_list:
            new = copy.deepcopy(dict(row))
            if "id" not in new:
                if table == "financial_periods":
                    new["id"] = PERIOD_ID
                else:
                    new["id"] = "%s-%d" % (table, len(self._rows(table)) + 1)
            self._rows(table).append(new)
            stored.append(copy.deepcopy(new))
        return stored if returning else []

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Optional[Dict[str, Any]] = None) -> None:
        for row in self._rows(table):
            if self._match(row, filters):
                row.update(copy.deepcopy(patch))

    def delete(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> None:
        keep = [r for r in self._rows(table) if not self._match(r, filters)]
        self.tables[table] = keep

    def upsert(self, table: str, rows: Any, *, on_conflict: str = "",
               returning: bool = True):
        return self.insert(table, rows, returning=returning)


@contextlib.contextmanager
def bound_store(store: MemoryStore):
    """Point every Supabase seam the pipeline and the endpoint use at the
    in-memory store, and bypass the JWT gate."""
    from engine.api import _supabase as sb

    @contextlib.contextmanager
    def _ctx(*_a: Any, **_k: Any):
        yield store

    saved = {
        "admin": sb.admin,
        "per_user": sb.per_user,
        "p_admin": getattr(_pipeline._supabase, "admin", None),
        "p_per_user": getattr(_pipeline._supabase, "per_user", None),
        "require_jwt": getattr(_pipeline, "_require_jwt", None),
    }
    sb.admin = _ctx
    sb.per_user = _ctx
    _pipeline._supabase.admin = _ctx
    _pipeline._supabase.per_user = _ctx
    _pipeline._require_jwt = lambda *_a, **_k: "fixture-jwt"
    try:
        yield
    finally:
        sb.admin = saved["admin"]
        sb.per_user = saved["per_user"]
        if saved["p_admin"] is not None:
            _pipeline._supabase.admin = saved["p_admin"]
        if saved["p_per_user"] is not None:
            _pipeline._supabase.per_user = saved["p_per_user"]
        if saved["require_jwt"] is not None:
            _pipeline._require_jwt = saved["require_jwt"]


def seed_store(input_path: Path, company: str, industry_key: str,
               industry_display: str, period_end: str):
    """Run the REAL pipeline over `input_path` and return
    `(store, period_id, provenance)`. Shared by the fixture writer and the
    sidecar server so both serve byte-identical state."""
    content = input_path.read_bytes()
    pack = get_pack("RO")

    tb_rows = pack.parse_trial_balance(content, input_path.name)
    source_format = (dict(getattr(tb_rows, "extraction", {}) or {})
                     .get("source_format"))
    _tb, shaped, assembled = pack.assemble_parsed_tb(
        tb_rows, company_name=company, period_label=period_end,
    )

    doc = {
        "id": DOC_ID,
        "org_id": ORG_ID,
        "original_filename": input_path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": period_end,
    }
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows),
    )

    store = MemoryStore()
    store.insert("organizations", [{
        "id": ORG_ID, "name": company,
        "industry_key": industry_key,
        "industry_display_name": industry_display,
    }])
    store.insert("documents", [{
        "id": DOC_ID, "org_id": ORG_ID,
        "original_filename": input_path.name,
        "filename": input_path.name,
        "status": "analyzed",
        "detected_type": "trial_balance",
    }])

    with bound_store(store):
        period_id = _pipeline.stage_persist(doc, parsed, assembled)
        metrics = _pipeline.stage_compute(doc, assembled, period_id)

    provenance = {
        "produced_by": "design_review/capsule/tools/make_period_fixture.py",
        "input_file": str(input_path.relative_to(REPO)),
        "input_sha256": hashlib.sha256(content).hexdigest(),
        "input_bytes": len(content),
        "source_format_detected": source_format,
        "trial_balance_rows": len(list(tb_rows)),
        "metrics_computed": len(metrics),
        "company": company,
        "period_end": period_end,
        "period_id": period_id,
        "model_consulted": False,
    }
    return store, period_id, provenance


def build(input_path: Path, company: str, industry_key: str,
          industry_display: str, period_end: str) -> Dict[str, Any]:
    """The `/api/period/{id}` payload, produced by the REAL route handler
    mounted from the REAL router factory (`pipeline.build_router` is what
    `server.create_app` includes) — not by a reimplementation of it."""
    store, period_id, provenance = seed_store(
        input_path, company, industry_key, industry_display, period_end)
    with bound_store(store):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from engine.api.pipeline import build_router as create_pipeline_router

        app = FastAPI()
        app.include_router(create_pipeline_router())
        client = TestClient(app)
        res = client.get("/api/period/%s" % period_id,
                         headers={"Authorization": "Bearer fixture-jwt"})
        if res.status_code != 200:
            raise SystemExit("GET /api/period returned %d: %s"
                             % (res.status_code, res.text[:400]))
        payload = res.json()
    payload["_fixture_provenance"] = provenance
    return payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--company", required=True)
    ap.add_argument("--industry-key", default="food_manufacturing")
    ap.add_argument("--industry-display", default="Food & Beverage Manufacturing")
    ap.add_argument("--period-end", default="2025-12-31")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    payload = build(
        (REPO / args.input) if not Path(args.input).is_absolute() else Path(args.input),
        args.company, args.industry_key, args.industry_display, args.period_end,
    )
    out = (REPO / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False,
                              sort_keys=True, allow_nan=False) + "\n",
                   encoding="utf-8")

    prov = payload["_fixture_provenance"]
    st = payload.get("statements") or {}
    print("wrote %s (%.1f KB)" % (out, out.stat().st_size / 1024))
    print("  input          %s" % prov["input_file"])
    print("  sha256         %s" % prov["input_sha256"][:32])
    print("  parser         %s" % prov["source_format_detected"])
    print("  tb rows        %s" % prov["trial_balance_rows"])
    print("  metrics        %s" % prov["metrics_computed"])
    print("  currency       %s" % st.get("currency"))
    cbs = (st.get("canonical_bs") or {})
    print("  canonical_bs   status=%s difference=%s"
          % (cbs.get("status"), cbs.get("difference")))
    meth = ((st.get("assembled_canonical_v1") or {}).get("methodology") or {})
    ebitda = meth.get("ebitda")
    print("  methodology    revenue_net=%s ebitda.reported=%s"
          % ((meth.get("totals") or {}).get("revenue_net"),
             ebitda.get("reported") if isinstance(ebitda, dict) else ebitda))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
