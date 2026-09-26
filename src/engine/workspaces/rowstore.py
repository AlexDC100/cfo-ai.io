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
  "to_org", "document_id", "content_type", "expect_sha256", "must_exist"}``
    copy a storage object to another org's prefix. No row effect; the old
    object is never deleted. ``expect_sha256`` (when the plan's facts pass
    read the object) is what the copy must find and write: a source that is
    gone or different by then stops the run before any row moves. So does a
    source that is gone while ``must_exist`` is true (the snapshot's object
    inventory recorded it): only a source the inventory ALSO recorded as
    missing lets the row move without a file.

UNDOING A PLAN — ``undo_ops`` (the rollback of ``scripts/db_restore.py``
--plan): the inverse of exactly the operations above, in reverse order —
an ``update`` puts its ``expect`` values back (guarded by the ``set`` it
wrote), a ``merge_prefs`` takes its keys out of the bag (the pre-image of
those keys comes from the snapshot), an inserted workspace is archived
(held), an inserted membership is left (no archive column), a copy is
left (never deleted). A row the plan did not name is never touched; a row
the plan named that is gone is re-inserted from the snapshot.

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


# ── undo of a plan ─────────────────────────────────────────────────────

#: A table the plan inserts rows into, and how an inserted row is undone
#: without a delete: ``organizations`` are archived (held: ``purge_after``
#: NULL — a later run brings the same id back, rule 4). ``memberships``
#: have no archive column: an inserted one stays (RESIDUE).
UNDO_INSERTED = {
    "organizations": ({"archived_at": NOW, "purge_after": None}, "archived_at"),
}


def at_planned_state(row: Mapping[str, Any], raw_set: Mapping[str, Any]) -> bool:
    """``row`` holds what a plan ``update`` wrote: every column of ``set``
    except the ``"$now"`` ones equal, and every ``"$now"`` column a
    timestamp (whatever run wrote it)."""
    for col, val in raw_set.items():
        if val == NOW:
            if row.get(col) is None:
                return False
        elif not same_value(row.get(col), val):
            return False
    return True


