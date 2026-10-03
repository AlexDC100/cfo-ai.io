#!/usr/bin/env python3
"""What the shared SQLite store holds — COUNTS AND COLUMN NAMES ONLY.

    docker exec cfo-ai-backend python3 /app/scripts/check_public_store.py
    python3 scripts/check_public_store.py --db path/to/engine.db

Owner ticket 2026-10-02 ("confirm the shared SQLite store holds no real user
data"; CLAUDE.md §27). Opens ``engine.db`` READ-ONLY (``mode=ro``: it cannot
create the file, a table or a journal) and prints, per table, the row count,
the column names and the date range of its rows — never a row, a name, an
address, a SKU or a figure. The file is not copied anywhere.

Exit 0: every table that may hold nothing is empty. Exit 3: a table holds
rows the rule says it should not (see ``EXPECT_EMPTY``) — read the counts,
decide, clear with the operator's own hand. Exit 2: the file or a table is
missing (the store is not the one this script knows).
"""

from __future__ import annotations

import argparse
import sqlite3
import sys

DEFAULT_DB = "/app/data/engine.db"

#: table -> the column that dates a row (None: the table carries no date).
TABLES = {
    "recommendations": "created_at",
    "session_log": "first_seen",
    "chat_messages": "created_at",
    "daily_decisions": "run_date",
    "category_metrics": "snapshot_date",
    "master_skus": None,
}

#: Tables no code path of the product writes for a customer. A row in one of
#: them on cfo-ai.io was put there by a direct caller of a public route
#: before 2026-10-02 (recommendations), by the dead identity roster
#: (session_log), or by an operator's own run of the legacy SKU engine.
EXPECT_EMPTY = ("recommendations", "chat_messages", "daily_decisions",
                "category_metrics", "master_skus")


def main(argv=None):  # type: (object) -> int
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=DEFAULT_DB)
    args = ap.parse_args(argv)

    try:
        con = sqlite3.connect("file:%s?mode=ro" % args.db, uri=True)
        present = [r[0] for r in con.execute(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1")]
    except sqlite3.Error as exc:
        print("RED — cannot open %s read-only: %s" % (args.db, exc))
        return 2

    status = 0
    unknown = sorted(set(present) - set(TABLES))
    missing = sorted(set(TABLES) - set(present))
    if unknown or missing:
        print("RED — the store's tables are not the six this script knows: "
              "unknown=%s missing=%s" % (unknown, missing))
        status = 2

    print("%-18s %8s  %-24s %s" % ("table", "rows", "dated (min .. max)", "columns"))
    for table in present:
        count = con.execute('select count(*) from "%s"' % table).fetchone()[0]
        cols = [c[1] for c in con.execute('pragma table_info("%s")' % table)]
        dated = TABLES.get(table)
        span = "—"
        if dated and count:
            lo, hi = con.execute('select min("%s"), max("%s") from "%s"' % (dated, dated, table)).fetchone()
            span = "%s .. %s" % (str(lo)[:10], str(hi)[:10])
        print("%-18s %8d  %-24s %s" % (table, count, span, ",".join(cols)))
        if table in EXPECT_EMPTY and count and status == 0:
            status = 3

    if "recommendations" in present:
        print("recommendations by status: %s" % dict(con.execute(
            "select status, count(*) from recommendations group by 1 order by 1").fetchall()))
        print("recommendations distinct target_id: %d, with an owner set: %d" % con.execute(
            "select count(distinct target_id), count(owner) from recommendations").fetchone())
    if "session_log" in present:
        print("session_log distinct names: %d, distinct addresses: %d, last seen: %s" % con.execute(
            "select count(distinct name), count(distinct ip), coalesce(substr(max(last_seen), 1, 10), '—') "
            "from session_log").fetchone())
    con.close()

    print("")
    if status == 0:
        print("GREEN — every table that may hold nothing is empty.")
    elif status == 3:
        print("ROWS PRESENT — a table that should be empty is not. Counts only "
              "above; nothing was changed.")
    return status


if __name__ == "__main__":
    sys.exit(main())
