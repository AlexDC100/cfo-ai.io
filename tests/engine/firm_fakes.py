"""In-memory stand-in for the SERVICE-ROLE Supabase client, for the firm
cockpit suites. It is NOT a mirror of a store this lane owns (the
FakeStore lesson): it fakes only the thin PostgREST client surface the
production code calls (`select` with eq./in./is. filters, `insert`,
`update`, `upsert`, `upload_object`), and every call is recorded so a
test can assert what was written, in what order.
"""
from __future__ import annotations

import copy
import uuid
from typing import Any, Dict, List, Optional


class FakeAdmin(object):
    def __init__(self, tables: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> None:
        self.tables = {}  # type: Dict[str, List[Dict[str, Any]]]
        for name, rows in (tables or {}).items():
            self.tables[name] = [dict(r) for r in rows]
        self.calls = []  # type: List[Any]
        self.uploads = []  # type: List[Any]

    def __enter__(self) -> "FakeAdmin":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def close(self) -> None:
        return None

    # -- filters ---------------------------------------------------------

    @staticmethod
    def _match(row: Dict[str, Any], key: str, spec: str) -> bool:
        value = row.get(key)
        if isinstance(value, bool):
            value = "true" if value else "false"
        if spec.startswith("eq."):
            return str(value) == spec[3:]
        if spec.startswith("in.(") and spec.endswith(")"):
            wanted = [v.strip() for v in spec[4:-1].split(",") if v.strip()]
            return str(value) in wanted
        if spec == "is.null":
            return value is None
        if spec.startswith("gte."):
            return value is not None and str(value) >= spec[4:]
        if spec.startswith("lte."):
            return value is not None and str(value) <= spec[4:]
        raise AssertionError("FakeAdmin does not understand filter %r" % spec)

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        self.calls.append(("select", table, dict(filters or {})))
        # `offset` / `limit` inside `filters` are PostgREST's reserved query
        # keywords, not columns: the real client forwards `filters` verbatim
        # into the query string, which is the wire the page walk
        # (engine.api._paging.select_all — every _firm* list read) rides.
        # Applied after ordering, as PostgREST applies them; a multi-column
        # order is applied in full (stable sorts, last key first).
        params = dict(filters or {})
        offset = int(params.pop("offset", 0) or 0)
        keyword_limit = params.pop("limit", None)
        if limit is None and keyword_limit is not None:
            limit = int(keyword_limit)
        rows = [r for r in self.tables.get(table, [])
                if all(self._match(r, k, v) for k, v in params.items())]
        if order:
            for spec in reversed(order.split(",")):
                col, _, direction = spec.strip().partition(".")
                rows.sort(key=lambda r: str(r.get(col) if r.get(col) is not None else ""),
                          reverse=(direction == "desc"))
        if offset:
            rows = rows[offset:]
        if limit is not None:
            rows = rows[:limit]
        return [copy.deepcopy(r) for r in rows]

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        body = rows if isinstance(rows, list) else [rows]
        out = []  # type: List[Dict[str, Any]]
        for r in body:
            row = dict(r)
            row.setdefault("id", str(uuid.uuid4()))
            self.tables.setdefault(table, []).append(row)
            out.append(copy.deepcopy(row))
        self.calls.append(("insert", table, copy.deepcopy(body)))
        return out if returning else []

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        self.calls.append(("update", table, copy.deepcopy(patch), dict(filters)))
        for r in self.tables.get(table, []):
            if all(self._match(r, k, v) for k, v in filters.items()):
                r.update(copy.deepcopy(patch))

    def upsert(self, table: str, rows: Any, *, on_conflict: str,
               returning: bool = False) -> List[Dict[str, Any]]:
        body = rows if isinstance(rows, list) else [rows]
        keys = [k.strip() for k in on_conflict.split(",")]
        self.calls.append(("upsert", table, copy.deepcopy(body), on_conflict))
        for r in body:
            existing = None
            for row in self.tables.get(table, []):
                if all(str(row.get(k)) == str(r.get(k)) for k in keys):
                    existing = row
                    break
            if existing is None:
                new = dict(r)
                new.setdefault("id", str(uuid.uuid4()))
                self.tables.setdefault(table, []).append(new)
            else:
                existing.update(dict(r))
        return []

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        self.calls.append(("delete", table, dict(filters)))
        self.tables[table] = [r for r in self.tables.get(table, [])
                              if not all(self._match(r, k, v) for k, v in filters.items())]

    def upload_object(self, bucket: str, path: str, content: bytes, *,
                      content_type: str = "application/octet-stream") -> None:
        self.uploads.append((bucket, path, len(content), content_type))

    def rpc(self, fn: str, params: Optional[Dict[str, Any]] = None) -> Any:
        raise AssertionError("FakeAdmin has no RPC %r" % fn)


def install(monkeypatch: Any, fake: FakeAdmin) -> FakeAdmin:
    """Route `engine.api._supabase.admin()` to `fake` for the test."""
    from engine.api import _supabase

    monkeypatch.setattr(_supabase, "admin", lambda: fake)
    return fake