def undo_ops(plan_ops: Sequence[Mapping[str, Any]],
             current: Mapping[str, List[Mapping[str, Any]]],
             snapshot: Mapping[str, List[Mapping[str, Any]]], *,
             pks: Optional[Mapping[str, Sequence[str]]] = None) -> Dict[str, Any]:
    """The operations that take ``current`` back to the state before
    ``plan_ops`` ran — scoped to the rows the plan names, nothing else.

    Returns ``{"ops", "undone", "skipped", "conflicts", "residue",
    "reinserted", "touched"}``:

    * ``ops`` — ``rowstore`` operations (``update`` / ``upsert``), the
      plan's operations inverted in REVERSE order, each ``update`` guarded
      by the exact values the row holds now (a writer that finds anything
      else stops);
    * ``undone`` — rows the plan named that already hold their pre-image
      (an interrupted run never wrote them, or an earlier undo did);
    * ``conflicts`` — rows the plan named that hold NEITHER what the plan
      wrote NOR their pre-image: something changed them since the run.
      No operation is produced for them — a user's change is never
      overwritten by a rollback;
    * ``residue`` — what an undo leaves behind, counted: storage copies
      (never deleted), inserted rows with no archive column;
    * ``reinserted`` — rows the plan named that are GONE (hard-deleted since
      the run) and come back from the snapshot, the pre-image of exactly
      those keys. ``documents`` and ``financial_periods`` point at each other
      with immediate foreign keys: a document whose period is gone too is
      re-inserted with ``period_id`` NULL and relinked after the periods;
    * ``touched`` — ``{table: {key: pre-image columns}}`` of every row an
      undo must leave at its pre-image (what the post-check compares).

    Rows the plan does not name — a user's upload after the run, a
    workspace they created, a preference another user changed, a message
    — are not in any of these: the rollback of a migration is the undo of
    the migration's own writes, never "production is the snapshot".
    """
    cur_idx: Dict[str, Dict[Tuple[str, ...], Dict[str, Any]]] = {}
    snap_idx: Dict[str, Dict[Tuple[str, ...], Dict[str, Any]]] = {}

    def _cur(table: str) -> Dict[Tuple[str, ...], Dict[str, Any]]:
        if table not in cur_idx:
            cur_idx[table] = index_rows(current.get(table) or [], pk_for(table, pks))
        return cur_idx[table]

    def _snap(table: str) -> Dict[Tuple[str, ...], Dict[str, Any]]:
        if table not in snap_idx:
            snap_idx[table] = index_rows(snapshot.get(table) or [], pk_for(table, pks))
        return snap_idx[table]

    out: Dict[str, Any] = {"ops": [], "undone": [], "skipped": [], "conflicts": [], "residue": {},
                           "reinserted": [], "touched": {}}
    residue: Dict[str, int] = {}

    def _residue(label: str) -> None:
        residue[label] = residue.get(label, 0) + 1

    def _touch(table: str, key: Tuple[str, ...], cols: Mapping[str, Any]) -> None:
        out["touched"].setdefault(table, {}).setdefault(key, {}).update(cols)

    # Pass 1 — rows the plan named that are gone come back from the
    # snapshot, ordered documents (period link cut when the period is gone
    # too) -> periods -> the rest, then the links.
    named: Dict[str, List[Tuple[str, ...]]] = {}
    for raw in plan_ops:
        if raw["op"] == "copy_object":
            continue
        t = raw["table"]
        key = row_key(raw.get("row") or raw.get("key"), pk_for(t, pks))
        if key not in named.setdefault(t, []):
            named[t].append(key)
    gone: List[Tuple[str, Tuple[str, ...]]] = []
    for t, keys in named.items():
        for key in keys:
            if key not in _cur(t) and key in _snap(t):
                gone.append((t, key))
    gone_keys = set(gone)
    period_pk = pk_for("financial_periods", pks)
    periods_now = set(_cur("financial_periods"))     # a re-inserted period comes AFTER the documents
    relink: List[Dict[str, Any]] = []
    reinserts: List[Dict[str, Any]] = []
    order = {t: i for i, t in enumerate(TABLE_ORDER)}
    for t, key in sorted(gone, key=lambda tk: (order.get(tk[0], len(TABLE_ORDER)), tk[0], tk[1])):
        row = dict(_snap(t)[key])
        pk = pk_for(t, pks)
        if t == "documents" and row.get("period_id") is not None \
                and row_key({"id": row["period_id"]}, period_pk) not in periods_now:
            relink.append({"op": "update", "table": t, "key": key_dict(row, pk),
                           "set": {"period_id": row["period_id"]}, "expect": {"period_id": None}})
            row["period_id"] = None
        reinserts.append({"op": "upsert", "table": t, "row": row})
        out["reinserted"].append((t, key_dict(row, pk)))
        _touch(t, key, {c: v for c, v in _snap(t)[key].items() if c not in VOLATILE_COLUMNS})
    out["ops"].extend(reinserts)
    out["ops"].extend(relink)

    # Pass 2 — the plan's operations, inverted, newest first.
    for raw in reversed(list(plan_ops)):
        kind = raw["op"]
        if kind == "copy_object":
            _residue("storage copies (never deleted)")
            continue
        t = raw["table"]
        pk = pk_for(t, pks)
        if kind == "insert":
            key = row_key(raw["row"], pk)
            cur = _cur(t).get(key)
            rule = UNDO_INSERTED.get(t)
            if cur is None:
                out["undone"].append((t, key_dict(raw["row"], pk), "never created"))
                continue
            if rule is None:
                _residue("%s rows the plan inserted (no archive column)" % t)
                continue
            patch, marker = rule
            if cur.get(marker) is not None:
                if t == "organizations" and cur.get("purge_after") is not None:
                    out["skipped"].append((t, key_dict(raw["row"], pk),
                                           "archived by its owner with a deletion date — left as the owner set it"))
                else:
                    out["undone"].append((t, key_dict(raw["row"], pk), "created by the plan: archived (held)"))
                    _touch(t, key, {"purge_after": None})
                continue
            out["ops"].append({"op": "update", "table": t, "key": key_dict(raw["row"], pk),
                               "set": dict(patch), "expect": {c: cur.get(c) for c in patch}})
            _touch(t, key, {"purge_after": None})
            continue
        if kind == "merge_prefs":
            key = row_key(raw["key"], pk)
            if (t, key) in gone_keys:
                continue
            cur = _cur(t).get(key)
            merged = dict(raw["merge"])
            pre_bag = dict((_snap(t).get(key) or {}).get("prefs") or {})
            pre = {k: pre_bag.get(k) for k in merged}
            if cur is None:
                out["undone"].append((t, key_dict(raw["key"], pk), "no row"))
                _touch(t, key, {"prefs": pre})
                continue
            bag = dict(cur.get("prefs") or {})
            if all(canonical_json(bag.get(k)) == canonical_json(v) for k, v in pre.items()):
                out["undone"].append((t, key_dict(raw["key"], pk), "already at its pre-image"))
                _touch(t, key, {"prefs": pre})
                continue
            if not all(k in bag and canonical_json(bag[k]) == canonical_json(v) for k, v in merged.items()):
                out["conflicts"].append((t, key_dict(raw["key"], pk),
                                         "prefs %s hold neither what the plan merged nor their pre-image"
                                         % sorted(merged)))
                continue
            new_bag = {k: v for k, v in bag.items() if k not in merged}
            for k, v in pre.items():
                if k in pre_bag:
                    new_bag[k] = v
            out["ops"].append({"op": "update", "table": t, "key": dict(raw["key"]),
                               "set": {"prefs": new_bag}, "expect": {"prefs": bag}})
            _touch(t, key, {"prefs": pre})
            if not new_bag and key not in _snap(t):
                _residue("%s rows the plan created, now empty bags (an empty bag is no row)" % t)
            continue
        if kind == "update":
            key = row_key(raw["key"], pk)
            if (t, key) in gone_keys:
                continue          # back from the snapshot: at its pre-image
            cur = _cur(t).get(key)
            if cur is None:
                out["conflicts"].append((t, key_dict(raw["key"], pk), "gone, and not in the snapshot"))
                continue
            expect = dict(raw.get("expect") or {})
            sset = dict(raw["set"])
            if set(sset) - set(expect):
                out["conflicts"].append((t, key_dict(raw["key"], pk), "the plan recorded no pre-image for %s"
                                         % sorted(set(sset) - set(expect))))
                continue
            pre = {c: expect[c] for c in sset}
            if not at_planned_state(cur, sset):
                if values_match(cur, pre):
                    out["undone"].append((t, key_dict(raw["key"], pk), "already at its pre-image"))
                else:
                    out["conflicts"].append((t, key_dict(raw["key"], pk),
                                             "%s hold neither what the plan wrote nor the pre-image: now %s"
                                             % (sorted(sset), canonical_json({c: cur.get(c) for c in sset})[:160])))
                    continue
                _touch(t, key, pre)
                continue
            out["ops"].append({"op": "update", "table": t, "key": dict(raw["key"]), "set": pre,
                               "expect": {c: cur.get(c) for c in sset}})
            _touch(t, key, pre)
            continue
        raise ValueError("a plan never carries op %r" % kind)
    out["residue"] = residue
    return out


def undo_remaining(plan_ops: Sequence[Mapping[str, Any]],
                   current: Mapping[str, List[Mapping[str, Any]]],
                   snapshot: Mapping[str, List[Mapping[str, Any]]], *,
                   pks: Optional[Mapping[str, Sequence[str]]] = None) -> List[str]:
    """After an undo: every row the plan named that is NOT at its
    pre-image, as text — empty when the rollback is exact."""
    again = undo_ops(plan_ops, current, snapshot, pks=pks)
    lines: List[str] = []
    for op in again["ops"]:
        key = op.get("key") or {c: op["row"].get(c) for c in pk_for(op["table"], pks)}
        lines.append("%s %s: still %s" % (op["table"], canonical_json(key),
                                          "gone" if op["op"] == "upsert" else
                                          canonical_json(op.get("expect"))[:120]))
    for t, key, why in again["conflicts"]:
        lines.append("%s %s: %s" % (t, canonical_json(key), why))
    return lines
