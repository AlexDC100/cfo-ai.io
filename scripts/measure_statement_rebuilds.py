#!/usr/bin/env python3
"""Count the periods whose statements cannot be rebuilt (plan/2 B5,
plan_contract_v2 1.4). READ-ONLY: it writes nothing, anywhere.

From B5, GET /api/forecast answers 409 {code: statements_rebuild_failed} on an
anchor whose statements do not rebuild, where it used to project off
statements None. From B13 those periods show the Scenarios refusal state
(20.1). This script says how many periods that is, before anyone ships it.

Modes
  default            the four corpus books, in process (no network)
  --local-xlsx PATH  plus one local trial balance (never committed; only the
                     count is printed)
  --live             every financial_periods row the OPERATOR credentials in
                     the environment can read (SUPABASE service credentials,
                     the same ones scripts/measure_bs_drift.py uses). The
                     owner runs this; no agent session does. Read-only
                     selects through engine.api._supabase.admin().

It runs engine.api.pipeline.load_period_rows over each period, counts
StatementsRebuildError by sentence, and prints the counts and period ids.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))


def _count(label: str, client: Any, period_ids: List[str], org_id: Optional[str],
           tally: Dict[str, List[str]]) -> Tuple[int, int]:
    from engine.api import pipeline
    ok = failed = 0
    for period_id in period_ids:
        try:
            pipeline.load_period_rows(client, period_id, org_id=org_id, rebuild=True)
            ok += 1
        except pipeline.StatementsRebuildError as exc:
            tally.setdefault(exc.text, []).append("%s:%s" % (label, period_id))
            failed += 1
        except pipeline.PeriodNotFound:
            tally.setdefault("period not readable", []).append("%s:%s" % (label, period_id))
            failed += 1
    return ok, failed


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--local-xlsx", type=Path, default=None)
    ap.add_argument("--live", action="store_true",
                    help="owner only: read every period the operator credentials can read")
    args = ap.parse_args(argv)
    os.environ.setdefault("CFO_AI_SKIP_BOOT_VERIFY", "1")
    import measure_plan_blast_radius as M

    tally = {}  # type: Dict[str, List[str]]
    total_ok = total_failed = 0
    if args.live:
        from engine.api import _supabase
        with _supabase.admin() as client:
            rows = client.select("financial_periods", columns="id") or []
            ok, failed = _count("live", client, [str(r["id"]) for r in rows], None, tally)
        print("live periods read %d: rebuilt %d, failed %d" % (len(rows), ok, failed))
        total_ok, total_failed = ok, failed
    else:
        books = [(name, M._corpus_book(name)) for name in M.BOOKS]
        if args.local_xlsx is not None:
            books.append(("local", M._local_book(args.local_xlsx)))
        for name, book in books:
            server = M._RowServer(book, "period", "org")
            ok, failed = _count(name, server, ["period"], "org", tally)
            print("%-10s rebuilt %d, failed %d" % (name, ok, failed))
            total_ok += ok
            total_failed += failed
    print("TOTAL rebuilt %d, StatementsRebuildError %d" % (total_ok, total_failed))
    for sentence in sorted(tally):
        print("  %d x %s" % (len(tally[sentence]), sentence))
        for period in tally[sentence][:50]:
            print("      %s" % period)
    print("nothing was written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
