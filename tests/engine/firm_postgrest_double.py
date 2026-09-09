"""A PostgREST-FAITHFUL stand-in for ``engine.api._supabase.per_user(jwt)``,
for the attention route (``engine.api._firm_attention``).

NOT a mirror of a store (the FakeStore lesson — a double that answers
everything hides the query that PostgREST would refuse). It fakes the ONE
thing the real ``SupabaseClient`` does — turn ``(table, filters, columns,
order, limit)`` into rows, or into the error PostgREST sends — and it
refuses exactly what PostgREST refuses:

  * a FILTER or a SELECT on a column the table does not declare -> HTTP 400
    ``{"code": "42703", "message": "column <table>.<col> does not exist"}``,
    raised as the genuine ``httpx.HTTPStatusError`` the real client raises
    (``Response.raise_for_status()`` on a real ``httpx.Response``) — this is
    how the cadence rows were lost (C4): the route filtered
    ``firm_client_cadence`` by ``org_id``, a column it does not have;
  * an unknown TABLE -> HTTP 404 ``{"code": "PGRST205", ...}`` (PostgREST
    12, what Supabase runs); ``PGRST205`` and the older ``42P01`` are both
    "migration not applied" to the route;
  * JSON-path aliases in ``select`` (``alias:col->a->>b``) are evaluated
    the way PostgREST evaluates them (``->`` an object, ``->>`` its text);
  * ``eq.``, ``neq.``, ``in.("a","b")``, ``is.null``, ``order=col.desc``,
    ``limit`` — the operators the route sends, and NO others (an operator
    this double cannot express raises, never matches everything);
  * THE CAP (A2): every response is truncated after ordering at
    ``MAX_ROWS`` (PostgREST ``db-max-rows``, Supabase's default 1000) —
    silently, exactly as deployed: no error, no marker, the rows past the
    cap are not there. A ``limit`` above the cap is capped too. Every
    truncation the CAP (not a caller's own ``limit``) caused is recorded
    in ``truncations`` so a gate can assert the plant was live;
  * ``offset`` / ``limit`` inside ``filters`` are PostgREST's reserved
    query keywords (the real client forwards ``filters`` verbatim into the
    query string, where ``limit`` already travels), not columns: applied
    after ordering, never checked against the table. This is the wire the
    route's ``select_all`` page walk rides.

Auto-generated ids are SEQUENTIAL per table (``<table>-000042``), never
random: a read ordered ``id.asc`` is then insertion order, so a page walk
over a fixture is byte-stable across runs.

Columns of the FIRM tables are PARSED from the migrations under
``supabase/`` — the thing the route must agree with; the pre-existing
tables (``organizations``, ``financial_periods``, ``statement_line_items``)
carry a base list mirrored from ``supabase/schema.sql`` and its
``alter table … add column`` phases.

Every call is RECORDED (``calls``: ``(op, table, filters, columns)``), so a
test can count the heavy reads one open of the board caused — the
route-shaped FC9 gate reads that log, not only a clock.

Tenancy is NOT modelled here: every row is visible to the caller. FC1
(``tests/engine/test_firm_tenancy.py``) owns the two walls; this double
serves the correctness and the cost of the reads.
"""

from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx

REPO = Path(__file__).resolve().parents[2]
SUPABASE_DIR = REPO / "supabase"

