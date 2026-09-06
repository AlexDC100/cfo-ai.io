"""A PROJECTION-FAITHFUL stand-in for the per-user Supabase client, for
the Radar suites.

`tests/engine/firm_fakes.FakeAdmin` records the thin PostgREST surface
but IGNORES `columns=` — it hands back the whole row whatever the query
asked for. `engine.api._supabase.SupabaseClient.select` sends `columns`
as PostgREST `select=`, so in production a route that lists periods
LIGHT gets exactly the columns it named and nothing else. A fake that
returns more than the query asked for is the class of failure recorded
under "fake stores hid 20+ defects": the Radar route's rebuild read
`assembled_canonical_v1` off a row that never carried it, every route
test stayed green, and the served figures differed from the Capsule's on
every corpus book (design_review/radar/SERVE_GATES.md, A2).

This double honours `columns=` the way PostgREST does:

  * `col`                        the column, verbatim
  * `alias:col`                  renamed
  * `alias:col->a->b`            a JSON path — the JSON value
  * `alias:col->a->>b`           a JSON path ending in `->>` — TEXT, the
                                 way PostgREST renders it (a number comes
                                 back as its string, null as null)
  * a plain column the row does NOT carry is a 400 in PostgREST
    (`column <table>.<col> does not exist`); it raises here, so a
    projection naming a column the table lacks (there is no
    `financial_periods.period_label`) cannot pass a test.

Everything else — filters, order, limit, insert/update recording — is
the parent's. Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from tests.engine.firm_fakes import FakeAdmin


def _json_text(value: Any) -> Optional[str]:
    """`->>` semantics: text for scalars, JSON text for containers,
    null for null."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def walk_json_path(row: Dict[str, Any], path: str) -> Any:
    """`col->a->b->>c` over a row dict. The final `->>` renders text."""
    as_text = "->>" in path
    if as_text:
        head, _, last = path.rpartition("->>")
        parts = head.split("->") + [last]
    else:
        parts = path.split("->")
    current = row.get(parts[0]) if parts else None
    for part in parts[1:]:
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                current = None
        else:
            current = None
    return _json_text(current) if as_text else current


def project_row(table: str, row: Dict[str, Any], columns: str) -> Dict[str, Any]:
    """One row through a PostgREST `select=` list."""
    out = {}  # type: Dict[str, Any]
    for token in columns.split(","):
        token = token.strip()
        if not token:
            continue
        if ":" in token:
            alias, path = token.split(":", 1)
            alias, path = alias.strip(), path.strip()
        else:
            alias, path = token, token
        if "->" in path:
            out[alias] = walk_json_path(row, path)
            continue
        if path not in row:
            raise RuntimeError(
                "PostgREST would answer 400 Bad Request: column %s.%s does not "
                "exist (select=%s)" % (table, path, columns))
        out[alias] = row[path]
    return out


class ProjectingAdmin(FakeAdmin):
    """`FakeAdmin` that honours `columns=` exactly as PostgREST `select=`
    would. `select` records `(table, filters, columns)` so a test can
    assert what a route asked for, not only which table it read."""

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        rows = FakeAdmin.select(self, table, filters=filters, columns=columns,
                                limit=limit, order=order, single=single)
        # Rewrite the parent's record so the projection is on it.
        self.calls[-1] = ("select", table, dict(filters or {}), columns)
        if columns.strip() == "*":
            return rows
        return [project_row(table, r, columns) for r in rows]


__all__ = ["ProjectingAdmin", "project_row", "walk_json_path"]
