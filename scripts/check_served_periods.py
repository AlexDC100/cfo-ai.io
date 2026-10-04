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
    ... --require-common-size
                            every period's body must ALSO carry a lawful
                            `statements.common_size` (schema common_size/1 —
                            the single-period share column, 2026-10-04). The
                            pre-flight for the image that first serves it; the
                            count of lawful blocks is printed either way.
                            Two shapes are NAMED, listed and not failures —
                            they are what the engine serves by design, and
                            the operator decides whether to ship beside them:
                              · block withheld: the period's re-assembly
                                produced no assembled P&L or balance sheet, so
                                the engine attaches no block (the page says
                                the shares are not available);
                              · no canonical balance-sheet rows: a period
                                with no canonical_bs gets the registry lines
                                only, so its balance-sheet tab has no share
                                to print.
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
    # Run from outside the tree (a temporary copy in /tmp during a baseline
    # capture): fine as long as the engine is importable via PYTHONPATH.
    try:
        import engine  # noqa: F401
    except ImportError:
        raise SystemExit("check_served_periods: repo root (pyproject.toml) not found and `engine` is not importable")


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


def credit_snapshot(body: Any) -> Dict[str, Any]:
    """The lender-facing verdict of one served body, for a before/after diff
    across a deploy (`--dump`). Reads what is served; computes nothing."""
    credit = ((body or {}).get("assembled_metrics") or {}).get("credit") if isinstance(body, dict) else None
    credit = credit if isinstance(credit, dict) else {}
    return {k: credit.get(k) for k in ("letter_grade", "composite_score", "altman_z_score", "model_revision")}


COMMON_SIZE_SCHEMA = "common_size/1"
_COMMON_SIZE_ROW_KEYS = ("key", "statement", "base_key", "current", "share", "status", "note")
_COMMON_SIZE_BASES = (("PL", "pl.revenue"), ("BS", "bs.total_assets"))
#: Every status a row may carry (engine.comparatives.shares.SIDE_STATUSES —
#: tests/engine/test_common_size_single.py holds the two equal). This script
#: runs before the engine is trusted, so it states the vocabulary itself.
COMMON_SIZE_STATUSES = ("share", "no_base", "margin_not_meaningful", "absent", "refused",
                        "not_disclosed_at_this_detail_level")
#: The key whose presence means the block carries the canonical
#: balance-sheet rows the balance-sheet tab prints.
_CANONICAL_BASE_KEY = "bs.total.assets"

#: The two named outcomes that are not failures (see the usage text).
WITHHELD_NO_ASSEMBLED = "block withheld: no assembled statements"
NO_CANONICAL_ROWS = "no canonical balance-sheet rows"


def common_size_withheld(body: Any) -> bool:
    """The body carries NO block and has no assembled P&L or balance sheet:
    the engine withholds the block there on purpose (a block built on a
    failed re-assembly would call every line "not reported"). A named
    outcome, not a failure — a body WITH both statements and no block is
    one."""
    statements = body.get("statements") if isinstance(body, dict) else None
    if not isinstance(statements, dict) or isinstance(statements.get("common_size"), dict):
        return False
    return not (isinstance(statements.get("assembled_pl"), dict)
                and isinstance(statements.get("assembled_bs"), dict))


def common_size_lacks_canonical_rows(body: Any) -> bool:
    """A lawful block with no canonical balance-sheet rows (the period has
    no canonical_bs): its balance-sheet tab has no share to print."""
    if common_size_problem(body) is not None:
        return False
    rows = body["statements"]["common_size"]["rows"]
    return not any(row.get("key") == _CANONICAL_BASE_KEY for row in rows)


def common_size_problem(body: Any) -> Optional[str]:
    """Why this served body's `statements.common_size` is not a lawful
    common_size/1 block — None when it is. Reads the block; computes nothing.

    The problem names keys and statuses, NEVER a figure: this output goes
    into a deploy log, and a customer's amounts do not."""
    statements = body.get("statements") if isinstance(body, dict) else None
    block = statements.get("common_size") if isinstance(statements, dict) else None
    if not isinstance(block, dict):
        return "no statements.common_size block"
    if block.get("schema") != COMMON_SIZE_SCHEMA:
        return "statements.common_size.schema is %r, not %r" % (block.get("schema"), COMMON_SIZE_SCHEMA)
    bases = block.get("bases")
    for statement, key in _COMMON_SIZE_BASES:
        base = bases.get(statement) if isinstance(bases, dict) else None
        if not isinstance(base, dict) or base.get("key") != key or "value" not in base:
            return "statements.common_size.bases.%s does not name %s" % (statement, key)
    rows = block.get("rows")
    if not isinstance(rows, list) or not rows:
        return "statements.common_size.rows is empty"
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != set(_COMMON_SIZE_ROW_KEYS):
            return "a statements.common_size row does not carry exactly %s" % (_COMMON_SIZE_ROW_KEYS,)
        if row["status"] not in COMMON_SIZE_STATUSES:
            return "row %s carries status %r, which is not one of %s" % (
                row["key"], row["status"], COMMON_SIZE_STATUSES)
        if row["key"] in seen:
            return "row %s appears twice (a key names one line)" % (row["key"],)
        seen.add(row["key"])
        if (row["share"] is not None) != (row["status"] == "share"):
            return "row %s carries a share under status %r (a share exists only under 'share')" % (
                row["key"], row["status"])
    return None


