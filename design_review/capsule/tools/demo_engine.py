#!/usr/bin/env python3
"""THE GROUNDED NUMERIC DEMO — the sidecar engine.

Serves the REAL `/api/period/{id}` and `/api/capsule/tools/*` routers over
a period built by running the REAL pipeline on a REAL trial balance. It
exists so the Capsule demo and the latency run talk to a live HTTP server
running production route code, rather than to a JSON file replayed by the
test driver.

  · the routers          `pipeline.build_router` and
                         `_capsule_tools.build_router` — the SAME factories
                         `server.create_app` includes. No reimplementation.
  · the data             `make_period_fixture.seed_store` — parse →
                         stage_persist → stage_compute on the real .xlsx.
  · Supabase             the in-memory store, bound at the `_supabase`
                         seam. Substituted; the NUMBERS never pass through
                         the substitution.
  · auth                 any bearer token resolves to the seeded org. This
                         box is bound to 127.0.0.1 and holds one period
                         built from a repo file.

NO MODEL. `sys.modules["anthropic"] = None` is installed by the importer
before the engine loads, so a model call raises ImportError instead of
costing a token.

Usage:
  .venv/bin/python design_review/capsule/tools/demo_engine.py --port 8010
"""
from __future__ import annotations

import argparse
import contextlib
import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from make_period_fixture import (  # noqa: E402
    ORG_ID, REPO, MemoryStore, bound_store, seed_store,
)


def repair_tool_body_binding() -> None:
    """Make `POST /api/capsule/tools/{name}` accept a request body.

    THIS IS A MEASUREMENT AID, NOT A FIX, and it is opt-in.

    `_capsule_tools.py:80` carries `from __future__ import annotations`, so
    every annotation in that module is a STRING. `build_router()` defines
    its `ToolCall` body model INSIDE the factory's closure, so when FastAPI
    evaluates the annotation `"ToolCall"` against the function's MODULE
    globals, the name is not there. FastAPI cannot see a Pydantic model,
    falls back to treating `body` as a plain QUERY parameter, and every
    well-formed call returns
    `422 {"loc": ["query", "body"], "msg": "Field required"}`.

    Publishing an unmeasured Tier-1 number is not an option, and neither is
    measuring a path that does not run. So the sidecar can be started BOTH
    ways: faithful (default — reproduces the 422 the shipped engine
    returns) and repaired (`--repair-tool-body`), which measures what the
    fact card WOULD cost once the defect is closed.

    The repair puts an EQUIVALENT `ToolCall` into the module namespace
    before `build_router()` runs, so the annotation resolves. Not one line
    of `_context`, `dispatch` or any tool is touched — only the parameter
    binding FastAPI got wrong.
    """
    from typing import Optional as _Optional

    from pydantic import BaseModel, Field

    from engine.api import _capsule_tools as ct

    class ToolCall(BaseModel):
        args: Dict[str, Any] = Field(default_factory=dict)
        period: _Optional[str] = None

    ct.ToolCall = ToolCall  # type: ignore[attr-defined]


def make_app(store: MemoryStore, period_id: str, repair: bool = False):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    from engine.api import _org, _supabase
    from engine.api import pipeline as _pipeline
    from engine.api._capsule_tools import build_router as capsule_router
    from engine.api.pipeline import build_router as period_router

    if repair:
        repair_tool_body_binding()

    @contextlib.contextmanager
    def _ctx(*_a, **_k):
        yield store

    # Bind every seam ONCE, for the life of the process — `bound_store` is
    # a context manager built for a single call, and a server outlives one.
    _supabase.admin = _ctx
    _supabase.per_user = _ctx
    _pipeline._supabase.admin = _ctx
    _pipeline._supabase.per_user = _ctx
    _pipeline._require_jwt = lambda *_a, **_k: "demo-jwt"
    _org.resolve_org = lambda *_a, **_k: ("demo-user", ORG_ID)
    _org.resolve_user_id = lambda *_a, **_k: "demo-user"

    app = FastAPI(title="capsule demo sidecar")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(period_router())
    app.include_router(capsule_router())

    @app.get("/__demo/period-id")
    def _period_id():
        return {"period_id": period_id, "org_id": ORG_ID,
                "tool_body_binding": "repaired" if repair else "as-shipped"}

    return app


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="files/prod_scandia_frozen_31.12.2025.xlsx")
    ap.add_argument("--company", default="Scandia Food SRL")
    ap.add_argument("--industry-key", default="food_manufacturing")
    ap.add_argument("--industry-display", default="Food & Beverage Manufacturing")
    ap.add_argument("--period-end", default="2025-12-31")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--repair-tool-body", action="store_true",
                    help="work around the closure/future-annotations body-binding "
                         "defect so the Tier-1 fact card can be measured at all; "
                         "OFF by default, so the sidecar reproduces the shipped 422")
    args = ap.parse_args()

    store, period_id, prov = seed_store(
        REPO / args.input, args.company, args.industry_key,
        args.industry_display, args.period_end)
    print("[demo-engine] seeded period %s from %s (sha256 %s…, %d rows)"
          % (period_id, prov["input_file"], prov["input_sha256"][:16],
             prov["trial_balance_rows"]), flush=True)

    import uvicorn
    print("[demo-engine] tool body binding: %s"
          % ("REPAIRED (measurement aid)" if args.repair_tool_body
             else "as-shipped (POST /api/capsule/tools/* will 422)"), flush=True)
    uvicorn.run(make_app(store, period_id, repair=args.repair_tool_body),
                host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