#: Pre-existing tables the route reads, mirrored from supabase/schema.sql
#: (+ schema_phase_multi_workspace.sql: archived_at / purge_after;
#: schema_phase_firm.sql: firm_id / cui; the F4.1e canonical envelope
#: column on financial_periods; caen_code from the industry phase).
BASE_COLUMNS = {
    "organizations": ["id", "name", "industry_key", "industry_display_name",
                      "default_currency", "created_at", "updated_at", "archived_at",
                      "purge_after", "caen_code", "firm_id", "cui"],
    # EXACTLY what `supabase/schema.sql:568` declares plus the four later
    # `alter table` adds. Nothing else.
    #
    # This list used to carry `period_label`, `status` AND `caen_code`, none
    # of which any migration adds. A double that invents a column answers
    # 200 where production answers `400 42703`, which is the one thing a
    # double must never do — it is the fake-store failure mode with a
    # narrower blast radius. It cost exactly that: `_firm_attention`
    # named `caen_code` in an explicit projection, the double served it,
    # `test_firm_route.py` asserted the value came back, and the whole
    # attention board would have 500'd on the first real request.
    "financial_periods": ["id", "org_id", "source_document_id", "period_start",
                          "period_end", "currency", "extraction_confidence",
                          "assembled_canonical_v1", "detection_envelope",
                          "methodology_version", "pre_backfill_snapshot",
                          "created_at", "updated_at"],
    "statement_line_items": ["id", "period_id", "statement", "bucket",
                             "ro_account_code", "ro_account_name", "amount", "is_derived"],
}

#: The migrations that declare the firm tables the route reads.
FIRM_MIGRATIONS = ("schema_phase_firm_requests.sql", "schema_phase_firm_attention.sql")

_CONSTRAINT_WORDS = ("primary key", "unique", "check", "constraint", "foreign key",
                     "exclude")
#: A column line is `<name> <type> …`; a continuation of a multi-line
#: check (`or deadline_days … between 1 and 120)`) is not, and neither is
#: a bare `(cadence in (…))`. Requiring a SQL type as the second token is
#: what tells them apart.
_SQL_TYPES = ("uuid", "text", "int", "integer", "bigint", "smallint", "numeric", "jsonb",
              "json", "timestamptz", "timestamp", "date", "boolean", "bool", "float",
              "double", "real", "serial", "bigserial", "varchar", "char", "bytea")
_CREATE_TABLE_RX = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\((.*?)\n\);",
    re.I | re.S)


def parse_table_columns(sql: str) -> Dict[str, List[str]]:
    """``{table: [column, …]}`` for every ``create table`` in a migration.
    A column is the first token of a top-level line inside the parens
    that is not a table constraint. Comments are stripped first."""
    out = {}  # type: Dict[str, List[str]]
    for m in _CREATE_TABLE_RX.finditer(sql):
        table, body = m.group(1), m.group(2)
        cols = []  # type: List[str]
        for raw in body.splitlines():
            line = raw.split("--", 1)[0].strip().rstrip(",").strip()
            if not line:
                continue
            low = line.lower()
            if any(low.startswith(w) for w in _CONSTRAINT_WORDS):
                continue
            token = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_]+)", line)
            if token and token.group(2).lower() in _SQL_TYPES:
                cols.append(token.group(1))
        out[table] = cols
    return out


def firm_table_columns(migrations: Sequence[str] = FIRM_MIGRATIONS) -> Dict[str, List[str]]:
    cols = {}  # type: Dict[str, List[str]]
    for name in migrations:
        cols.update(parse_table_columns((SUPABASE_DIR / name).read_text(encoding="utf-8")))
    return cols


# ── The PostgREST refusals, as the real client raises them ───────────────


def postgrest_error(status: int, code: str, message: str, table: str,
                    hint: Optional[str] = None) -> httpx.HTTPStatusError:
    """The exception ``SupabaseClient.select`` raises for this response:
    ``raise_for_status()`` on a real ``httpx.Response`` carrying the
    PostgREST JSON body ``{code, details, hint, message}``."""
    request = httpx.Request("GET", "http://postgrest-double.local/rest/v1/%s" % table)
    response = httpx.Response(status, request=request,
                              json={"code": code, "details": None, "hint": hint,
                                    "message": message})
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        return exc
    raise AssertionError("status %d did not raise" % status)  # pragma: no cover


def unknown_column(table: str, column: str) -> httpx.HTTPStatusError:
    return postgrest_error(400, "42703", "column %s.%s does not exist" % (table, column), table)


def unknown_table(table: str) -> httpx.HTTPStatusError:
    return postgrest_error(
        404, "PGRST205", "Could not find the table 'public.%s' in the schema cache" % table,
        table, hint="Perhaps you meant the table 'public.organizations'")


# ── Filters and select lists ─────────────────────────────────────────────


