"""Doubles for the duplicate-upload / quota gates.

`FakeDB` is a small in-memory PostgREST stand-in: the filter grammar the
engine's `SupabaseClient` sends (`eq.`, `is.null`, `not.is.null`, `in.(…)`,
`gte.` / `lt.`, `and=(…)`, `order`, `limit`, `offset`, `single`), update,
insert, delete, and the two storage calls. It serves BOTH `admin()` and
`per_user(jwt)` — RLS is not what these gates are about (the write wall has
its own suite, test_identity_wall.py).

`Meter` is the upload meter, mirrored line for line from the SQL bodies in
supabase/schema_phase_pricing_v3_atomic.sql (`reserve_user_upload`,
`reserve_user_upload_extra`, `commit_user_upload`, `release_user_upload`)
plus `increment_user_usage` from schema_phase5_usage_limits.sql — the
legacy bump that double-counted. The counters these gates read are the
ones the quota banner and the 402 dialog read in production.
"""
from __future__ import annotations

import copy
import re
import threading
from typing import Any, Dict, List, Optional


def _match(row: Dict[str, Any], key: str, cond: str) -> bool:
    if key in ("offset",):
        return True
    if key == "and":
        inner = cond.strip()[1:-1]
        for part in re.split(r",(?![^()]*\))", inner):
            col, op, val = part.split(".", 2)
            if not _match(row, col, "%s.%s" % (op, val)):
                return False
        return True
    v = row.get(key)
    if cond == "is.null":
        return v is None
    if cond == "not.is.null":
        return v is not None
    if cond.startswith("eq."):
        return v is not None and str(v) == cond[3:]
    if cond.startswith("neq."):
        return str(v) != cond[4:]
    if cond.startswith("in.("):
        return v is not None and str(v) in cond[4:-1].split(",")
    if cond.startswith("gte."):
        return v is not None and str(v) >= cond[4:]
    if cond.startswith("lt."):
        return v is not None and str(v) < cond[3:]
    raise AssertionError("FakeDB: unsupported filter %s=%s" % (key, cond))


class FakeDB:
    def __init__(self, tables: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {k: [dict(r) for r in v] for k, v in (tables or {}).items()}
        self.lock = threading.RLock()
        self.updates: List[tuple] = []
        self.deleted_objects: List[str] = []
        self.url = "https://fake.supabase"
        self.users_by_token: Dict[str, str] = {}

    # context-manager client protocol
    def client(self) -> "FakeDB":
        return self

    def __enter__(self) -> "FakeDB":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def rows(self, table: str) -> List[Dict[str, Any]]:
        return self.tables.setdefault(table, [])

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None, columns: str = "*",
               limit: Optional[int] = None, order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        with self.lock:
            filters = dict(filters or {})
            offset = int(filters.pop("offset", 0) or 0)
            out = [r for r in self.rows(table) if all(_match(r, k, c) for k, c in filters.items())]
            if order:
                for part in reversed(order.split(",")):
                    col, _, direction = part.partition(".")
                    out.sort(key=lambda r: (r.get(col) is None, str(r.get(col) or "")),
                             reverse=direction.startswith("desc"))
            out = out[offset:]
            if limit is not None:
                out = out[:limit]
            if single:
                out = out[:1]
            return [copy.deepcopy(r) for r in out]

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        with self.lock:
            self.updates.append((table, dict(patch), dict(filters)))
            for r in self.rows(table):
                if all(_match(r, k, c) for k, c in filters.items()):
                    r.update(copy.deepcopy(patch))

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        with self.lock:
            body = rows if isinstance(rows, list) else [rows]
            for r in body:
                self.rows(table).append(dict(r))
            return [dict(r) for r in body] if returning else []

    def upsert(self, table: str, rows: Any, *, on_conflict: str,
               returning: bool = False) -> List[Dict[str, Any]]:
        """PostgREST `resolution=merge-duplicates`: a row whose conflict
        columns match an existing one UPDATES only the columns it carries."""
        with self.lock:
            body = rows if isinstance(rows, list) else [rows]
            keys = [k.strip() for k in on_conflict.split(",") if k.strip()]
            out = []
            for r in body:
                hit = next((x for x in self.rows(table)
                            if all(str(x.get(k)) == str(r.get(k)) for k in keys)), None)
                if hit is None:
                    hit = dict(r)
                    self.rows(table).append(hit)
                else:
                    hit.update(copy.deepcopy(r))
                out.append(dict(hit))
            return out if returning else []

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        with self.lock:
            self.tables[table] = [r for r in self.rows(table)
                                  if not all(_match(r, k, c) for k, c in filters.items())]

    def delete_object(self, bucket: str, path: str, *, org_id: str) -> None:
        self.deleted_objects.append(path)

    def signed_url(self, bucket: str, path: str, *, org_id: str, expires_in: int = 300) -> str:
        raise RuntimeError("storage is not modelled — rows carry their content_hash")

    def get_user(self, jwt: str) -> Dict[str, Any]:
        return {"id": self.users_by_token.get(jwt) or jwt.split(":", 1)[-1]}


class Meter:
    """The upload meter, one user, one month — the SQL, in Python."""

    def __init__(self, *, cap: int = 15) -> None:
        self.cap = cap
        self.uploads = 0
        self.reserved = 0
        self.extra_billed = 0
        self.pending = 0
        self.calls: List[str] = []
        self.lock = threading.Lock()

    def rpc(self, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            self.calls.append(name)
            if name == "reserve_user_upload":
                if self.uploads + self.reserved < payload["p_base_cap"]:
                    self.reserved += 1
                    return {"kind": "allowed", "used": self.uploads, "reserved": self.reserved}
                kind = "extra_required" if payload["p_allow_extra"] else "blocked"
                return {"kind": kind, "used": self.uploads, "reserved": self.reserved}
            if name == "reserve_user_upload_extra":
                self.reserved += 1
                self.pending += 1
                return {"kind": "extra_reserved", "used": self.uploads, "reserved": self.reserved}
            if name == "commit_user_upload":
                self.uploads += 1
                self.reserved = max(self.reserved - 1, 0)
                if payload["p_was_extra"]:
                    self.extra_billed += 1
                    self.pending = max(self.pending - 1, 0)
                return {"used": self.uploads, "reserved": self.reserved}
            if name == "release_user_upload":
                self.reserved = max(self.reserved - 1, 0)
                if payload["p_was_extra"]:
                    self.pending = max(self.pending - 1, 0)
                return {"used": self.uploads, "reserved": self.reserved}
            if name == "increment_user_usage":  # the legacy soft counter
                self.uploads += int(payload.get("p_amount") or 1)
                return {}
            raise AssertionError("Meter: unexpected RPC %s" % name)

    def snapshot(self) -> Dict[str, int]:
        return {"uploads": self.uploads, "reserved": self.reserved,
                "extra_billed": self.extra_billed, "pending": self.pending}