def check_periods(periods: Iterable[Dict[str, Any]], fetch: Fetch,
                  observe: Optional[Callable[[Dict[str, Any], int, Any], None]] = None,
                  require_common_size: bool = False) -> Dict[str, Any]:
    """Pure core: request every period, judge every answer. No I/O of its own."""
    rows = list(periods)
    failures: List[Dict[str, Any]] = []
    slowest: Tuple[float, str] = (0.0, "")
    with_common_size = 0
    withheld: List[str] = []
    no_canonical: List[str] = []
    for row in rows:
        pid = str(row.get("id") or "")
        started = time.monotonic()
        try:
            status, body = fetch(pid)
            problem = _judge(pid, status, body, require_common_size=require_common_size)
            if status == 200 and common_size_problem(body) is None:
                with_common_size += 1
            if status == 200 and common_size_withheld(body):
                withheld.append(pid)
            if status == 200 and common_size_lacks_canonical_rows(body):
                no_canonical.append(pid)
            if observe is not None:
                observe(row, status, body)
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
                "label": row.get("period_end"),
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
        # How many served bodies carry a lawful common_size/1 block — counted
        # on every run, required only under --require-common-size.
        "common_size": {
            "lawful": with_common_size, "required": bool(require_common_size),
            # The two named outcomes, by period id — never failures.
            "withheld": {"outcome": WITHHELD_NO_ASSEMBLED, "periods": withheld},
            "no_canonical_rows": {"outcome": NO_CANONICAL_ROWS, "periods": no_canonical},
        },
    }


def _judge(pid: str, status: int, body: Any, require_common_size: bool = False) -> Optional[str]:
    if status != 200:
        detail = body.get("detail") if isinstance(body, dict) else body
        return f"HTTP {status}: {detail}"
    if not isinstance(body, dict):
        return f"served body is {type(body).__name__}, not an object"
    period = body.get("period")
    if not isinstance(period, dict) or str(period.get("id")) != pid:
        return "served body does not carry this period"
    if require_common_size and not common_size_withheld(body):
        # A block the engine withholds by design is a NAMED outcome the
        # report lists, not a failure of the image under test.
        return common_size_problem(body)
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
            rows = ro.select("financial_periods", filters=f, columns="id,org_id,period_end",
                             order="period_end.desc,id.asc", limit=want)
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
    ap.add_argument("--dump", help="write one JSON line per period (id, org, status, served credit verdict) "
                                   "— run before and after a deploy and diff the two files")
    ap.add_argument("--require-common-size", action="store_true",
                    help="a period whose body carries no lawful statements.common_size "
                         "(schema common_size/1) is a failure")
    args = ap.parse_args(argv)

    _add_src_to_path()
    # THE IMAGE MUST BE ABLE TO BOOT (2026-09-20). This gate once printed GREEN
    # inside an image that could not start: packs/credit/model.yaml had not
    # been synced, the credit boundary failed CLOSED (every rating withheld,
    # every period still 200), and the container then crash-looped on
    # boot_verify for six minutes of production downtime. A gate that imports
    # the handlers without running the boot checks certifies an app that will
    # never serve. Older images without boot_verify skip this honestly.
    try:
        from engine import boot_verify
    except ImportError:
        boot_verify = None
    if boot_verify is not None and hasattr(boot_verify, "verify_config"):
        try:
            boot_verify.verify_config()
        except Exception as exc:  # noqa: BLE001
            print(f"SERVED PERIODS: RED — this image cannot boot: {exc}")
            return 2
    try:
        from engine.api import _supabase
        periods = _list_periods(_supabase.admin, args.org, args.limit)
        seen: List[Dict[str, Any]] = []
        report = check_periods(
            periods, _served_fetch(),
            observe=(lambda row, status, body: seen.append(
                {"period_id": row.get("id"), "org_id": row.get("org_id"), "status": status, **credit_snapshot(body)}))
            if args.dump else None,
            require_common_size=args.require_common_size,
        )
        if args.dump:
            with open(args.dump, "w", encoding="utf-8") as fh:
                for rec in sorted(seen, key=lambda r: str(r["period_id"])):
                    fh.write(json.dumps(rec, sort_keys=True, default=str) + "\n")
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
        print(f"  statements.common_size ({COMMON_SIZE_SCHEMA}) lawful on "
              f"{report['common_size']['lawful']} of {report['checked']} periods"
              + (" — REQUIRED" if args.require_common_size else ""))
        for name in ("withheld", "no_canonical_rows"):
            outcome = report["common_size"][name]
            if outcome["periods"]:
                print(f"  NOTE {outcome['outcome']} — {len(outcome['periods'])} period(s): "
                      + ", ".join(outcome["periods"]))
        for f in report["failures"]:
            print(f"  RED  {f['period_id']}  org {f['org_id']}  {f['label']}  → {f['problem']}")
        verdict = {0: "GREEN — every stored period serves", 1: f"RED — {report['failed']} period(s) fail to serve",
                   2: "RED — nothing to check (vacuous)"}[exit_code(report)]
        print(f"  {verdict}")
    return exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
