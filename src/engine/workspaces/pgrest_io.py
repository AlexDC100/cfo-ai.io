"""The Supabase side of the snapshot / restore / migration scripts.

Everything else in ``engine.workspaces`` is pure; this module is the wire:

  * table discovery from PostgREST's OpenAPI document (columns, and the
    primary key PostgREST marks with ``<pk/>``);
  * COMPLETE reads: every page, ordered by primary key, until the count
    PostgREST reports (``Prefer: count=exact``) is reached. Supabase caps a
    response at ``db-max-rows`` (1000 by default) silently — a reader that
    stops at the first short page would snapshot a truncated table;
  * one-row reads and writes by primary key, for the read-before-write
    executor (``apply_live``);
  * storage: existence, download and upload of objects in the
    tenant-scoped ``documents`` bucket, always through the tenant-asserting
    methods of ``engine.api._supabase.SupabaseClient`` (``org_id`` declared).
    Nothing here deletes an object or a row.

The service-role client comes from ``engine.api._supabase.admin()``.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from engine.workspaces.rowstore import (
    KNOWN_PKS,
    NOW,
    OpConflict,
    canonical_json,
    pk_for,
    resolve_now,
    table_sha256,
    values_match,
)

PAGE = 1000
SNAPSHOT_FORMAT = "cfo-ai-db-snapshot/1"

#: Always in a snapshot (the rest: every table with org_id / period_id /
#: organization_id). user_usage + subscriptions are READ for reference and
#: never written by the migration.
REQUIRED_TABLES = (
    "organizations", "memberships", "org_prefs", "user_prefs", "financial_periods",
    "documents", "user_usage", "subscriptions",
)
SCOPE_COLUMNS = ("org_id", "period_id", "organization_id")
#: Read for reference only; never restored unless named explicitly.
BILLING_TABLES = frozenset({"user_usage", "subscriptions", "billing_events"})


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _in_list(values: Iterable[Any]) -> str:
    return "in.(%s)" % ",".join('"%s"' % str(v).replace('"', '\\"') for v in values)


class PgRest:
    """Thin, complete reads and keyed writes over one SupabaseClient."""

    def __init__(self, client: Any) -> None:
        self.c = client
        self.base = "%s/rest/v1" % client.url
        self.writes: List[Tuple[str, str, Any]] = []
        self._openapi: Optional[Dict[str, Any]] = None

    # ── discovery ─────────────────────────────────────────────────────

    def openapi(self) -> Dict[str, Any]:
        """PostgREST's OpenAPI document (a GET), read once."""
        if self._openapi is None:
            r = self.c._client.get(self.base + "/", headers=self.c._headers)
            r.raise_for_status()
            self._openapi = r.json() or {}
        return self._openapi

    def has_rpc(self, name: str) -> bool:
        """True when PostgREST exposes the function ``name`` to this role
        (``/rpc/<name>`` in the OpenAPI paths) — read, never called."""
        return ("/rpc/%s" % name) in (self.openapi().get("paths") or {})

    def discover(self) -> Dict[str, Dict[str, List[str]]]:
        """{table: {"columns": [...], "pk": [...]}} from the OpenAPI document."""
        defs = self.openapi().get("definitions") or {}
        out: Dict[str, Dict[str, List[str]]] = {}
        for name, d in defs.items():
            props = d.get("properties") or {}
            cols = sorted(props)
            pk = [c for c in cols if "<pk/>" in str((props[c] or {}).get("description") or "")]
            out[name] = {"columns": cols, "pk": pk}
        return out

    @staticmethod
    def snapshot_tables(schema: Mapping[str, Mapping[str, Sequence[str]]]) -> List[str]:
        chosen = [t for t in REQUIRED_TABLES if t in schema]
        for t in sorted(schema):
            cols = schema[t].get("columns") or []
            if t not in chosen and any(c in cols for c in SCOPE_COLUMNS):
                chosen.append(t)
        return chosen

    @staticmethod
    def resolve_pk(table: str, meta: Mapping[str, Sequence[str]]) -> List[str]:
        cols = list(meta.get("columns") or [])
        pk = [c for c in (meta.get("pk") or []) if c in cols]
        if pk:
            return pk
        known = list(KNOWN_PKS.get(table, ()))
        if known and all(c in cols for c in known):
            return known
        if "id" in cols:
            return ["id"]
        return sorted(cols)

    # ── reads ─────────────────────────────────────────────────────────

    def select_all(self, table: str, pk: Sequence[str], *,
                   filters: Optional[Mapping[str, str]] = None) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        total: Optional[int] = None
        order = ",".join("%s.asc" % c for c in pk)
        while True:
            params = {"select": "*", "order": order, "limit": str(PAGE), "offset": str(len(rows))}
            params.update(filters or {})
            headers = dict(self.c._headers)
            headers["Prefer"] = "count=exact"
            r = self.c._client.get("%s/%s" % (self.base, table), params=params, headers=headers)
            r.raise_for_status()
            page = r.json() or []
            m = re.search(r"/(\d+)$", r.headers.get("content-range") or "")
            if m:
                total = int(m.group(1))
            rows.extend(page)
            if total is None:
                if len(page) < PAGE:
                    break
            elif len(rows) >= total:
                break
            elif not page:
                raise RuntimeError("%s: read stopped at %d of %d rows (table changed mid-read?)"
                                   % (table, len(rows), total))
        if total is not None and len(rows) != total:
            raise RuntimeError("%s: read %d rows, PostgREST counted %d" % (table, len(rows), total))
        return rows

    def get_row(self, table: str, key: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        params = {"select": "*"}
        for c, v in key.items():
            params[c] = "is.null" if v is None else "eq.%s" % v
        r = self.c._client.get("%s/%s" % (self.base, table), params=params, headers=self.c._headers)
        r.raise_for_status()
        rows = r.json() or []
        if len(rows) > 1:
            raise RuntimeError("%s %s: key matched %d rows" % (table, canonical_json(key), len(rows)))
        return rows[0] if rows else None

    # ── writes (never a delete) ───────────────────────────────────────

    def insert(self, table: str, row: Mapping[str, Any]) -> None:
        headers = dict(self.c._headers)
        headers["Prefer"] = "return=minimal"
        r = self.c._client.post("%s/%s" % (self.base, table), json=[dict(row)], headers=headers)
        if r.status_code >= 400:
            raise RuntimeError("insert %s failed (%d): %s" % (table, r.status_code, r.text[:400]))
        self.writes.append(("insert", table, dict(row)))

    def upsert(self, table: str, row: Mapping[str, Any], pk: Sequence[str]) -> None:
        headers = dict(self.c._headers)
        headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
        r = self.c._client.post("%s/%s" % (self.base, table), json=[dict(row)], headers=headers,
                                params={"on_conflict": ",".join(pk)})
        if r.status_code >= 400:
            raise RuntimeError("upsert %s failed (%d): %s" % (table, r.status_code, r.text[:400]))
        self.writes.append(("upsert", table, dict(row)))

    def update(self, table: str, key: Mapping[str, Any], patch: Mapping[str, Any]) -> None:
        if not key or any(v is None for v in key.values()):
            raise RuntimeError("update %s refused: incomplete key %s" % (table, canonical_json(key)))
        params = {c: "eq.%s" % v for c, v in key.items()}
        headers = dict(self.c._headers)
        headers["Prefer"] = "return=representation"
        r = self.c._client.patch("%s/%s" % (self.base, table), params=params, json=dict(patch),
                                 headers=headers)
        if r.status_code >= 400:
            raise RuntimeError("update %s %s failed (%d): %s"
                               % (table, canonical_json(key), r.status_code, r.text[:400]))
        n = len(r.json() or [])
        if n != 1:
            raise RuntimeError("update %s %s touched %d rows (expected 1)" % (table, canonical_json(key), n))
        self.writes.append(("update", table, {"key": dict(key), "set": dict(patch)}))

    # ── storage ───────────────────────────────────────────────────────

    def object_exists(self, bucket: str, path: str, *, org_id: str) -> bool:
        try:
            self.c.signed_url(bucket, path, org_id=org_id, expires_in=60)
        except Exception as exc:  # noqa: BLE001
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (400, 404):
                return False
            raise
        return True

    def download(self, bucket: str, path: str, *, org_id: str) -> Optional[bytes]:
        try:
            url = self.c.signed_url(bucket, path, org_id=org_id, expires_in=300)
        except Exception as exc:  # noqa: BLE001
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (400, 404):
                return None
            raise
        r = self.c._client.get(url)
        if r.status_code in (400, 404):
            return None
        r.raise_for_status()
        return r.content

    def upload(self, bucket: str, path: str, content: bytes, *, org_id: str,
               content_type: Optional[str]) -> None:
        self.c.upload_object(bucket, path, content, org_id=org_id,
                             content_type=content_type or "application/octet-stream")
        self.writes.append(("upload", bucket, path))


# ── snapshot files ─────────────────────────────────────────────────────

def read_tables(db: PgRest, tables: Sequence[str], pks: Mapping[str, Sequence[str]]
                ) -> Dict[str, List[Dict[str, Any]]]:
    return {t: db.select_all(t, pks[t]) for t in tables}


def build_snapshot(db: PgRest, *, schema: Optional[Mapping[str, Mapping[str, Sequence[str]]]] = None,
                   created_at: Optional[str] = None) -> Dict[str, Any]:
    live = db.discover()
    if schema:
        # the pinned list decides WHICH tables; the live document decides
        # their columns and keys (a table the pin names but production
        # lacks is an error, not a silent skip).
        wanted = PgRest.snapshot_tables(schema)
        missing = [t for t in wanted if t not in live]
        if missing:
            raise RuntimeError("tables named by the schema file are not in production: %s" % missing)
    else:
        wanted = PgRest.snapshot_tables(live)
    pks = {t: PgRest.resolve_pk(t, live[t]) for t in wanted}
    tables = read_tables(db, wanted, pks)
    snap = {"format": SNAPSHOT_FORMAT, "created_at": created_at or utc_now_iso(),
            "source": db.c.url, "tables": {}}
    for t in wanted:
        rows = sorted(tables[t], key=lambda r: canonical_json([r.get(c) for c in pks[t]]))
        snap["tables"][t] = {"pk": list(pks[t]), "columns": list(live[t]["columns"]),
                             "count": len(rows), "sha256": table_sha256(rows, pks[t]), "rows": rows}
    objects = object_inventory(db, tables.get("documents") or [])
    snap["objects"] = objects
    snap["objects_sha256"] = hashlib.sha256(canonical_json(objects).encode("utf-8")).hexdigest()
    return snap


def object_inventory(db: PgRest, documents: Iterable[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """``{document id: {"path", "org_id", "exists"}}`` — whether each
    document's storage object resolved when the snapshot was taken. The
    rollback checks the objects that DID exist then still do (a restored
    ``storage_path`` whose object a purge erased is not a restore).
    ``exists`` is None when the object could not be asked about."""
    out: Dict[str, Dict[str, Any]] = {}
    for d in sorted(documents, key=lambda r: str(r.get("id"))):
        path = d.get("storage_path")
        if not path:
            continue
        try:
            exists: Optional[bool] = db.object_exists("documents", str(path), org_id=str(d.get("org_id")))
        except Exception:  # noqa: BLE001 — a path outside its own org, an outage: unknown
            exists = None
        out[str(d["id"])] = {"path": str(path), "org_id": str(d.get("org_id")), "exists": exists}
    return out


def write_snapshot(snap: Mapping[str, Any], path: str) -> str:
    data = json.dumps(snap, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    with gzip.open(path, "wb") as fh:
        fh.write(data)
    return hashlib.sha256(data).hexdigest()


def load_snapshot(path: str) -> Dict[str, Any]:
    with gzip.open(path, "rb") as fh:
        snap = json.loads(fh.read().decode("utf-8"))
    if snap.get("format") != SNAPSHOT_FORMAT:
        raise RuntimeError("%s is not a %s file" % (path, SNAPSHOT_FORMAT))
    for t, meta in snap["tables"].items():
        if table_sha256(meta["rows"], meta["pk"]) != meta["sha256"] or len(meta["rows"]) != meta["count"]:
            raise RuntimeError("snapshot %s: table %s fails its own checksum" % (path, t))
    if "objects" in snap and hashlib.sha256(canonical_json(snap["objects"]).encode("utf-8")).hexdigest() \
            != snap.get("objects_sha256"):
        raise RuntimeError("snapshot %s: the storage object inventory fails its own checksum" % path)
    return snap


def snapshot_rows(snap: Mapping[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    return {t: [dict(r) for r in meta["rows"]] for t, meta in snap["tables"].items()}


def snapshot_pks(snap: Mapping[str, Any]) -> Dict[str, List[str]]:
    return {t: list(meta["pk"]) for t, meta in snap["tables"].items()}


def verify_snapshot(db: PgRest, snap: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Per table: equal?, counts, and (when not) which keys differ."""
    from engine.workspaces.rowstore import restore_diff

    pks = snapshot_pks(snap)
    current = read_tables(db, list(snap["tables"]), pks)
    rows = snapshot_rows(snap)
    diff = restore_diff(rows, current, pks=pks)
    out: Dict[str, Dict[str, Any]] = {}
    for t, meta in snap["tables"].items():
        sha = table_sha256(current[t], pks[t])
        d = diff[t]
        out[t] = {"equal": sha == meta["sha256"], "snapshot_count": meta["count"],
                  "current_count": len(current[t]), "changed": len(d["changed"]),
                  "missing": len(d["missing"]), "created": len(d["created"]),
                  "detail": d if sha != meta["sha256"] else None}
    return out


# ── the read-before-write executor ─────────────────────────────────────

def applied_at_another_time(row: Mapping[str, Any], raw_set: Mapping[str, Any]) -> bool:
    """An ``update`` whose ``set`` carries ``"$now"`` is ALREADY IN EFFECT
    when every other column holds its planned value and every ``$now``
    column holds a timestamp — the one an earlier, interrupted run wrote.
    Without this a resumed run compares the first run's timestamp with its
    own clock, then the untouched ``expect`` (``deleted_at`` NULL) with the
    first run's write, and stops half-migrated (OpConflict)."""
    stamped = [c for c, v in raw_set.items() if v == NOW]
    if not stamped:
        return False
    if any(row.get(c) is None for c in stamped):
        return False
    return values_match(row, {c: v for c, v in raw_set.items() if v != NOW})


def apply_live(db: PgRest, ops: Sequence[Mapping[str, Any]], *, now: str,
               pks: Mapping[str, Sequence[str]], log: Callable[[str], None] = print
               ) -> Dict[str, Any]:
    """Apply ``ops`` to production, one row at a time, reading each row
    first. An op already in effect is skipped (so a re-run is a no-op); a
    row found in neither the planned-from nor the planned-to state stops
    the run (``OpConflict``). Returns counts and the storage misses."""
    done = {"applied": 0, "skipped": 0, "copied": 0, "copy_skipped": 0,
            "missing_objects": [], "conflicts": []}
    for i, raw in enumerate(ops):
        op = resolve_now(dict(raw), now)
        kind = op["op"]
        if kind == "copy_object":
            if db.object_exists(op["bucket"], op["to_path"], org_id=op["to_org"]):
                done["copy_skipped"] += 1
                continue
            content = db.download(op["bucket"], op["from_path"], org_id=op["from_org"])
            if content is None:
                done["missing_objects"].append(op["from_path"])
                log("  [%d] copy %s: source object missing — row still moves" % (i, op["from_path"]))
                continue
            db.upload(op["bucket"], op["to_path"], content, org_id=op["to_org"],
                      content_type=op.get("content_type"))
            done["copied"] += 1
            continue
        table = op["table"]
        pk = list(pk_for(table, pks))
        if kind == "insert":
            key = {c: op["row"].get(c) for c in pk}
            if db.get_row(table, key) is not None:
                done["skipped"] += 1
                continue
            db.insert(table, op["row"])
            done["applied"] += 1
        elif kind == "merge_prefs":
            cur = db.get_row(table, op["key"])
            prefs = dict((cur or {}).get("prefs") or {})
            if cur is not None and all(canonical_json(prefs.get(k)) == canonical_json(v)
                                       for k, v in op["merge"].items()):
                done["skipped"] += 1
                continue
            prefs.update(op["merge"])
            db.upsert(table, dict(op["key"], prefs=prefs), list(op["key"]))
            done["applied"] += 1
        elif kind in ("update", "upsert"):
            key = op["key"] if kind == "update" else {c: op["row"].get(c) for c in pk}
            cur = db.get_row(table, key)
            if kind == "upsert":
                if cur is not None and values_match(cur, {k: v for k, v in op["row"].items()
                                                          if k != "updated_at"}):
                    done["skipped"] += 1
                    continue
                db.upsert(table, op["row"], pk)
                done["applied"] += 1
                continue
            if cur is None:
                raise OpConflict("[%d] %s %s: row missing" % (i, table, canonical_json(key)))
            if values_match(cur, op["set"]) or applied_at_another_time(cur, raw["set"]):
                done["skipped"] += 1
                continue
            if "expect" in op and not values_match(cur, op["expect"]):
                raise OpConflict("[%d] %s %s: expected %s, found %s" % (
                    i, table, canonical_json(key), canonical_json(op["expect"]),
                    canonical_json({c: cur.get(c) for c in op["expect"]})))
            db.update(table, key, op["set"])
            done["applied"] += 1
        else:
            raise ValueError("unknown op %r" % kind)
    return done