def _in_values(spec: str) -> List[str]:
    inner = spec[len("in.("):-1]
    return [v.strip().strip('"') for v in inner.split(",") if v.strip()]


def match_filter(row: Dict[str, Any], column: str, spec: str) -> bool:
    value = row.get(column)
    if isinstance(value, bool):
        value = "true" if value else "false"
    if spec == "is.null":
        return value is None
    if spec == "not.is.null":
        return value is not None
    if spec.startswith("eq."):
        return value is not None and str(value) == spec[3:]
    if spec.startswith("neq."):
        return str(value) != spec[4:]
    if spec.startswith("in.(") and spec.endswith(")"):
        return value is not None and str(value) in _in_values(spec)
    raise AssertionError(
        "the double cannot express filter %r on %r — the real client would send it to "
        "PostgREST. Teach the double or change the query; never match everything."
        % (spec, column))


_PATH_RX = re.compile(r"(->>|->)")


def parse_select(columns: str) -> List[Tuple[str, str, List[Tuple[str, str]]]]:
    """``"a,b:c->x->>y"`` -> ``[(alias, base_column, [(op, key), …])]``.
    ``*`` is the empty list (every column)."""
    if columns.strip() == "*":
        return []
    out = []  # type: List[Tuple[str, str, List[Tuple[str, str]]]]
    for item in columns.split(","):
        item = item.strip()
        if not item:
            continue
        alias, _, expr = item.rpartition(":")
        expr = expr or item
        parts = _PATH_RX.split(expr)
        base = parts[0].strip()
        path = []  # type: List[Tuple[str, str]]
        for i in range(1, len(parts) - 1, 2):
            path.append((parts[i], parts[i + 1].strip()))
        out.append((alias or base, base, path))
    return out


def eval_path(value: Any, path: List[Tuple[str, str]]) -> Any:
    """PostgREST/Postgres JSON path: ``->`` yields the JSON value (or NULL),
    ``->>`` its TEXT (or NULL)."""
    current = value
    for op, key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
        if op == "->>":
            if current is None:
                return None
            if isinstance(current, (dict, list)):
                import json
                return json.dumps(current, sort_keys=True)
            if isinstance(current, bool):
                return "true" if current else "false"
            return str(current)
    return current


# ── The double ───────────────────────────────────────────────────────────


#: PostgREST reserves these query keywords; they are never column names.
RESERVED_QUERY_KEYWORDS = ("offset", "limit")


