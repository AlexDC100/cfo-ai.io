"""Post-deploy gate — EVERY stored period loads through the served path.

Owner ruling 2026-09-20: `check_deploy_drift.py` proves the FILES in the
container are the ones in git. Nothing proved the DATA still loads. This is the
same gate for data: after every deploy, every row of `financial_periods` is
requested through the REAL `GET /api/period/{id}` handler, and the deploy is
red if any of them errors.

What "the served path" means here
---------------------------------
The real router (`engine.api.pipeline.build_router`) is mounted on a FastAPI
app and called with an in-process client. Exactly two seams are swapped:

  * `_require_jwt`     → a constant (there is no browser session in a gate);
  * `_supabase.per_user` → the service-role client behind `ReadOnlyClient`.

Everything else — the selects, the assembly, the equity completion, the
envelope, the serialisation — is the production code path, unmodified.

READ-ONLY, enforced at the seam this gate owns: `ReadOnlyClient` forwards
`select` and refuses every other attribute, so a write attempted through the
request's client fails the gate instead of touching a customer's data. (A
helper that opened its OWN service-role client would not pass through this
proxy; `get_period` opens none today — the census test pins that.)

Exit codes: 0 every period served · 1 at least one period failed · 2 the gate
could not run or found NOTHING to check (a vacuous pass is a red, TC-2).

Usage (inside the backend container, §14 step 5):
    docker exec cfo-ai-backend python3 /app/scripts/check_served_periods.py
    ... --org <org_id>      one workspace only
    ... --limit 50          newest N periods only (prints that scope is partial)
    ... --json              machine-readable report on stdout
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "pyproject.toml").exists() and (parent / "src").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return
    raise SystemExit("check_served_periods: repo root (pyproject.toml) not found")


class ReadOnlyClient:
    """The service-role client, reduced to `select`. Anything else raises."""

    _ALLOWED = frozenset({"select"})

    def __init__(self, inner: Any) -> None:
        object.__setattr__(self, "_inner", inner)

    def __enter__(self) -> "ReadOnlyClient":
        enter = getattr(self._inner, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, *exc: Any) -> Any:
        leave = getattr(self._inner, "__exit__", None)
        return leave(*exc) if leave is not None else None

    def __getattr__(self, name: str) -> Any:
        if name in self._ALLOWED:
            return getattr(self._inner, name)
        raise PermissionError(
            f"served-periods gate is READ-ONLY: the served path called `{name}` during a GET"
        )

    def __setattr__(self, name: str, value: Any) -> None:
        raise PermissionError("served-periods gate is READ-ONLY")


Fetch = Callable[[str], Tuple[int, Any]]


def check_periods(periods: Iterable[Dict[str, Any]], fetch: Fetch) -> Dict[str, Any]:
    """Pure core: request every period, judge every answer. No I/O of its own."""
    rows = list(periods)
    failures: List[Dict[str, Any]] = []
    slowest: Tuple[float, str] = (0.0, "")
    for row in rows:
        pid = str(row.get("id") or "")
        started = time.monotonic()
        try:
            status, body = fetch(pid)
            problem = _judge(pid, status, body)
        except Exception as exc:  # noqa: BLE001 — a crash IS the finding
            problem = f"{type(exc).__name__}: {exc}"
            status = 0
        took = time.monotonic() - started
        if took > slowest[0]:
            slowest = (took, pid)
        if problem:
            failures.append({
                "period_id": pid,
                "org_id": row.get("org_id"),
                "label": row.get("period_label") or row.get("period_end"),
                "status": status,
                "problem": problem[:600],
            })
    return {
        "checked": len(rows),
        "orgs": len({r.get("org_id") for r in rows}),
        "failed": len(failures),
        "failures": failures,
        "slowest_seconds": round(slowest[0], 2),
        "slowest_period": slowest[1],
    }


def _judge(pid: str, status: int, body: Any) -> Optional[str]:
    if status != 200:
        detail = body.get("detail") if isinstance(body, dict) else body
        return f"HTTP {status}: {detail}"
    if not isinstance(body, dict):
        return f"served body is {type(body).__name__}, not an object"
    period = body.get("period")
    if not isinstance(period, dict) or str(period.get("id")) != pid:
        return "served body does not carry this period"
    return None


def exit_code(report: Dict[str, Any]) -> int:
    if report["checked"] == 0:
        return 2
    return 1 if report["failed"] else 0


def _list_periods(admin_factory: Callable[[], Any], org: Optional[str], limit: Optional[int]) -> List[Dict[str, Any]]:
    filters = {"org_id": f"eq.{org}"} if org else None
    out: List[Dict[str, Any]] = []
    page = 1000
    with admin_factory() as ac:
        ro = ReadOnlyClient(ac)
        offset = 0
        while True:
            want = page if limit is None else min(page, limit - len(out))
            if want <= 0:
                break
            f = dict(filters or {})
            f["offset"] = str(offset)
            rows = ro.select("financial_periods", filters=f, columns="id,org_id,period_label,period_end",
                             order="created_at.desc", limit=want)
            out.extend(rows)
            if len(rows) < want:
                break
            offset += len(rows)
    return out


def _served_fetch() -> Fetch:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.api import _supabase, pipeline

    pipeline._require_jwt = lambda authorization=None: "served-periods-gate"  # type: ignore[assignment]
    real_admin = _supabase.admin
    _supabase.per_user = lambda jwt: ReadOnlyClient(real_admin())  # type: ignore[assignment]

    app = FastAPI()
    app.include_router(pipeline.build_router())
    client = TestClient(app, raise_server_exceptions=False)

    def fetch(pid: str) -> Tuple[int, Any]:
        r = client.get(f"/api/period/{pid}", headers={"Authorization": "Bearer served-periods-gate"})
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, r.text[:600]

    return fetch


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--org")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    _add_src_to_path()
    try:
        from engine.api import _supabase
        periods = _list_periods(_supabase.admin, args.org, args.limit)
        report = check_periods(periods, _served_fetch())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("SERVED PERIODS: COULD NOT RUN — treat as RED")
        return 2

    report["scope"] = ("org " + args.org if args.org else "every org") + (
        f", newest {args.limit} only (PARTIAL)" if args.limit else ", every stored period")
    if args.json:
        print(json.dumps(report, indent=1, default=str))
    else:
        print(f"SERVED PERIODS — scope: {report['scope']}")
        print(f"  checked {report['checked']} periods across {report['orgs']} orgs; "
              f"slowest {report['slowest_seconds']}s ({report['slowest_period']})")
        for f in report["failures"]:
            print(f"  RED  {f['period_id']}  org {f['org_id']}  {f['label']}  → {f['problem']}")
        verdict = {0: "GREEN — every stored period serves", 1: f"RED — {report['failed']} period(s) fail to serve",
                   2: "RED — nothing to check (vacuous)"}[exit_code(report)]
        print(f"  {verdict}")
    return exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
