"""Row-level vocabulary shared by the snapshot, the restore and the planner.

PURE. Tables are ``{table_name: [row_dict, ...]}``; a row is identified by
its primary key (``pk_for``). Everything that CHANGES rows is expressed as
a list of operations (dicts), so the same list can be

  * printed and reviewed (the dry-run),
  * applied to an in-memory copy of the tables (``apply_ops`` — the
    planner's own simulation, and the tests' "post-state"),
  * applied to production by ``scripts/workspace_migration.py`` /
    ``scripts/db_restore.py``, which read each row before writing it.

OPERATIONS
----------
``{"op": "insert", "table": T, "row": {...}}``
    create the row unless a row with its primary key exists (then no-op).
``{"op": "merge_prefs", "table": T, "key": {...}, "merge": {...}}``
    ``prefs`` jsonb merge (``{**old, **merge}``); creates the row if absent.
``{"op": "update", "table": T, "key": {...}, "set": {...}, "expect": {...}}``
    set columns on one existing row. ``expect`` holds the values the plan
    saw; a writer that finds neither ``expect`` nor ``set`` in place stops
    (someone else changed the row since the plan).
``{"op": "upsert", "table": T, "row": {...}}``
    put the whole row back (restore only) — or, for a bag row created
    since the snapshot on an owner the snapshot had, its key and an empty
    bag (``EMPTY_BAGS``).
``{"op": "copy_object", "bucket": B, "from_path", "from_org", "to_path",
  "to_org", "document_id", "content_type", "expect_sha256"}``
    copy a storage object to another org's prefix. No row effect; the old
    object is never deleted. ``expect_sha256`` (when the plan's facts pass
    read the object) is what the copy must find and write: a source that is
    gone or different by then stops the run before any row moves.

The value ``"$now"`` in an operation is replaced by the run's timestamp,
so a plan is free of clocks and two plans of the same state compare equal.
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

NOW = "$now"

#: Primary keys that are not ``id``. Everything else is keyed by ``id``.
#: The snapshot stores the key it used per table; this is the fallback
#: when PostgREST's OpenAPI does not mark one.
KNOWN_PKS: Dict[str, Tuple[str, ...]] = {
    "memberships": ("org_id", "user_id"),
    "org_prefs": ("org_id",),
    "user_prefs": ("user_id",),
    "alert_states": ("alert_id",),
    "user_valuation_assumptions": ("user_id", "period_id"),
    "org_coa_mappings_overrides": ("org_id", "coa_key", "account_code"),
    "plan_chat_daily_usage": ("user_id", "day"),
    "detection_opus_cache": ("ocr_hash",),
}

#: Columns a database trigger rewrites on every UPDATE; never compared.
VOLATILE_COLUMNS = frozenset({"updated_at"})

#: Restore order: rows others point at come first. ``documents`` and
#: ``financial_periods`` point at EACH OTHER with immediate foreign keys
#: (``documents.period_id`` -> financial_periods, schema_phase3.sql:530;
#: ``financial_periods.source_document_id`` -> documents ON DELETE CASCADE,
#: schema.sql:571): ``restore_ops`` breaks the cycle in two phases. Parents
#: of other tables' rows (alerts <- alert_states, sales_datasets <- sku_*)
#: come before the alphabetical rest.
TABLE_ORDER = (
    "organizations", "memberships", "org_prefs", "user_prefs",
    "documents", "financial_periods", "alerts", "sales_datasets",
)


def pk_for(table: str, pks: Optional[Mapping[str, Sequence[str]]] = None) -> Tuple[str, ...]:
    if pks and table in pks and pks[table]:
        return tuple(pks[table])
    return KNOWN_PKS.get(table, ("id",))


def row_key(row: Mapping[str, Any], pk: Sequence[str]) -> Tuple[str, ...]:
    return tuple("" if row.get(c) is None else str(row.get(c)) for c in pk)


def key_dict(row: Mapping[str, Any], pk: Sequence[str]) -> Dict[str, Any]:
    return {c: row.get(c) for c in pk}


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def sorted_rows(rows: Iterable[Mapping[str, Any]], pk: Sequence[str]) -> List[Mapping[str, Any]]:
    return sorted(rows, key=lambda r: row_key(r, pk))


def table_sha256(rows: Iterable[Mapping[str, Any]], pk: Sequence[str],
                 ignore: Iterable[str] = ()) -> str:
    """Order-independent digest of a table's rows (sorted by primary key)."""
    skip = set(ignore)
    h = hashlib.sha256()
    for r in sorted_rows(rows, pk):
        h.update(canonical_json({k: v for k, v in r.items() if k not in skip}).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def index_rows(rows: Iterable[Mapping[str, Any]], pk: Sequence[str]) -> Dict[Tuple[str, ...], Dict[str, Any]]:
    return {row_key(r, pk): dict(r) for r in rows}


def resolve_now(value: Any, now: str) -> Any:
    if isinstance(value, str) and value == NOW:
        return now
    if isinstance(value, dict):
        return {k: resolve_now(v, now) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_now(v, now) for v in value]
    return value


def rows_equal(a: Mapping[str, Any], b: Mapping[str, Any],
               ignore: Iterable[str] = VOLATILE_COLUMNS) -> bool:
    skip = set(ignore)
    ka = {k for k in a if k not in skip}
    kb = {k for k in b if k not in skip}
    if ka != kb:
        return False
    return all(canonical_json(a[k]) == canonical_json(b[k]) for k in ka)


def values_match(row: Mapping[str, Any], wanted: Mapping[str, Any]) -> bool:
    """Every column of ``wanted`` holds that value in ``row`` (timestamps
    compared as instants, so ``...+00:00`` and ``...Z`` agree)."""
    for col, val in wanted.items():
        if not same_value(row.get(col), val):
            return False
    return True


def same_value(a: Any, b: Any) -> bool:
    if canonical_json(a) == canonical_json(b):
        return True
    if isinstance(a, str) and isinstance(b, str):
        from datetime import datetime
        try:
            da = datetime.fromisoformat(a.replace("Z", "+00:00"))
            db = datetime.fromisoformat(b.replace("Z", "+00:00"))
        except ValueError:
            return False
        return da == db
    return False


class OpConflict(RuntimeError):
    """A row is not in the state the plan saw (someone changed it)."""


def apply_ops(tables: Mapping[str, List[Mapping[str, Any]]], ops: Sequence[Mapping[str, Any]], *,
              now: str, pks: Optional[Mapping[str, Sequence[str]]] = None,
              strict: bool = True) -> Dict[str, List[Dict[str, Any]]]:
    """A NEW copy of ``tables`` with ``ops`` applied (the input is untouched).

    ``strict``: an ``update`` whose row is missing, or whose row holds
    neither ``expect`` nor ``set``, raises ``OpConflict`` — exactly what the
    production writer does."""
    out: Dict[str, List[Dict[str, Any]]] = {t: [dict(r) for r in rows] for t, rows in tables.items()}
    idx: Dict[str, Dict[Tuple[str, ...], Dict[str, Any]]] = {}

    def _index(table: str) -> Dict[Tuple[str, ...], Dict[str, Any]]:
        if table not in idx:
            pk = pk_for(table, pks)
            out.setdefault(table, [])
            idx[table] = {row_key(r, pk): r for r in out[table]}
        return idx[table]

    for raw in ops:
        op = resolve_now(copy.deepcopy(dict(raw)), now)
        kind = op["op"]
        if kind == "copy_object":
            continue
        table = op["table"]
        pk = pk_for(table, pks)
        ix = _index(table)
        if kind == "insert":
            key = row_key(op["row"], pk)
            if key not in ix:
                row = dict(op["row"])
                out[table].append(row)
                ix[key] = row
        elif kind == "upsert":
            key = row_key(op["row"], pk)
            if key in ix:
                ix[key].clear()
                ix[key].update(op["row"])
            else:
                row = dict(op["row"])
                out[table].append(row)
                ix[key] = row
        elif kind == "merge_prefs":
            key = row_key(op["key"], pk)
            if key in ix:
                prefs = dict(ix[key].get("prefs") or {})
                prefs.update(op["merge"])
                ix[key]["prefs"] = prefs
            else:
                row = dict(op["key"])
                row["prefs"] = dict(op["merge"])
                out[table].append(row)
                ix[key] = row
        elif kind == "update":
            key = row_key(op["key"], pk)
            row = ix.get(key)
            if row is None:
                if strict:
                    raise OpConflict("%s %s: row missing" % (table, key))
                continue
            if values_match(row, op["set"]):
                continue
            if strict and "expect" in op and not values_match(row, op["expect"]):
                raise OpConflict("%s %s: expected %s, found %s" % (
                    table, key, canonical_json(op["expect"]),
                    canonical_json({c: row.get(c) for c in op["expect"]})))
            row.update(op["set"])
        else:
            raise ValueError("unknown op %r" % kind)
    return out


# ── restore ────────────────────────────────────────────────────────────

#: Key/value bags whose row the app reads the same whether it is absent or
#: its bag is empty (frontend/lib/prefs.ts hydrateOrgPrefs: no org_prefs
#: row -> ``{}``). ``table: (bag column, owner table, owner column)``. A row
#: holding nothing but an empty bag EQUALS no row — which is what lets a
#: restore undo a row the migration CREATED without deleting it.
EMPTY_BAGS: Dict[str, Tuple[str, str, str]] = {
    "org_prefs": ("prefs", "organizations", "org_id"),
}


def is_empty_bag(table: str, row: Mapping[str, Any], pk: Sequence[str]) -> bool:
    """``row`` of an ``EMPTY_BAGS`` table carries nothing (its bag is
    ``{}`` / NULL and every other non-key column is NULL)."""
    spec = EMPTY_BAGS.get(table)
    if spec is None:
        return False
    for col, val in row.items():
        if col in pk or col in VOLATILE_COLUMNS:
            continue
        if col == spec[0]:
            if val not in (None, {}):
                return False
        elif val is not None:
            return False
    return True


def stamped_bags(snapshot: Mapping[str, List[Mapping[str, Any]]],
                 current: Mapping[str, List[Mapping[str, Any]]], *,
                 pks: Optional[Mapping[str, Sequence[str]]] = None,
                 tables: Optional[Iterable[str]] = None) -> List[Tuple[str, Dict[str, Any], List[str]]]:
    """(table, key, bag keys) of every bag row CREATED since the snapshot
    for an owner the snapshot already had (a workspace that existed before
    the migration) that still carries something. The migration's identity
    stamp (``org_prefs.prefs = {cui, company_name, identity_sources}``) on
    a pre-existing workspace is exactly this — and rule 1 of the next plan
    reads it before anything else, so a rollback that leaves it brings the
    identity it was rolled back for straight back."""
    names = list(tables) if tables is not None else sorted(snapshot)
    out: List[Tuple[str, Dict[str, Any], List[str]]] = []
    for t in names:
        spec = EMPTY_BAGS.get(t)
        if spec is None:
            continue
        bag, owner_table, owner_col = spec
        owners = {str(r.get("id")) for r in snapshot.get(owner_table) or []}
        pk = pk_for(t, pks)
        snap = index_rows(snapshot.get(t) or [], pk)
        for r in sorted_rows(current.get(t) or [], pk):
            if row_key(r, pk) in snap or str(r.get(owner_col)) not in owners or is_empty_bag(t, r, pk):
                continue
            out.append((t, key_dict(r, pk), sorted((r.get(bag) or {}).keys())))
    return out


def restore_diff(snapshot: Mapping[str, List[Mapping[str, Any]]],
                 current: Mapping[str, List[Mapping[str, Any]]], *,
                 pks: Optional[Mapping[str, Sequence[str]]] = None,
                 tables: Optional[Iterable[str]] = None) -> Dict[str, Dict[str, Any]]:
    """Per table: rows whose current state differs from the snapshot
    (``changed`` — with the differing columns), rows the snapshot has and
    production lost (``missing``), rows production has that the snapshot
    does not (``created``). A row of an ``EMPTY_BAGS`` table that carries
    nothing equals an absent row, on either side."""
    names = list(tables) if tables is not None else sorted(snapshot)
    out: Dict[str, Dict[str, Any]] = {}
    for t in names:
        pk = pk_for(t, pks)
        snap = index_rows(snapshot.get(t) or [], pk)
        cur = index_rows(current.get(t) or [], pk)
        changed = []
        for k, srow in snap.items():
            crow = cur.get(k)
            if crow is None or rows_equal(srow, crow):
                continue
            cols = sorted({c for c in set(srow) | set(crow) if c not in VOLATILE_COLUMNS
                           and canonical_json(srow.get(c)) != canonical_json(crow.get(c))})
            changed.append({"key": key_dict(srow, pk), "columns": {
                c: {"now": crow.get(c), "snapshot": srow.get(c)} for c in cols}})
        missing = [key_dict(snap[k], pk) for k in sorted(snap)
                   if k not in cur and not is_empty_bag(t, snap[k], pk)]
        created = [key_dict(cur[k], pk) for k in sorted(cur)
                   if k not in snap and not is_empty_bag(t, cur[k], pk)]
        out[t] = {"changed": changed, "missing": missing, "created": created}
    return out


#: How a row CREATED after the snapshot is archived — never deleted. Tables
#: without an archive column are reported and left in place.
ARCHIVE_CREATED = {
    "organizations": ({"archived_at": NOW, "purge_after": None}, "archived_at"),
    "documents": ({"deleted_at": NOW, "error": "archived: created after the snapshot"}, "deleted_at"),
}


def restore_ops(snapshot: Mapping[str, List[Mapping[str, Any]]],
                current: Mapping[str, List[Mapping[str, Any]]], *,
                pks: Optional[Mapping[str, Sequence[str]]] = None,
                tables: Optional[Iterable[str]] = None) -> Tuple[List[Dict[str, Any]], List[str]]:
    """(operations, notes) that put ``tables`` back to the snapshot.

    TWO PHASES for the documents <-> financial_periods cycle: a document
    whose snapshot ``period_id`` names a period production no longer has
    (a period erased by ON DELETE CASCADE with its source) is put back with
    ``period_id`` NULL, the periods are put back (their source documents
    now exist), and only then is each such ``period_id`` set — every
    statement satisfies both immediate foreign keys.

    A bag row (``EMPTY_BAGS``) created since the snapshot for an owner the
    snapshot already had is put back to its empty bag — never deleted:
    an empty bag is what the app reads for no row at all. The one the
    migration writes is the identity stamp on a pre-existing workspace, and
    leaving it made the next plan decide that workspace's company from the
    very stamp the rollback was meant to undo (verifier, 2026-09-21)."""
    names = list(tables) if tables is not None else sorted(snapshot)
    ordered = [t for t in TABLE_ORDER if t in names] + sorted(t for t in names if t not in TABLE_ORDER)
    diff = restore_diff(snapshot, current, pks=pks, tables=ordered)
    ops: List[Dict[str, Any]] = []
    notes: List[str] = []
    period_pk = pk_for("financial_periods", pks)
    periods_now = {row_key(r, period_pk) for r in current.get("financial_periods") or []}
    relink: List[Dict[str, Any]] = []
    for t in ordered:
        pk = pk_for(t, pks)
        snap = index_rows(snapshot.get(t) or [], pk)
        cur = index_rows(current.get(t) or [], pk)
        for key in [ch["key"] for ch in diff[t]["changed"]] + list(diff[t]["missing"]):
            row = dict(snap[row_key(key, pk)])
            if t == "documents" and row.get("period_id") is not None \
                    and (str(row["period_id"]),) not in periods_now:
                relink.append({"op": "update", "table": t, "key": key_dict(row, pk),
                               "set": {"period_id": row["period_id"]}, "expect": {"period_id": None}})
                row["period_id"] = None
            ops.append({"op": "upsert", "table": t, "row": row})
        if t == "financial_periods" or (t == "documents" and "financial_periods" not in ordered):
            ops.extend(relink)
            relink = []
        bag = EMPTY_BAGS.get(t)
        owners = {str(r.get("id")) for r in snapshot.get(bag[1]) or []} if bag else set()
        for key in diff[t]["created"]:
            row = cur[row_key(key, pk)]
            if bag and str(row.get(bag[2])) in owners:
                ops.append({"op": "upsert", "table": t, "row": dict(key_dict(row, pk), **{bag[0]: {}})})
                notes.append("%s %s created after the snapshot for a pre-existing %s: emptied (%s)"
                             % (t, canonical_json(key), bag[2], ", ".join(sorted((row.get(bag[0]) or {}).keys()))))
                continue
            rule = ARCHIVE_CREATED.get(t)
            if rule is None:
                notes.append("%s %s created after the snapshot: no archive column, left in place"
                             % (t, canonical_json(key)))
                continue
            patch, marker = rule
            if row.get(marker):
                continue
            ops.append({"op": "update", "table": t, "key": dict(key), "set": dict(patch),
                        "expect": {c: row.get(c) for c in patch}})
    return ops, notes