class PostgrestDouble(object):
    """``_supabase.per_user(jwt)`` -> this. Context manager, like the real one."""

    #: ``db-max-rows`` as Supabase deploys PostgREST (CLAUDE.md §14 tells
    #: operators to TOGGLE the setting — "Max Rows" — as the schema-cache
    #: escalation). The class attribute is the DEFAULT, never a pin: a
    #: test passes ``max_rows=`` and runs the same walk at 37, 500 and
    #: 1000 (critic D9 — the earlier gate asserted MAX_ROWS == PAGE_ROWS
    #: == 1000, a test that reds when the deployment changes the knob).
    MAX_ROWS = 1000

    def __init__(self, tables: Optional[Dict[str, List[Dict[str, Any]]]] = None,
                 columns: Optional[Dict[str, List[str]]] = None,
                 max_rows: Optional[int] = None) -> None:
        if max_rows is not None:
            if int(max_rows) < 1:
                raise ValueError("max_rows must be >= 1")
            self.MAX_ROWS = int(max_rows)
        self.columns = dict(BASE_COLUMNS)
        self.columns.update(firm_table_columns())
        if columns:
            self.columns.update(columns)
        self.tables = {}  # type: Dict[str, List[Dict[str, Any]]]
        self._auto_ids = 0
        #: (table, rows the query matched, rows served) — every response
        #: the CAP cut. Empty means the plant was never exercised.
        self.truncations = []  # type: List[Tuple[str, int, int]]
        for name, rows in (tables or {}).items():
            for row in rows:
                self.add(name, row)
        self.calls = []  # type: List[Tuple[str, str, Dict[str, str], str]]

    # -- context manager, like SupabaseClient --
    def __enter__(self) -> "PostgrestDouble":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def close(self) -> None:
        return None

    # -- rows --
    def add(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        if table not in self.columns:
            raise AssertionError("unknown table %r (teach the double its columns)" % table)
        unknown = set(row) - set(self.columns[table])
        if unknown:
            raise AssertionError("row for %s names column(s) the table does not declare: %s"
                                 % (table, sorted(unknown)))
        full = dict((c, None) for c in self.columns[table])
        full.update(row)
        if "id" in full and full["id"] is None:
            self._auto_ids += 1
            full["id"] = "%s-%06d" % (table, self._auto_ids)
        self.tables.setdefault(table, []).append(full)
        return full

    def rows(self, table: str) -> List[Dict[str, Any]]:
        return self.tables.setdefault(table, [])

    # -- the surface the route calls --
    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
        self.calls.append(("select", table, dict(filters or {}), columns))
        if table not in self.columns:
            raise unknown_table(table)
        known = self.columns[table]
        # Reserved query keywords ride `filters` on the real client's wire
        # (params.update(filters)); PostgREST reads them as paging, not as
        # columns. `limit` here is the keyword form; the kwarg wins when
        # both are sent, as the real client's params dict would.
        params = dict(filters or {})
        offset = int(params.pop("offset", 0) or 0)
        keyword_limit = params.pop("limit", None)
        if limit is None and keyword_limit is not None:
            limit = int(keyword_limit)
        for column in params:
            if column not in known:
                raise unknown_column(table, column)
        projection = parse_select(columns)
        for _alias, base, _path in projection:
            if base not in known:
                raise unknown_column(table, base)
        out = [r for r in self.rows(table)
               if all(match_filter(r, c, s) for c, s in params.items())]
        if order:
            for spec in reversed(order.split(",")):
                key, _, direction = spec.partition(".")
                out.sort(key=lambda r: (r.get(key) is None, str(r.get(key) or "")),
                         reverse=(direction == "desc"))
        if offset:
            out = out[offset:]
        # THE CAP. db-max-rows bounds every response, a caller's `limit`
        # included; only a cut the CAP made (not the caller's own limit)
        # is the silent truncation this double exists to reproduce.
        cap = self.MAX_ROWS if limit is None else min(int(limit), self.MAX_ROWS)
        if len(out) > cap:
            if limit is None or int(limit) > self.MAX_ROWS:
                self.truncations.append((table, len(out), cap))
            out = out[:cap]
        if single:
            out = out[:1]
        if not projection:
            return [copy.deepcopy(r) for r in out]
        shaped = []  # type: List[Dict[str, Any]]
        for r in out:
            row = {}  # type: Dict[str, Any]
            for alias, base, path in projection:
                row[alias] = copy.deepcopy(eval_path(r.get(base), path) if path else r.get(base))
            shaped.append(row)
        return shaped

    def insert(self, table: str, rows: Any, *, returning: bool = True) -> List[Dict[str, Any]]:
        body = rows if isinstance(rows, list) else [rows]
        self.calls.append(("insert", table, {}, ""))
        if table not in self.columns:
            raise unknown_table(table)
        stored = [copy.deepcopy(self.add(table, dict(r))) for r in body]
        return stored if returning else []

    def get_user(self, jwt: str) -> Dict[str, Any]:
        """The identity the REAL client would return: VERIFIED against the
        session's test JWKS (see ``mint_jwt`` / ``install_test_jwks`` at the
        bottom of this module), or ``{}`` for a bearer whose signature does
        not verify — never a fixed user for any bearer (FC1x, critic D5)."""
        return verified_identity(jwt)

    def update(self, table: str, patch: Dict[str, Any], *, filters: Dict[str, str]) -> None:
        """PATCH — the crons write ``firm_digest_prefs`` / ``firm_file_requests``
        through the client handed to them (the D11 sibling gates run them
        over this double). Filters as on a select; reserved keywords are
        not part of a PATCH."""
        self.calls.append(("update", table, dict(filters), ""))
        if table not in self.columns:
            raise unknown_table(table)
        for column in filters:
            if column not in self.columns[table]:
                raise unknown_column(table, column)
        unknown = set(patch) - set(self.columns[table])
        if unknown:
            raise unknown_column(table, sorted(unknown)[0])
        for row in self.rows(table):
            if all(match_filter(row, c, s) for c, s in filters.items()):
                row.update(copy.deepcopy(patch))

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        self.calls.append(("delete", table, dict(filters), ""))
        if table not in self.columns:
            raise unknown_table(table)
        self.tables[table] = [r for r in self.rows(table)
                              if not all(match_filter(r, c, s) for c, s in filters.items())]

    # -- the log, by shape --
    def selects(self, table: Optional[str] = None) -> List[Tuple[str, str, Dict[str, str], str]]:
        return [c for c in self.calls if c[0] == "select" and (table is None or c[1] == table)]

    def heavy_reads(self) -> Dict[str, int]:
        """The per-period REQUESTS a cache MISS costs: the envelope select,
        the full period row, and the line-item pages. A warm open makes
        none. The line items are a paged list, so one period's line items
        are TWO requests — the page and the empty page that proves it was
        the last (engine.api._paging: the walk stops on nothing else); see
        ``heavy_walks`` for the per-period count."""
        out = {"envelope": 0, "period_full": 0, "line_items": 0}
        for _op, table, filters, columns in self.selects():
            if table == "financial_periods" and "id" in filters:
                if columns == "*":
                    out["period_full"] += 1
                elif "assembled_canonical_v1" in columns:
                    out["envelope"] += 1
            elif table == "statement_line_items":
                out["line_items"] += 1
        return out

    def heavy_walks(self) -> Dict[str, int]:
        """The DISTINCT periods each heavy read touched — "every period read
        exactly once" is a claim about periods, not about pages."""
        seen = {"envelope": set(), "period_full": set(), "line_items": set()}  # type: Dict[str, Any]
        for _op, table, filters, columns in self.selects():
            if table == "financial_periods" and "id" in filters:
                key = "period_full" if columns == "*" else "envelope"
                seen[key].add(filters["id"])
            elif table == "statement_line_items" and "period_id" in filters:
                seen["line_items"].add(filters["period_id"])
        return dict((k, len(v)) for k, v in seen.items())

    def pages(self, table: str) -> List[Optional[str]]:
        """The ``offset`` of every select on a table, in order — ``None`` for
        a first page. What a paging gate reads to see the walk."""
        return [c[2].get("offset") for c in self.selects(table)]

    def in_list_sizes(self) -> List[int]:
        """The length of every ``in.(…)`` list a select carried — what a
        chunking gate asserts against the route's IN_CHUNK."""
        sizes = []  # type: List[int]
        for _op, _table, filters, _columns in self.calls:
            for spec in filters.values():
                if isinstance(spec, str) and spec.startswith("in.(") and spec.endswith(")"):
                    sizes.append(len(_in_values(spec)))
        return sizes

    def reset_calls(self) -> None:
        self.calls = []


# ── Seeding a client book from the captured fixtures ─────────────────────


_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def month_ends(last_year: int, last_month: int, count: int) -> List[str]:
    """``count`` calendar month ends, ending (last_year, last_month), oldest
    first. Leap years are irrelevant to a fixture book (2025 is not one)."""
    ends = []  # type: List[str]
    year, month = last_year, last_month
    for _ in range(count):
        ends.append("%04d-%02d-%02d" % (year, month, _MONTH_DAYS[month - 1]))
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    return list(reversed(ends))


def seed_client(double: PostgrestDouble, org_id: str, name: str, case: Dict[str, Any],
                period_ends: Sequence[str], updated_at: str = "2026-01-02T10:00:00+00:00",
                attached: bool = True) -> List[str]:
    """One organization + one financial_periods row per period end (each
    carrying the case's REAL persisted envelope and its REAL line items)
    — the shape the route reads. Returns the period ids, oldest first."""
    double.add("organizations", {"id": org_id, "name": name, "default_currency": case["currency"]})
    ids = []  # type: List[str]
    for end in period_ends:
        pid = "%s:%s" % (org_id, end)
        double.add("financial_periods", {
            "id": pid, "org_id": org_id, "period_start": end[:8] + "01", "period_end": end,
            # `financial_periods` declares no `period_label`, no `status`
            # and no `caen_code`. Seeding them made the double answer
            # 200 where production answers 400 42703.
            "currency": case["currency"],
            "assembled_canonical_v1": (copy.deepcopy(case["envelope"]) if attached else None),
            "source_document_id": ("doc:%s" % pid if attached else None),
            "updated_at": updated_at,
        })
        if attached:
            for item in case["line_items"]:
                double.add("statement_line_items", dict(item, period_id=pid))
        ids.append(pid)
    return ids


def install(monkeypatch: Any, double: PostgrestDouble, user_id: str = "user-double") -> PostgrestDouble:
    """Route ``_supabase.per_user`` to the double and resolve the JWT to a
    fixed user. Nothing here reaches a network."""
    from engine.api import _org, _supabase

    monkeypatch.setattr(_supabase, "per_user", lambda jwt: double)
    monkeypatch.setattr(_org, "resolve_user_id", lambda jwt: user_id)
    return double


# ── JWT / identity — the double models SIGNATURES (FC1x, critic D5) ──────
#
# "The double cannot model it" was the critics' verdict on the forged-bearer
# hole: the backend decoded a JWT without verifying it, and so did every
# double, so a forged `sub` passed in both. Now the backend verifies ES256
# against Supabase's JWKS (engine.api._jwt) and the doubles verify against
# THIS key: one P-256 key generated once per process, its JWKS served to
# the verifier by `install_test_jwks`, every test bearer minted by
# `mint_jwt` as a real ES256 JWT (kid / iss / aud / exp correct), and
# `verified_identity` refusing — as `{}` — any bearer whose signature does
# not verify. A critic harness outside pytest mints the same way:
#
#     import firm_postgrest_double as D
#     D.install_test_jwks(pytest.MonkeyPatch())   # once per process
#     bearer = D.mint_jwt(user_id, email)
#     forged = D.forged_jwt(victim_user_id)        # wrong key, right kid
#
# The imports below stay INSIDE the functions: test_firm_route.py's
# dead-registry probe imports this module and then asserts which modules
# are loaded, so nothing here may import the engine at module scope. The
# helpers are deliberately NOT named `test_*`: a module that star-imports
# this one would otherwise have them collected as tests.

TEST_KID = "fc1x-test-kid-0001"
#: The issuer the test verifier expects and the test minter writes. A
#: constant, NOT read from VITE_SUPABASE_URL, so a suite that never sets
#: the URL (the tenancy suite points nothing at Supabase) still verifies.
TEST_ISSUER = "https://test.supabase.co/auth/v1"
TEST_AUD = "authenticated"
_SESSION_KEYS = {}  # type: Dict[str, Any]


def _ec():
    from cryptography.hazmat.primitives.asymmetric import ec
    return ec


def session_private_key(name: str = "signing") -> Any:
    """A P-256 private key, generated ONCE per process per name. ``"signing"``
    is the key the test JWKS publishes; any other name is a key the JWKS
    does NOT publish (``forged_jwt`` uses ``"forged"``)."""
    key = _SESSION_KEYS.get(name)
    if key is None:
        key = _ec().generate_private_key(_ec().SECP256R1())
        _SESSION_KEYS[name] = key
    return key


def _b64url(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def session_jwks() -> Dict[str, Any]:
    """The JWKS document for the session's signing key, in the shape
    Supabase serves (measured 2026-09-05: kty EC, crv P-256, alg ES256)."""
    numbers = session_private_key().public_key().public_numbers()
    return {"keys": [{
        "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": TEST_KID,
        "x": _b64url(numbers.x.to_bytes(32, "big")),
        "y": _b64url(numbers.y.to_bytes(32, "big")),
    }]}


def public_key_bytes() -> bytes:
    """The session signing key's PUBLIC bytes (uncompressed point) — what an
    alg-confusion attacker would use as the HS256 secret."""
    numbers = session_private_key().public_key().public_numbers()
    return b"\x04" + numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")


def mint_jwt(sub: str, email: Optional[str] = None, *, key: Any = None, kid: Optional[str] = TEST_KID,
             alg: str = "ES256", iss: str = TEST_ISSUER, aud: Any = TEST_AUD,
             exp_in: int = 3600, now: Optional[float] = None,
             extra: Optional[Dict[str, Any]] = None, hs_secret: Optional[bytes] = None) -> str:
    """A real JWT for ``sub``: ES256 over ``header.payload`` with the
    session signing key by default. Every knob exists so a test can mint
    the ONE wrong thing it is about (a wrong key, an unknown kid, a past
    exp, another issuer, ``alg`` none / HS256) and nothing else."""
    import hashlib
    import hmac
    import json
    import time
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    now = time.time() if now is None else now
    header = {"alg": alg, "typ": "JWT"}
    if kid is not None:
        header["kid"] = kid
    payload = {"sub": sub, "email": email, "iss": iss, "aud": aud, "role": "authenticated",
               "iat": int(now), "exp": int(now) + int(exp_in)}
    if extra:
        payload.update(extra)
    signing_input = "%s.%s" % (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8")),
        _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")))
    if alg == "ES256":
        der = (key or session_private_key()).sign(signing_input.encode("ascii"),
                                                   _ec().ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    elif alg == "HS256":
        signature = hmac.new(hs_secret or b"", signing_input.encode("ascii"), hashlib.sha256).digest()
    else:
        signature = b"forged"
    return "%s.%s" % (signing_input, _b64url(signature))


def forged_jwt(sub: str, email: Optional[str] = None, **kw: Any) -> str:
    """A token that CLAIMS ``sub`` under the published kid but is signed by
    a key the JWKS does not hold — the critics' forgery, with a signature
    that is merely wrong rather than absent."""
    return mint_jwt(sub, email, key=session_private_key("forged"), **kw)


def install_test_jwks(monkeypatch: Any) -> None:
    """Point the verifier at the session's test key: ``_fetch_jwks`` serves
    ``session_jwks()`` (no fetch ever leaves the process), ``jwks_url`` and
    ``expected_issuer`` are derived from ``TEST_ISSUER`` — NOT from
    VITE_SUPABASE_URL, which the tenancy suite deliberately never sets
    (with the URL unset the real ``jwks_url`` is a 503 IdentityUnavailable,
    the production fail-closed answer, not a test's) — and the key cache
    starts empty."""
    from engine.api import _jwt

    monkeypatch.setattr(_jwt, "_fetch_jwks", lambda url: session_jwks())
    monkeypatch.setattr(_jwt, "jwks_url", lambda: TEST_ISSUER + "/.well-known/jwks.json")
    monkeypatch.setattr(_jwt, "expected_issuer", lambda: TEST_ISSUER)
    _jwt.reset_cache()


def verified_identity(jwt: str) -> Dict[str, Any]:
    """``{"id", "email", "claims"}`` when ``jwt`` verifies against the keys
    the verifier currently holds; ``{}`` otherwise (a 401 or a 503 from the
    verifier are both "no identity" to a double). This is what PostgREST's
    `anon` looks like from the route: auth.uid() NULL."""
    from engine.api import _jwt

    try:
        return _jwt.verified_identity(jwt)
    except _jwt.HTTPException:
        return {}


__all__ = [
    "BASE_COLUMNS", "FIRM_MIGRATIONS", "PostgrestDouble", "TEST_AUD", "TEST_ISSUER", "TEST_KID",
    "eval_path", "firm_table_columns", "forged_jwt", "install", "install_test_jwks",
    "match_filter", "mint_jwt", "month_ends", "parse_select", "parse_table_columns",
    "postgrest_error", "public_key_bytes", "seed_client", "session_jwks", "session_private_key",
    "unknown_column", "unknown_table", "verified_identity",
]
