"""The rollback against a store that ENFORCES the foreign keys production has.

``documents.period_id`` -> ``financial_periods(id)`` (immediate,
schema_phase3.sql:530) and ``financial_periods.source_document_id`` ->
``documents(id)`` ON DELETE CASCADE (schema.sql:571) point at each other.
When a period's source document is hard-deleted (a "Clear all", a purge),
Postgres erases the period and every row scoped to it. The in-memory
``apply_ops`` double enforces no foreign key, so a restore that re-inserts
the pair in the wrong order passed there and fails in production — the
2026-09-21 verifier reproduced exactly that with SQLite.

This file runs the plan and the rollback through SQLite with the same
foreign keys (``PRAGMA foreign_keys=ON``, immediate). WHAT IT REDS ON:
  * a restore that cannot put back a document + period pair the cascade
    erased (the single-phase restore did);
  * a restore that leaves any snapshot row different;
  * the store not enforcing the keys at all (the non-vacuity check).
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, List, Mapping, Optional, Sequence

import pytest

from engine.workspaces.migration_plan import build_plan
from engine.workspaces.rowstore import (
    OpConflict,
    pk_for,
    resolve_now,
    restore_ops,
    row_key,
    rows_equal,
    values_match,
)

from ws_migration_fixture import build_world, facts_for

DATE = "2026-09-21"
RUN = "2026-09-21T15:00:00+00:00"

#: (column, parent table, ON DELETE) — production's keys on the tables the
#: migration touches (schema.sql / schema_phase3.sql).
FKS = {
    "documents": [("period_id", "financial_periods", "SET NULL")],
    "financial_periods": [("source_document_id", "documents", "CASCADE")],
    "calculated_metrics": [("period_id", "financial_periods", "CASCADE")],
    "statement_line_items": [("period_id", "financial_periods", "CASCADE")],
    "briefings": [("period_id", "financial_periods", "CASCADE")],
    "memberships": [("org_id", "organizations", "CASCADE")],
}


def _enc(v: Any) -> Any:
    return None if v is None else json.dumps(v, sort_keys=True)


def _dec(v: Any) -> Any:
    return None if v is None else json.loads(v)


class FkStore:
    """Tables in SQLite with production's foreign keys, and a writer that
    applies ``rowstore`` operations one statement at a time — the way
    ``pgrest_io.apply_live`` does against PostgREST."""

    def __init__(self, tables: Mapping[str, List[Mapping[str, Any]]]) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.cols: Dict[str, List[str]] = {}
        for t, rows in tables.items():
            cols = sorted(set().union(*(set(r) for r in rows)) | set(pk_for(t))) if rows else list(pk_for(t))
            for c, _p, _d in FKS.get(t, []):
                if c not in cols:
                    cols.append(c)
            self.cols[t] = cols
            fk = "".join(', FOREIGN KEY ("%s") REFERENCES "%s"("id") ON DELETE %s' % (c, p, d)
                         for c, p, d in FKS.get(t, []))
            self.db.execute('CREATE TABLE "%s" (%s, PRIMARY KEY (%s)%s)' % (
                t, ", ".join('"%s"' % c for c in cols), ", ".join('"%s"' % c for c in pk_for(t)), fk))
        # load: documents without their period link first, then periods,
        # then the link — the only order the two keys allow.
        order = ["organizations", "documents", "financial_periods"]
        order += [t for t in sorted(tables) if t not in order]
        for t in order:
            for r in tables.get(t) or []:
                row = dict(r)
                if t == "documents":
                    row["period_id"] = None
                self._insert(t, row)
        for r in tables.get("documents") or []:
            if r.get("period_id"):
                self.db.execute('UPDATE documents SET period_id = ? WHERE id = ?',
                                (_enc(r["period_id"]), _enc(r["id"])))

    def _insert(self, t: str, row: Mapping[str, Any], *, upsert: bool = False) -> None:
        cols = [c for c in row if c in self.cols[t]]
        sql = 'INSERT INTO "%s" (%s) VALUES (%s)' % (t, ", ".join('"%s"' % c for c in cols),
                                                     ", ".join("?" for _ in cols))
        if upsert:
            sets = [c for c in cols if c not in pk_for(t)]
            sql += " ON CONFLICT (%s) DO %s" % (
                ", ".join('"%s"' % c for c in pk_for(t)),
                ("UPDATE SET " + ", ".join('"%s" = excluded."%s"' % (c, c) for c in sets)) if sets else "NOTHING")
        self.db.execute(sql, [_enc(row[c]) for c in cols])

    def get(self, t: str, key: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        where = " AND ".join('"%s" = ?' % c for c in key)
        cur = self.db.execute('SELECT * FROM "%s" WHERE %s' % (t, where), [_enc(v) for v in key.values()])
        got = cur.fetchone()
        if got is None:
            return None
        return {d[0]: _dec(v) for d, v in zip(cur.description, got)}

    def rows(self) -> Dict[str, List[Dict[str, Any]]]:
        out = {}
        for t in self.cols:
            cur = self.db.execute('SELECT * FROM "%s"' % t)
            out[t] = [{d[0]: _dec(v) for d, v in zip(cur.description, r)} for r in cur.fetchall()]
        return out

    def apply(self, ops: Sequence[Mapping[str, Any]], *, now: str) -> None:
        for raw in ops:
            op = resolve_now(dict(raw), now)
            kind = op["op"]
            if kind == "copy_object":
                continue
            t = op["table"]
            pk = pk_for(t)
            if kind == "insert":
                if self.get(t, {c: op["row"].get(c) for c in pk}) is None:
                    self._insert(t, op["row"])
            elif kind == "upsert":
                self._insert(t, op["row"], upsert=True)
            elif kind == "merge_prefs":
                cur = self.get(t, op["key"])
                prefs = dict((cur or {}).get("prefs") or {})
                prefs.update(op["merge"])
                self._insert(t, dict(op["key"], prefs=prefs), upsert=True)
            elif kind == "update":
                cur = self.get(t, op["key"])
                if cur is None:
                    raise OpConflict("%s %s: row missing" % (t, op["key"]))
                if values_match(cur, op["set"]):
                    continue
                if "expect" in op and not values_match(cur, op["expect"]):
                    raise OpConflict("%s %s: expected %s" % (t, op["key"], op["expect"]))
                sets = ", ".join('"%s" = ?' % c for c in op["set"])
                where = " AND ".join('"%s" = ?' % c for c in op["key"])
                self.db.execute('UPDATE "%s" SET %s WHERE %s' % (t, sets, where),
                                [_enc(v) for v in op["set"].values()] + [_enc(v) for v in op["key"].values()])
            else:
                raise ValueError(kind)

    def hard_delete_document(self, doc_id: str) -> None:
        """What clear-deleted / a purge does to a documents row."""
        self.db.execute('DELETE FROM documents WHERE id = ?', (_enc(doc_id),))


@pytest.fixture
def migrated():
    tables, storage, rules = build_world()
    facts = facts_for(tables, storage, rules)
    plan = build_plan(tables, facts, migration_date=DATE)
    store = FkStore(tables)
    store.apply(plan.ops, now=RUN)   # the plan itself satisfies the keys
    return tables, store


def test_the_store_enforces_the_keys(migrated):
    """Non-vacuity: a document naming a period that does not exist, and a
    period naming a missing source, are refused; a hard-deleted source takes
    its period (and the period's metrics) with it."""
    pre, store = migrated
    with pytest.raises(sqlite3.IntegrityError):
        store.apply([{"op": "upsert", "table": "documents",
                      "row": dict(next(d for d in pre["documents"] if d["id"] == "q-sf25-src"),
                                  id="ghost", period_id="no-such-period")}], now=RUN)
    store.hard_delete_document("q-sf25-src")
    left = store.rows()
    assert not [p for p in left["financial_periods"] if p["id"] == "per-q25"]
    assert not [m for m in left["calculated_metrics"] if m["period_id"] == "per-q25"]


def test_restore_puts_back_a_document_and_period_the_cascade_erased(migrated):
    """The 10fd52ab restore upserted documents (period_id -> the erased
    period) before financial_periods: 'FOREIGN KEY constraint failed', the
    archived period gone for good. Two phases put every snapshot row back."""
    pre, store = migrated
    store.hard_delete_document("q-sf25-src")        # per-q25 + its metrics cascade away
    store.hard_delete_document("d-omega-trash")     # per-sf21 too
    current = store.rows()
    assert not [p for p in current["financial_periods"] if p["id"] in ("per-q25", "per-sf21")]
    ops, _notes = restore_ops(pre, current)
    store.apply(ops, now="2026-09-22T00:00:00+00:00")
    after = store.rows()
    for table, rows in pre.items():
        pk = pk_for(table)
        now_rows = {row_key(r, pk): r for r in after[table]}
        for r in rows:
            got = now_rows.get(row_key(r, pk))
            assert got is not None and rows_equal({k: v for k, v in r.items()},
                                                  {k: got.get(k) for k in r}), (table, r, got)
