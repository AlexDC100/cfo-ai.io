#!/usr/bin/env python3
"""G4 on PRODUCTION DATA — no period without an analysed file behind it.

    python3 scripts/check_no_empty_periods.py                       # live, GET only
    python3 scripts/check_no_empty_periods.py --snapshot SNAP.json.gz   # a db_snapshot file
    python3 scripts/check_no_empty_periods.py --org <uuid> [--org …]    # only these workspaces

Owner rule (workspace redesign, 2026-09-21): a `financial_periods` row exists
only once an analysed source document backs it. Production carried rows with
no file behind them (a current-month row per workspace per month, a 2021,
"current month" rows) — minted by the browser, which no longer can
(tests/engine/test_no_empty_period_creators.py). This is the check an
operator runs against the data itself, before and after the workspace
migration, and after any deploy that touches uploads.

A period in a LIVE workspace (organizations.archived_at is null) is EMPTY
when — the same definition the migration planner archives by
(`engine.workspaces.migration_plan.empty_live_periods`, one authority):

  · it names no source document, or that document does not exist;
  · its source document is deleted (documents.deleted_at set);
  · its source document is not `analyzed`;
  · its source document sits in ANOTHER workspace;
  · nothing was persisted for it (no canonical envelope, no metric, no
    line item).

LIVE MODE reads through the service-role client and issues GET requests only
(`engine.workspaces.pgrest_io.PgRest`: every page, until PostgREST's exact
count — a response is silently capped at db-max-rows). It reads light columns
only: the envelope column is tested with `not.is.null`, never downloaded, and
metric / line-item rows are read only for the periods that have no envelope.

Output: one `EMPTY  <period_id>  <why>  org=<org_id> end=<period_end>` line per
offender, then a `CHECKED` line with what was examined.

Exit codes: 0 no empty period · 1 empty periods found · 2 nothing to check
(no live period at all — a vacuous pass is a red) or the check could not run.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return


_add_src_to_path()

from engine.workspaces import pgrest_io  # noqa: E402
from engine.workspaces.migration_plan import empty_live_periods  # noqa: E402

#: `in.(…)` lists are chunked so a URL stays well under proxy limits.
IN_CHUNK = 150


def _chunks(values: Sequence[str], size: int = IN_CHUNK) -> Iterable[List[str]]:
    for i in range(0, len(values), size):
        yield list(values[i:i + size])


def read_live(db: "pgrest_io.PgRest") -> Dict[str, List[Dict[str, Any]]]:
    """The tables `empty_live_periods` needs, light columns only, GET only."""
    orgs = db.select_all("organizations", ["id"], columns="id,archived_at")
    periods = db.select_all("financial_periods", ["id"],
                            columns="id,org_id,source_document_id,period_end")
    with_envelope = set(str(r["id"]) for r in db.select_all(
        "financial_periods", ["id"], columns="id",
        filters={"assembled_canonical_v1": "not.is.null"}))
    docs = db.select_all("documents", ["id"], columns="id,org_id,status,deleted_at")
    shaped = []  # type: List[Dict[str, Any]]
    for p in periods:
        row = {"id": p["id"], "org_id": p["org_id"], "source_document_id": p.get("source_document_id"),
               "period_end": p.get("period_end"),
               # A marker, not the envelope: presence is all the rule reads.
               "assembled_canonical_v1": True if str(p["id"]) in with_envelope else None}
        shaped.append(row)
    no_envelope = sorted(str(p["id"]) for p in shaped if not p["assembled_canonical_v1"])
    persisted = {"calculated_metrics": [], "statement_line_items": []}  # type: Dict[str, List[Dict[str, Any]]]
    for table in persisted:
        for chunk in _chunks(no_envelope):
            persisted[table] += db.select_all(table, ["id"], columns="id,period_id",
                                              filters={"period_id": pgrest_io._in_list(chunk)})
    return {"organizations": orgs, "financial_periods": shaped, "documents": docs,
            "calculated_metrics": persisted["calculated_metrics"],
            "statement_line_items": persisted["statement_line_items"]}


def check(tables: Mapping[str, List[Mapping[str, Any]]], *, orgs: Optional[Iterable[str]] = None,
          out: Callable[[str], None] = print) -> int:
    scope = set(orgs) if orgs else None
    live_orgs = set(str(o["id"]) for o in tables.get("organizations") or []
                    if not o.get("archived_at") and (scope is None or str(o["id"]) in scope))
    examined = [p for p in tables.get("financial_periods") or [] if str(p.get("org_id")) in live_orgs]
    offenders = empty_live_periods(tables, orgs=scope)
    by_id = dict((str(p["id"]), p) for p in examined)
    for pid, why in offenders:
        p = by_id.get(pid) or {}
        out("EMPTY  %s  %s  org=%s end=%s" % (pid, why, p.get("org_id"), str(p.get("period_end") or "")[:10]))
    out("CHECKED %d period(s) in %d live workspace(s): %d empty"
        % (len(examined), len(live_orgs), len(offenders)))
    if not examined:
        out("NOTHING TO CHECK — no period in a live workspace; a vacuous pass is not a pass")
        return 2
    return 1 if offenders else 0


def main(argv: Optional[Sequence[str]] = None, *, client_factory: Optional[Callable[[], Any]] = None,
         out: Callable[[str], None] = print) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", help="read a db_snapshot.py file instead of production")
    ap.add_argument("--org", action="append", default=[], help="only this workspace (repeatable)")
    args = ap.parse_args(list(argv) if argv is not None else None)

    if args.snapshot:
        try:
            tables = pgrest_io.snapshot_rows(pgrest_io.load_snapshot(args.snapshot))
        except Exception as exc:  # noqa: BLE001
            out("CANNOT RUN: %s" % exc)
            return 2
        return check(tables, orgs=args.org, out=out)

    if client_factory is None:
        from engine.api import _supabase
        client_factory = _supabase.admin
    client = client_factory()
    try:
        try:
            tables = read_live(pgrest_io.PgRest(client))
        except Exception as exc:  # noqa: BLE001
            out("CANNOT RUN: %s" % exc)
            return 2
        return check(tables, orgs=args.org, out=out)
    finally:
        close = getattr(client, "close", None)
        if close:
            close()


if __name__ == "__main__":
    sys.exit(main())
