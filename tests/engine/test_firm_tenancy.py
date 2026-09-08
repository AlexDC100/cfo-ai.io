"""FC1 — FIRM TENANCY. A member of firm A cannot read ANY firm-B client
through any route, RPC, or Capsule tool — and the role matrix holds per
role × per action.

Run as its own named battery gate:

    python -m pytest tests/engine/test_firm_tenancy.py -q
    python scripts/run_battery.py            # gate name: firm-tenancy

WHAT IS UNDER TEST, AND HOW THE DOUBLE IS KEPT HONEST
-----------------------------------------------------
There is no Postgres on this machine and nothing here may point at
Supabase (8,880 junk orgs were written to PRODUCTION by a test run last
week). So the boundary is tested at two layers, with one file as the
single source of truth for both:

  1. THE SQL LANE reads ``supabase/schema_phase_firm.sql`` and asserts
     its STRUCTURE: the role matrix seed, cell by cell, against
     ``_firm.ROLE_MATRIX`` and against a RECORDED expectation table in
     this file (TC-6 — a per-component expectation, not a count); every
     SECURITY DEFINER helper pinned and revoked from anon; no
     self-referencing policy on firm_memberships (the 42P17 trap); the
     client-data policies select-only and routed through
     ``can_read_client_org``; every mutating RPC guarded by ``firm_can``
     and ending in ``firm_audit``.

  2. THE TENANCY LANE drives the REAL routers — EVERY route the REAL
     app serves under /api/firm and /api/capsule. The surface is
     ENUMERATED FROM ``create_app()``'s OWN ROUTE TABLE (W2): the fixture
     mounts a roster, and a test asserts the fixture's (method, path,
     endpoint) set equals the real app's — so a fifth router mounted in
     server.py by ANY import shape (relative or absolute import, a
     module reference, a module not named ``_firm*``) is a red, not a
     surface outside FC1. The routers go through FastAPI's TestClient
     against an in-memory Supabase double whose row visibility is
     EVALUATED FROM THE POLICY EXPRESSIONS PARSED OUT OF THE THREE FIRM
     MIGRATIONS (schema_phase_firm.sql, schema_phase_firm_requests.sql,
     schema_phase_firm_attention.sql), whose matrix is the SQL seed (not
     the Python one), and whose RPC guards are read out of each
     function's body. Loosen a policy in the SQL and the double loosens
     with it, and FC1 goes red. That is the difference between this
     double and the FakeStore that hid two outages (CLAUDE.md §21): it
     does not mirror what the code should do; it derives what the
     database WOULD do from the migration text.

     What the double does NOT model is deliberately narrow and stated:
     it does not cascade deletes, it raises on any filter operator it
     cannot express (never matches everything), per-user reads of a
     table with no policy return nothing (deny-by-default), a per-user
     INSERT is admitted only by an insert policy's WITH CHECK parsed
     from the migration (none → refused, as PostgREST would), a
     per-user UPDATE touches only rows an update policy's USING selects
     and refuses a new row no WITH CHECK admits, a per-user UPSERT is
     the INSERT check first and — on conflict — the UPDATE policies on
     the existing row (an error, not a skip, as Postgres does), and a
     bearer this backend cannot decode is PostgREST's ``anon``:
     auth.uid() NULL, every policy false, every write refused — never
     the service role (W4).

  THE WRITE SWEEP (W1, the owner's ruling). EVERY write a signed-in user
  can make under /api/firm — cadence, request, revocation, digest
  preference, suppression, brief cache, assignment, attach, detach, role,
  removal, invitation, revocation, CSV import — is driven by an intruder
  three times: with the Python wall standing (403, the row unchanged);
  with the Python wall REMOVED BY HAND (`resolve_firm`, `require`,
  `require_client`, `authorize_client`, `client_org_ids_for` patched to
  wave anyone through) — the write reaches the database AS THE INTRUDER
  and the policies / RPC guards parsed from the migrations refuse it,
  the row unchanged; and with the SQL wall loosened too — the write
  LANDS, which is what proves the first two assertions were the walls.
  A row that moved is reported as ``FC1 WRITE VIOLATED`` naming the
  route, the table and the row.

  THE SWEEP (critic C1, 2026-09-04). Every route under /api/firm that
  serves client data is driven by a firm-B owner, a firm-B viewer, a solo
  user and a firm-A non-member against firm-A's client, in every shape
  the route accepts (firm-A's id, the intruder's own firm, no firm), with
  a SECRET marker seeded in every table those routes read; any answer
  carrying a marker is "FC1 VIOLATED" naming the route. Each route also
  has a POSITIVE CONTROL — the right firm-A role reads the marker — so a
  403 is proven to be the wall and not a broken route. A route census
  asserts every mounted route is either swept or declared (with its
  reason) as serving no client data, so a new route cannot be forgotten.

  TWO WALLS on the cockpit surface (critic C2): /requests/list,
  /requests/{id}/revoke, /cadence/status, /digest/prefs and /brief read
  through the caller's own client, and the firm-read policies in
  schema_phase_firm_requests.sql are evaluated by the double; the plant
  ``test_fc1_plant_cross_firm_cockpit_read_is_blocked_at_both_walls``
  removes the Python wall by hand and shows RLS still answers nothing,
  then loosens the policy and shows the leak.

THE PLANT (TC-2) — executable, ships with the gate:
  ``test_fc1_plant_cross_firm_read_is_blocked_at_both_walls`` forges the
  exact cross-firm read a hostile client would send (firm-B member, valid
  JWT, firm-A path, firm-A client id), and proves it is blocked at the
  Python wall (403) AND, with the Python wall removed by hand, at the RLS
  wall (empty). Both halves must hold; either alone is one bug away from
  a leak.

Fixtures are REAL ENGINE OUTPUT (TC-1): the firm-A client's period carries
``corpus/saga_10_col_carniprod/expected/served_envelope.json`` as its
persisted canonical_bs, and the positive control asserts the Capsule
returns exactly the ``total_assets_cents`` recorded in that case's
``gateway_facts.json`` — so "blocked" is proven against a read that is
demonstrably real, not against a route that is broken.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import base64
import copy
import importlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _capsule_tools as CT
from engine.api import _firm, _firm_import, _firm_invites, _firm_requests
from engine.api import _supabase as _supabase_module

REPO = Path(__file__).resolve().parents[2]
SQL_PATH = REPO / "supabase" / "schema_phase_firm.sql"
#: The two sibling migrations whose policies the cockpit routes read
#: under. The double evaluates ALL THREE files' policies.
SQL_REQUESTS_PATH = REPO / "supabase" / "schema_phase_firm_requests.sql"
SQL_ATTENTION_PATH = REPO / "supabase" / "schema_phase_firm_attention.sql"
CORPUS_CASE = REPO / "corpus" / "saga_10_col_carniprod" / "expected"
FIRM_MODULES = (
    REPO / "src" / "engine" / "api" / "_firm.py",
    REPO / "src" / "engine" / "api" / "_firm_invites.py",
    REPO / "src" / "engine" / "api" / "_firm_import.py",
)
#: The cockpit routers, scanned for role-name branches too (the write
#: census stays on FIRM_MODULES: the request landing writes a `documents`
#: row on the CLIENT's behalf, through the normal pipeline — FC7).
COCKPIT_MODULES = (
    REPO / "src" / "engine" / "api" / "_firm_requests.py",
    REPO / "src" / "engine" / "api" / "_firm_brief.py",
    REPO / "src" / "engine" / "api" / "_firm_attention.py",
)

#: The routers server.py mounts under /api/firm, IN MOUNT ORDER. Asserted
#: equal to server.py's own AST (test_the_fixture_mounts_exactly_what_
#: server_py_mounts) so a router added to production cannot be missing
#: from the sweep.
FIRM_ROUTERS = ("_firm", "_firm_requests", "_firm_brief", "_firm_attention")

#: The SECRET markers seeded into every table the cockpit routes read for
#: firm-A's client. None of them may ever appear in an intruder's answer.
SECRET_NOTE = "SECRET-A1-NOTE-7f3c"
SECRET_EMAIL = "secret-a1-7f3c@example.test"
SECRET_SUPPRESSION = "SECRET-A1-SUPPRESSION-7f3c"
SECRET_COVENANT = "SECRET-A1-COVENANT-7f3c"
SECRET_BRIEF = "SECRET-A1-BRIEF-7f3c"
SECRET_TOKEN = "SECRET-A1-TOKEN-7f3c.sig"
SECRET_EMAIL_SUBJECT = "SECRET-A1-EMAIL-7f3c"
SECRET_CADENCE_NUDGES = [97, 43]


# ══════════════════════════════════════════════════════════════════════
# THE RECORDED EXPECTATION — the matrix as this wave decided it (TC-6).
# Three sources must agree per cell: this table, the SQL seed, ROLE_MATRIX.
# ══════════════════════════════════════════════════════════════════════

EXPECTED_MATRIX = {
    # role          read   assign invite import request_file suppress manage
    "owner":      (True,  True,  True,  True,  True,        True,    True),
    "partner":    (True,  True,  True,  True,  True,        True,    False),
    "accountant": (True,  False, False, False, True,        True,    False),
    "assistant":  (True,  False, False, False, True,        False,   False),
    "viewer":     (True,  False, False, False, False,       False,   False),
}
EXPECTED_ROLES = ("owner", "partner", "accountant", "assistant", "viewer")
EXPECTED_ACTIONS = ("read", "assign", "invite", "import", "request_file",
                    "suppress", "manage")
CELLS = [(role, action) for role in EXPECTED_ROLES for action in EXPECTED_ACTIONS]


def expected_cell(role, action):  # type: (str, str) -> bool
    return EXPECTED_MATRIX[role][EXPECTED_ACTIONS.index(action)]


# ══════════════════════════════════════════════════════════════════════
# SQL parsing — the migration is the fixture
# ══════════════════════════════════════════════════════════════════════

def _sql_text():  # type: () -> str
    return SQL_PATH.read_text(encoding="utf-8")


def _strip_sql_comments(text):  # type: (str) -> str
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def parse_matrix(sql):  # type: (str) -> Dict[Tuple[str, str], bool]
    body = _strip_sql_comments(sql)
    m = re.search(r"insert into firm_role_permissions\s*\(role,\s*action,\s*allowed\)\s*values(.*?)on conflict",
                  body, re.S | re.I)
    assert m, "firm_role_permissions seed not found in the migration"
    cells = re.findall(r"\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(true|false)\s*\)", m.group(1), re.I)
    return dict(((role, action), value.lower() == "true") for role, action, value in cells)


def parse_roles(sql):  # type: (str) -> List[str]
    body = _strip_sql_comments(sql)
    m = re.search(r"insert into firm_roles\s*\(role,\s*rank,\s*description\)\s*values(.*?)on conflict",
                  body, re.S | re.I)
    assert m, "firm_roles seed not found"
    return re.findall(r"\(\s*'(\w+)'\s*,\s*\d+\s*,", m.group(1))


def _balanced(text, start):  # type: (str, int) -> str
    """text[start] must be '('; returns the content inside the matching ')'."""
    assert text[start] == "("
    depth = 0
    i = start
    in_str = False
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == "'":
                if i + 1 < len(text) and text[i + 1] == "'":
                    i += 1
                else:
                    in_str = False
        elif ch == "'":
            in_str = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
        i += 1
    raise AssertionError("unbalanced parentheses in policy text")


def parse_policies(sql):  # type: (str) -> List[Dict[str, str]]
    """Every `create policy` in the file: name, table, command, the USING
    expression and the WITH CHECK expression (an insert policy has only
    the latter; an update policy may carry both)."""
    body = _strip_sql_comments(sql)
    out = []  # type: List[Dict[str, str]]
    for m in re.finditer(r'create policy\s+"([^"]+)"\s+on\s+(\w+)\s+for\s+(select|insert|update|delete|all)\s*',
                         body, re.I):
        rest = body[m.end():]
        using_expr = None
        check_expr = None
        um = re.match(r"\s*using\s*\(", rest)
        if um:
            raw = _balanced(rest, um.end() - 1)
            using_expr = raw.strip()
            rest = rest[um.end() - 1 + len(raw) + 2:]
        cm = re.match(r"\s*with\s+check\s*\(", rest)
        if cm:
            check_expr = _balanced(rest, cm.end() - 1).strip()
        out.append({"name": m.group(1), "table": m.group(2).lower(),
                    "command": m.group(3).lower(), "using": using_expr or "",
                    "check": check_expr or ""})
    return out


def parse_functions(sql):  # type: (str) -> Dict[str, Dict[str, Any]]
    body = _strip_sql_comments(sql)
    out = {}  # type: Dict[str, Dict[str, Any]]
    for m in re.finditer(r"create or replace function\s+(\w+)\s*\((.*?)\)\s*returns\s+(.*?)\s+language\s+(\w+)(.*?)as\s+\$\$(.*?)\$\$\s*;",
                         body, re.S | re.I):
        name = m.group(1)
        attrs = m.group(5)
        out[name] = {
            "args": m.group(2).strip(),
            "returns": " ".join(m.group(3).split()),
            "language": m.group(4).lower(),
            "security_definer": bool(re.search(r"security\s+definer", attrs, re.I)),
            "search_path": bool(re.search(r"set\s+search_path\s*=\s*public", attrs, re.I)),
            "stable": bool(re.search(r"\bstable\b", attrs, re.I)),
            "body": m.group(6),
        }
    return out


def parse_table_columns(sql):  # type: (str) -> Dict[str, List[str]]
    body = _strip_sql_comments(sql)
    out = {}  # type: Dict[str, List[str]]
    for m in re.finditer(r"create table if not exists\s+(\w+)\s*\(", body, re.I):
        inner = _balanced(body, m.end() - 1)
        cols = []
        depth = 0
        current = []
        for ch in inner:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                cols.append("".join(current))
                current = []
            else:
                current.append(ch)
        cols.append("".join(current))
        names = []
        for col in cols:
            first = col.strip().split()
            if not first:
                continue
            head = first[0].lower()
            if head in ("primary", "unique", "check", "constraint", "foreign"):
                continue
            names.append(head)
        out[m.group(1).lower()] = names
    return out


def sql_actions_of(fn_body):  # type: (str) -> List[str]
    """The action literals a function asks firm_can() about."""
    return re.findall(r"firm_can\(\s*[\w().]+\s*,\s*'(\w+)'\s*\)", fn_body)


#: The privileges Supabase's project default grants every new table in
#: `public` to the API roles — `alter default privileges in schema public
#: grant all on tables to anon, authenticated, service_role`. Mirrored as
#: a fact about the deployment (not parsed: it is not in any migration);
#: the migrations' `revoke` / `grant` statements are parsed and applied
#: ON TOP of it, in file order (D1). `True` is a table-wide privilege, a
#: set is a column-level one, `False` is none.
API_ROLES = ("anon", "authenticated")
_TABLE_PRIVILEGE_OPS = ("insert", "update", "delete")


def parse_grants(sql):  # type: (str) -> List[Tuple[str, str, List[str], Any, List[str]]]
    """Every table-privilege statement in a migration, in order:
    ``(verb, table, [ops], columns-or-None, [roles])`` for
    ``revoke insert, update on T from anon, authenticated`` and
    ``grant update (a, b) on T to authenticated``. Function grants are
    not table privileges and are skipped (``on function`` never matches
    the ``on <table>`` shape below)."""
    body = _strip_sql_comments(sql)
    out = []  # type: List[Tuple[str, str, List[str], Any, List[str]]]
    rx = re.compile(
        r"\b(grant|revoke)\s+(all|(?:(?:insert|update|delete|select|truncate|references|trigger)"
        r"\s*(?:\([^)]*\))?\s*,?\s*)+)\s+on\s+(?:table\s+)?(\w+)\s+(?:to|from)\s+([\w\s,]+?)\s*;",
        re.I)
    for m in rx.finditer(body):
        verb, privs, table, roles = m.group(1).lower(), m.group(2), m.group(3).lower(), m.group(4)
        if table == "function":
            continue
        role_list = [r.strip().lower() for r in roles.split(",") if r.strip()]
        if privs.strip().lower() == "all":
            out.append((verb, table, list(_TABLE_PRIVILEGE_OPS) + ["select"], None, role_list))
            continue
        for pm in re.finditer(r"(insert|update|delete|select|truncate|references|trigger)\s*(\(([^)]*)\))?",
                              privs, re.I):
            op = pm.group(1).lower()
            cols = ([c.strip().lower() for c in pm.group(3).split(",") if c.strip()]
                    if pm.group(2) else None)
            out.append((verb, table, [op], cols, role_list))
    return out


def parse_triggers(sql):  # type: (str) -> List[Tuple[str, str, str, str]]
    """Every row trigger a migration creates: ``(table, timing, event,
    function)`` — the shape the migrations use (``before insert on T for
    each row execute function f()``)."""
    body = _strip_sql_comments(sql)
    out = []  # type: List[Tuple[str, str, str, str]]
    for m in re.finditer(r"create trigger\s+\w+\s+(before|after)\s+(insert|update|delete)"
                         r"(?:\s+or\s+(?:insert|update|delete))*\s+on\s+(\w+)\s+for each row\s+"
                         r"execute (?:function|procedure)\s+(\w+)\s*\(\s*\)", body, re.I):
        out.append((m.group(3).lower(), m.group(1).lower(), m.group(2).lower(), m.group(4)))
    return out


def parse_trigger_assignments(fn_body):  # type: (str) -> List[Tuple[str, Any]]
    """The ``new.<col> := <expr>;`` assignments of a plpgsql trigger body,
    each expression parsed by the policy interpreter — the only shape the
    era-pin trigger has. Any statement other than these, ``begin``,
    ``return new;`` and ``end;`` is refused: a trigger the double cannot
    evaluate must not be silently skipped."""
    out = []  # type: List[Tuple[str, Any]]
    for raw in fn_body.split(";"):
        stmt = raw.strip()
        if not stmt or stmt.lower() in ("begin", "end", "return new"):
            continue
        m = re.match(r"^(?:begin\s+)?new\.(\w+)\s*:=\s*(.+)$", stmt, re.I | re.S)
        if not m:
            raise AssertionError("trigger statement the double cannot evaluate: %r" % stmt)
        out.append((m.group(1).lower(), parse_policy_expr(m.group(2).strip())))
    return out


# ══════════════════════════════════════════════════════════════════════
# Policy-expression interpreter (the subset the migration uses)
# ══════════════════════════════════════════════════════════════════════

_TOKEN_RX = re.compile(
    r"(->>|<>|[(),=])|('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)|(\d+)")


def _tokenize(text):  # type: (str) -> List[Tuple[str, Any]]
    out = []  # type: List[Tuple[str, Any]]
    pos = 0
    while pos < len(text):
        if text[pos].isspace():
            pos += 1
            continue
        m = _TOKEN_RX.match(text, pos)
        if not m:
            raise AssertionError("cannot tokenize policy text at %r" % text[pos:pos + 40])
        pos = m.end()
        if m.group(1):
            out.append(("op", m.group(1)))
        elif m.group(2):
            out.append(("str", m.group(2)[1:-1].replace("''", "'")))
        elif m.group(3):
            out.append(("id", m.group(3)))
        else:
            out.append(("num", int(m.group(4))))
    return out


class _Parser(object):
    def __init__(self, tokens):  # type: (List[Tuple[str, Any]]) -> None
        self.t = tokens
        self.i = 0

    def _peek(self, kind=None, value=None):  # type: (Optional[str], Optional[str]) -> bool
        if self.i >= len(self.t):
            return False
        tok = self.t[self.i]
        if kind is not None and tok[0] != kind:
            return False
        if value is not None and str(tok[1]).lower() != value:
            return False
        return True

    def _take(self, kind=None, value=None):  # type: (Optional[str], Optional[str]) -> Tuple[str, Any]
        if not self._peek(kind, value):
            raise AssertionError("policy parse: expected %s %r at %r"
                                 % (kind, value, self.t[self.i:self.i + 4]))
        tok = self.t[self.i]
        self.i += 1
        return tok

    def parse(self):  # type: () -> Any
        node = self._or()
        if self.i != len(self.t):
            raise AssertionError("policy parse: trailing tokens %r" % self.t[self.i:])
        return node

    def _or(self):
        left = self._and()
        while self._peek("id", "or"):
            self._take()
            left = ("or", left, self._and())
        return left

    def _and(self):
        left = self._not()
        while self._peek("id", "and"):
            self._take()
            left = ("and", left, self._not())
        return left

    def _not(self):
        if self._peek("id", "not"):
            self._take()
            return ("not", self._not())
        return self._cmp()

    def _cmp(self):
        left = self._value()
        if self._peek("op", "="):
            self._take()
            return ("eq", left, self._value())
        if self._peek("op", "<>"):
            self._take()
            return ("neq", left, self._value())
        if self._peek("id", "is"):
            self._take()
            negated = False
            if self._peek("id", "not"):
                self._take()
                negated = True
            if self._peek("id", "distinct"):
                self._take()
                self._take("id", "from")
                return ("distinct", left, self._value(), negated)
            self._take("id", "null")
            return ("isnull", left, negated)
        return left

    def _value(self):
        tok = self._take()
        if tok == ("op", "("):
            node = self._or()
            self._take("op", ")")
            return self._postfix(node)
        if tok[0] == "str":
            return ("str", tok[1])
        if tok[0] == "num":
            return ("num", tok[1])
        if tok[0] != "id":
            raise AssertionError("policy parse: unexpected token %r" % (tok,))
        name = tok[1]
        low = name.lower()
        if low == "exists":
            return self._exists()
        if low == "select":
            return self._select()
        if low in ("true", "false"):
            return ("bool", low == "true")
        if low == "null":
            return ("null",)
        if low == "cast":
            # cast(<expr> as <type>) — the brief policies' firm_key pin.
            self._take("op", "(")
            inner = self._or()
            self._take("id", "as")
            target = self._take("id")[1].lower()
            self._take("op", ")")
            return self._postfix(("cast", inner, target))
        if self._peek("op", "("):
            self._take()
            args = []
            if not self._peek("op", ")"):
                args.append(self._or())
                while self._peek("op", ","):
                    self._take()
                    args.append(self._or())
            self._take("op", ")")
            return self._postfix(("call", low, args))
        return ("col", name)

    def _postfix(self, node):
        if self._peek("op", "->>"):
            self._take()
            key = self._take("str")
            return ("json", node, key[1])
        return node

    def _exists(self):
        self._take("op", "(")
        node = self._value()
        if node[0] != "select":
            raise AssertionError("exists() must wrap a select")
        self._take("op", ")")
        return ("exists", node)

    _FROM_STOP = ("where", "join", "on")

    def _from_item(self):
        """`table [as] [alias]`, or a set-returning call
        `unnest(x) [as] alias(col, …)` — the FROM shapes the migrations'
        `language sql` helpers use. Returns (source, alias, columns):
        `source` is a table name or a call node."""
        if self._peek("id") and self.i + 1 < len(self.t) and self.t[self.i + 1] == ("op", "(") \
                and str(self.t[self.i][1]).lower() not in ("exists", "select"):
            source = self._value()
        else:
            source = self._take("id")[1].lower()
        alias = None
        cols = []  # type: List[str]
        if self._peek("id", "as"):
            self._take()
        if self._peek("id") and str(self.t[self.i][1]).lower() not in self._FROM_STOP:
            alias = self._take("id")[1]
            if self._peek("op", "("):
                self._take()
                cols.append(self._take("id")[1])
                while self._peek("op", ","):
                    self._take()
                    cols.append(self._take("id")[1])
                self._take("op", ")")
        return source, alias, cols

    def _select(self):
        """select <expr> [from T [a] (join T [a] on <expr>)*] [where <expr>]
        — the whole shape the migration's `language sql` helpers use."""
        projection = self._or()
        froms = []
        if self._peek("id", "from"):
            self._take()
            source, alias, cols = self._from_item()
            froms.append((source, alias, cols, None))
            while self._peek("id", "join"):
                self._take()
                source, alias, cols = self._from_item()
                self._take("id", "on")
                froms.append((source, alias, cols, self._or()))
        where = None
        if self._peek("id", "where"):
            self._take()
            where = self._or()
        return ("select", projection, froms, where)


def parse_policy_expr(text):  # type: (str) -> Any
    return _Parser(_tokenize(text)).parse()


# ══════════════════════════════════════════════════════════════════════
# The SQL-derived Supabase double
# ══════════════════════════════════════════════════════════════════════

#: Select policies that already exist BEFORE this migration (schema.sql /
#: schema_phase3.sql), mirrored as text so they run through the same
#: interpreter. The firm migration's policies are parsed from the file.
BASE_SELECT_POLICIES = {
    "organizations": ("is_member_of(id)",),
    "memberships": ("auth.uid() = user_id",),
    "financial_periods": ("is_member_of(org_id)",),
    "documents": ("is_member_of(org_id)",),
    "statement_line_items": (
        "exists (select 1 from financial_periods p where p.id = period_id and is_member_of(p.org_id))",),
    "industry_profiles": ("true",),
    "caen_industry_mappings": ("true",),
}

#: The one pre-existing helper the firm helpers build on (schema_phase3.sql),
#: mirrored as SQL text so it runs through the same interpreter.
BASE_FUNCTIONS = {
    "is_member_of": {
        "language": "sql", "args": "_org_id uuid",
        "body": "select exists (select 1 from memberships "
                "where org_id = _org_id and user_id = auth.uid())",
    },
}

#: Columns of the pre-existing tables the double serves (firm tables come
#: from the migration text). A select of a column outside these raises —
#: PostgREST would 400, and a double that answered would hide the typo.
BASE_COLUMNS = {
    "organizations": ["id", "name", "industry_key", "industry_display_name",
                      "default_currency", "created_at", "updated_at", "archived_at",
                      "purge_after", "caen_code", "firm_id", "cui"],
    "memberships": ["user_id", "org_id", "role", "created_at"],
    "financial_periods": ["id", "org_id", "source_document_id", "period_start",
                          "period_end", "currency", "period_label", "status",
                          "assembled_canonical_v1", "caen_code", "created_at",
                          "updated_at"],
    "documents": ["id", "org_id", "original_filename", "status", "created_at"],
    "statement_line_items": ["id", "period_id", "statement", "bucket",
                             "ro_account_code", "ro_account_name", "amount"],
    "industry_profiles": ["key", "display_name", "is_active", "sector", "parent_key"],
    "caen_industry_mappings": ["caen_code", "caen_label_en", "caen_label_ro",
                               "industry_key", "parent_industry_key",
                               "match_quality", "confidence"],
}


class Refusal(Exception):
    """A Postgres `raise exception … using errcode` from an RPC."""

    def __init__(self, code, message):  # type: (str, str) -> None
        Exception.__init__(self, message)
        self.code = code
        self.message = message


def _pg_text(value):  # type: (Any) -> str
    """A cell as PostgREST compares it in a filter: booleans are
    `true`/`false`, everything else its text, case-folded."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).lower()


_COLUMN_SPEC_RX = re.compile(r"^(?:(?P<alias>[A-Za-z_][A-Za-z0-9_]*):)?(?P<col>[A-Za-z_][A-Za-z0-9_]*)(?P<path>(?:->>?[A-Za-z_][A-Za-z0-9_]*)*)$")


def _parse_column_spec(spec):  # type: (str) -> Tuple[str, str, List[Tuple[str, str]]]
    """PostgREST `select=` item -> (output name, base column, json path).
    `alias:col->a->>b` is what _firm_attention's LIGHT_PERIOD_COLUMNS
    sends; a spec the double cannot read raises, never returns nothing."""
    m = _COLUMN_SPEC_RX.match(spec.strip())
    if not m:
        raise AssertionError("double cannot express select item %r" % spec)
    path = re.findall(r"(->>?)([A-Za-z_][A-Za-z0-9_]*)", m.group("path") or "")
    return (m.group("alias") or m.group("col")), m.group("col"), path


def _json_walk(value, path):  # type: (Any, List[Tuple[str, str]]) -> Any
    for op, key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
        if op == "->>" and value is not None and not isinstance(value, str):
            value = json.dumps(value, sort_keys=True)
    return value


def _match_filter(row, column, expr):  # type: (Dict[str, Any], str, str) -> bool
    value = row.get(column)
    if expr == "is.null":
        return value is None
    if expr == "not.is.null":
        return value is not None
    if expr.startswith("eq."):
        return value is not None and _pg_text(value) == expr[3:].lower()
    if expr.startswith("neq."):
        return _pg_text(value) != expr[4:].lower()
    if expr.startswith("in.(") and expr.endswith(")"):
        # PostgREST accepts both `in.(a,b)` and `in.("a","b")`.
        wanted = [v.strip().strip('"').lower() for v in expr[4:-1].split(",") if v.strip()]
        return _pg_text(value) in wanted
    raise AssertionError(
        "double cannot express filter %r on %r — the real client would send it "
        "to PostgREST. Teach the double or change the query; never match everything."
        % (expr, column))


class FirmWorld(object):
    """Tables + the security predicates, derived from the migrations.

    `sql` is the tenancy migration (the matrix seed, the helpers);
    `sibling_sqls` are the cockpit migrations whose tables and policies
    the other /api/firm routers read under. Every select policy and
    every insert WITH CHECK of all three files is parsed here."""

    def __init__(self, sql, sibling_sqls=()):  # type: (str, Any) -> None
        self.sql = sql
        self.matrix = parse_matrix(sql)
        self.roles = parse_roles(sql)
        self.functions = {}  # type: Dict[str, Dict[str, Any]]
        self.columns = dict(BASE_COLUMNS)
        self.policies = {}  # type: Dict[str, List[Any]]
        self.insert_policies = {}  # type: Dict[str, List[Any]]
        #: table -> [(USING ast, WITH CHECK ast)]; a policy with no WITH
        #: CHECK uses its USING for the new row, as Postgres does.
        self.update_policies = {}  # type: Dict[str, List[Tuple[Any, Any]]]
        #: (role, table) -> {op: True (table-wide) | set(columns) | False}.
        #: Starts as Supabase's default grant for every table the double
        #: knows (API_ROLES: anon + authenticated), then the migrations'
        #: revoke / grant statements are applied in file order (D1).
        self.privileges = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]
        #: table -> [(timing, event, [(column, expr ast)])] — the BEFORE
        #: INSERT triggers parsed from the migrations (the era pin). Fired
        #: on EVERY insert, whoever inserts, before the WITH CHECK — the
        #: order Postgres fires them in.
        self.triggers = {}  # type: Dict[str, List[Tuple[str, str, List[Tuple[str, Any]]]]]
        for table, exprs in BASE_SELECT_POLICIES.items():
            self.policies.setdefault(table, []).extend(parse_policy_expr(e) for e in exprs)
        grant_statements = []  # type: List[Tuple[str, str, List[str], Any, List[str]]]
        trigger_rows = []  # type: List[Tuple[str, str, str, str]]
        for text in (sql,) + tuple(sibling_sqls):
            self.functions.update(parse_functions(text))
            self.columns.update(parse_table_columns(text))
            grant_statements.extend(parse_grants(text))
            trigger_rows.extend(parse_triggers(text))
            for pol in parse_policies(text):
                if pol["command"] == "select":
                    self.policies.setdefault(pol["table"], []).append(parse_policy_expr(pol["using"]))
                elif pol["command"] == "insert":
                    assert pol["check"], "insert policy %r has no WITH CHECK" % pol["name"]
                    self.insert_policies.setdefault(pol["table"], []).append(
                        parse_policy_expr(pol["check"]))
                elif pol["command"] == "update":
                    assert pol["using"], "update policy %r has no USING" % pol["name"]
                    using = parse_policy_expr(pol["using"])
                    check = parse_policy_expr(pol["check"]) if pol["check"] else using
                    self.update_policies.setdefault(pol["table"], []).append((using, check))
        self.tables = dict((name, []) for name in self.columns)  # type: Dict[str, List[Dict[str, Any]]]
        for role in API_ROLES:
            for table in self.columns:
                self.privileges[(role, table)] = dict((op, True) for op in _TABLE_PRIVILEGE_OPS)
        for verb, table, ops, cols, roles in grant_statements:
            for role in roles:
                if role not in API_ROLES:
                    continue
                for op in ops:
                    if op not in _TABLE_PRIVILEGE_OPS:
                        continue
                    if (role, table) not in self.privileges:
                        raise AssertionError("%s on unknown table %s" % (verb, table))
                    if verb == "revoke":
                        # a table-wide revoke drops column grants too, as Postgres does
                        self.privileges[(role, table)][op] = False
                    elif cols is None:
                        self.privileges[(role, table)][op] = True
                    else:
                        current = self.privileges[(role, table)][op]
                        if current is True:
                            continue
                        self.privileges[(role, table)][op] = set(current or ()) | set(cols)
        for table, timing, event, fn in trigger_rows:
            spec = self.functions.get(fn)
            if spec is None or spec["returns"].lower() != "trigger":
                # set_updated_at_now: a pre-existing function (schema_phase3)
                # this double does not model — it writes updated_at only.
                continue
            self.triggers.setdefault(table, []).append(
                (timing, event, parse_trigger_assignments(spec["body"])))
        self._body_cache = {}  # type: Dict[str, Any]
        # The matrix and the roles are ROWS, exactly as the migration seeds
        # them — firm_can() below joins these, it never consults Python.
        for rank, role in enumerate(self.roles, 1):
            self.tables["firm_roles"].append({"role": role, "rank": rank, "description": ""})
        for (role, action), allowed in sorted(self.matrix.items()):
            self.tables["firm_role_permissions"].append(
                {"role": role, "action": action, "allowed": allowed})
        self.auth_users = {}  # type: Dict[str, str]
        self.clock = datetime(2026, 9, 3, 12, 0, 0, tzinfo=timezone.utc)
        self._seq = 1000

    # ── clock + ids ──
    def tick(self, seconds=1):  # type: (int) -> str
        self.clock = self.clock + timedelta(seconds=seconds)
        return self.clock.isoformat()

    def now_iso(self):  # type: () -> str
        return self.clock.isoformat()

    def next_id(self):  # type: () -> str
        self._seq += 1
        return str(uuid.UUID(int=self._seq))

    # ── rows ──
    def rows(self, table):  # type: (str) -> List[Dict[str, Any]]
        if table not in self.tables:
            raise AssertionError("unknown table %r" % table)
        return self.tables[table]

    def add(self, table, row):  # type: (str, Dict[str, Any]) -> Dict[str, Any]
        cols = self.columns[table]
        unknown = set(row) - set(cols)
        if unknown:
            raise AssertionError("insert into %s names unknown column(s) %s" % (table, sorted(unknown)))
        full = dict((c, None) for c in cols)
        full.update(row)
        if "id" in cols and full.get("id") is None:
            full["id"] = self.next_id()
        if "token" in cols and full.get("token") is None:
            full["token"] = self.next_id()
        stamp = self.tick()
        for c in ("created_at", "updated_at"):
            if c in cols and full.get(c) is None:
                full[c] = stamp
        if table == "firm_invite_email_queue" and full.get("status") is None:
            full["status"] = "queued"
        if table == "client_assignments" and full.get("collaborator_user_ids") is None:
            full["collaborator_user_ids"] = []
        if table == "memberships" and full.get("role") is None:
            full["role"] = "owner"
        # BEFORE INSERT triggers fire on every insert — a seed, a
        # service-role write, a per-user one — as Postgres fires them.
        full = self.fire_before_insert(table, full)
        self.rows(table).append(full)
        return full

    # ── triggers and table privileges (parsed from the migrations) ──
    def _complete(self, table, row):  # type: (str, Dict[str, Any]) -> Dict[str, Any]
        """The row as the table would store it: every declared column,
        NULL where the caller sent nothing."""
        full = dict((c, None) for c in self.columns[table])
        full.update(row)
        return full

    def fire_before_insert(self, table, row):  # type: (str, Dict[str, Any]) -> Dict[str, Any]
        """Apply the table's BEFORE INSERT row triggers to `row` (the
        era pin: ``new.firm_id := firm_of_org(new.org_id)``). Pure on
        its input; returns the row the WITH CHECK then sees."""
        out = dict(row)
        for timing, event, assignments in self.triggers.get(table, ()):
            if timing != "before" or event != "insert":
                continue
            for column, expr in assignments:
                scope = {"uid": None, "email": None, "frames": [("new", out)]}
                out[column] = self._eval(expr, scope)
        return out

    def privilege(self, role, table, op):  # type: (str, str, str) -> Any
        return self.privileges[(role, table)][op]

    def check_privilege(self, role, table, op, columns):  # type: (str, str, str, Any) -> None
        """Postgres's FIRST wall, checked BEFORE any policy: the API role
        must hold the table privilege, or the column privilege for EVERY
        column the statement names (a PATCH's keys; an upsert's whole
        payload, since ON CONFLICT DO UPDATE sets each of them). Raises
        the refusal PostgREST returns — 42501 permission denied for the
        TABLE, which is how Postgres words a column-privilege failure."""
        held = self.privilege(role, table, op)
        if held is True:
            return
        named = set(str(c).lower() for c in columns)
        if held is False or (named - set(held)):
            raise Refusal("42501", "permission denied for table %s" % table)

    def plant_privileges(self, table, op="update", grant=True):  # type: (str, str, bool) -> None
        """Test hook: put the Supabase DEFAULT (table-wide) grant back on
        `table` for both API roles — the state every table was in before
        the migrations' column-privilege sections (a plant)."""
        for role in API_ROLES:
            self.privileges[(role, table)][op] = bool(grant)

    def plant_trigger_off(self, table):  # type: (str) -> None
        """Test hook: drop the table's BEFORE INSERT triggers (a plant)."""
        self.triggers.pop(table, None)

    # ── the SECURITY DEFINER helpers: their SQL bodies, evaluated ──
    def plant_function(self, name, body):  # type: (str, str) -> None
        """Test hook: replace a helper's SQL body (a plant), as an edit to
        the migration would — the pre-existing `is_member_of` included."""
        spec = self.functions.get(name) or BASE_FUNCTIONS.get(name)
        assert spec is not None, "no helper %s to plant" % name
        self.functions[name] = dict(spec, body=body)
        self._body_cache.pop(name, None)

    def plant_policy(self, table, using):  # type: (str, str) -> None
        """Test hook: replace EVERY select policy on `table` with one
        expression (a plant), as loosening the migration would."""
        assert table in self.policies, "no select policy on %s to loosen" % table
        self.policies[table] = [parse_policy_expr(using)]

    def plant_write_policy(self, table, check):  # type: (str, str) -> None
        """Test hook: replace EVERY insert WITH CHECK and every update
        USING / WITH CHECK on `table` with one expression (a plant)."""
        node = parse_policy_expr(check)
        self.insert_policies[table] = [node]
        self.update_policies[table] = [(node, node)]

    def plant_update_check(self, table, check):  # type: (str, str) -> None
        """Test hook: keep every update USING on `table`, replace every
        update WITH CHECK with one expression — the D1 defect's shape
        (`revoked_by = auth.uid()` and nothing else on the NEW row)."""
        assert self.update_policies.get(table), "no update policy on %s to loosen" % table
        node = parse_policy_expr(check)
        self.update_policies[table] = [(using, node) for using, _c in self.update_policies[table]]

    def plant_select_policy_text(self, table, using):  # type: (str, str) -> None
        """Test hook: replace every select policy on `table` with one
        expression (a plant on the MIGRATION's text — `plant_policy`
        under its D3 name, kept separate so a plant reads as one)."""
        self.plant_policy(table, using)

    def admit_insert(self, uid, email, table, row):  # type: (Optional[str], Optional[str], str, Dict[str, Any]) -> bool
        """PostgREST's WITH CHECK for a per-user insert: some insert
        policy on the table must accept the NEW row; none → refused."""
        policies = self.insert_policies.get(table) or []
        if not policies:
            return False
        # The WITH CHECK sees the row AFTER defaults and BEFORE INSERT
        # triggers — never the caller's bare payload (the era pin is the
        # trigger's value, whatever the caller sent).
        row = self.fire_before_insert(table, self._complete(table, row))
        scope = {"uid": uid, "email": email, "frames": [(None, row)]}
        return any(bool(self._eval(p, scope)) for p in policies)

    def admit_update(self, uid, email, table, old, new):  # type: (Optional[str], Optional[str], str, Dict[str, Any], Dict[str, Any]) -> str
        """Postgres' verdict on a per-user UPDATE of one row:
        "skip" — no update policy's USING selects the existing row (the
        row is simply not updated; PostgREST answers as if it were not
        there); "ok" — selected, and some policy's WITH CHECK admits the
        new row; "refuse" — selected, but no WITH CHECK admits the new
        row (42501)."""
        policies = self.update_policies.get(table) or []
        if not policies:
            return "skip"
        old_scope = {"uid": uid, "email": email, "frames": [(None, old)]}
        if not any(bool(self._eval(using, old_scope)) for using, _check in policies):
            return "skip"
        new_scope = {"uid": uid, "email": email, "frames": [(None, new)]}
        if any(bool(self._eval(check, new_scope)) for _using, check in policies):
            return "ok"
        return "refuse"

    def _fn(self, name, uid, args, email=None):  # type: (str, Optional[str], List[Any], Optional[str]) -> Any
        return self._call(name, list(args), {"uid": uid, "email": email, "frames": []})

    def is_member_of(self, uid, org_id):  # type: (Optional[str], Any) -> bool
        return bool(self._fn("is_member_of", uid, [org_id]))

    def is_firm_member_of(self, uid, firm_id):  # type: (Optional[str], Any) -> bool
        return bool(self._fn("is_firm_member_of", uid, [firm_id]))

    def firm_role_of(self, uid, firm_id):  # type: (Optional[str], Any) -> Optional[str]
        return self._fn("firm_role_of", uid, [firm_id])

    def firm_can(self, uid, firm_id, action):  # type: (Optional[str], Any, str) -> bool
        return bool(self._fn("firm_can", uid, [firm_id, action]))

    def firm_of_org(self, org_id):  # type: (Any) -> Optional[str]
        return self._fn("firm_of_org", None, [org_id])

    def can_read_client_org(self, uid, org_id):  # type: (Optional[str], Any) -> bool
        return bool(self._fn("can_read_client_org", uid, [org_id]))

    # ── policy evaluation ──
    def visible(self, uid, email, table, row):  # type: (Optional[str], Optional[str], str, Dict[str, Any]) -> bool
        policies = self.policies.get(table) or []
        if not policies:
            return False  # RLS enabled, no policy: deny-by-default
        scope = {"uid": uid, "email": email, "frames": [(None, row)]}
        return any(bool(self._eval(p, scope)) for p in policies)

    def _eval(self, node, scope):  # type: (Any, Dict[str, Any]) -> Any
        kind = node[0]
        if kind == "or":
            return bool(self._eval(node[1], scope)) or bool(self._eval(node[2], scope))
        if kind == "and":
            return bool(self._eval(node[1], scope)) and bool(self._eval(node[2], scope))
        if kind == "not":
            return not bool(self._eval(node[1], scope))
        if kind == "eq":
            a = self._eval(node[1], scope)
            b = self._eval(node[2], scope)
            return a is not None and b is not None and str(a) == str(b)
        if kind == "neq":
            a = self._eval(node[1], scope)
            b = self._eval(node[2], scope)
            return a is not None and b is not None and str(a) != str(b)
        if kind == "isnull":
            value = self._eval(node[1], scope)
            return (value is None) != node[2]
        if kind == "distinct":
            a = self._eval(node[1], scope)
            b = self._eval(node[2], scope)
            differ = (None if a is None else str(a)) != (None if b is None else str(b))
            return (not differ) if node[3] else differ
        if kind in ("str", "num", "bool"):
            return node[1]
        if kind == "cast":
            value = self._eval(node[1], scope)
            if value is None:
                return None
            if node[2] == "text":
                return str(value)
            raise AssertionError("cast to %r is not modelled" % node[2])
        if kind == "null":
            return None
        if kind == "col":
            return self._column(node[1], scope)
        if kind == "json":
            obj = self._eval(node[1], scope)
            return (obj or {}).get(node[2]) if isinstance(obj, dict) else None
        if kind == "call":
            return self._call(node[1], [self._eval(a, scope) for a in node[2]], scope)
        if kind == "exists":
            for _row_scope in self._select_scopes(node[1], scope):
                return True
            return False
        if kind == "select":
            projection = node[1]
            for row_scope in self._select_scopes(node, scope):
                return self._eval(projection, row_scope)
            return None
        raise AssertionError("unsupported policy node %r" % (node,))

    def _select_scopes(self, node, scope):  # type: (Any, Dict[str, Any]) -> Any
        """Every row-combination scope a `select` yields (nested loops over
        its FROM/JOIN items, ON and WHERE applied). A FROM-less select
        yields the caller's scope once. A set-returning FROM item
        (`unnest(x) as u(id)`) yields one frame per element."""
        _, _projection, froms, where = node
        if not froms:
            yield scope
            return

        def _walk(i, frames):
            if i == len(froms):
                inner = {"uid": scope["uid"], "email": scope["email"],
                         "frames": frames + scope["frames"]}
                if where is None or bool(self._eval(where, inner)):
                    yield inner
                return
            source, alias, cols, on = froms[i]
            if isinstance(source, str):
                candidates = self.rows(source)
            else:
                outer = {"uid": scope["uid"], "email": scope["email"],
                         "frames": frames + scope["frames"]}
                values = self._eval(source, outer)
                if values is None:
                    values = []
                if not isinstance(values, (list, tuple)):
                    raise AssertionError("set-returning FROM item %r yielded %r" % (source, values))
                name = cols[0] if cols else (alias or "value")
                candidates = [{name: v} for v in values]
            for row in candidates:
                new_frames = [(alias, row)] + frames
                inner = {"uid": scope["uid"], "email": scope["email"],
                         "frames": new_frames + scope["frames"]}
                if on is not None and not bool(self._eval(on, inner)):
                    continue
                for out in _walk(i + 1, new_frames):
                    yield out

        for out in _walk(0, []):
            yield out

    def _sql_function(self, name):  # type: (str) -> Optional[Dict[str, Any]]
        spec = self.functions.get(name) or BASE_FUNCTIONS.get(name)
        if spec is None or spec.get("language") != "sql":
            return None
        return spec

    def _body_ast(self, name, spec):  # type: (str, Dict[str, Any]) -> Any
        cached = self._body_cache.get(name)
        if cached is None:
            text = spec["body"].strip().rstrip(";").strip()
            cached = parse_policy_expr(text)
            self._body_cache[name] = cached
        return cached

    def _column(self, name, scope):  # type: (str, Dict[str, Any]) -> Any
        if "." in name:
            alias, col = name.split(".", 1)
            for frame_alias, row in scope["frames"]:
                if frame_alias == alias:
                    return row.get(col)
            raise AssertionError("policy references unknown alias %r" % alias)
        for _alias, row in scope["frames"]:
            if name in row:
                return row.get(name)
        raise AssertionError("policy references unknown column %r" % name)

    def _call(self, name, args, scope):  # type: (str, List[Any], Dict[str, Any]) -> Any
        uid = scope["uid"]
        if name == "auth.uid":
            return uid
        if name == "auth.jwt":
            return {"sub": uid, "email": scope["email"]}
        if name == "lower":
            return None if args[0] is None else str(args[0]).lower()
        if name == "coalesce":
            for a in args:
                if a is not None:
                    return a
            return None
        if name == "unnest":
            value = args[0]
            if value is None:
                return []
            return list(value) if isinstance(value, (list, tuple)) else [value]
        spec = self._sql_function(name)
        if spec is not None:
            params = [a.split()[0] for a in spec["args"].split(",") if a.strip()]
            if len(params) != len(args):
                raise AssertionError("%s takes %d argument(s), called with %d"
                                     % (name, len(params), len(args)))
            frame = dict(zip(params, args))
            inner = {"uid": uid, "email": scope["email"],
                     "frames": [(None, frame)] + scope["frames"]}
            return self._eval(self._body_ast(name, spec), inner)
        raise AssertionError("policy calls a function the double does not know: %s" % name)

    # ── RPCs (guards read out of the SQL body) ──
    def _guarded_actions(self, fn):  # type: (str) -> List[str]
        spec = self.functions.get(fn)
        if spec is None:
            raise AssertionError("RPC %s is not defined in the migration" % fn)
        return sql_actions_of(spec["body"])

    def _require_action(self, fn, uid, firm_id, action):  # type: (str, Optional[str], Any, str) -> None
        actions = self._guarded_actions(fn)
        if action not in actions:
            raise AssertionError(
                "SQL body of %s no longer asks firm_can(…, '%s') — the double refuses "
                "to enforce a guard the database does not have" % (fn, action))
        if not self.firm_can(uid, firm_id, action):
            raise Refusal("42501", "Your firm role does not hold '%s'." % action)

    def _audit(self, firm_id, uid, action, target):  # type: (Any, Optional[str], str, Dict[str, Any]) -> None
        self.add("firm_audit_log", {"firm_id": firm_id, "actor_user_id": uid,
                                    "action": action, "target": target})

    def _is_org_owner(self, uid, org_id):  # type: (Optional[str], Any) -> bool
        return any(r["org_id"] == str(org_id) and r["user_id"] == uid and r["role"] == "owner"
                   for r in self.rows("memberships"))

    def rpc(self, uid, email, fn, params):  # type: (Optional[str], Optional[str], str, Dict[str, Any]) -> Any
        p = params or {}
        if fn == "create_firm":
            if uid is None:
                raise Refusal("28000", "Not authenticated.")
            name = (p.get("p_name") or "").strip()
            if not name:
                raise Refusal("22023", "Firm name is required.")
            firm = self.add("firms", {"name": name, "created_by": uid})
            self.add("firm_memberships", {"firm_id": firm["id"], "user_id": uid, "role": "owner"})
            self._audit(firm["id"], uid, "firm.create", {"name": name})
            return firm["id"]

        if fn == "list_firms":
            out = []
            for m in self.rows("firm_memberships"):
                if m["user_id"] != uid:
                    continue
                firm = next(f for f in self.rows("firms") if f["id"] == m["firm_id"])
                out.append({
                    "id": firm["id"], "name": firm["name"], "role": m["role"],
                    "member_count": sum(1 for x in self.rows("firm_memberships") if x["firm_id"] == firm["id"]),
                    "client_count": sum(1 for o in self.rows("organizations")
                                        if o.get("firm_id") == firm["id"] and o.get("archived_at") is None),
                    "archived_at": firm.get("archived_at"), "created_at": firm["created_at"],
                })
            return sorted(out, key=lambda r: r["created_at"])

        if fn == "list_firm_members":
            firm_id = p.get("p_firm_id")
            assert "is_firm_member_of(p_firm_id)" in self.functions[fn]["body"]
            if not self.is_firm_member_of(uid, firm_id):
                return []
            return [{"user_id": m["user_id"], "email": self.auth_users.get(m["user_id"]),
                     "role": m["role"], "created_at": m["created_at"]}
                    for m in self.rows("firm_memberships") if m["firm_id"] == firm_id]

        if fn == "list_firm_clients":
            firm_id = p.get("p_firm_id")
            actions = self._guarded_actions(fn)
            assert actions == ["read"], "list_firm_clients must be gated by the read cell"
            if not self.firm_can(uid, firm_id, "read"):
                return []
            out = []
            for o in self.rows("organizations"):
                if o.get("firm_id") != firm_id:
                    continue
                a = next((x for x in self.rows("client_assignments") if x["org_id"] == o["id"]), {})
                out.append({"org_id": o["id"], "name": o["name"], "cui": o.get("cui"),
                            "industry_key": o.get("industry_key"),
                            "industry_display_name": o.get("industry_display_name"),
                            "default_currency": o.get("default_currency"),
                            "archived_at": o.get("archived_at"),
                            "responsible_user_id": a.get("responsible_user_id"),
                            "collaborator_user_ids": list(a.get("collaborator_user_ids") or []),
                            "import_resolution": a.get("import_resolution"),
                            "attached_at": a.get("created_at")})
            return sorted(out, key=lambda r: (r["name"] or "", r["org_id"]))

        if fn == "attach_workspace_to_firm":
            org_id, firm_id = p.get("p_org_id"), p.get("p_firm_id")
            assert "role = 'owner'" in self.functions[fn]["body"]
            if not self._is_org_owner(uid, org_id):
                raise Refusal("42501", "Only the workspace owner can attach it to a firm.")
            self._require_action(fn, uid, firm_id, "import")
            firm = next((f for f in self.rows("firms") if f["id"] == firm_id), None)
            if firm and firm.get("archived_at"):
                raise Refusal("P0001", "Firm is archived.")
            org = next(o for o in self.rows("organizations") if o["id"] == org_id)
            if org.get("firm_id") is not None:
                raise Refusal("P0001", "Workspace is already attached to a firm.")
            org["firm_id"] = firm_id
            existing = next((x for x in self.rows("client_assignments") if x["org_id"] == org_id), None)
            if existing:
                existing["firm_id"] = firm_id
            else:
                self.add("client_assignments", {"firm_id": firm_id, "org_id": org_id})
            self._audit(firm_id, uid, "client.attach", {"org_id": org_id})
            return None

        if fn == "import_firm_client":
            firm_id = p.get("p_firm_id")
            if uid is None:
                raise Refusal("28000", "Not authenticated.")
            self._require_action(fn, uid, firm_id, "import")
            firm = next((f for f in self.rows("firms") if f["id"] == firm_id), None)
            if firm and firm.get("archived_at"):
                raise Refusal("P0001", "Firm is archived.")
            name = (p.get("p_name") or "").strip()
            cui = (p.get("p_cui") or "").strip()
            if not name or not cui:
                raise Refusal("22023", "A client needs a name and a CUI.")
            if any(o.get("firm_id") == firm_id and o.get("cui") == cui for o in self.rows("organizations")):
                raise Refusal("23505", "Already a client of this firm.")
            resp = p.get("p_responsible")
            if resp is not None and not self.is_firm_member_of(resp, firm_id):
                raise Refusal("22023", "Responsible accountant must be a member of the firm.")
            body = self.functions[fn]["body"]
            for needle in ("insert into organizations", "insert into memberships",
                           "insert into client_assignments"):
                assert needle in body, "import_firm_client lost its %r" % needle
            org = self.add("organizations", {
                "name": name, "cui": cui, "firm_id": firm_id,
                "industry_key": p.get("p_industry_key"),
                "industry_display_name": p.get("p_industry_display_name"),
                "caen_code": p.get("p_caen_code")})
            self.add("memberships", {"user_id": uid, "org_id": org["id"], "role": "owner"})
            if resp is not None and resp != uid:
                self.add("memberships", {"user_id": resp, "org_id": org["id"], "role": "admin"})
            resolution = p.get("p_resolution") or {}
            self.add("client_assignments", {"firm_id": firm_id, "org_id": org["id"],
                                            "responsible_user_id": resp,
                                            "collaborator_user_ids": [],
                                            "import_resolution": resolution})
            self._audit(firm_id, uid, "client.import", {
                "org_id": org["id"], "cui": cui, "name": name,
                "industry_status": (resolution.get("industry") or {}).get("status"),
                "responsible_status": (resolution.get("responsible") or {}).get("status")})
            return org["id"]

        if fn == "detach_workspace_from_firm":
            org_id = p.get("p_org_id")
            firm_id = self.firm_of_org(org_id)
            if firm_id is None:
                raise Refusal("P0002", "Workspace is not attached to a firm.")
            assert "role = 'owner'" in self.functions[fn]["body"]
            assert "manage" in self._guarded_actions(fn)
            if not self._is_org_owner(uid, org_id) and not self.firm_can(uid, firm_id, "manage"):
                raise Refusal("42501", "Only the workspace owner or the firm's manager can detach it.")
            org = next(o for o in self.rows("organizations") if o["id"] == org_id)
            org["firm_id"] = None
            self.tables["client_assignments"] = [x for x in self.rows("client_assignments")
                                                 if x["org_id"] != org_id]
            self._audit(firm_id, uid, "client.detach", {"org_id": org_id})
            return None

        if fn == "assign_client":
            org_id = p.get("p_org_id")
            firm_id = self.firm_of_org(org_id)
            if firm_id is None:
                raise Refusal("P0002", "Workspace is not a client of any firm.")
            self._require_action(fn, uid, firm_id, "assign")
            resp = p.get("p_responsible")
            collabs = list(p.get("p_collaborators") or [])
            if resp is not None and not self.is_firm_member_of(resp, firm_id):
                raise Refusal("22023", "Responsible accountant must be a member of the firm.")
            for c in collabs:
                if not self.is_firm_member_of(c, firm_id):
                    raise Refusal("22023", "Every collaborator must be a member of the firm.")
            existing = next((x for x in self.rows("client_assignments") if x["org_id"] == org_id), None)
            if existing:
                existing["responsible_user_id"] = resp
                existing["collaborator_user_ids"] = collabs
            else:
                self.add("client_assignments", {"firm_id": firm_id, "org_id": org_id,
                                                "responsible_user_id": resp,
                                                "collaborator_user_ids": collabs})
            self._audit(firm_id, uid, "client.assign",
                        {"org_id": org_id, "responsible": resp, "collaborators": collabs})
            return None

        if fn == "set_firm_member_role":
            firm_id, target, role = p.get("p_firm_id"), p.get("p_user_id"), p.get("p_role")
            self._require_action(fn, uid, firm_id, "manage")
            if role not in self.roles:
                raise Refusal("22023", "Unknown firm role.")
            row = next((m for m in self.rows("firm_memberships")
                        if m["firm_id"] == firm_id and m["user_id"] == target), None)
            if row is None:
                raise Refusal("P0002", "Not a member of this firm.")
            owners = sum(1 for m in self.rows("firm_memberships")
                         if m["firm_id"] == firm_id and m["role"] == "owner")
            if row["role"] == "owner" and role != "owner" and owners <= 1:
                raise Refusal("P0001", "Cannot demote the last owner.")
            old = row["role"]
            row["role"] = role
            self._audit(firm_id, uid, "member.role", {"user_id": target, "from": old, "to": role})
            return None

        if fn == "remove_firm_member":
            firm_id, target = p.get("p_firm_id"), p.get("p_user_id")
            if target != uid:
                self._require_action(fn, uid, firm_id, "manage")
            row = next((m for m in self.rows("firm_memberships")
                        if m["firm_id"] == firm_id and m["user_id"] == target), None)
            if row is None:
                raise Refusal("P0002", "Not a member of this firm.")
            owners = sum(1 for m in self.rows("firm_memberships")
                         if m["firm_id"] == firm_id and m["role"] == "owner")
            if row["role"] == "owner" and owners <= 1:
                raise Refusal("P0001", "Cannot remove the last owner.")
            self.tables["firm_memberships"] = [m for m in self.rows("firm_memberships") if m is not row]
            for a in self.rows("client_assignments"):
                if a["firm_id"] == firm_id and a.get("responsible_user_id") == target:
                    a["responsible_user_id"] = None
                if a["firm_id"] == firm_id:
                    a["collaborator_user_ids"] = [c for c in a.get("collaborator_user_ids") or [] if c != target]
            self._audit(firm_id, uid, "member.remove",
                        {"user_id": target, "role": row["role"], "self": target == uid})
            return None

        if fn == "create_firm_invitation":
            firm_id = p.get("p_firm_id")
            self._require_action(fn, uid, firm_id, "invite")
            email_v = (p.get("p_email") or "").strip().lower()
            role = p.get("p_role")
            ttl = min(max(int(p.get("p_ttl_hours") or 168), 1), 720)
            if not email_v or "@" not in email_v:
                raise Refusal("22023", "A valid e-mail is required.")
            if role not in self.roles:
                raise Refusal("22023", "Unknown firm role.")
            assert "p_role = 'owner'" in self.functions[fn]["body"]
            if role == "owner":
                self._require_action(fn, uid, firm_id, "manage")
            inv = self.add("firm_invitations", {
                "firm_id": firm_id, "email": email_v, "role": role, "invited_by": uid,
                "expires_at": (self.clock + timedelta(hours=ttl)).isoformat()})
            self._audit(firm_id, uid, "invite.create",
                        {"invitation_id": inv["id"], "email": email_v, "role": role, "ttl_hours": ttl})
            return inv["id"]

        if fn == "accept_firm_invitation":
            if uid is None:
                raise Refusal("28000", "Not authenticated.")
            body = self.functions[fn]["body"]
            for needle in ("revoked_at is not null", "accepted_at is not null",
                           "expires_at < now()", "auth.jwt() ->> 'email'"):
                assert needle in body, "accept_firm_invitation lost its %r check" % needle
            token = p.get("p_token")
            inv = next((i for i in self.rows("firm_invitations") if i["token"] == token), None)
            if inv is None:
                raise Refusal("P0002", "Invitation not found.")
            if inv.get("revoked_at"):
                raise Refusal("P0001", "Invitation was revoked.")
            if inv.get("accepted_at"):
                raise Refusal("P0001", "Invitation was already accepted.")
            if datetime.fromisoformat(inv["expires_at"]) < self.clock:
                raise Refusal("P0001", "Invitation has expired.")
            if not email or inv["email"].lower() != email.lower():
                raise Refusal("42501", "This invitation was sent to a different e-mail address.")
            existing = next((m for m in self.rows("firm_memberships")
                             if m["firm_id"] == inv["firm_id"] and m["user_id"] == uid), None)
            if existing:
                existing["role"] = inv["role"]
            else:
                self.add("firm_memberships", {"firm_id": inv["firm_id"], "user_id": uid, "role": inv["role"]})
            inv["accepted_at"] = self.now_iso()
            inv["accepted_by"] = uid
            self._audit(inv["firm_id"], uid, "invite.accept", {"invitation_id": inv["id"], "role": inv["role"]})
            return inv["firm_id"]

        if fn == "revoke_firm_invitation":
            inv = next((i for i in self.rows("firm_invitations") if i["id"] == p.get("p_invitation_id")), None)
            if inv is None:
                raise Refusal("P0002", "Invitation not found.")
            self._require_action(fn, uid, inv["firm_id"], "invite")
            if not inv.get("revoked_at") and not inv.get("accepted_at"):
                inv["revoked_at"] = self.now_iso()
            self._audit(inv["firm_id"], uid, "invite.revoke", {"invitation_id": inv["id"]})
            return None

        raise AssertionError("RPC %r is not modelled by the double" % fn)


class _Client(object):
    """Shared SupabaseClient surface. `service_role=True` is
    `_supabase.admin()` (RLS bypassed). Otherwise `uid` is the JWT's
    subject — or None for a bearer this backend could not decode, which
    is PostgREST's `anon`: auth.uid() NULL, every policy false, every
    write refused. An undecodable JWT is NEVER the service role (W4)."""

    def __init__(self, world, uid, email, service_role=False):  # type: (FirmWorld, Optional[str], Optional[str], bool) -> None
        self.world = world
        self.uid = uid
        self.email = email
        self.service_role = bool(service_role)
        self.url = "http://firm-double.local"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def close(self):
        return None

    def get_user(self, jwt):  # type: (str) -> Dict[str, Any]
        from firm_postgrest_double import verified_identity
        return verified_identity(jwt)

    def _visible_rows(self, table):  # type: (str) -> List[Dict[str, Any]]
        rows = self.world.rows(table)
        if self.service_role:
            return rows
        return [r for r in rows if self.world.visible(self.uid, self.email, table, r)]

    def _refusal(self, table):  # type: (str) -> RuntimeError
        return RuntimeError(
            "Supabase write to %s failed (HTTP 403): {'code': '42501', "
            "'message': 'new row violates row-level security policy for table \"%s\"'}"
            % (table, table))

    @property
    def api_role(self):  # type: () -> str
        """PostgREST's role for this bearer: `authenticated` for a
        decodable JWT, `anon` for none (W4). The service role bypasses
        both the privilege wall and RLS."""
        return "authenticated" if self.uid else "anon"

    def _privilege(self, table, op, columns):  # type: (str, str, Any) -> None
        """Postgres's FIRST wall — the table / column privilege — checked
        BEFORE any policy, exactly as the planner does; a failure is the
        42501 PostgREST returns, worded for the TABLE (D1)."""
        if self.service_role:
            return
        try:
            self.world.check_privilege(self.api_role, table, op, columns)
        except Refusal as exc:
            raise RuntimeError(
                "Supabase write to %s failed (HTTP %d): {'code': '%s', 'message': '%s'}"
                % (table, 403 if self.uid else 401, exc.code, exc.message))

    def select(self, table, filters=None, columns="*", limit=None, order=None, single=False):
        out = [copy.deepcopy(r) for r in self._visible_rows(table)]
        # `offset` / `limit` inside `filters` are PostgREST's reserved query
        # keywords, not columns: the real client forwards `filters` verbatim
        # into the query string, which is the wire the page walk
        # (engine.api._paging.select_all — every _firm* list read, D11)
        # rides. Applied after ordering, as PostgREST applies them.
        params = dict(filters or {})
        offset = int(params.pop("offset", 0) or 0)
        keyword_limit = params.pop("limit", None)
        if limit is None and keyword_limit is not None:
            limit = int(keyword_limit)
        for column, expr in params.items():
            if column not in self.world.columns[table]:
                # PostgREST answers 400 for a filter on a column the
                # table does not have; the client raises on it.
                raise RuntimeError("HTTP 400: column %s.%s does not exist" % (table, column))
            out = [r for r in out if _match_filter(r, column, expr)]
        if order:
            for spec in reversed(order.split(",")):
                key = spec.split(".")[0]
                desc = spec.endswith(".desc")
                out.sort(key=lambda r: (r.get(key) is None, str(r.get(key) or "")), reverse=desc)
        if offset:
            out = out[offset:]
        if limit is not None:
            out = out[:limit]
        if columns != "*":
            specs = [_parse_column_spec(c) for c in columns.split(",") if c.strip()]
            for _name, base, _path in specs:
                if base not in self.world.columns[table]:
                    raise RuntimeError("HTTP 400: column %s.%s does not exist" % (table, base))
            out = [dict((name, _json_walk(r.get(base), path) if path else r.get(base))
                        for name, base, path in specs) for r in out]
        if single:
            out = out[:1]
        return out

    def _full(self, table, r):  # type: (str, Dict[str, Any]) -> Dict[str, Any]
        cols = self.world.columns[table]
        unknown = set(r) - set(cols)
        if unknown:
            raise AssertionError("write to %s names unknown column(s) %s" % (table, sorted(unknown)))
        full = dict((c, None) for c in cols)
        full.update(r)
        return full

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        for r in rows_list:
            self._privilege(table, "insert", r.keys())
        if not self.service_role:
            # A per-user insert is admitted ONLY by an insert policy's
            # WITH CHECK parsed from the migration — evaluated on the row
            # as it would be stored (defaults filled, BEFORE INSERT
            # triggers fired), before it lands.
            for r in rows_list:
                if not self.world.admit_insert(self.uid, self.email, table, self._full(table, r)):
                    raise self._refusal(table)
        stored = [copy.deepcopy(self.world.add(table, copy.deepcopy(r))) for r in rows_list]
        return stored if returning else []

    def upsert(self, table, rows, on_conflict, returning=False):
        """INSERT … ON CONFLICT DO UPDATE. Per user, as Postgres decides
        it: the INSERT WITH CHECK on the proposed row first; then, on a
        conflict, the UPDATE policies' USING on the EXISTING row (an
        error when it fails — not a skip) and WITH CHECK on the merged
        row. The conflict itself is physical, never RLS-scoped."""
        rows_list = rows if isinstance(rows, list) else [rows]
        keys = [k.strip() for k in on_conflict.split(",") if k.strip()]
        out = []
        for r in rows_list:
            # Privileges are checked at PLAN time, conflict or not: INSERT on
            # the payload's columns AND UPDATE on every one of them (the
            # ON CONFLICT DO UPDATE SET list PostgREST generates).
            self._privilege(table, "insert", r.keys())
            self._privilege(table, "update", r.keys())
            existing = next((row for row in self.world.rows(table)
                             if all(str(row.get(k)) == str(r.get(k)) for k in keys)), None)
            if not self.service_role:
                if not self.world.admit_insert(self.uid, self.email, table, self._full(table, r)):
                    raise self._refusal(table)
                if existing is not None:
                    merged = dict(existing)
                    merged.update(r)
                    if self.world.admit_update(self.uid, self.email, table, existing, merged) != "ok":
                        raise self._refusal(table)
            if existing is None:
                out.append(copy.deepcopy(self.world.add(table, copy.deepcopy(r))))
            else:
                self._full(table, r)
                existing.update(copy.deepcopy(r))
                out.append(copy.deepcopy(existing))
        return out if returning else []

    def update(self, table, patch, filters):
        """PATCH. FIRST the privilege wall (the columns the patch names,
        before any row is looked at — a refused column is 42501 even
        when the filter matches nothing). Then, per user: only rows the
        SELECT policies show AND an update policy's USING selects are
        touched (the rest are silently left — PostgREST answers 204
        either way); a touched row whose new shape no WITH CHECK admits
        is a 42501 refusal."""
        self._privilege(table, "update", patch.keys())
        for row in self.world.rows(table):
            if not all(_match_filter(row, c, e) for c, e in filters.items()):
                continue
            if not self.service_role:
                if not self.world.visible(self.uid, self.email, table, row):
                    continue
                merged = dict(row)
                merged.update(patch)
                verdict = self.world.admit_update(self.uid, self.email, table, row, merged)
                if verdict == "skip":
                    continue
                if verdict == "refuse":
                    raise self._refusal(table)
            row.update(copy.deepcopy(patch))

    def delete(self, table, filters):
        if not self.service_role:
            raise AssertionError("per-user delete of %s is not modelled" % table)
        self.world.tables[table] = [r for r in self.world.rows(table)
                                    if not all(_match_filter(r, c, e) for c, e in filters.items())]

    def rpc(self, fn, params=None):
        if self.service_role:
            raise AssertionError("the firm modules must call RPCs as the USER, never as service role")
        try:
            return self.world.rpc(self.uid, self.email, fn, params or {})
        except Refusal as exc:
            detail = {"code": exc.code, "details": None, "hint": None, "message": exc.message}
            raise RuntimeError("rpc %s failed (%d): %s" % (fn, 400, detail))


# ══════════════════════════════════════════════════════════════════════
# The world — two firms, one solo workspace, real engine output
# ══════════════════════════════════════════════════════════════════════

def U(n):  # type: (int) -> str
    return str(uuid.UUID(int=n))


A_OWNER, A_PARTNER, A_ACCOUNTANT, A_ASSISTANT, A_VIEWER = U(1), U(2), U(3), U(4), U(5)
B_OWNER, B_VIEWER = U(11), U(12)
SOLO = U(21)
NOBODY = U(31)
EMAILS = {
    A_OWNER: "a.owner@example.test", A_PARTNER: "a.partner@example.test",
    A_ACCOUNTANT: "a.accountant@example.test", A_ASSISTANT: "a.assistant@example.test",
    A_VIEWER: "a.viewer@example.test", B_OWNER: "b.owner@example.test",
    B_VIEWER: "b.viewer@example.test", SOLO: "solo@example.test",
    NOBODY: "nobody@example.test",
}
FIRM_A, FIRM_B = U(101), U(102)
ORG_A1, ORG_A2, ORG_B1, ORG_S, ORG_P = U(201), U(202), U(203), U(204), U(205)
PERIOD_A1, PERIOD_A2, PERIOD_B1, PERIOD_S = U(301), U(302), U(303), U(304)
ROLE_USER = {"owner": A_OWNER, "partner": A_PARTNER, "accountant": A_ACCOUNTANT,
             "assistant": A_ASSISTANT, "viewer": A_VIEWER}


def _jwt(user_id, email):  # type: (str, str) -> str
    # A REAL ES256 bearer signed by the session's test key (the backend verifies
    # signatures since the FC1 close-out: an unsigned bearer is 401 everywhere).
    from firm_postgrest_double import mint_jwt
    return mint_jwt(user_id, email)


def hdr(user_id, org_id=None):  # type: (str, Optional[str]) -> Dict[str, str]
    out = {"Authorization": "Bearer %s" % _jwt(user_id, EMAILS[user_id])}
    if org_id:
        out["X-Org-Id"] = org_id
    return out


@pytest.fixture(scope="module")
def served_envelope():
    """REAL engine output: the corpus case's served canonical_bs, wrapped as
    the persisted assembled_canonical_v1 the pipeline writes."""
    served = json.loads((CORPUS_CASE / "served_envelope.json").read_text(encoding="utf-8"))
    return {"canonical_bs": served,
            "provenance": {"source_document_id": "doc-carniprod",
                           "content_hash": "sha256-carniprod",
                           "written_at": "2026-08-30T00:00:00+00:00"}}


@pytest.fixture(scope="module")
def gateway_facts():
    return json.loads((CORPUS_CASE / "gateway_facts.json").read_text(encoding="utf-8"))


REQUEST_A1, REQUEST_B1 = U(501), U(502)
COVENANT_A1 = U(601)
SUPPRESSION_A1 = U(701)
INVITATION_A, INVITATION_B = U(801), U(802)


def _sibling_sql_texts():  # type: () -> Tuple[str, str]
    return (SQL_REQUESTS_PATH.read_text(encoding="utf-8"),
            SQL_ATTENTION_PATH.read_text(encoding="utf-8"))


@pytest.fixture()
def world(monkeypatch, served_envelope):
    w = FirmWorld(_sql_text(), _sibling_sql_texts())
    w.auth_users.update(EMAILS)

    w.add("firms", {"id": FIRM_A, "name": "Firm Alpha", "created_by": A_OWNER})
    w.add("firms", {"id": FIRM_B, "name": "Firm Beta", "created_by": B_OWNER})
    for uid, role in ((A_OWNER, "owner"), (A_PARTNER, "partner"), (A_ACCOUNTANT, "accountant"),
                      (A_ASSISTANT, "assistant"), (A_VIEWER, "viewer")):
        w.add("firm_memberships", {"firm_id": FIRM_A, "user_id": uid, "role": role})
    for uid, role in ((B_OWNER, "owner"), (B_VIEWER, "viewer")):
        w.add("firm_memberships", {"firm_id": FIRM_B, "user_id": uid, "role": role})

    w.add("organizations", {"id": ORG_A1, "name": "Client A1", "firm_id": FIRM_A, "cui": "11111111",
                            "industry_key": "food_manufacturing", "default_currency": "RON"})
    w.add("organizations", {"id": ORG_A2, "name": "Client A2", "firm_id": FIRM_A, "cui": "22222222",
                            "default_currency": "RON"})
    w.add("organizations", {"id": ORG_B1, "name": "Client B1", "firm_id": FIRM_B, "cui": "33333333",
                            "default_currency": "RON"})
    w.add("organizations", {"id": ORG_S, "name": "Solo Workspace", "default_currency": "RON"})
    w.add("organizations", {"id": ORG_P, "name": "Partner Own Workspace", "default_currency": "RON"})
    for uid, org in ((A_OWNER, ORG_A1), (A_OWNER, ORG_A2), (B_OWNER, ORG_B1),
                     (SOLO, ORG_S), (A_PARTNER, ORG_P)):
        w.add("memberships", {"user_id": uid, "org_id": org, "role": "owner"})

    w.add("client_assignments", {"firm_id": FIRM_A, "org_id": ORG_A1, "responsible_user_id": A_ACCOUNTANT})
    w.add("client_assignments", {"firm_id": FIRM_A, "org_id": ORG_A2})
    w.add("client_assignments", {"firm_id": FIRM_B, "org_id": ORG_B1, "responsible_user_id": B_OWNER})

    for pid, org, label, env in ((PERIOD_A1, ORG_A1, "December 2025", served_envelope),
                                 (PERIOD_A2, ORG_A2, "December 2025", None),
                                 (PERIOD_B1, ORG_B1, "December 2025", served_envelope),
                                 (PERIOD_S, ORG_S, "December 2025", served_envelope)):
        w.add("financial_periods", {"id": pid, "org_id": org, "period_label": label,
                                    "period_start": "2025-01-01", "period_end": "2025-12-31",
                                    "currency": "RON", "status": "ready",
                                    "assembled_canonical_v1": copy.deepcopy(env) if env else None,
                                    "source_document_id": "doc-%s" % pid if env else None})
    w.add("documents", {"id": U(401), "org_id": ORG_A1, "original_filename": "a1.xlsx", "status": "analyzed"})
    w.add("documents", {"id": U(402), "org_id": ORG_B1, "original_filename": "b1.xlsx", "status": "analyzed"})
    w.add("firm_audit_log", {"firm_id": FIRM_A, "actor_user_id": A_OWNER, "action": "firm.create",
                             "target": {"name": "Firm Alpha"}})
    w.add("firm_audit_log", {"firm_id": FIRM_B, "actor_user_id": B_OWNER, "action": "firm.create",
                             "target": {"name": "Firm Beta"}})
    for firm_id, inviter, inv_id in ((FIRM_A, A_OWNER, INVITATION_A), (FIRM_B, B_OWNER, INVITATION_B)):
        inv = w.add("firm_invitations", {"id": inv_id, "firm_id": firm_id, "email": "someone@example.test",
                                         "role": "viewer", "invited_by": inviter,
                                         "expires_at": (w.clock + timedelta(days=7)).isoformat()})
        w.add("firm_invite_email_queue", {"invitation_id": inv["id"],
                                          "payload": {"to": "someone@example.test"}})

    w.add("industry_profiles", {"key": "food_manufacturing", "display_name": "Food manufacturing",
                                "is_active": True, "sector": "food_manufacturing"})
    w.add("industry_profiles", {"key": "manufacturing_generic", "display_name": "Manufacturing (generic)",
                                "is_active": True, "sector": "manufacturing"})
    w.add("industry_profiles", {"key": "retired_key", "display_name": "Retired",
                                "is_active": False, "sector": "misc"})
    w.add("caen_industry_mappings", {"caen_code": "1013", "caen_label_en": "Meat products",
                                     "industry_key": "food_manufacturing", "match_quality": "exact",
                                     "confidence": 0.92})
    w.add("caen_industry_mappings", {"caen_code": "2599", "caen_label_en": "Other metal products",
                                     "industry_key": "manufacturing_generic",
                                     "match_quality": "sector_fallback", "confidence": 0.45})

    # ── the cockpit tables, each with a SECRET marker on firm-A's client ──
    seed_stamp = w.now_iso()
    w.add("firm_file_requests", {
        "id": REQUEST_A1, "firm_id": FIRM_A, "client_org_id": ORG_A1, "period_end": "2026-01-31",
        "requested_by": A_ACCOUNTANT, "requested_at": seed_stamp,
        "expires_at": (w.clock + timedelta(days=30)).isoformat(),
        "token_hash": _firm_requests.token_hash(SECRET_TOKEN), "to_email": SECRET_EMAIL,
        "note": SECRET_NOTE, "status": _firm_requests.STATUS_REQUESTED, "reminder_count": 0,
        "reminders_sent": [], "refusal_count": 0,
        "expected_identity": {"name": "Client A1", "cui": "11111111"}})
    w.add("firm_file_requests", {
        "id": REQUEST_B1, "firm_id": FIRM_B, "client_org_id": ORG_B1, "period_end": "2026-01-31",
        "requested_by": B_OWNER, "requested_at": seed_stamp,
        "expires_at": (w.clock + timedelta(days=30)).isoformat(),
        "token_hash": _firm_requests.token_hash("b1-token.sig"), "to_email": "b1@example.test",
        "note": "firm B's own note", "status": _firm_requests.STATUS_REQUESTED,
        "reminder_count": 0, "reminders_sent": [], "refusal_count": 0,
        "expected_identity": {"name": "Client B1", "cui": "33333333"}})
    w.add("firm_file_request_tokens", {"request_id": REQUEST_A1, "token": SECRET_TOKEN})
    w.add("firm_client_cadence", {"client_org_id": ORG_A1, "firm_id": FIRM_A, "cadence": "quarterly",
                                  "fiscal_year_end_month": 12,
                                  "nudge_days_before": list(SECRET_CADENCE_NUDGES),
                                  "set_by": A_ACCOUNTANT})
    w.add("firm_digest_prefs", {"user_id": A_OWNER, "firm_id": FIRM_A, "enabled": True,
                                "frequency": "daily", "send_hour_utc": 7, "last_item_ids": []})
    w.add("firm_digest_log", {"user_id": A_OWNER, "firm_id": FIRM_A, "sent_for_date": "2026-09-01",
                              "item_set_hash": "seed", "item_count": 1})
    w.add("firm_email_queue", {"kind": _firm_requests.EMAIL_KIND_REQUEST, "firm_id": FIRM_A,
                               "client_org_id": ORG_A1, "request_id": REQUEST_A1,
                               "to_email": SECRET_EMAIL, "template": "file_request",
                               "payload": {"subject": SECRET_EMAIL_SUBJECT}, "status": "queued",
                               "send_at": seed_stamp})
    w.add("firm_briefs", {"firm_key": FIRM_A, "firm_id": FIRM_A, "user_id": A_OWNER,
                          "client_org_ids": [ORG_A1],
                          "brief_date": "2026-09-01", "item_set_hash": "seed-never-matches",
                          "payload": {"version": "seed", "notice": SECRET_BRIEF},
                          "degraded": False})
    w.add("firm_attention_suppressions", {"id": SUPPRESSION_A1, "org_id": ORG_A1, "kind": "CASH_RUNWAY",
                                          "scope_key": "*", "reason": SECRET_SUPPRESSION,
                                          "dismissed_by": A_ACCOUNTANT, "dismissed_at": seed_stamp})
    w.add("firm_covenants", {"id": COVENANT_A1, "org_id": ORG_A1, "covenant_id": "cov-a1",
                             "label": SECRET_COVENANT, "metric": "equity", "comparator": ">=",
                             "limit_value": 1000, "unit": "money", "headroom_warn_share": 0.1,
                             "test_date": "2026-06-30", "source": "seed", "created_by": A_OWNER})

    monkeypatch.setattr(_supabase_module, "admin", lambda: _Client(w, None, None, service_role=True))

    def _per_user(jwt):
        # The double's identity fidelity (W4): a bearer this backend cannot
        # decode is PostgREST's `anon` — nothing visible, nothing writable
        # — and never, by any accident of shape, the service role.
        from firm_postgrest_double import verified_identity
        claims = verified_identity(jwt)
        if not claims.get("id"):
            return _Client(w, None, None, service_role=False)
        return _Client(w, claims.get("id"), claims.get("email"), service_role=False)

    monkeypatch.setattr(_supabase_module, "per_user", _per_user)
    # The invitation routes read the wall clock (`_firm_invites._now`)
    # while the world's RPCs read `w.clock` (frozen at 2026-09-03): an
    # invitation minted with a 48 h TTL against the frozen clock reads as
    # EXPIRED to the route once the real date passes 2026-09-05 12:00 UTC
    # (it did, on this host, at that hour). One clock for both.
    monkeypatch.setattr(_firm_invites, "_now", lambda: w.clock)
    _firm_import.reset_default_public_store()
    return w


#: The URL prefixes FC1 owns: every route the real app serves under them
#: is either swept or declared (the census below).
SWEPT_PREFIXES = ("/api/firm", "/api/capsule")


#: The middleware the real app declares, OUTERMOST FIRST — the order
#: `app.user_middleware` keeps (Starlette inserts each add_middleware at
#: the front). An `@app.middleware("http")` answering a firm path is a
#: BaseHTTPMiddleware that never appears in any route table: it is red
#: here, by class name and dispatch function, until declared (D2).
#: SurfaceWallMiddleware answers ONLY /api/public/* (except the RO
#: storefront) and the two literal legacy-SKU-AI paths, with a stable
#: JSON 404; it can match no /api/firm or /api/capsule path.
#: SecurityHeadersMiddleware never answers — it only sets response
#: headers. Both are added in create_app() after CORS.
DECLARED_MIDDLEWARE = (
    "SurfaceWallMiddleware", "SecurityHeadersMiddleware",
    "CORSMiddleware",
    # Caps the request body (8 MiB general, 36 MiB on the two document
    # paths) and answers 413 above it. Like the two above it can match a
    # firm path, but it only refuses oversize bodies — it never serves
    # firm data, and a 413 is a refusal, not a leak.
    "BodyLimitMiddleware",
    "GZipMiddleware",
)

#: The modules that may name a firm-model table (every `create table` of
#: the three firm migrations). A module in the REAL app's import closure
#: that names one and is not here is red BY THE TABLE IT READS — an
#: `include_router(prefix="/api/cabinet")` reading firm_file_requests
#: never reaches a swept prefix, so the prefix census cannot see it (D2).
#: Every route a declared module serves must be under SWEPT_PREFIXES.
DECLARED_FIRM_TABLE_READERS = (
    "engine.api._firm", "engine.api._firm_requests", "engine.api._firm_brief",
    "engine.api._firm_attention", "engine.api._firm_invites",
    # engine.firm.digest names firm_file_requests in its module text (the
    # provenance of the request items it ranks) and serves no route;
    # _firm_import creates clients through the import_firm_client RPC and
    # names no table.
    "engine.firm.digest",
)

#: The client-data tables schema_phase_firm.sql gives a firm read policy
#: on, and the modules of the REAL closure that name them — measured
#: 2026-09-05. A NEW reader of client data is red until it is declared
#: here and its routes classified: the firm modules' routes must be under
#: SWEPT_PREFIXES; the product's own readers (the pipeline and its
#: siblings) are gated by membership on their own routes and are not this
#: gate's sweep — D4 (a firm READ policy widening a pipeline WRITE) is the
#: identity lane's finding, named here, not closed here.
CLIENT_DATA_TABLES = ("organizations", "financial_periods", "documents", "statement_line_items",
                      "alerts", "recommendations", "calculated_metrics", "briefings")
DECLARED_CLIENT_DATA_READERS = (
    "engine.actions", "engine.ai.numerals", "engine.ai_lane", "engine.ai_lane.routes",
    "engine.api._benchmarks", "engine.api._billing", "engine.api._capsule_tools",
    "engine.api._features", "engine.api._firm", "engine.api._firm_attention",
    # PRODUCT route, under its own membership gate: `GET
    # /api/forecast/{period_id}` resolves the workspace through
    # `_org.resolve_org` (403 on a non-member org, never a silent
    # fallback), reads `financial_periods` and `statement_line_items`
    # through the CALLER's own RLS-scoped client, and filters on org_id
    # as a second lock on top of that. Not a firm module and not under a
    # swept prefix. Pinned behaviourally by
    # tests/engine/test_forecast_route.py.
    "engine.api._forecast_routes",
    "engine.api._firm_import", "engine.api._firm_requests", "engine.api._industry_detection",
    "engine.api._industry_intelligence", "engine.api._journal_routes", "engine.api._ops_routes",
    "engine.api._org", "engine.api._period_move", "engine.api._reconcile", "engine.api.cfo_ai",
    "engine.api.frontend", "engine.api.pipeline", "engine.firm.attention",
    "engine.storage.postgres",
)


def _walk_routes(routes, prefix=""):  # type: (Any, str) -> Any
    """EVERY route an app serves, RECURSIVELY through every Mount — a
    sub-app's routes are routes, at the mount's path. Yields
    (route, full path)."""
    from starlette.routing import Mount
    for route in routes:
        path = prefix + str(getattr(route, "path", "") or "")
        yield route, path
        if isinstance(route, Mount):
            for inner in _walk_routes(getattr(route, "routes", ()) or (), path):
                yield inner


def _route_table(application):  # type: (Any) -> set
    """(method, path, endpoint) for every HTTP route under SWEPT_PREFIXES,
    Mounts walked recursively — the path with its convertors stripped
    (`{firm_id:uuid}` → `{firm_id}`; the convertor is routing, not
    identity), the endpoint by module and name so the SAME path served by
    a different function is a difference, not a match. Shapes that carry
    no endpoint/methods (a Mount, a WebSocketRoute) are NOT routes here:
    `_foreign_surface` reds on them."""
    from fastapi.routing import APIRoute
    out = set()
    for route, path in _walk_routes(application.routes):
        if not isinstance(route, APIRoute) or not path.startswith(SWEPT_PREFIXES):
            continue
        norm = re.sub(r"\{(\w+):\w+\}", r"{\1}", path)
        for method in getattr(route, "methods", ()) or ():
            if method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                out.add((method, norm, "%s.%s" % (route.endpoint.__module__, route.endpoint.__name__)))
    return out


def _foreign_surface(application):  # type: (Any) -> List[str]
    """Every shape under SWEPT_PREFIXES that is NOT a FastAPI APIRoute —
    a Mount (a sub-app whose routes the prefix census would have to walk
    and whose auth nobody swept), a WebSocketRoute (no `methods`, never
    in a (method, path) table), a raw Starlette Route (no endpoint
    signature FastAPI validates). Each is named by class and path."""
    from fastapi.routing import APIRoute
    out = []  # type: List[str]
    for route, path in _walk_routes(application.routes):
        if isinstance(route, APIRoute) or not path.startswith(SWEPT_PREFIXES):
            continue
        out.append("%s at %s" % (type(route).__name__, path))
    return out


def _middleware_names(application):  # type: (Any) -> List[str]
    """Each user middleware as `Class` or `Class(dispatch=module.fn)` —
    the second form is what `@app.middleware("http")` registers."""
    out = []  # type: List[str]
    for mw in application.user_middleware:
        cls = getattr(mw, "cls", None)
        name = getattr(cls, "__name__", str(cls))
        dispatch = (getattr(mw, "kwargs", None) or {}).get("dispatch")
        if dispatch is not None:
            name = "%s(dispatch=%s.%s)" % (name, getattr(dispatch, "__module__", "?"),
                                          getattr(dispatch, "__name__", "?"))
        out.append(name)
    return out


def _table_readers(module_names, tables):  # type: (Any, Any) -> Dict[str, List[str]]
    """{module: [tables it names]} over the given modules' SOURCE TEXT — a
    quoted table name anywhere in the file (the way every client call
    names one). Modules without a file (namespace packages, C extensions)
    read nothing."""
    import sys as _sys
    rx = re.compile(r"""['"](%s)['"]""" % "|".join(re.escape(t) for t in tables))
    out = {}  # type: Dict[str, List[str]]
    for name in sorted(module_names):
        module = _sys.modules.get(name)
        path = getattr(module, "__file__", None)
        if not path or not str(path).endswith(".py"):
            continue
        try:
            text = Path(path).read_text(encoding="utf-8")
        except OSError:
            continue
        found = sorted(set(rx.findall(text)))
        if found:
            out[name] = found
    return out


_APP_CLOSURE_CACHE = {}  # type: Dict[str, Tuple[str, ...]]


def real_app_import_closure():  # type: () -> Tuple[str, ...]
    """The `engine.*` modules the REAL app imports — MEASURED IN A CHILD
    PROCESS, which is the only place the answer is a property of the app
    rather than of the test session.

    ── WHY NOT `sys.modules` ─────────────────────────────────────────────

    The census below used to read `[m for m in sys.modules if
    m.startswith("engine.")]`. That is not the app's import closure; it is
    everything 136 test modules have imported by the time this one runs,
    so the test PASSED ALONE AND FAILED IN THE FULL RUN. Measured
    2026-09-08 on this tree, the three strangers it invented were

        engine.api._radar          engine.dst.faults      engine.dst.harness

    none of which `create_app()` imports — `_radar` appears in the app's
    sources only inside two comments in `pipeline.py`, and the `dst`
    package is the deterministic-simulation harness, which no route
    reaches. A gate whose subject depends on collection order is a gate
    that will be silenced by whoever hits it at 2 a.m., and the true
    reading (this one) is the one that keeps its teeth.

    An in-process alternative — drop every `engine.*` from `sys.modules`,
    re-import, restore — was rejected: this package registers things at
    import time, and re-running those registrations mid-session to
    measure something is a side effect the measurement does not need.

    ── THE CHILD ─────────────────────────────────────────────────────────

    Same interpreter, same env the `real_app` fixture uses (including
    `FIRM_COCKPIT_ENABLED=1`, or the Cockpit's own modules would be
    missing from the closure and every one of them would read as stale),
    and `netblock._install()` FIRST — the parent runs under `-p netblock`
    and a child that quietly reached the network would defeat that.

    Cached for the session: it costs one interpreter start, and nothing
    about it changes between tests."""
    import os as _os
    import subprocess as _subprocess
    import sys as _sys

    cached = _APP_CLOSURE_CACHE.get("closure")
    if cached is not None:
        return cached
    script = (
        "import json, sys\n"
        "sys.path.insert(0, %r)\n"
        "sys.path.insert(0, %r)\n"
        "import netblock; netblock._install()\n"
        "from engine.api.server import create_app\n"
        "create_app(config_path=%r)\n"
        "print(json.dumps(sorted(m for m in sys.modules "
        "if m == 'engine' or m.startswith('engine.'))))\n"
        % (str(REPO), str(REPO / "src"), str(REPO / "config.yaml"))
    )
    env = dict(_os.environ)
    env.update({
        "VITE_SUPABASE_URL": "https://test.supabase.co",
        "VITE_SUPABASE_ANON_KEY": "test-anon",
        "SUPABASE_SERVICE_ROLE_KEY": "test-service",
        "CFO_AI_SKIP_BOOT_VERIFY": "1",
        "FIRM_COCKPIT_ENABLED": "1",
    })
    for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "ENGINE_API_TOKEN"):
        env.pop(key, None)
    proc = _subprocess.run(
        [_sys.executable, "-c", script],
        cwd=str(REPO), env=env, stdout=_subprocess.PIPE, stderr=_subprocess.PIPE,
    )
    assert proc.returncode == 0, (
        "could not build the real app in a child process to measure its import closure; "
        "the census cannot run without it.\nstderr:\n%s"
        % proc.stderr.decode("utf-8", "replace")[-3000:]
    )
    # The child prints exactly one JSON line last; anything a module wrote
    # to stdout on import comes before it.
    line = [ln for ln in proc.stdout.decode("utf-8", "replace").splitlines() if ln.startswith("[")]
    assert line, "the child produced no closure line; stdout:\n%s" % proc.stdout.decode("utf-8", "replace")[-2000:]
    closure = tuple(json.loads(line[-1]))
    _APP_CLOSURE_CACHE["closure"] = closure
    return closure


def firm_model_tables():  # type: () -> Tuple[str, ...]
    """Every table the three firm migrations create — parsed, so a table a
    later migration adds is in the census the moment it exists."""
    names = []  # type: List[str]
    for path in (SQL_PATH, SQL_REQUESTS_PATH, SQL_ATTENTION_PATH):
        names.extend(parse_table_columns(path.read_text(encoding="utf-8")))
    return tuple(sorted(set(names)))


@pytest.fixture(scope="module")
def real_app():
    """The REAL app — `create_app()` itself, built once, against the
    test-manifest Supabase URL (never the checkout's .env) with boot
    verification skipped, `config.yaml` by absolute path so the same app
    builds from any cwd (the battery, a sandbox). This is the census's
    source of truth (W2 / D2): a router, a Mount, a WebSocket route or a
    middleware reached server.py by ANY shape shows up here, and only
    here, so it cannot be in production and missing from the sweep."""
    mp = pytest.MonkeyPatch()
    try:
        mp.setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
        mp.setenv("VITE_SUPABASE_ANON_KEY", "test-anon")
        mp.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service")
        mp.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
        # The Cockpit mounts only behind FIRM_COCKPIT_ENABLED (server.py
        # `_firm_cockpit_enabled`; unset in production, so /api/firm is a
        # 404 there by construction). THIS gate is the surface census over
        # those routes — it must build the app WITH them, or it measures an
        # empty surface and passes vacuously. The flag itself is gated by
        # test_firm_real_app.py::test_the_cockpit_is_not_mounted_without_its_flag.
        mp.setenv("FIRM_COCKPIT_ENABLED", "1")
        for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "ENGINE_API_TOKEN"):
            mp.delenv(key, raising=False)
        from engine.api.server import create_app
        application = create_app(config_path=REPO / "config.yaml")
    finally:
        mp.undo()
    return application


@pytest.fixture(scope="module")
def real_app_routes(real_app):
    """The REAL app's HTTP route table under SWEPT_PREFIXES (W2)."""
    table = _route_table(real_app)
    assert table, "create_app() serves no route under %s — discovery broken" % (SWEPT_PREFIXES,)
    return table


@pytest.fixture()
def app(world, monkeypatch, tmp_path):
    """EVERY router server.py mounts under /api/firm, in the same order,
    plus the real Capsule router. No test-mode bypass, no scheduler
    token, no model key; the signing key is set so the request routes
    verify signatures (a forged token is refused, not 503)."""
    for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "ENGINE_API_TOKEN",
                "ANTHROPIC_API_KEY", "PRICING_ADMIN_USER_IDS", "RESEND_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AI_BREAKER_STATE_DIR", str(tmp_path / "ai_spend"))
    monkeypatch.setenv(_firm_requests.SIGNING_KEY_ENV, "tenancy-suite-signing-key-0123456789")
    application = FastAPI()
    for name in FIRM_ROUTERS:
        application.include_router(importlib.import_module("engine.api." + name).build_router())
    application.include_router(CT.build_router())
    return TestClient(application)


# ══════════════════════════════════════════════════════════════════════
# 1. THE SQL LANE — the migration's structure
# ══════════════════════════════════════════════════════════════════════

def test_sql_runbook_and_notify_are_present():
    text = _sql_text()
    for marker in ("PRE-FLIGHT", "APPLY ORDER", "Reload schema cache", "ROLLBACK", "VERIFY"):
        assert marker in text, "runbook header is missing %r" % marker
    statements = [s.strip() for s in _strip_sql_comments(text).split(";") if s.strip()]
    assert statements[-1].upper() == "NOTIFY PGRST, 'RELOAD SCHEMA'", (
        "the migration must END with the PostgREST reload NOTIFY (CLAUDE.md §14)")


def test_sql_matrix_is_the_full_grid():
    matrix = parse_matrix(_sql_text())
    roles = parse_roles(_sql_text())
    assert tuple(roles) == EXPECTED_ROLES
    assert len(matrix) == len(EXPECTED_ROLES) * len(EXPECTED_ACTIONS) == 35
    assert set(r for r, _ in matrix) == set(EXPECTED_ROLES)
    assert set(a for _, a in matrix) == set(EXPECTED_ACTIONS)
    # per-role granted counts, recorded — the runbook's step-4 numbers
    granted = dict((role, sum(1 for (r, _), v in matrix.items() if r == role and v))
                   for role in EXPECTED_ROLES)
    assert granted == {"owner": 7, "partner": 6, "accountant": 3, "assistant": 2, "viewer": 1}


@pytest.mark.parametrize("role,action", CELLS, ids=["%s-%s" % c for c in CELLS])
def test_matrix_cell_agrees_across_sql_python_and_the_record(role, action):
    """One cell, three sources: the recorded expectation, the SQL seed,
    and the Python table — each compared explicitly (TC-6)."""
    recorded = expected_cell(role, action)
    sql_cell = parse_matrix(_sql_text())[(role, action)]
    py_cell = _firm.ROLE_MATRIX[role][action]
    assert sql_cell == recorded, "SQL seed %s/%s = %r, recorded %r" % (role, action, sql_cell, recorded)
    assert py_cell == recorded, "ROLE_MATRIX %s/%s = %r, recorded %r" % (role, action, py_cell, recorded)
    assert _firm.can(role, action) == recorded


def test_sql_helpers_are_security_definer_pinned_and_revoked_from_anon():
    fns = parse_functions(_sql_text())
    helpers = ("is_firm_member_of", "firm_role_of", "firm_can", "firm_of_org",
               "can_read_client_org", "firm_audit")
    rpcs = ("create_firm", "list_firms", "list_firm_members", "list_firm_clients",
            "attach_workspace_to_firm", "detach_workspace_from_firm", "assign_client",
            "set_firm_member_role", "remove_firm_member", "create_firm_invitation",
            "accept_firm_invitation", "revoke_firm_invitation", "import_firm_client")
    for name in helpers + rpcs:
        assert name in fns, "function %s is not defined" % name
        assert fns[name]["security_definer"], "%s must be SECURITY DEFINER" % name
        assert fns[name]["search_path"], "%s must pin search_path = public" % name
    text = _strip_sql_comments(_sql_text())
    for name in helpers + rpcs:
        assert re.search(r"revoke (execute|all)\s+on function %s\(" % name, text), (
            "%s keeps the default PUBLIC EXECUTE grant — revoke it from public, anon" % name)
    assert re.search(r"revoke all\s+on function firm_audit\(.*?\)\s+from public, anon, authenticated", text), (
        "firm_audit is internal; it must not be callable by any API role")
    assert not re.search(r"grant execute on function firm_audit", text)


def test_sql_no_self_referencing_policy_on_firm_memberships():
    """The 42P17 trap: a policy ON firm_memberships must never subquery
    firm_memberships. It goes through is_firm_member_of() instead."""
    pols = [p for p in parse_policies(_sql_text()) if p["table"] == "firm_memberships"]
    assert pols, "no policy on firm_memberships was found — discovery broken"
    for p in pols:
        assert "firm_memberships" not in p["using"], (
            "policy %r subqueries firm_memberships inside a policy on firm_memberships "
            "— that is the documented 42P17 infinite recursion" % p["name"])
        assert "is_firm_member_of(" in p["using"]
    fn = parse_functions(_sql_text())["is_firm_member_of"]
    assert "from firm_memberships" in fn["body"] and "auth.uid()" in fn["body"]


def test_sql_firm_tables_have_no_client_write_policy():
    pols = parse_policies(_sql_text())
    by_table = {}  # type: Dict[str, List[str]]
    for p in pols:
        by_table.setdefault(p["table"], []).append(p["command"])
    for table in ("firms", "firm_memberships", "client_assignments", "firm_invitations",
                  "firm_audit_log", "firm_role_permissions", "firm_roles"):
        commands = by_table.get(table, [])
        assert commands, "no policy found on %s — discovery broken" % table
        assert not any(c in ("insert", "delete", "all") for c in commands), (
            "%s carries a client write policy; mutations must go through the RPCs" % table)
    assert "firm_invite_email_queue" not in by_table, "the e-mail queue is service-role only"
    assert any(c == "update" for c in by_table["firms"]), "firms rename policy (manage) expected"
    assert [c for c in by_table["firms"] if c == "update"] and \
        all("firm_can(id, 'manage')" in p["using"] for p in pols
            if p["table"] == "firms" and p["command"] == "update")


def test_sql_client_data_firm_policies_are_select_only_and_go_through_can_read_client_org():
    pols = parse_policies(_sql_text())
    client_tables = ("financial_periods", "documents", "alerts", "recommendations",
                     "calculated_metrics", "briefings", "statement_line_items", "organizations")
    firm_read = [p for p in pols if p["name"].endswith(" firm read") and p["table"] in client_tables]
    assert set(p["table"] for p in firm_read) == set(client_tables), (
        "firm read policies cover %s" % sorted(set(p["table"] for p in firm_read)))
    for p in firm_read:
        assert p["command"] == "select", "%r must be select-only" % p["name"]
        if p["table"] == "organizations":
            assert "firm_can(firm_id, 'read')" in p["using"] and "firm_id is not null" in p["using"]
        else:
            assert "can_read_client_org(" in p["using"], p["name"]
    for p in pols:
        if p["table"] in client_tables:
            assert p["command"] == "select", (
                "%r adds a %s policy on %s — a firm reads its clients, it does not edit them"
                % (p["name"], p["command"], p["table"]))
    fn = parse_functions(_sql_text())["can_read_client_org"]
    assert "is_member_of(_org_id)" in fn["body"]
    assert "firm_can(firm_of_org(_org_id), 'read')" in fn["body"]


def test_sql_every_mutating_rpc_is_guarded_and_audited():
    fns = parse_functions(_sql_text())
    guarded = {
        "attach_workspace_to_firm": ["import"],
        "detach_workspace_from_firm": ["manage"],
        "assign_client": ["assign"],
        "set_firm_member_role": ["manage"],
        "remove_firm_member": ["manage"],
        "create_firm_invitation": ["invite", "manage"],
        "revoke_firm_invitation": ["invite"],
        "import_firm_client": ["import"],
    }
    for name, actions in guarded.items():
        body = fns[name]["body"]
        assert sql_actions_of(body) == actions, (
            "%s asks firm_can about %s, expected %s" % (name, sql_actions_of(body), actions))
        assert "perform firm_audit(" in body, "%s does not write an audit row" % name
    for name in ("create_firm", "accept_firm_invitation"):
        assert "perform firm_audit(" in fns[name]["body"]
    assert "auth.uid() is null" in fns["create_firm"]["body"]
    assert "role = 'owner'" in fns["attach_workspace_to_firm"]["body"], (
        "attaching a workspace needs the WORKSPACE owner's consent")


def test_sql_accept_invitation_checks_email_expiry_revocation_and_acceptance():
    body = parse_functions(_sql_text())["accept_firm_invitation"]["body"]
    for needle, why in (("auth.jwt() ->> 'email'", "e-mail scoped"),
                        ("expires_at < now()", "expiring"),
                        ("revoked_at is not null", "revocable"),
                        ("accepted_at is not null", "single-use")):
        assert needle in body, "accept_firm_invitation is not %s (missing %r)" % (why, needle)
    inv = parse_functions(_sql_text())["create_firm_invitation"]["body"]
    assert "least(greatest(" in inv and "720" in inv, "TTL must be clamped"
    assert "p_role = 'owner' and not firm_can(p_firm_id, 'manage')" in inv


def test_sql_organizations_firm_id_is_nullable_and_set_null_on_firm_delete():
    text = _strip_sql_comments(_sql_text())
    m = re.search(r"alter table organizations add column if not exists firm_id\s+uuid\s+references firms\(id\)\s+on delete set null", text)
    assert m, "organizations.firm_id must be a nullable FK with ON DELETE SET NULL"
    assert "not null" not in m.group(0)
    assert "alter table organizations add column if not exists cui text" in text
    cols = parse_table_columns(_sql_text())
    assert cols["client_assignments"] == ["id", "firm_id", "org_id", "responsible_user_id",
                                          "collaborator_user_ids", "import_resolution",
                                          "created_at", "updated_at"]
    assert "unique (org_id)" in text, "one responsible accountant per client"


def test_the_double_evaluates_the_migrations_helper_bodies_not_a_mirror(world):
    """DISCOVERY CANARY for the double: every helper the policies call is
    evaluated from its SQL body (the firm_can JOIN over the seeded matrix
    rows included). A helper that fell back to Python would make Plant 1
    (loosen a body in the migration) invisible to FC1."""
    for name in ("is_firm_member_of", "firm_role_of", "firm_can", "firm_of_org", "can_read_client_org"):
        assert world._sql_function(name) is not None, name
        assert world._body_ast(name, world.functions[name])[0] == "select", name
    fc = world._body_ast("firm_can", world.functions["firm_can"])
    assert "join" in world.functions["firm_can"]["body"] and fc[0] == "select"
    assert world.firm_can(A_VIEWER, FIRM_A, "read") is True
    assert world.firm_can(A_VIEWER, FIRM_A, "manage") is False
    assert world.firm_can(A_OWNER, FIRM_A, "manage") is True
    assert world.firm_can(B_OWNER, FIRM_A, "read") is False
    assert world.firm_can(A_OWNER, None, "read") is False
    assert world.firm_role_of(A_PARTNER, FIRM_A) == "partner" and world.firm_role_of(SOLO, FIRM_A) is None
    assert world.firm_of_org(ORG_A1) == FIRM_A and world.firm_of_org(ORG_S) is None
    assert world.can_read_client_org(A_VIEWER, ORG_A1) and not world.can_read_client_org(B_OWNER, ORG_A1)
    assert world.can_read_client_org(SOLO, ORG_S) and not world.can_read_client_org(A_OWNER, ORG_S)
    # flip ONE matrix row in the double's table and the JOIN answers differently
    cell = next(r for r in world.rows("firm_role_permissions") if r["role"] == "viewer" and r["action"] == "manage")
    cell["allowed"] = True
    assert world.firm_can(A_VIEWER, FIRM_A, "manage") is True
    cell["allowed"] = False
    # and a loosened body is honoured, which is what makes Plant 1 visible
    world.plant_function("can_read_client_org", "select true")
    assert world.can_read_client_org(B_OWNER, ORG_A1) is True


# ══════════════════════════════════════════════════════════════════════
# 2. THE PYTHON MATRIX
# ══════════════════════════════════════════════════════════════════════

def test_can_refuses_unknown_action_and_denies_unknown_role():
    with pytest.raises(_firm.FirmActionError):
        _firm.can("owner", "delete_everything")
    assert _firm.can("intern", "read") is False
    assert _firm.can(None, "read") is False
    assert _firm.permissions_for("viewer") == dict((a, a == "read") for a in EXPECTED_ACTIONS)


def test_role_matrix_is_frozen():
    with pytest.raises(TypeError):
        _firm.ROLE_MATRIX["owner"] = {}
    with pytest.raises(TypeError):
        _firm.ROLE_MATRIX["viewer"]["manage"] = True
    assert tuple(_firm.ROLES) == EXPECTED_ROLES and tuple(_firm.ACTIONS) == EXPECTED_ACTIONS


# ══════════════════════════════════════════════════════════════════════
# 3. FC1 — cross-firm reads are blocked at every entry
# ══════════════════════════════════════════════════════════════════════

def test_fc1_positive_control_the_world_is_real(app, world, gateway_facts):
    """Before proving a read is blocked, prove the read is real: the firm-A
    owner reads A1's period through the firm route AND through the Capsule,
    and the Capsule's total_assets equals the corpus case's recorded fact."""
    r = app.get("/api/firm/%s/clients/%s/periods" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200, r.text
    periods = r.json()["periods"]
    assert [p["period_id"] for p in periods] == [PERIOD_A1]
    assert periods[0]["has_envelope"] is True
    assert "assembled_canonical_v1" not in json.dumps(r.json()), "the firm route must not ship the envelope"

    r = app.post("/api/capsule/tools/get_facts", headers=hdr(A_OWNER, ORG_A1),
                 json={"args": {"metric": "total_assets", "period": "December 2025"}})
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload.get("gaps") in (None, []), payload
    values = payload.get("values") or []
    assert values and values[0].get("amount_minor") == gateway_facts["total_assets_cents"], payload
    assert values[0].get("currency") == gateway_facts["currency"]

    r = app.get("/api/firm/%s/clients" % FIRM_A, headers=hdr(A_VIEWER))
    assert r.status_code == 200
    assert sorted(c["org_id"] for c in r.json()["clients"]) == sorted([ORG_A1, ORG_A2])


#: Every firm-model route that names a firm in its path (FastAPI path
#: form, so the route census below can compare it to the mounted app).
CROSS_FIRM_ROUTES = [
    ("GET", "/api/firm/{firm_id}", None),
    ("GET", "/api/firm/{firm_id}/clients", None),
    ("GET", "/api/firm/{firm_id}/clients/{org_id}/periods", None),
    ("GET", "/api/firm/{firm_id}/members", None),
    ("GET", "/api/firm/{firm_id}/audit", None),
    ("GET", "/api/firm/{firm_id}/invitations", None),
    ("POST", "/api/firm/{firm_id}/invitations", {"email": "x@example.test", "role": "viewer"}),
    ("POST", "/api/firm/{firm_id}/invitations/{invitation_id}/revoke", None),
    ("POST", "/api/firm/{firm_id}/import", {"csv": "name,cui\nX,44444444\n", "dry_run": True}),
    ("PUT", "/api/firm/{firm_id}/clients/{org_id}/assignment", {"responsible_user_id": None}),
    ("POST", "/api/firm/{firm_id}/clients/{org_id}/detach", None),
    ("POST", "/api/firm/{firm_id}/clients/attach", {"org_id": "{org_id}"}),
    ("PUT", "/api/firm/{firm_id}/members/{user_id}/role", {"role": "viewer"}),
    ("DELETE", "/api/firm/{firm_id}/members/{user_id}", None),
]


def _fill(text, **values):  # type: (str, **str) -> str
    for key, value in values.items():
        text = text.replace("{%s}" % key, value)
    return text


@pytest.mark.parametrize("method,path,body", CROSS_FIRM_ROUTES,
                         ids=["%s %s" % (m, p) for m, p, _ in CROSS_FIRM_ROUTES])
@pytest.mark.parametrize("intruder", [B_OWNER, B_VIEWER, SOLO, NOBODY],
                         ids=["b_owner", "b_viewer", "solo", "nobody"])
def test_fc1_every_firm_route_refuses_a_non_member_with_403(app, world, intruder, method, path, body):
    url = _fill(path, firm_id=FIRM_A, org_id=ORG_A1, user_id=A_VIEWER, invitation_id=U(999))
    payload = None
    if body is not None:
        payload = dict((k, (_fill(v, org_id=ORG_A1) if isinstance(v, str) else v)) for k, v in body.items())
    r = app.request(method, url, headers=hdr(intruder), json=payload)
    assert r.status_code == 403, "%s %s by %s → %s %s" % (method, url, intruder, r.status_code, r.text)
    assert "Firm Alpha" not in r.text and "Client A1" not in r.text
    assert r.json()["detail"] == "Not a member of the requested firm."


@pytest.mark.parametrize("table,filters", [
    ("organizations", {"id": "eq." + ORG_A1}),
    ("organizations", {"firm_id": "eq." + FIRM_A}),
    ("financial_periods", {"org_id": "eq." + ORG_A1}),
    ("documents", {"org_id": "eq." + ORG_A1}),
    ("firms", {"id": "eq." + FIRM_A}),
    ("firm_memberships", {"firm_id": "eq." + FIRM_A}),
    ("client_assignments", {"firm_id": "eq." + FIRM_A}),
    ("firm_invitations", {"firm_id": "eq." + FIRM_A}),
    ("firm_audit_log", {"firm_id": "eq." + FIRM_A}),
    ("firm_invite_email_queue", {}),
    # the cockpit tables (schema_phase_firm_requests.sql / _attention.sql)
    ("firm_file_requests", {"client_org_id": "eq." + ORG_A1}),
    ("firm_file_request_tokens", {}),
    ("firm_client_cadence", {"client_org_id": "eq." + ORG_A1}),
    ("firm_digest_prefs", {"firm_id": "eq." + FIRM_A}),
    ("firm_digest_log", {"firm_id": "eq." + FIRM_A}),
    ("firm_email_queue", {}),
    ("firm_briefs", {"firm_id": "eq." + FIRM_A}),
    ("firm_attention_suppressions", {"org_id": "eq." + ORG_A1}),
    ("firm_covenants", {"org_id": "eq." + ORG_A1}),
], ids=lambda v: v if isinstance(v, str) else "")
@pytest.mark.parametrize("intruder", [B_OWNER, B_VIEWER, SOLO], ids=["b_owner", "b_viewer", "solo"])
def test_fc1_rls_hides_every_firm_a_row_from_a_non_member(world, intruder, table, filters):
    """The second wall, alone: the policies parsed from the THREE
    migrations yield NOTHING for a firm-B member (or a solo user) on
    firm-A rows — the firm model's tables and the cockpit's."""
    client = _supabase_module.per_user(_jwt(intruder, EMAILS[intruder]))
    assert client.select(table, filters=filters) == []
    # and the same rows DO exist — the emptiness is the policy, not the seed
    assert _supabase_module.admin().select(table, filters=filters), "seed row missing for %s" % table


def test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell(world):
    for role, uid in ROLE_USER.items():
        client = _supabase_module.per_user(_jwt(uid, EMAILS[uid]))
        expect_read = expected_cell(role, "read")
        periods = client.select("financial_periods", filters={"org_id": "eq." + ORG_A1})
        assert bool(periods) == expect_read, (role, periods)
        orgs = client.select("organizations", filters={"firm_id": "eq." + FIRM_A})
        assert (len(orgs) == 2) == expect_read
        assert client.select("firm_memberships", filters={"firm_id": "eq." + FIRM_A})
        # firm-B rows never, whatever the role
        assert client.select("financial_periods", filters={"org_id": "eq." + ORG_B1}) == []
        assert client.select("organizations", filters={"id": "eq." + ORG_B1}) == []
        audit = client.select("firm_audit_log", filters={"firm_id": "eq." + FIRM_A})
        assert bool(audit) == expected_cell(role, "manage")
        # the cockpit tables follow the read cell too (C2: the second wall
        # exists on the request / cadence / brief / attention surface)
        for table, filters in (("firm_file_requests", {"client_org_id": "eq." + ORG_A1}),
                               ("firm_client_cadence", {"client_org_id": "eq." + ORG_A1}),
                               ("firm_briefs", {"firm_id": "eq." + FIRM_A}),
                               ("firm_attention_suppressions", {"org_id": "eq." + ORG_A1}),
                               ("firm_covenants", {"org_id": "eq." + ORG_A1})):
            rows = client.select(table, filters=filters)
            assert bool(rows) == expect_read, (role, table, rows)
        # never the secret half, never the queue, never another user's prefs
        assert client.select("firm_file_request_tokens") == []
        assert client.select("firm_email_queue") == []
        if uid != A_OWNER:
            assert client.select("firm_digest_prefs", filters={"user_id": "eq." + A_OWNER}) == []


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/firm/{firm}/clients/{org}/periods", None),
    ("PUT", "/api/firm/{firm}/clients/{org}/assignment", {"responsible_user_id": None}),
    ("POST", "/api/firm/{firm}/clients/{org}/detach", None),
], ids=["periods", "assignment", "detach"])
@pytest.mark.parametrize("target", [ORG_B1, ORG_S, U(999)], ids=["firm_b_client", "solo", "missing"])
def test_fc1_a_firm_member_cannot_reach_another_firms_client_through_their_own_firm(
        app, world, target, method, path, body):
    """The second probe shape: a legitimate firm-A OWNER names a workspace
    that is not firm A's — firm B's client, a solo workspace, or nothing
    at all — under firm A's own path. 403 every time, with ONE message,
    so the answer never says which of the three it was."""
    url = path.format(firm=FIRM_A, org=target)
    r = app.request(method, url, headers=hdr(A_OWNER), json=body)
    assert r.status_code == 403, (url, r.status_code, r.text)
    assert r.json()["detail"] == _firm.NOT_A_CLIENT
    assert world.firm_of_org(ORG_B1) == FIRM_B and world.firm_of_org(ORG_S) is None


def test_fc1_rpcs_refuse_a_firm_b_member_on_firm_a(world):
    client = _supabase_module.per_user(_jwt(B_OWNER, EMAILS[B_OWNER]))
    assert client.rpc("list_firm_clients", {"p_firm_id": FIRM_A}) == []
    assert client.rpc("list_firm_members", {"p_firm_id": FIRM_A}) == []
    for fn, params in (
        ("assign_client", {"p_org_id": ORG_A1, "p_responsible": None, "p_collaborators": []}),
        ("detach_workspace_from_firm", {"p_org_id": ORG_A1}),
        ("create_firm_invitation", {"p_firm_id": FIRM_A, "p_email": "x@example.test", "p_role": "viewer"}),
        ("set_firm_member_role", {"p_firm_id": FIRM_A, "p_user_id": A_VIEWER, "p_role": "owner"}),
        ("remove_firm_member", {"p_firm_id": FIRM_A, "p_user_id": A_VIEWER}),
        ("attach_workspace_to_firm", {"p_org_id": ORG_B1, "p_firm_id": FIRM_A}),
    ):
        with pytest.raises(RuntimeError) as exc:
            client.rpc(fn, params)
        assert "'42501'" in str(exc.value), (fn, str(exc.value))
    # state is untouched
    assert world.firm_of_org(ORG_A1) == FIRM_A and world.firm_of_org(ORG_B1) == FIRM_B
    assert world.firm_role_of(A_VIEWER, FIRM_A) == "viewer"


def test_fc1_capsule_tool_refuses_a_firm_a_client_for_anyone_but_its_members(app, world):
    """The Capsule scopes by ORG membership (`_org.resolve_org`); a firm
    role grants no Capsule read in this wave. Firm-B members, a solo user
    AND a firm-A viewer all get 403 on A1 — the firm read path is the
    firm route, through RLS, and nothing else."""
    for intruder in (B_OWNER, B_VIEWER, SOLO, A_VIEWER, A_ACCOUNTANT):
        r = app.post("/api/capsule/tools/get_facts", headers=hdr(intruder, ORG_A1),
                     json={"args": {"metric": "total_assets", "period": "December 2025"}})
        assert r.status_code == 403, (intruder, r.status_code, r.text)
        assert "12588619251" not in r.text and "values" not in r.text


def test_fc1_plant_cross_firm_read_is_blocked_at_both_walls(app, world, monkeypatch):
    """THE PLANT — the exact hostile read, executed, at each wall in turn.

    Wall 1 (Python): a firm-B owner with a valid JWT sends firm-A's id in
    the path and firm-A's client in the URL. 403, before any read.

    Wall 2 (RLS): remove Wall 1 by hand — `resolve_firm` is patched to
    accept anyone as an OWNER of any firm, and `require_client` to accept
    any org — and re-send. The route now reaches the database as the
    intruder, and the policies parsed from the migration return NOTHING.
    Then remove Wall 2 too (patch the double's predicate) and show the
    leak: that last step is what proves the test can fail."""
    forged = "/api/firm/%s/clients/%s/periods" % (FIRM_A, ORG_A1)
    r = app.get(forged, headers=hdr(B_OWNER))
    assert r.status_code == 403

    monkeypatch.setattr(_firm, "resolve_firm",
                        lambda jwt, firm_id: _firm.FirmContext(B_OWNER, firm_id, "owner"))
    monkeypatch.setattr(_firm, "require_client", lambda ctx, org_id: org_id)
    r = app.get(forged, headers=hdr(B_OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["periods"] == [], "RLS wall breached: %s" % r.text
    r = app.get("/api/firm/%s/clients" % FIRM_A, headers=hdr(B_OWNER))
    assert r.status_code == 200 and r.json()["clients"] == []

    # the leak, deliberately: with the helper's SQL body loosened to
    # `select true` (the exact Plant 1 in design_review) the intruder sees A1
    world.plant_function("can_read_client_org", "select true")
    r = app.get(forged, headers=hdr(B_OWNER))
    assert [p["period_id"] for p in r.json()["periods"]] == [PERIOD_A1], (
        "with both walls removed the read must succeed — otherwise the two "
        "assertions above passed for a reason other than the walls")


def test_capsule_post_route_binds_its_body_at_module_scope(world):
    """The Capsule's `ToolCall` moved to module scope (the closure-local
    forward-ref defect this suite once pinned is gone); the real route
    binds the JSON body, so FC1 exercises the Capsule with no shim."""
    assert hasattr(CT, "ToolCall") and CT.ToolCall.__module__ == CT.__name__
    application = FastAPI()
    application.include_router(CT.build_router())
    r = TestClient(application).post("/api/capsule/tools/get_facts", headers=hdr(A_OWNER, ORG_A1),
                                     json={"args": {"metric": "total_assets"}})
    assert r.status_code == 200, r.text


def test_fc1_solo_workspace_is_untouched(app, world):
    """A workspace with firm_id NULL is today's product: its owner reads
    it exactly as before, no firm sees it, and it has no firm to list."""
    client = _supabase_module.per_user(_jwt(SOLO, EMAILS[SOLO]))
    assert [p["id"] for p in client.select("financial_periods", filters={"org_id": "eq." + ORG_S})] == [PERIOD_S]
    assert client.select("organizations", filters={"id": "eq." + ORG_S})[0]["firm_id"] is None
    for firm_user in (A_OWNER, B_OWNER):
        c = _supabase_module.per_user(_jwt(firm_user, EMAILS[firm_user]))
        assert c.select("financial_periods", filters={"org_id": "eq." + ORG_S}) == []
        assert c.select("organizations", filters={"id": "eq." + ORG_S}) == []
    r = app.get("/api/firm", headers=hdr(SOLO))
    assert r.status_code == 200 and r.json()["firms"] == []
    r = app.post("/api/capsule/tools/get_facts", headers=hdr(SOLO, ORG_S),
                 json={"args": {"metric": "total_assets", "period": "December 2025"}})
    assert r.status_code == 200 and r.json().get("values")


# ══════════════════════════════════════════════════════════════════════
# 4. THE ROLE MATRIX, PER ROLE × PER ACTION, THROUGH THE ROUTES
# ══════════════════════════════════════════════════════════════════════

ROUTE_FOR_ACTION = {
    "read": ("GET", "/api/firm/{firm}/clients", None),
    "assign": ("PUT", "/api/firm/{firm}/clients/{org}/assignment",
               {"responsible_user_id": A_ACCOUNTANT, "collaborator_user_ids": []}),
    "invite": ("POST", "/api/firm/{firm}/invitations",
               {"email": "new.person@example.test", "role": "viewer"}),
    "import": ("POST", "/api/firm/{firm}/import",
               {"csv": "name,cui\nNew Client,55555555\n", "dry_run": True}),
    "manage": ("GET", "/api/firm/{firm}/audit", None),
}
ROUTE_CELLS = [(role, action) for role in EXPECTED_ROLES for action in ROUTE_FOR_ACTION]


@pytest.mark.parametrize("role,action", ROUTE_CELLS, ids=["%s-%s" % c for c in ROUTE_CELLS])
def test_matrix_cell_is_enforced_by_the_route(app, world, role, action):
    method, path, body = ROUTE_FOR_ACTION[action]
    url = path.format(firm=FIRM_A, org=ORG_A2)
    r = app.request(method, url, headers=hdr(ROLE_USER[role]), json=body)
    if expected_cell(role, action):
        assert r.status_code == 200, "%s should hold %s: %s %s" % (role, action, r.status_code, r.text)
    else:
        assert r.status_code == 403, "%s must NOT hold %s: %s %s" % (role, action, r.status_code, r.text)
        assert r.json()["detail"] == "Your firm role does not permit '%s'." % action


@pytest.mark.parametrize("role", EXPECTED_ROLES)
def test_get_firm_reports_the_callers_row_of_the_matrix(app, world, role):
    r = app.get("/api/firm/%s" % FIRM_A, headers=hdr(ROLE_USER[role]))
    assert r.status_code == 200
    assert r.json()["role"] == role
    assert r.json()["permissions"] == dict((a, expected_cell(role, a)) for a in EXPECTED_ACTIONS)
    assert r.json()["firm"]["name"] == "Firm Alpha"


def test_roles_endpoint_publishes_the_matrix_verbatim(app, world):
    r = app.get("/api/firm/roles", headers=hdr(A_VIEWER))
    assert r.status_code == 200
    assert r.json()["roles"] == list(EXPECTED_ROLES)
    assert r.json()["matrix"] == dict((role, dict((a, expected_cell(role, a)) for a in EXPECTED_ACTIONS))
                                      for role in EXPECTED_ROLES)
    assert app.get("/api/firm/roles").status_code == 401


# ══════════════════════════════════════════════════════════════════════
# 5. ATTACH / DETACH — additive and clean
# ══════════════════════════════════════════════════════════════════════

def test_attach_then_detach_is_additive_and_clean(app, world):
    # the partner owns ORG_P and holds `import`: they may bring it in
    before = copy.deepcopy(next(o for o in world.rows("organizations") if o["id"] == ORG_P))
    r = app.post("/api/firm/%s/clients/attach" % FIRM_A, headers=hdr(A_PARTNER), json={"org_id": ORG_P})
    assert r.status_code == 200, r.text
    org = next(o for o in world.rows("organizations") if o["id"] == ORG_P)
    assert org["firm_id"] == FIRM_A
    assignment = next(a for a in world.rows("client_assignments") if a["org_id"] == ORG_P)
    assert assignment["responsible_user_id"] is None, "attach must not invent a responsible accountant"
    # the firm now reads it; a second attach is a state conflict, not a re-file
    r = app.get("/api/firm/%s/clients" % FIRM_A, headers=hdr(A_VIEWER))
    assert ORG_P in [c["org_id"] for c in r.json()["clients"]]
    r = app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(A_PARTNER), json={"org_id": ORG_P})
    assert r.status_code == 403  # partner is not in firm B
    world.add("firm_memberships", {"firm_id": FIRM_B, "user_id": A_PARTNER, "role": "partner"})
    r = app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(A_PARTNER), json={"org_id": ORG_P})
    assert r.status_code == 409 and "already attached" in r.text

    # detach: the workspace keeps working solo, exactly as before
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_P), headers=hdr(A_PARTNER))
    assert r.status_code == 200, r.text
    org = next(o for o in world.rows("organizations") if o["id"] == ORG_P)
    assert org["firm_id"] is None
    assert not [a for a in world.rows("client_assignments") if a["org_id"] == ORG_P]
    after = dict(org)
    after.pop("firm_id")
    before.pop("firm_id")
    assert after == before, "detach must change nothing but firm_id"
    owner_client = _supabase_module.per_user(_jwt(A_PARTNER, EMAILS[A_PARTNER]))
    assert owner_client.select("organizations", filters={"id": "eq." + ORG_P})
    viewer_client = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    assert viewer_client.select("organizations", filters={"id": "eq." + ORG_P}) == []
    actions = [a["action"] for a in world.rows("firm_audit_log") if a["firm_id"] == FIRM_A]
    assert actions[-2:] == ["client.attach", "client.detach"]


def test_attach_needs_the_workspace_owner_and_the_import_cell(app, world):
    # firm-A owner holds `import` but does not own ORG_S → the workspace owner's consent is missing
    r = app.post("/api/firm/%s/clients/attach" % FIRM_A, headers=hdr(A_OWNER), json={"org_id": ORG_S})
    assert r.status_code == 403 and "workspace owner" in r.text
    # the solo owner consents but is not in the firm at all
    r = app.post("/api/firm/%s/clients/attach" % FIRM_A, headers=hdr(SOLO), json={"org_id": ORG_S})
    assert r.status_code == 403
    # a firm viewer who owns a workspace still lacks `import`
    world.add("memberships", {"user_id": A_VIEWER, "org_id": ORG_S, "role": "owner"})
    r = app.post("/api/firm/%s/clients/attach" % FIRM_A, headers=hdr(A_VIEWER), json={"org_id": ORG_S})
    assert r.status_code == 403 and "'import'" in r.text
    assert world.firm_of_org(ORG_S) is None


def test_detach_by_firm_manage_or_workspace_owner_only(app, world):
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_PARTNER))
    assert r.status_code == 403, "partner: no manage, not the workspace owner"
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_B1), headers=hdr(A_OWNER))
    assert r.status_code == 403 and r.json()["detail"] == _firm.NOT_A_CLIENT
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, U(999)), headers=hdr(A_OWNER))
    assert r.status_code == 403 and r.json()["detail"] == _firm.NOT_A_CLIENT, (
        "a missing org and someone else's org must be indistinguishable")
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) is None


# ══════════════════════════════════════════════════════════════════════
# 6. ASSIGNMENTS
# ══════════════════════════════════════════════════════════════════════

def test_assignment_requires_firm_members_and_records_the_change(app, world):
    url = "/api/firm/%s/clients/%s/assignment" % (FIRM_A, ORG_A2)
    r = app.put(url, headers=hdr(A_PARTNER),
                json={"responsible_user_id": B_OWNER, "collaborator_user_ids": []})
    assert r.status_code == 400 and "member of the firm" in r.text
    r = app.put(url, headers=hdr(A_PARTNER),
                json={"responsible_user_id": A_ACCOUNTANT, "collaborator_user_ids": [SOLO]})
    assert r.status_code == 400 and "collaborator" in r.text
    r = app.put(url, headers=hdr(A_PARTNER),
                json={"responsible_user_id": A_ACCOUNTANT, "collaborator_user_ids": [A_ASSISTANT]})
    assert r.status_code == 200, r.text
    a = next(x for x in world.rows("client_assignments") if x["org_id"] == ORG_A2)
    assert a["responsible_user_id"] == A_ACCOUNTANT and a["collaborator_user_ids"] == [A_ASSISTANT]
    r = app.put(url, headers=hdr(A_PARTNER), json={"responsible_user_id": None})
    assert r.status_code == 200
    assert next(x for x in world.rows("client_assignments") if x["org_id"] == ORG_A2)["responsible_user_id"] is None
    # cross-firm target: refused before the RPC, with the indistinguishable message
    r = app.put("/api/firm/%s/clients/%s/assignment" % (FIRM_A, ORG_B1), headers=hdr(A_PARTNER),
                json={"responsible_user_id": A_ACCOUNTANT})
    assert r.status_code == 403 and r.json()["detail"] == _firm.NOT_A_CLIENT
    audit = [x for x in world.rows("firm_audit_log") if x["action"] == "client.assign"]
    assert len(audit) == 2 and audit[0]["actor_user_id"] == A_PARTNER


def test_removing_a_member_scrubs_their_assignments_and_guards_the_last_owner(app, world):
    r = app.delete("/api/firm/%s/members/%s" % (FIRM_A, A_ACCOUNTANT), headers=hdr(A_OWNER))
    assert r.status_code == 200
    assert next(x for x in world.rows("client_assignments") if x["org_id"] == ORG_A1)["responsible_user_id"] is None
    assert world.firm_role_of(A_ACCOUNTANT, FIRM_A) is None
    r = app.delete("/api/firm/%s/members/%s" % (FIRM_A, A_OWNER), headers=hdr(A_OWNER))
    assert r.status_code == 409 and "last owner" in r.text
    r = app.put("/api/firm/%s/members/%s/role" % (FIRM_A, A_OWNER), headers=hdr(A_OWNER),
                json={"role": "viewer"})
    assert r.status_code == 409
    r = app.put("/api/firm/%s/members/%s/role" % (FIRM_A, A_PARTNER), headers=hdr(A_OWNER),
                json={"role": "owner"})
    assert r.status_code == 200 and world.firm_role_of(A_PARTNER, FIRM_A) == "owner"
    r = app.delete("/api/firm/%s/members/%s" % (FIRM_A, A_OWNER), headers=hdr(A_OWNER))
    assert r.status_code == 200, "with a second owner in place, leaving is allowed"
    # a viewer may leave on their own, but may not remove anyone else
    r = app.delete("/api/firm/%s/members/%s" % (FIRM_A, A_ASSISTANT), headers=hdr(A_VIEWER))
    assert r.status_code == 403
    r = app.delete("/api/firm/%s/members/%s" % (FIRM_A, A_VIEWER), headers=hdr(A_VIEWER))
    assert r.status_code == 200 and world.firm_role_of(A_VIEWER, FIRM_A) is None
    r = app.put("/api/firm/%s/members/%s/role" % (FIRM_A, A_ASSISTANT), headers=hdr(A_PARTNER),
                json={"role": "director"})
    assert r.status_code == 400


# ══════════════════════════════════════════════════════════════════════
# 7. INVITATIONS — e-mail-scoped, role-scoped, expiring, audit-logged
# ══════════════════════════════════════════════════════════════════════

def test_invitation_lifecycle(app, world):
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_PARTNER),
                 json={"email": "New.Hire@Example.Test", "role": "accountant", "ttl_hours": 48})
    assert r.status_code == 200, r.text
    inv = r.json()["invitation"]
    assert inv["email"] == "new.hire@example.test" and inv["role"] == "accountant"
    assert inv["status"] == "pending" and inv["token"] and inv["accept_url"].endswith("?token=" + inv["token"])
    assert r.json()["email"]["queued"] is True
    queued = [q for q in world.rows("firm_invite_email_queue") if q["invitation_id"] == inv["id"]]
    assert len(queued) == 1 and queued[0]["status"] == "queued" and queued[0]["sent_at"] is None
    assert queued[0]["payload"]["to"] == "new.hire@example.test"
    assert queued[0]["payload"]["vars"]["firm_name"] == "Firm Alpha"
    assert queued[0]["template"] == _firm_invites.INVITE_TEMPLATE
    assert [a["action"] for a in world.rows("firm_audit_log") if a["firm_id"] == FIRM_A][-1] == "invite.create"

    # the invitee signs in with the matching e-mail and sees it under "mine"
    world.auth_users[NOBODY] = "new.hire@example.test"
    EMAILS[NOBODY] = "new.hire@example.test"
    try:
        r = app.get("/api/firm/invitations/mine", headers=hdr(NOBODY))
        assert r.status_code == 200
        assert [i["id"] for i in r.json()["invitations"]] == [inv["id"]]
        assert r.json()["invitations"][0]["firm_name"] == "Firm Alpha"
        r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": inv["token"]})
        assert r.status_code == 200, r.text
        assert r.json()["firm_id"] == FIRM_A and r.json()["role"] == "accountant"
        assert world.firm_role_of(NOBODY, FIRM_A) == "accountant"
        r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": inv["token"]})
        assert r.status_code == 409 and "already accepted" in r.text
    finally:
        EMAILS[NOBODY] = "nobody@example.test"
    r = app.get("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_PARTNER))
    listed = dict((i["id"], i["status"]) for i in r.json()["invitations"])
    assert listed[inv["id"]] == "accepted"
    assert all("token" not in i for i in r.json()["invitations"]), "the list never re-exposes tokens"
    assert [a["action"] for a in world.rows("firm_audit_log") if a["firm_id"] == FIRM_A][-1] == "invite.accept"


def test_invitation_refuses_the_wrong_email_expiry_and_revocation(app, world):
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                 json={"email": "invited@example.test", "role": "viewer", "ttl_hours": 2})
    token = r.json()["invitation"]["token"]
    # wrong e-mail: 403, membership unchanged
    r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": token})
    assert r.status_code == 403 and "different e-mail" in r.text
    assert world.firm_role_of(NOBODY, FIRM_A) is None
    # expired
    world.clock = world.clock + timedelta(hours=3)
    EMAILS[NOBODY] = "invited@example.test"
    try:
        r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": token})
        assert r.status_code == 409 and "expired" in r.text
        assert app.get("/api/firm/invitations/mine", headers=hdr(NOBODY)).json()["invitations"] == []
        # revoked (a fresh one)
        r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                     json={"email": "invited@example.test", "role": "viewer"})
        fresh = r.json()["invitation"]
        r = app.post("/api/firm/%s/invitations/%s/revoke" % (FIRM_A, fresh["id"]), headers=hdr(A_PARTNER))
        assert r.status_code == 200
        r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": fresh["token"]})
        assert r.status_code == 409 and "revoked" in r.text
        # unknown token
        r = app.post("/api/firm/invitations/accept", headers=hdr(NOBODY), json={"token": U(777)})
        assert r.status_code == 404
    finally:
        EMAILS[NOBODY] = "nobody@example.test"
    assert world.firm_role_of(NOBODY, FIRM_A) is None
    # firm-B cannot revoke firm-A's invitation
    r = app.post("/api/firm/%s/invitations/%s/revoke" % (FIRM_B, fresh["id"]), headers=hdr(B_OWNER))
    assert r.status_code == 404


def test_invitation_role_scoping(app, world):
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_PARTNER),
                 json={"email": "x@example.test", "role": "owner"})
    assert r.status_code == 403 and "manage" in r.text, "a partner must not mint owners"
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                 json={"email": "x@example.test", "role": "owner"})
    assert r.status_code == 200
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                 json={"email": "x@example.test", "role": "ceo"})
    assert r.status_code == 400
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                 json={"email": "not-an-email", "role": "viewer"})
    assert r.status_code == 400
    r = app.post("/api/firm/%s/invitations" % FIRM_A, headers=hdr(A_OWNER),
                 json={"email": "x@example.test", "role": "viewer", "ttl_hours": 9999})
    assert r.status_code == 422, "TTL outside 1..720 h is rejected at the edge"


def test_invitation_status_is_a_pure_function_of_row_and_clock():
    now = datetime(2026, 9, 3, tzinfo=timezone.utc)
    later = (now + timedelta(days=1)).isoformat()
    earlier = (now - timedelta(days=1)).isoformat()
    assert _firm_invites.invitation_status({"expires_at": later}, now) == "pending"
    assert _firm_invites.invitation_status({"expires_at": earlier}, now) == "expired"
    assert _firm_invites.invitation_status({"expires_at": later, "accepted_at": earlier}, now) == "accepted"
    assert _firm_invites.invitation_status({"expires_at": later, "revoked_at": earlier,
                                            "accepted_at": earlier}, now) == "revoked"


def test_enqueue_degrades_honestly_when_the_queue_is_missing(world, monkeypatch):
    class _Broken(_Client):
        def insert(self, table, rows, returning=True):
            raise RuntimeError("relation firm_invite_email_queue does not exist")
    monkeypatch.setattr(_supabase_module, "admin", lambda: _Broken(world, None, None))
    out = _firm_invites.enqueue_invitation_email(
        {"id": U(1), "email": "a@example.test", "role": "viewer", "token": U(2), "expires_at": "x"}, "F")
    assert out["queued"] is False and "accept link" in out["note"]


# ══════════════════════════════════════════════════════════════════════
# 8. CSV IMPORT — honest resolution, never a guess
# ══════════════════════════════════════════════════════════════════════

@pytest.fixture()
def public_store(tmp_path, monkeypatch):
    """A REAL PublicRoStore (the sanctioned public-data spine) in a temp
    file — TC-4: never the repo's data/public_ro.db."""
    from engine.public_ro.store import PublicRoStore
    db = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(db))
    store = PublicRoStore(db)
    store.ensure_company_stub(12345678, "1013")
    store.set_identification(12345678, name="CARNE BUNA SRL", county="Sibiu", locality="Sibiu",
                             reg_number="J32/100/2001", tip_contrib="PJ", publishable=True,
                             name_source="identification-2026")
    store.ensure_company_stub(87654321, "2599")
    store.set_identification(87654321, name="METAL PRELUCRAT SRL", county="Cluj", locality="Cluj-Napoca",
                             reg_number="J12/200/2005", tip_contrib="PJ", publishable=True,
                             name_source="identification-2026")
    store.ensure_company_stub(55555555, "6920")
    store.set_identification(55555555, name="POPESCU ION PFA", county="Iasi", locality="Iasi",
                             reg_number="F22/300/2010", tip_contrib="PF", publishable=False,
                             name_source="identification-2026")
    yield store
    store.close()


IMPORT_CSV = (
    "Name;CUI;Industry;Responsible\n"
    ";RO 12.345.678;;a.accountant@example.test\n"          # name + industry from public data (exact CAEN)
    "Metal Prelucrat SRL;87654321;;a.viewer@example.test\n"   # CAEN is sector_fallback → UNRESOLVED, hint kept
    "Explicit Industry SRL;99999999;food_manufacturing;%s\n"  # industry from the file, responsible by user id
    "Unknown CUI SRL;44444444;;stranger@example.test\n"       # nothing public, responsible not a member
    "Retired Key SRL;66666666;retired_key;\n"                  # inactive industry key → UNRESOLVED
    "Popescu Ion;55555555;;\n"                                 # PF row: public data withheld (PS7)
    "Dup of A1;11111111;;\n"                                   # already a client → skipped
    "Bad CUI;ROXYZ;;\n"                                        # invalid → issue
    ";77777777;;\n"                                            # no name in file, none public → issue
    ";44444444;;\n"                                            # repeats inside the file → skipped
) % A_ASSISTANT


def test_import_creates_clients_honestly(app, world, public_store):
    before_orgs = len(world.rows("organizations"))
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER),
                 json={"csv": IMPORT_CSV, "dry_run": False})
    assert r.status_code == 200, r.text
    report = r.json()
    assert report["columns"] == ["cui", "industry", "name", "responsible"]
    assert report["counts"] == {"rows": 10, "created": 6, "skipped": 2, "issues": 2,
                                "industry_unresolved": 4, "responsible_unresolved": 1}
    by_cui = dict((c["cui"], c) for c in report["created"])
    assert sorted(by_cui) == ["12345678", "44444444", "55555555", "66666666", "87654321", "99999999"]

    # 3. industry from the file, responsible by user id
    c = by_cui["99999999"]
    assert c["industry_status"] == "resolved" and c["industry_key"] == "food_manufacturing"
    assert c["resolution"]["industry"]["source"] == "user_provided"
    assert c["responsible_user_id"] == A_ASSISTANT and c["responsible_status"] == "resolved"

    # 1. name and industry from the public spine, credited
    c = by_cui["12345678"]
    assert c["name"] == "CARNE BUNA SRL" and c["resolution"]["name"]["source"] == "public_registry"
    assert c["industry_status"] == "resolved" and c["industry_key"] == "food_manufacturing"
    assert c["resolution"]["industry"]["source"] == "auto_caen"
    assert c["resolution"]["industry"]["caen"] == "1013"
    assert c["resolution"]["public_data"]["source"] == "data.gov.ro"
    assert c["responsible_user_id"] == A_ACCOUNTANT

    # 2. sector_fallback is a guess: UNRESOLVED, hint recorded, industry_key NULL
    c = by_cui["87654321"]
    assert c["industry_status"] == "unresolved" and c["industry_key"] is None
    assert c["resolution"]["industry"]["reason"] == "sector_fallback_only"
    assert c["resolution"]["industry"]["hint_industry_key"] == "manufacturing_generic"
    assert c["name"] == "Metal Prelucrat SRL" and c["resolution"]["name"]["source"] == "csv"
    assert c["resolution"]["name"]["public_name"] == "METAL PRELUCRAT SRL"

    # 4. nothing public, responsible not a member → unresolved markers, created unassigned
    c = by_cui["44444444"]
    assert c["resolution"]["public_data"] == {"status": "absent"}
    assert c["industry_status"] == "unresolved" and c["resolution"]["industry"]["reason"] == "no_industry_signal"
    assert c["responsible_status"] == "unresolved" and c["responsible_user_id"] is None
    assert c["resolution"]["responsible"]["value"] == "stranger@example.test"

    # 5. inactive key is not silently accepted
    c = by_cui["66666666"]
    assert c["resolution"]["industry"] == {"status": "unresolved", "reason": "unknown_industry_key",
                                           "value": "retired_key"}
    # 6. PF: the store's row is withheld — no name, no CAEN leaks into the workspace
    c = by_cui["55555555"]
    assert c["resolution"]["public_data"] == {"status": "withheld", "reason": "not_publishable"}
    assert c["name"] == "Popescu Ion" and "PFA" not in json.dumps(c)

    assert [s["cui"] for s in report["skipped"]] == ["11111111", "44444444"]
    assert report["skipped"][0]["org_id"] == ORG_A1
    assert [(i["line"], i["code"]) for i in report["issues"]] == [(9, "invalid_cui"), (10, "name_required")]

    # writes: one org per created row, importer owner + responsible admin, assignment, audit
    created_orgs = [o for o in world.rows("organizations") if o["id"] in [c["org_id"] for c in report["created"]]]
    assert len(created_orgs) == len(report["created"]) == len(world.rows("organizations")) - before_orgs
    for c in report["created"]:
        org = next(o for o in created_orgs if o["id"] == c["org_id"])
        assert org["firm_id"] == FIRM_A and org["cui"] == c["cui"] and org["industry_key"] == c["industry_key"]
        members = dict((m["user_id"], m["role"]) for m in world.rows("memberships") if m["org_id"] == org["id"])
        assert members[A_PARTNER] == "owner"
        if c["responsible_user_id"] and c["responsible_user_id"] != A_PARTNER:
            assert members[c["responsible_user_id"]] == "admin"
        a = next(x for x in world.rows("client_assignments") if x["org_id"] == org["id"])
        assert a["responsible_user_id"] == c["responsible_user_id"]
        assert a["import_resolution"]["industry"]["status"] == c["industry_status"]
    assert sum(1 for x in world.rows("firm_audit_log") if x["action"] == "client.import") == len(report["created"])
    # the firm sees them all; firm B sees none
    r = app.get("/api/firm/%s/clients" % FIRM_A, headers=hdr(A_VIEWER))
    assert len(r.json()["clients"]) == 2 + len(report["created"])
    assert app.get("/api/firm/%s/clients" % FIRM_B, headers=hdr(B_OWNER)).json()["count"] == 1
    # a second run: everything is now a duplicate
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER), json={"csv": IMPORT_CSV})
    assert r.json()["counts"]["created"] == 0 and r.json()["counts"]["skipped"] >= len(report["created"]) + 1


def test_import_row_census_matches_the_file(app, world, public_store):
    """Explicit per-line expectation for the fixture file (TC-6) — the
    previous test asserts contents, this one pins WHICH line became what."""
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER),
                 json={"csv": IMPORT_CSV, "dry_run": True})
    report = r.json()
    outcome = {}
    for c in report["created"]:
        outcome[c["line"]] = "created"
    for s in report["skipped"]:
        outcome[s["line"]] = "skipped"
    for i in report["issues"]:
        outcome[i["line"]] = "issue:" + i["code"]
    assert outcome == {2: "created", 3: "created", 4: "created", 5: "created", 6: "created",
                       7: "created", 8: "skipped", 9: "issue:invalid_cui",
                       10: "issue:name_required", 11: "skipped"}


def test_import_dry_run_writes_nothing_and_is_byte_deterministic(app, world, public_store):
    snapshot = json.dumps(world.tables, sort_keys=True, default=str)
    r1 = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER),
                  json={"csv": IMPORT_CSV, "dry_run": True})
    r2 = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER),
                  json={"csv": IMPORT_CSV, "dry_run": True})
    assert r1.status_code == 200 and r1.content == r2.content
    assert r1.json()["dry_run"] is True and r1.json()["counts"]["created"] == 6
    assert json.dumps(world.tables, sort_keys=True, default=str) == snapshot
    assert not any("org_id" in c for c in r1.json()["created"])


def test_import_refuses_a_file_without_a_cui_column_and_the_matrix_cell(app, world):
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_PARTNER),
                 json={"csv": "company,industry\nX,food_manufacturing\n"})
    assert r.status_code == 400 and "No cui column" in r.text
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_ACCOUNTANT),
                 json={"csv": "name,cui\nX,12345678\n", "dry_run": True})
    assert r.status_code == 403
    r = app.get("/api/firm/import/columns", headers=hdr(A_ACCOUNTANT))
    assert r.status_code == 200 and r.json()["required"] == ["cui"]


def test_import_without_the_public_spine_is_unavailable_not_absent(app, world, monkeypatch):
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", "/nonexistent/public_ro.db")
    _firm_import.reset_default_public_store()
    r = app.post("/api/firm/%s/import" % FIRM_A, headers=hdr(A_OWNER),
                 json={"csv": "name,cui\nX SRL,12345678\n", "dry_run": True})
    assert r.status_code == 200
    c = r.json()["created"][0]
    assert c["resolution"]["public_data"] == {"status": "unavailable", "reason": "public_store_unavailable"}
    assert c["industry_status"] == "unresolved"


@pytest.mark.parametrize("raw,expected", [
    ("RO 12.345.678", "12345678"), ("ro12345678", "12345678"), (" 1234 5678 ", "12345678"),
    ("RO", None), ("", None), ("12345678901", None), ("1", None), ("12", "12"),
    ("0000012345", "12345"), ("RO-12345678", "12345678"), ("12a45", None),
])
def test_normalize_cui(raw, expected):
    assert _firm_import.normalize_cui(raw) == expected


def test_parse_csv_accepts_aliases_and_delimiters():
    rows, issues, header = _firm_import.parse_clients_csv(
        "﻿Denumire,CIF,Industrie,Responsabil\nAlfa,1,x,y\n\n")
    assert header == {"name": 0, "cui": 1, "industry": 2, "responsible": 3}
    assert rows[0].name == "Alfa" and rows[0].responsible == "y" and not issues
    rows, _, header = _firm_import.parse_clients_csv("cui\tname\n1\tBeta\n")
    assert header == {"cui": 0, "name": 1} and rows[0].name == "Beta"
    with pytest.raises(_firm_import.CsvFormatError):
        _firm_import.parse_clients_csv("")


# ══════════════════════════════════════════════════════════════════════
# 9. THE PROFILE-NAME GUARD (test_company_profile.py §8), APPLIED TO ROLES AND NAMES
#    — and no write to a client's books
# ══════════════════════════════════════════════════════════════════════

FIXTURE_NAME_TOKENS = ("Firm Alpha", "Firm Beta", "Client A1", "Client A2", "Client B1",
                       "Scandia", "Carniprod", "EEI", "Agras")


def _role_literal_branches(source):  # type: (str) -> List[Tuple[int, str]]
    """Compare nodes with a role name on one side — a branch on a role."""
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left] + list(node.comparators)
        for operand in operands:
            if isinstance(operand, ast.Constant) and isinstance(operand.value, str) \
                    and operand.value in EXPECTED_ROLES:
                hits.append((node.lineno, operand.value))
    return hits


def _role_literals_outside_module_data(source):  # type: (str) -> List[Tuple[int, str]]
    """Role names may appear as DATA (module-level assignments) only."""
    tree = ast.parse(source)
    data_nodes = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for node in ast.walk(stmt.value):
                data_nodes.add(id(node))
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and node.value in EXPECTED_ROLES and id(node) not in data_nodes:
            hits.append((node.lineno, node.value))
    return hits


def _quoted_fixture_names(source):  # type: (str) -> List[Tuple[int, str]]
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            for token in FIXTURE_NAME_TOKENS:
                if token in node.value:
                    hits.append((node.lineno, node.value))
    return hits


def _write_targets(source):  # type: (str) -> List[Tuple[int, str, str]]
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr in ("insert", "update", "delete", "upsert") and node.args:
            receiver = node.func.value
            if isinstance(receiver, ast.Name) and receiver.id == "router":
                continue  # @router.delete("/path") is a route, not a write
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                hits.append((node.lineno, node.func.attr, first.value))
    return hits


CLIENT_BOOK_TABLES = ("financial_periods", "documents", "statement_line_items",
                      "calculated_metrics", "briefings", "alerts", "recommendations")


def test_n7_firm_modules_never_branch_on_a_role_name_or_quote_a_client():
    violations = []
    for path in FIRM_MODULES + COCKPIT_MODULES:
        source = path.read_text(encoding="utf-8")
        for lineno, value in _role_literal_branches(source):
            violations.append("%s:%d compares against role %r" % (path.name, lineno, value))
        for lineno, value in _role_literals_outside_module_data(source):
            violations.append("%s:%d mentions role %r outside module data" % (path.name, lineno, value))
        for lineno, value in _quoted_fixture_names(source):
            violations.append("%s:%d quotes a firm/client name %r" % (path.name, lineno, value))
    assert not violations, (
        "roles-as-data guard: the matrix is data, `can(role, action)` is the only question:\n"
        + "\n".join(violations))


def test_n7_guard_is_not_vacuous():
    assert _role_literal_branches("if ctx.role == 'owner':\n    pass\n")
    assert _role_literals_outside_module_data("def f():\n    return 'partner'\n")
    assert not _role_literals_outside_module_data("ROLES = ('partner',)\n")
    assert _quoted_fixture_names("x = 'Client A1 rows'\n")
    assert _write_targets("ac.insert('documents', {})\n") == [(1, "insert", "documents")]


def test_firm_modules_never_write_to_a_clients_books():
    """The firm model's ONLY direct table write is the invitation e-mail
    queue (service-role, no policy, after the guarded RPC minted the
    invitation). Every other firm-model write — attach, detach, assign,
    roles, invitations and, since W1, the CSV importer's client creation
    — is a SECURITY DEFINER RPC called as the user, guarded by
    `firm_can()` in SQL and audited (test_sql_every_mutating_rpc_is_
    guarded_and_audited)."""
    found = []  # type: List[Tuple[str, str, str, str, int]]
    for path in FIRM_MODULES:
        # _write_sites resolves a table named by a module constant too
        # (the invites queue is INVITE_QUEUE_TABLE, not a literal)
        found.extend((path.name,) + hit for hit in _write_sites(path.read_text(encoding="utf-8")))
    assert found, "write-site census found nothing — discovery broken"
    offenders = [hit for hit in found if hit[3] in CLIENT_BOOK_TABLES]
    assert not offenders, "a firm reads its clients' books; it never writes them: %s" % offenders
    assert set(hit[3] for hit in found) == {_firm_invites.INVITE_QUEUE_TABLE}, (
        "a firm-model write outside the guarded RPCs: %s" % found)
    source = (REPO / "src" / "engine" / "api" / "_firm_import.py").read_text(encoding="utf-8")
    assert "organizations" not in set(hit[3] for hit in found), "the importer writes through the RPC"
    assert '"%s"' % _firm_import.IMPORT_RPC in source and _firm_import.IMPORT_RPC == "import_firm_client"
    body = parse_functions(_sql_text())[_firm_import.IMPORT_RPC]["body"]
    assert sql_actions_of(body) == ["import"] and "perform firm_audit(" in body
    for table in ("organizations", "memberships", "client_assignments"):
        assert "insert into %s" % table in body, "import_firm_client no longer writes %s" % table
    assert "'%s'" % _firm_import.ORG_ROLE_FOR_IMPORTER in body
    assert "'%s'" % _firm_import.ORG_ROLE_FOR_RESPONSIBLE in body


def test_the_firm_modules_import_no_model_client():
    for path in FIRM_MODULES:
        source = path.read_text(encoding="utf-8")
        assert "anthropic" not in source.lower(), "%s must stay deterministic: no model client" % path.name


# ══════════════════════════════════════════════════════════════════════
# 10. THE WHOLE /api/firm SURFACE — every router server.py mounts (C1),
#     two walls on the cockpit routes (C2), a client's request history
#     does not follow it across firms (C3)
# ══════════════════════════════════════════════════════════════════════

#: Every secret seeded into a cockpit table for firm-A's client, plus the
#: client's own identifiers. An intruder's answer may carry NONE of them.
COCKPIT_MARKERS = (SECRET_NOTE, SECRET_EMAIL, SECRET_SUPPRESSION, SECRET_COVENANT, SECRET_BRIEF,
                   SECRET_TOKEN, SECRET_EMAIL_SUBJECT,
                   json.dumps(SECRET_CADENCE_NUDGES, separators=(",", ":")),
                   "Client A1", REQUEST_A1, PERIOD_A1)

#: The cockpit routes a SIGNED-IN user reads client data through, with
#: every shape they accept. `{firm}` is filled per shape (firm-A's id,
#: the intruder's own firm, or omitted); `{org}` is firm-A's client.
#: `no_firm`: what the route does when no firm is named — "client":
#: needs a membership in the client workspace (an intruder is refused);
#: "own": the caller's own scope (an intruder gets their own, empty).
COCKPIT_ROUTES = [
    ("requests-create", "POST", "/api/firm/requests", None,
     {"client_org_id": "{org}", "period_end": "2026-02-28", "firm_id": "{firm}"}, "client"),
    ("requests-list", "GET", "/api/firm/requests/list",
     {"client_org_id": "{org}", "firm_id": "{firm}"}, None, "client"),
    ("requests-revoke", "POST", "/api/firm/requests/{request_id}/revoke",
     {"firm_id": "{firm}"}, None, "client"),
    ("cadence-status", "GET", "/api/firm/cadence/status",
     {"client_org_id": "{org}", "firm_id": "{firm}", "as_of": "2026-03-10"}, None, "client"),
    ("cadence-put", "PUT", "/api/firm/cadence", None,
     {"client_org_id": "{org}", "firm_id": "{firm}", "cadence": "monthly"}, "client"),
    ("digest-prefs-get", "GET", "/api/firm/digest/prefs", {"firm_id": "{firm}"}, None, "own"),
    ("digest-prefs-put", "PUT", "/api/firm/digest/prefs", None,
     {"firm_id": "{firm}", "enabled": True}, "own"),
    ("brief", "POST", "/api/firm/brief", None, {"firm_id": "{firm}", "as_of": "2026-03-10"}, "own"),
]

#: The attention routes take no firm: the caller's book is exactly what
#: RLS returns them (own workspaces + firm-readable clients).
ATTENTION_ROUTES = [
    ("attention-board", "GET", "/api/firm/attention", {"as_of": "2026-03-10"}, None),
    ("attention-board-one-client", "GET", "/api/firm/attention",
     {"as_of": "2026-03-10", "client_id": "{org}"}, None),
    ("attention-suppressions", "GET", "/api/firm/attention/suppressions", None, None),
    ("attention-suppress", "POST", "/api/firm/attention/suppress", None,
     {"client_id": "{org}", "kind": "CASH_RUNWAY", "reason": "an intruder's reason"}),
]

#: Routes under /api/firm that serve NO firm-A client data, each with the
#: reason it is not swept cross-firm (the census below refuses an
#: unlisted route). Token- and scheduler-gated routes are proven
#: unreachable without their secret in test_token_and_scheduler_routes…
DECLARED_NOT_CLIENT_DATA = {
    ("GET", "/api/firm/roles"): "the matrix — reference data for any signed-in user",
    ("GET", "/api/firm"): "the caller's OWN firms (list_firms RPC, RLS)",
    ("POST", "/api/firm"): "creates the caller's own firm",
    ("GET", "/api/firm/invitations/mine"): "invitations to the caller's OWN e-mail (invitee policy)",
    ("POST", "/api/firm/invitations/accept"): "the caller's own acceptance (e-mail-scoped RPC)",
    ("GET", "/api/firm/import/columns"): "the CSV column contract",
    ("GET", "/api/firm/requests/resolve/{token}"): "TOKEN-gated: the signed link is the auth",
    ("POST", "/api/firm/requests/{token}/upload"): "TOKEN-gated: the signed link is the auth",
    ("POST", "/api/firm/requests/cron/nudge"): "SCHEDULER-gated (ENGINE_API_TOKEN, fail closed)",
    ("POST", "/api/firm/digest/cron/run"): "SCHEDULER-gated (ENGINE_API_TOKEN, fail closed)",
    ("POST", "/api/firm/email/drain"): "ADMIN-gated (PRICING_ADMIN_USER_IDS)",
    ("GET", "/api/firm/brief/self-check"): "the model role's self-check; no client data",
    ("GET", "/api/firm/attention/kinds"): "the attention pack; no client data",
}

#: Mutating routes whose ONLY write is driven by a dedicated test rather
#: than the generic write sweep (the sweep would pass vacuously on them:
#: their write happens only under a condition the sweep cannot meet).
WRITE_SWEPT_BY_NAME = {
    ("POST", "/api/firm/brief"): "its only write is the brief cache row, and only when a model "
                                 "advisory was earned — the wall on that write is driven by "
                                 "test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients",
}

INTRUDERS = [B_OWNER, B_VIEWER, SOLO, NOBODY]
INTRUDER_IDS = ["b_owner", "b_viewer", "solo", "nobody"]
OWN_FIRM = {B_OWNER: FIRM_B, B_VIEWER: FIRM_B, SOLO: U(999), NOBODY: U(999)}
FIRM_SHAPES = ("firm_a", "own_firm", "no_firm")


def _no_marker(route_id, response, actor, shape):  # type: (str, Any, str, str) -> None
    hits = [m for m in COCKPIT_MARKERS if m in response.text]
    assert not hits, (
        "FC1 VIOLATED — route %s (shape %s) answered %d to %s with firm-A client data %s: %s"
        % (route_id, shape, response.status_code, actor, hits, response.text[:400]))


def _send(app, method, path, query, body, actor, **fill):
    url = _fill(path, **fill)
    params = None
    if query is not None:
        params = dict((k, _fill(v, **fill)) for k, v in query.items() if _fill(v, **fill) != "")
    payload = None
    if body is not None:
        payload = {}
        for k, v in body.items():
            filled = _fill(v, **fill) if isinstance(v, str) else v
            if filled != "":
                payload[k] = filled
    return app.request(method, url, params=params, headers=hdr(actor), json=payload)


def test_the_fixture_mounts_exactly_what_create_app_mounts(app, real_app_routes):
    """W2. A firm router mounted in production and not here would leave a
    client-data surface outside FC1 — exactly the gap the critics found,
    and one an import-shape regex over server.py catches only for the
    one shape it was written for. The source is the REAL app's route
    table: `create_app()` is built and every (method, path, endpoint)
    it serves under /api/firm and /api/capsule must be served, by the
    same endpoint, by the fixture — whatever import shape mounted it."""
    fixture = _route_table(app.app)
    missing = real_app_routes - fixture
    assert not missing, (
        "FC1 SURFACE INCOMPLETE — create_app() serves route(s) the fixture does not mount "
        "(a router reached server.py by an import shape the fixture roster %s does not "
        "carry): %s — add its module to FIRM_ROUTERS and classify every route it serves"
        % (FIRM_ROUTERS, sorted(missing)))
    extra = fixture - real_app_routes
    assert not extra, "the fixture mounts route(s) production does not serve: %s" % sorted(extra)
    assert len(real_app_routes) >= 36, "route census collapsed: %d" % len(real_app_routes)
    assert any(p.startswith("/api/capsule") for _m, p, _e in real_app_routes)


def test_every_mounted_firm_route_is_swept_or_declared(real_app_routes):
    """THE CENSUS, over the REAL app. Every (method, path) `create_app()`
    serves under /api/firm is either driven cross-firm by a READ sweep,
    driven by the WRITE sweep, or declared, with its reason, as serving
    no client data. A new route is red until it is classified; a
    classification that names a route the app no longer serves is red
    too (a stale sweep is a sweep of nothing)."""
    served = set((m, p) for m, p, _e in real_app_routes if p.startswith("/api/firm"))
    swept_read = set((m, p) for m, p, _ in CROSS_FIRM_ROUTES)
    swept_read |= set((m, p) for _i, m, p, _q, _b, _n in COCKPIT_ROUTES)
    swept_read |= set((m, p) for _i, m, p, _q, _b in ATTENTION_ROUTES)
    swept_write = set((w["method"], w["template"]) for w in WRITE_ROUTES)
    declared = set(DECLARED_NOT_CLIENT_DATA)
    assert not (swept_read & declared), swept_read & declared
    assert not (swept_write & declared), swept_write & declared
    unclassified = served - swept_read - swept_write - declared
    assert not unclassified, (
        "FC1 CENSUS — route(s) mounted under /api/firm that no sweep drives and no "
        "declaration explains: %s" % sorted(unclassified))
    stale = (swept_read | swept_write | declared) - served
    assert not stale, "sweep/declaration names route(s) the app does not serve: %s" % sorted(stale)
    assert len(served) >= 34, "route census collapsed: %d" % len(served)
    # every mutating route is in the WRITE sweep (or declared with the
    # secret that gates it): a POST/PUT/DELETE the read sweep alone
    # covers is a write nobody drove with the Python wall removed
    mutating = set((m, p) for m, p in served if m in ("POST", "PUT", "PATCH", "DELETE"))
    unswept_writes = mutating - swept_write - declared - set(WRITE_SWEPT_BY_NAME)
    assert not unswept_writes, (
        "FC1 WRITE CENSUS — mutating route(s) outside the write sweep: %s" % sorted(unswept_writes))
    assert not (set(WRITE_SWEPT_BY_NAME) - served), sorted(set(WRITE_SWEPT_BY_NAME) - served)


# ── D2: the surface is MEASURED, not defined — shapes the prefix census cannot see ──

def test_no_mount_websocket_or_raw_route_serves_the_swept_prefixes(real_app):
    """D2. Four sandbox plants served SECRET-FROM-PLANT with both W2 gates
    green: `app.mount('/api/firm/leak', sub_app)`, an
    `add_api_websocket_route('/api/firm/ws', …)`, an `@app.middleware`
    answering a firm path, an `include_router(prefix='/api/cabinet')`
    reading firm_file_requests. The first two are shapes with no
    `endpoint`/`methods`, so the (method, path) table never held them.
    The walk is now RECURSIVE through every Mount and every shape under
    /api/firm or /api/capsule that is not a FastAPI APIRoute is red, by
    class and path. After the repair this reds on (TC-11): a Mount, a
    WebSocket route or a raw Starlette Route under a swept prefix (each
    named) — and on the walk going blind (the probe below)."""
    foreign = _foreign_surface(real_app)
    assert not foreign, (
        "FC1 SURFACE — shape(s) under %s that no (method, path) sweep can see: %s — a Mount's "
        "sub-app, a WebSocket route or a raw Route serves firm data outside every sweep; "
        "remove it or route it through an APIRoute the census classifies"
        % (SWEPT_PREFIXES, foreign))
    # non-vacuity (TC-3): the walk does see every shape when there is one
    from starlette.routing import Mount, WebSocketRoute
    probe = FastAPI()
    probe.mount("/api/firm/probe", FastAPI())

    async def _ws(websocket):  # pragma: no cover — shape only
        await websocket.close()
    probe.add_api_websocket_route("/api/firm/ws", _ws)
    seen = _foreign_surface(probe)
    assert "Mount at /api/firm/probe" in seen, seen
    # FastAPI registers its own subclass (APIWebSocketRoute) — named as such
    assert "APIWebSocketRoute at /api/firm/ws" in seen, seen
    # …and the sub-app's own raw Starlette routes (its docs) behind the mount
    assert "Route at /api/firm/probe/openapi.json" in seen, seen
    assert isinstance(probe.routes[-2], Mount) and isinstance(probe.routes[-1], WebSocketRoute)
    inner = FastAPI()

    @inner.get("/requests")
    def _inner_requests():  # pragma: no cover — shape only
        return {}
    probe2 = FastAPI()
    probe2.mount("/api/firm/leak", inner)
    assert ("GET", "/api/firm/leak/requests") in set((m, p) for m, p, _e in _route_table(probe2)), (
        "the recursive walk must reach a sub-app's routes at the mount path")


def test_the_real_app_declares_every_middleware(real_app):
    """D2. An `@app.middleware("http")` that answers `/api/firm/leak6/…`
    is a BaseHTTPMiddleware: it is in no route table, under no prefix,
    and served the plant with both W2 gates green. `app.user_middleware`
    must EQUAL the declared list, outermost first; an undeclared one is
    red with its class name and its dispatch function. After the repair
    this reds on (TC-11): a middleware added anywhere in create_app() (or
    by an imported module on the app object) that is not in
    DECLARED_MIDDLEWARE — and on a declared one going missing."""
    names = _middleware_names(real_app)
    assert names == list(DECLARED_MIDDLEWARE), (
        "FC1 SURFACE — the real app's middleware stack %s is not the declared %s: an undeclared "
        "middleware can answer any path, firm paths included, outside every route sweep"
        % (names, list(DECLARED_MIDDLEWARE)))
    # non-vacuity: the naming sees a dispatch function the way the plant registers one
    probe = FastAPI()

    @probe.middleware("http")
    async def _leak_mw(request, call_next):  # pragma: no cover — shape only
        return await call_next(request)
    assert _middleware_names(probe) == ["BaseHTTPMiddleware(dispatch=%s._leak_mw)" % __name__]


def test_every_module_reading_a_firm_table_is_a_declared_firm_module_under_a_swept_prefix(real_app):
    """D2 — THE TABLE-READ CENSUS. `include_router(prefix='/api/cabinet')`
    reading firm_file_requests served the plant under a prefix no sweep
    owns. The prefix scope is a definition; this is a measurement: every
    module in the REAL app's import closure whose source names a
    firm-model table (parsed from the three migrations) must be a
    declared firm module, and every route a declared module serves must
    be under a swept prefix. A stranger is red BY THE TABLE IT READS, not
    by its prefix. After the repair this reds on (TC-11): a new module
    naming any `firm_*` / `firms` / `client_assignments` table; a declared
    module serving a route outside /api/firm or /api/capsule; a declared
    module that no longer names a firm table (a stale declaration); a new
    reader of a client-data table."""
    tables = firm_model_tables()
    assert len(tables) >= 17 and "firm_file_requests" in tables and "firms" in tables, tables
    # THE APP'S closure, not the session's — see `real_app_import_closure`.
    # `real_app` is requested (and therefore built here too) so that the
    # census and the route walk below are reading one app.
    closure = list(real_app_import_closure())
    assert len(closure) >= 150, "import-closure census collapsed: %d modules" % len(closure)
    # Every module in the app's closure must also be imported HERE, or
    # `_table_readers` — which reads `sys.modules[name].__file__` — would
    # skip it and the census would go quiet on exactly the module the
    # child found. Building `real_app` is what guarantees it; this is the
    # assertion that the guarantee held.
    import sys as _sys
    unimported = [m for m in closure if m not in _sys.modules]
    assert not unimported, (
        "the child process imported %d module(s) this process did not, so the source census "
        "cannot see them: %s" % (len(unimported), unimported[:8]))
    readers = _table_readers(closure, tables)
    assert readers, "DISCOVERY BROKEN — no module of the real app names a firm table"
    strangers = dict((m, t) for m, t in readers.items() if m not in DECLARED_FIRM_TABLE_READERS)
    assert not strangers, (
        "FC1 TABLE CENSUS — module(s) in the real app's import closure read firm table(s) and "
        "are not declared firm modules: %s — whatever prefix their routes use, every read of a "
        "firm table is FC1's to sweep; declare the module and classify every route it serves"
        % strangers)
    stale = sorted(set(DECLARED_FIRM_TABLE_READERS) - set(readers))
    assert not stale, "declared firm-table reader(s) read no firm table any more: %s" % stale
    # every route a declared firm module serves is under a swept prefix
    outside = []  # type: List[str]
    for route, path in _walk_routes(real_app.routes):
        module = getattr(getattr(route, "endpoint", None), "__module__", None)
        if module in DECLARED_FIRM_TABLE_READERS and not path.startswith(SWEPT_PREFIXES):
            outside.append("%s %s" % (module, path))
    assert not outside, (
        "FC1 TABLE CENSUS — firm module(s) serve route(s) outside %s, where no sweep drives "
        "them: %s" % (SWEPT_PREFIXES, outside))
    # the client-data readers: a NEW reader of client data is red until declared
    client_readers = _table_readers(closure, CLIENT_DATA_TABLES)
    assert "engine.api.pipeline" in client_readers and "engine.api._firm_attention" in client_readers
    new_readers = sorted(set(client_readers) - set(DECLARED_CLIENT_DATA_READERS))
    assert not new_readers, (
        "FC1 TABLE CENSUS — module(s) newly name client-data table(s) %s: %s — declare each "
        "and classify its routes (a firm module's under a swept prefix; the product's under "
        "its own membership gate)" % (CLIENT_DATA_TABLES, dict((m, client_readers[m]) for m in new_readers)))
    gone = sorted(set(DECLARED_CLIENT_DATA_READERS) - set(client_readers))
    assert not gone, "declared client-data reader(s) name no such table any more: %s" % gone


def test_the_table_census_is_not_vacuous(tmp_path, monkeypatch):
    """TC-3: the census must FIND a stranger. A module written to a temp
    dir that names firm_file_requests, imported under the engine
    namespace, is reported by the table it names."""
    import sys as _sys
    import types
    module = types.ModuleType("engine.api._fc1x_census_probe")
    src = tmp_path / "_fc1x_census_probe.py"
    src.write_text('ROWS = ac.select("firm_file_requests")\n', encoding="utf-8")
    module.__file__ = str(src)
    monkeypatch.setitem(_sys.modules, "engine.api._fc1x_census_probe", module)
    found = _table_readers(["engine.api._fc1x_census_probe"], firm_model_tables())
    assert found == {"engine.api._fc1x_census_probe": ["firm_file_requests"]}


@pytest.mark.parametrize("route_id,method,path,query,body,no_firm", COCKPIT_ROUTES,
                         ids=[r[0] for r in COCKPIT_ROUTES])
@pytest.mark.parametrize("shape", FIRM_SHAPES)
@pytest.mark.parametrize("intruder", INTRUDERS, ids=INTRUDER_IDS)
def test_fc1_every_cockpit_route_refuses_firm_a_client_data_to_an_intruder(
        app, world, intruder, shape, route_id, method, path, query, body, no_firm):
    """THE SWEEP over the routers the old FC1 never mounted. Three shapes
    per route: firm-A's id in the request (403, the one message), the
    intruder's OWN firm naming firm-A's client (403 — not their client,
    or not their cell), no firm at all (refused, or the caller's own
    empty scope). Never a marker."""
    firm = {"firm_a": FIRM_A, "own_firm": OWN_FIRM[intruder], "no_firm": ""}[shape]
    r = _send(app, method, path, query, body, intruder, firm=firm, org=ORG_A1, request_id=REQUEST_A1)
    _no_marker(route_id, r, intruder, shape)
    if shape == "firm_a" or (shape == "own_firm" and intruder in (SOLO, NOBODY)):
        # firm-A's id, or a firm the caller is not in (a solo user has no
        # firm: their "own" is a firm that does not exist): ONE message
        assert r.status_code == 403, (route_id, intruder, r.status_code, r.text)
        assert r.json()["detail"] == "Not a member of the requested firm."
    elif no_firm == "client":
        # not their client (403), or — for a read of one request row as
        # the caller — indistinguishable from a request that does not
        # exist (404); never the row
        assert r.status_code in (403, 404), (route_id, intruder, r.status_code, r.text)
        if r.status_code == 404:
            assert route_id == "requests-revoke" and r.json()["detail"] == "Request not found."
    else:
        # the caller's OWN scope (their prefs, their own firm's brief):
        # 200, and nothing of firm A in it
        assert r.status_code == 200, (route_id, intruder, r.status_code, r.text)
        if route_id == "brief":
            assert ORG_A1 not in json.dumps(r.json()["order"])
    # nothing of firm A's changed underneath
    assert next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_A1)["status"] == \
        _firm_requests.STATUS_REQUESTED
    assert next(x for x in world.rows("firm_client_cadence")
                if x["client_org_id"] == ORG_A1)["cadence"] == "quarterly"


@pytest.mark.parametrize("route_id,method,path,query,body", ATTENTION_ROUTES,
                         ids=[r[0] for r in ATTENTION_ROUTES])
@pytest.mark.parametrize("intruder", INTRUDERS, ids=INTRUDER_IDS)
def test_fc1_the_attention_routes_show_an_intruder_only_their_own_book(
        app, world, intruder, route_id, method, path, query, body):
    before = len(world.rows("firm_attention_suppressions"))
    r = _send(app, method, path, query, body, intruder, org=ORG_A1)
    _no_marker(route_id, r, intruder, "rls")
    if route_id == "attention-suppress":
        assert r.status_code == 403, (intruder, r.status_code, r.text)
        assert len(world.rows("firm_attention_suppressions")) == before, "a refused insert must not land"
    else:
        assert r.status_code == 200, (intruder, r.status_code, r.text)
        payload = r.json()
        if route_id.startswith("attention-board"):
            assert ORG_A1 not in [row["client_id"] for row in payload["clients"]]
            assert ORG_A1 not in json.dumps(payload["suppressed"])
        else:
            assert ORG_A1 not in json.dumps(payload["suppressions"])


POSITIVE_CONTROLS = [
    # route id, actor, method, path, query, body, status, marker the answer MUST carry
    ("requests-list", A_VIEWER, "GET", "/api/firm/requests/list",
     {"client_org_id": ORG_A1, "firm_id": FIRM_A}, None, 200, SECRET_NOTE),
    ("requests-create", A_ACCOUNTANT, "POST", "/api/firm/requests", None,
     {"client_org_id": ORG_A2, "period_end": "2026-02-28", "firm_id": FIRM_A,
      "to_email": "a2@example.test"}, 201, "Client A2"),
    ("requests-revoke", A_ACCOUNTANT, "POST", "/api/firm/requests/%s/revoke" % REQUEST_A1,
     {"firm_id": FIRM_A}, None, 200, '"status":"revoked"'),
    ("cadence-status", A_VIEWER, "GET", "/api/firm/cadence/status",
     {"client_org_id": ORG_A1, "firm_id": FIRM_A, "as_of": "2026-03-10"}, None, 200,
     json.dumps(SECRET_CADENCE_NUDGES, separators=(",", ":"))),
    ("cadence-put", A_ACCOUNTANT, "PUT", "/api/firm/cadence", None,
     {"client_org_id": ORG_A1, "firm_id": FIRM_A, "cadence": "monthly"}, 200, '"cadence":"monthly"'),
    ("digest-prefs-get", A_OWNER, "GET", "/api/firm/digest/prefs", {"firm_id": FIRM_A}, None, 200,
     '"enabled":true'),
    ("digest-prefs-put", A_OWNER, "PUT", "/api/firm/digest/prefs", None,
     {"firm_id": FIRM_A, "enabled": False}, 200, '"enabled":false'),
    ("brief", A_OWNER, "POST", "/api/firm/brief", None, {"firm_id": FIRM_A, "as_of": "2026-03-10"},
     200, "Client A1"),
    ("attention-board", A_OWNER, "GET", "/api/firm/attention", {"as_of": "2026-03-10"}, None, 200,
     "Client A1"),
    ("attention-suppressions", A_VIEWER, "GET", "/api/firm/attention/suppressions", None, None, 200,
     SECRET_SUPPRESSION),
    ("attention-suppress", A_ACCOUNTANT, "POST", "/api/firm/attention/suppress", None,
     {"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "facility signed"}, 200, ORG_A1),
]


@pytest.mark.parametrize("route_id,actor,method,path,query,body,status,marker", POSITIVE_CONTROLS,
                         ids=[c[0] for c in POSITIVE_CONTROLS])
def test_fc1_positive_control_the_right_firm_a_role_reads_the_marker(
        app, world, route_id, actor, method, path, query, body, status, marker):
    """Before an intruder's 403 counts as a wall, the same route must be
    proven to SERVE the marker to the right firm-A role — otherwise a
    broken route passes the sweep for the wrong reason (TC-9)."""
    r = app.request(method, path, params=query, headers=hdr(actor), json=body)
    assert r.status_code == status, (route_id, r.status_code, r.text)
    assert marker in r.text, (route_id, marker, r.text[:600])
    if route_id == "brief":
        payload = r.json()
        assert payload["item_count"] >= 1 and payload["degraded"] is True, payload["notice"]
        assert ORG_A1 in json.dumps(payload["order"]) and ORG_B1 not in r.text
    if route_id == "attention-board":
        ids = [row["client_id"] for row in r.json()["clients"]]
        assert sorted(ids) == sorted([ORG_A1, ORG_A2]) and ORG_B1 not in ids
    if route_id == "attention-suppress":
        assert any(x["reason"] == "facility signed" and x["dismissed_by"] == A_ACCOUNTANT
                   for x in world.rows("firm_attention_suppressions"))


def test_the_cockpit_role_cells_are_enforced_by_route_and_by_rls(app, world):
    """The matrix through the cockpit: a viewer reads but may not ask for
    a file, revoke, set a cadence, or suppress — the last one refused by
    the INSERT policy parsed from schema_phase_firm_attention.sql, not
    by Python (the route has no cell check of its own)."""
    r = app.post("/api/firm/requests", headers=hdr(A_VIEWER),
                 json={"client_org_id": ORG_A2, "period_end": "2026-02-28", "firm_id": FIRM_A})
    assert r.status_code == 403 and "'request_file'" in r.text
    r = app.post("/api/firm/requests/%s/revoke" % REQUEST_A1, params={"firm_id": FIRM_A},
                 headers=hdr(A_VIEWER))
    assert r.status_code == 403 and "'request_file'" in r.text
    r = app.put("/api/firm/cadence", headers=hdr(A_VIEWER),
                json={"client_org_id": ORG_A1, "firm_id": FIRM_A, "cadence": "monthly"})
    assert r.status_code == 403
    before = len(world.rows("firm_attention_suppressions"))
    r = app.post("/api/firm/attention/suppress", headers=hdr(A_VIEWER),
                 json={"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "viewer says so"})
    assert r.status_code == 403 and len(world.rows("firm_attention_suppressions")) == before
    assert world.firm_can(A_VIEWER, FIRM_A, "suppress") is False
    assert world.firm_can(A_ASSISTANT, FIRM_A, "suppress") is False
    r = app.post("/api/firm/attention/suppress", headers=hdr(A_ASSISTANT),
                 json={"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "assistant says so"})
    assert r.status_code == 403
    r = app.post("/api/firm/attention/suppress", headers=hdr(A_PARTNER),
                 json={"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "partner says so"})
    assert r.status_code == 200 and len(world.rows("firm_attention_suppressions")) == before + 1


def test_the_double_evaluates_the_cockpit_policy_bodies_not_a_mirror(world):
    """DISCOVERY CANARY for C2: the firm-read policies on the request /
    cadence / brief tables are parsed from schema_phase_firm_requests.sql
    and EVALUATED (firm_of_org, firm_can, can_read_client_org from the
    tenancy migration), so loosening the migration loosens the double."""
    pols = dict((p["name"], p) for p in parse_policies(SQL_REQUESTS_PATH.read_text(encoding="utf-8")))
    for name, table, floor in (("firm_file_requests firm read", "firm_file_requests", 2),
                               ("firm_client_cadence firm read", "firm_client_cadence", 2),
                               ("firm_briefs firm read", "firm_briefs", 1)):
        assert name in pols and pols[name]["command"] == "select", name
        assert len(world.policies[table]) >= floor, (
            "%s must keep its member policy AND gain the firm one" % table)
    assert "firm_id = firm_of_org(client_org_id)" in pols["firm_file_requests firm read"]["using"]
    assert "firm_can(firm_id, 'read')" in pols["firm_file_requests firm read"]["using"]
    assert "can_read_client_org(client_org_id)" in pols["firm_client_cadence firm read"]["using"]
    assert "firm_id = firm_of_org(client_org_id)" in pols["firm_client_cadence firm read"]["using"]
    assert "firm_can(firm_id, 'read')" in pols["firm_briefs firm read"]["using"]
    assert "user_id = auth.uid()" in pols["firm_briefs firm read"]["using"]
    assert "firm_brief_clients_readable(firm_id, client_org_ids)" in pols["firm_briefs firm read"]["using"]
    # the WRITE policies are parsed and evaluated too (W1)
    for name in ("firm_client_cadence firm write", "firm_file_requests firm write",
                 "firm_briefs firm write", "firm_digest_prefs own insert"):
        assert name in pols and pols[name]["command"] == "insert" and pols[name]["check"], name
    for name in ("firm_client_cadence firm update", "firm_file_requests firm update",
                 "firm_briefs firm update", "firm_digest_prefs own update"):
        assert name in pols and pols[name]["command"] == "update" and pols[name]["using"], name
    for table in ("firm_client_cadence", "firm_file_requests", "firm_briefs", "firm_digest_prefs"):
        assert world.insert_policies.get(table) and world.update_policies.get(table), table
    assert world._sql_function("firm_brief_clients_readable") is not None
    att = dict((p["name"], p) for p in parse_policies(SQL_ATTENTION_PATH.read_text(encoding="utf-8")))
    assert "firm_can(firm_of_org(org_id), 'suppress')" in att["firm_attention_suppressions insert"]["check"]
    assert world.insert_policies["firm_attention_suppressions"], "the insert WITH CHECK was not parsed"

    a_viewer = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    b_owner = _supabase_module.per_user(_jwt(B_OWNER, EMAILS[B_OWNER]))
    assert [r["id"] for r in a_viewer.select("firm_file_requests")] == [REQUEST_A1]
    assert [r["id"] for r in b_owner.select("firm_file_requests")] == [REQUEST_B1]
    assert a_viewer.select("firm_client_cadence") and b_owner.select("firm_client_cadence") == []
    assert a_viewer.select("firm_briefs") and b_owner.select("firm_briefs") == []
    # flip the viewer's read cell in the seeded matrix rows: the JOIN answers differently
    cell = next(r for r in world.rows("firm_role_permissions") if r["role"] == "viewer" and r["action"] == "read")
    cell["allowed"] = False
    assert a_viewer.select("firm_file_requests") == [] and a_viewer.select("firm_briefs") == []
    cell["allowed"] = True
    # a request row whose firm is NOT the client's current firm is invisible to the firm
    stray = next(r for r in world.rows("firm_file_requests") if r["id"] == REQUEST_A1)
    stray["firm_id"] = FIRM_B
    assert a_viewer.select("firm_file_requests") == []
    stray["firm_id"] = FIRM_A
    # and a loosened body is honoured, which is what makes the plant below visible
    world.plant_policy("firm_file_requests", "true")
    assert [r["id"] for r in b_owner.select("firm_file_requests", filters={"client_org_id": "eq." + ORG_A1})] == [REQUEST_A1]
    # the insert WITH CHECK is evaluated too: the caller must be the author
    forged = {"org_id": ORG_A1, "kind": "CASH_RUNWAY", "scope_key": "*", "reason": "x",
              "dismissed_by": A_OWNER}
    assert world.admit_insert(A_OWNER, EMAILS[A_OWNER], "firm_attention_suppressions", dict(forged)) is True
    assert world.admit_insert(A_PARTNER, EMAILS[A_PARTNER], "firm_attention_suppressions", dict(forged)) is False
    assert world.admit_insert(B_OWNER, EMAILS[B_OWNER], "firm_attention_suppressions",
                              dict(forged, dismissed_by=B_OWNER)) is False


def test_fc1_plant_cross_firm_cockpit_read_is_blocked_at_both_walls(app, world, monkeypatch):
    """THE PLANT for C2 — the hostile cockpit read, at each wall in turn.

    Wall 1 (Python): a firm-B owner asks for firm-A's client's requests,
    cadence and brief under firm-A's id. 403 before any read.

    Wall 2 (RLS): remove Wall 1 by hand — `authorize_client` and
    `client_org_ids_for` are patched to wave anyone through — and
    re-send. The routes now reach the database AS THE INTRUDER, and the
    policies parsed from the migrations return nothing: an empty list, a
    pack-default cadence, a brief with no item. Then remove Wall 2 too
    (loosen the policies as a migration edit would) and show the leak:
    that last step proves the two assertions above can fail."""
    list_q = {"client_org_id": ORG_A1, "firm_id": FIRM_A}
    cadence_q = {"client_org_id": ORG_A1, "firm_id": FIRM_A, "as_of": "2026-03-10"}
    brief_body = {"firm_id": FIRM_A, "as_of": "2026-03-10"}
    assert app.get("/api/firm/requests/list", params=list_q, headers=hdr(B_OWNER)).status_code == 403
    assert app.get("/api/firm/cadence/status", params=cadence_q, headers=hdr(B_OWNER)).status_code == 403
    assert app.post("/api/firm/brief", json=brief_body, headers=hdr(B_OWNER)).status_code == 403

    monkeypatch.setattr(_firm_requests, "authorize_client",
                        lambda jwt, firm_id, client_org_id, action: (B_OWNER, FIRM_A))
    monkeypatch.setattr(_firm_requests, "client_org_ids_for",
                        lambda user_id, firm_id, jwt=None, ac=None: [ORG_A1])
    r = app.get("/api/firm/requests/list", params=list_q, headers=hdr(B_OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["requests"] == [] and SECRET_NOTE not in r.text, "RLS wall breached: %s" % r.text
    r = app.get("/api/firm/cadence/status", params=cadence_q, headers=hdr(B_OWNER))
    assert r.status_code == 200 and r.json()["cadence"]["source"] == "pack_default", r.text
    assert json.dumps(SECRET_CADENCE_NUDGES, separators=(",", ":")) not in r.text
    assert r.json()["filed_period_ends"] == [], "financial_periods leaked through RLS"
    r = app.post("/api/firm/brief", json=brief_body, headers=hdr(B_OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["item_count"] == 0 and "Client A1" not in r.text and SECRET_NOTE not in r.text

    # the leak, deliberately: the exact Plant — every firm-read predicate
    # loosened in the migration text (organizations / periods through the
    # helper, the request and cadence tables through their policies)
    world.plant_policy("firm_file_requests", "true")
    world.plant_policy("firm_client_cadence", "true")
    world.plant_policy("organizations", "true")
    world.plant_function("can_read_client_org", "select true")
    r = app.get("/api/firm/requests/list", params=list_q, headers=hdr(B_OWNER))
    assert SECRET_NOTE in r.text, "with both walls removed the read must succeed"
    r = app.get("/api/firm/cadence/status", params=cadence_q, headers=hdr(B_OWNER))
    assert r.json()["cadence"]["source"] == "stored" and r.json()["filed_period_ends"] == ["2025-12-31"]
    r = app.post("/api/firm/brief", json=brief_body, headers=hdr(B_OWNER))
    assert "Client A1" in r.text and r.json()["item_count"] >= 1, (
        "with both walls removed the brief must carry firm-A's client — otherwise the "
        "assertions above passed for a reason other than the walls")


def test_c3_a_reattached_client_does_not_carry_the_previous_firms_requests(app, world):
    """C3. Firm X (A) minted a request on the client, with a note and the
    client's e-mail. The workspace is detached from X and attached to
    firm Y (B). Y reads NOTHING of X's era — at the route (firm_id
    filter) AND at RLS alone (firm_id = firm_of_org) — and X's firm-only
    members no longer read it either; the workspace's own owner keeps
    the client's full history. A new Y-era request is exactly what Y sees.
    After the repair this reds on (TC-11): an X-era row reaching Y's
    viewer at the route or at RLS; the X-era row being SCRUBBED instead
    of hidden; the workspace's own owner losing the client's history; Y
    unable to mint and read its own request."""
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) is None
    world.add("memberships", {"user_id": B_OWNER, "org_id": ORG_A1, "role": "owner"})
    r = app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(B_OWNER), json={"org_id": ORG_A1})
    assert r.status_code == 200, r.text
    assert world.firm_of_org(ORG_A1) == FIRM_B
    assert next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_A1)["firm_id"] == FIRM_A, (
        "the X-era row still exists — the test is about visibility, not scrubbing")

    r = app.get("/api/firm/requests/list", params={"client_org_id": ORG_A1, "firm_id": FIRM_B},
                headers=hdr(B_VIEWER))
    assert r.status_code == 200, r.text
    assert r.json()["requests"] == [], "C3 VIOLATED — firm Y sees firm X's request: %s" % r.text
    assert SECRET_NOTE not in r.text and SECRET_EMAIL not in r.text
    y_viewer = _supabase_module.per_user(_jwt(B_VIEWER, EMAILS[B_VIEWER]))
    assert y_viewer.select("firm_file_requests", filters={"client_org_id": "eq." + ORG_A1}) == [], (
        "C3 VIOLATED at the RLS wall alone")
    x_viewer = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    assert x_viewer.select("firm_file_requests", filters={"client_org_id": "eq." + ORG_A1}) == []
    r = app.get("/api/firm/requests/list", params={"client_org_id": ORG_A1, "firm_id": FIRM_A},
                headers=hdr(A_VIEWER))
    assert r.status_code == 403 and r.json()["detail"] == _firm.NOT_A_CLIENT
    r = app.post("/api/firm/brief", json={"firm_id": FIRM_B, "as_of": "2026-03-10"}, headers=hdr(B_OWNER))
    assert r.status_code == 200 and SECRET_NOTE not in r.text and REQUEST_A1 not in r.text

    # Y mints its own: that, and only that, is Y's view
    r = app.post("/api/firm/requests", headers=hdr(B_OWNER),
                 json={"client_org_id": ORG_A1, "period_end": "2026-02-28", "firm_id": FIRM_B})
    assert r.status_code == 201, r.text
    y_request = r.json()["id"]
    r = app.get("/api/firm/requests/list", params={"client_org_id": ORG_A1, "firm_id": FIRM_B},
                headers=hdr(B_VIEWER))
    assert [x["id"] for x in r.json()["requests"]] == [y_request]
    assert [x["id"] for x in y_viewer.select("firm_file_requests",
                                             filters={"client_org_id": "eq." + ORG_A1})] == [y_request]
    # the workspace's own owner: the client's whole history, through membership
    r = app.get("/api/firm/requests/list", params={"client_org_id": ORG_A1}, headers=hdr(B_OWNER))
    assert sorted(x["id"] for x in r.json()["requests"]) == sorted([REQUEST_A1, y_request])


def test_token_and_scheduler_routes_are_unreachable_without_their_secret(app, world, monkeypatch):
    """The reads that MUST stay service-role (schema_phase_firm_requests.sql
    header): the public token landing, the two crons, the admin drain.
    Each is proven closed without its secret and open with it."""
    forged = "%s.%s" % (base64.urlsafe_b64encode(b'{"v":"fr1","r":"x"}').decode().rstrip("="),
                        base64.urlsafe_b64encode(b"not-a-signature").decode().rstrip("="))
    r = app.get("/api/firm/requests/resolve/%s" % forged)
    assert r.status_code == 403 and "signature" in r.text, r.text
    r = app.post("/api/firm/requests/%s/upload" % forged, files={"file": ("x.csv", b"a;b\n", "text/csv")})
    assert r.status_code == 403 and "signature" in r.text, r.text
    assert SECRET_NOTE not in r.text
    # the real link, minted under the suite's key, reaches its own request — and nothing else
    key = _firm_requests.signing_key()
    claims = _firm_requests.TokenClaims(request_id=REQUEST_A1, client_org_id=ORG_A1,
                                        period_end="2026-01-31", nonce="n",
                                        expires_at=(world.clock + timedelta(days=7)).isoformat())
    token = _firm_requests.mint_token(claims, key)
    next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_A1)["token_hash"] = \
        _firm_requests.token_hash(token)
    r = app.get("/api/firm/requests/resolve/%s" % token)
    assert r.status_code == 200 and r.json()["client_name"] == "Client A1" and r.json()["note"] == SECRET_NOTE
    # a token for firm B's request cannot be pointed at firm A's client
    cross = _firm_requests.mint_token(_firm_requests.TokenClaims(
        request_id=REQUEST_B1, client_org_id=ORG_A1, period_end="2026-01-31", nonce="n",
        expires_at=claims.expires_at), key)
    next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_B1)["token_hash"] = \
        _firm_requests.token_hash(cross)
    r = app.get("/api/firm/requests/resolve/%s" % cross)
    assert r.status_code == 403 and "does not match" in r.text
    # no signing key at all: fail closed, before any read
    monkeypatch.delenv(_firm_requests.SIGNING_KEY_ENV)
    assert app.get("/api/firm/requests/resolve/%s" % token).status_code == 503
    monkeypatch.setenv(_firm_requests.SIGNING_KEY_ENV, "tenancy-suite-signing-key-0123456789")

    # the crons: no scheduler token configured → 503; a USER's JWT → 401
    for path in ("/api/firm/requests/cron/nudge", "/api/firm/digest/cron/run"):
        r = app.post(path, headers=hdr(A_OWNER))
        assert r.status_code == 503, (path, r.text)
        monkeypatch.setenv("ENGINE_API_TOKEN", "scheduler-secret")
        r = app.post(path, headers=hdr(A_OWNER))
        assert r.status_code == 401, (path, r.text)
        assert app.post(path).status_code == 401
        monkeypatch.delenv("ENGINE_API_TOKEN")
    monkeypatch.setenv("ENGINE_API_TOKEN", "scheduler-secret")
    # the crons read the wall clock for the send-hour gate; pin it
    monkeypatch.setattr(_firm_requests, "_now",
                        lambda: datetime(2026, 9, 3, 9, 0, tzinfo=timezone.utc))
    r = app.post("/api/firm/requests/cron/nudge", params={"as_of": "2026-09-03"},
                 headers={"Authorization": "Bearer scheduler-secret"})
    assert r.status_code == 200 and r.json()["open"] == 2, r.text
    r = app.post("/api/firm/digest/cron/run", params={"as_of": "2026-09-03"},
                 headers={"Authorization": "Bearer scheduler-secret"})
    assert r.status_code == 200 and r.json()["prefs"] == 1 and r.json()["queued"] == 0, r.text
    assert "no email address" in json.dumps(r.json()["notes"]), "the double has no auth admin API: a gap, not a send"

    # the drain: an owner is not an admin
    r = app.post("/api/firm/email/drain", headers=hdr(A_OWNER))
    assert r.status_code == 403 and SECRET_EMAIL not in r.text
    monkeypatch.setenv("PRICING_ADMIN_USER_IDS", A_OWNER)
    r = app.post("/api/firm/email/drain", headers=hdr(A_OWNER))
    assert r.status_code == 200 and r.json()["failed"] >= 1, "no mail provider: the row fails, nothing is sent"

    # the declared no-client-data routes carry no marker
    for method, path in (("GET", "/api/firm/roles"), ("GET", "/api/firm/import/columns"),
                         ("GET", "/api/firm/brief/self-check"), ("GET", "/api/firm/attention/kinds"),
                         ("GET", "/api/firm"), ("GET", "/api/firm/invitations/mine")):
        r = app.request(method, path, headers=hdr(B_OWNER))
        assert r.status_code == 200, (path, r.text)
        _no_marker(path, r, B_OWNER, "declared")


# ══════════════════════════════════════════════════════════════════════
# 11. W1 — TWO WALLS ON EVERY WRITE; W3 — a client's cadence and brief do
#     not follow it across firms; W4 — identity on every route, and the
#     double's fidelity to it (the owner's ruling, 2026-09-04)
# ══════════════════════════════════════════════════════════════════════

#: EVERY write a signed-in user can make under /api/firm. `template` is
#: the FastAPI path (the census compares it to the real app), `url` the
#: filled request; `table` + `key` locate THE ROW THAT WOULD MOVE;
#: `walls` names the Python wall a plant removes: "cockpit"
#: (_firm_requests.authorize_client / client_org_ids_for + the firm
#: helpers), "firm" (_firm.resolve_firm / require / require_client), or
#: "rls" (no Python client wall — the insert policy is the authority).
WRITE_ROUTES = [
    {"id": "cadence-put", "method": "PUT", "template": "/api/firm/cadence",
     "url": "/api/firm/cadence", "query": None,
     "body": {"client_org_id": ORG_A1, "firm_id": FIRM_A, "cadence": "monthly"},
     "table": "firm_client_cadence", "key": ("client_org_id", ORG_A1), "walls": "cockpit"},
    {"id": "requests-create", "method": "POST", "template": "/api/firm/requests",
     "url": "/api/firm/requests", "query": None,
     "body": {"client_org_id": ORG_A1, "period_end": "2026-03-31", "firm_id": FIRM_A},
     "table": "firm_file_requests", "key": ("client_org_id", ORG_A1), "walls": "cockpit"},
    {"id": "requests-revoke", "method": "POST", "template": "/api/firm/requests/{request_id}/revoke",
     "url": "/api/firm/requests/%s/revoke" % REQUEST_A1, "query": {"firm_id": FIRM_A}, "body": None,
     "table": "firm_file_requests", "key": ("id", REQUEST_A1), "walls": "cockpit"},
    {"id": "digest-prefs-put", "method": "PUT", "template": "/api/firm/digest/prefs",
     "url": "/api/firm/digest/prefs", "query": None, "body": {"firm_id": FIRM_A, "enabled": True},
     "table": "firm_digest_prefs", "key": ("firm_id", FIRM_A), "walls": "cockpit"},
    {"id": "attention-suppress", "method": "POST", "template": "/api/firm/attention/suppress",
     "url": "/api/firm/attention/suppress", "query": None,
     "body": {"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "an intruder's reason"},
     "table": "firm_attention_suppressions", "key": ("org_id", ORG_A1), "walls": "rls"},
    {"id": "assignment", "method": "PUT", "template": "/api/firm/{firm_id}/clients/{org_id}/assignment",
     "url": "/api/firm/%s/clients/%s/assignment" % (FIRM_A, ORG_A1), "query": None,
     "body": {"responsible_user_id": None},
     "table": "client_assignments", "key": ("org_id", ORG_A1), "walls": "firm"},
    {"id": "detach", "method": "POST", "template": "/api/firm/{firm_id}/clients/{org_id}/detach",
     "url": "/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), "query": None, "body": None,
     "table": "organizations", "key": ("id", ORG_A1), "walls": "firm"},
    {"id": "attach", "method": "POST", "template": "/api/firm/{firm_id}/clients/attach",
     "url": "/api/firm/%s/clients/attach" % FIRM_A, "query": None, "body": {"org_id": ORG_S},
     "table": "organizations", "key": ("id", ORG_S), "walls": "firm"},
    {"id": "member-role", "method": "PUT", "template": "/api/firm/{firm_id}/members/{user_id}/role",
     "url": "/api/firm/%s/members/%s/role" % (FIRM_A, A_VIEWER), "query": None, "body": {"role": "owner"},
     "table": "firm_memberships", "key": ("user_id", A_VIEWER), "walls": "firm"},
    {"id": "member-remove", "method": "DELETE", "template": "/api/firm/{firm_id}/members/{user_id}",
     "url": "/api/firm/%s/members/%s" % (FIRM_A, A_VIEWER), "query": None, "body": None,
     "table": "firm_memberships", "key": ("user_id", A_VIEWER), "walls": "firm"},
    {"id": "invitation-create", "method": "POST", "template": "/api/firm/{firm_id}/invitations",
     "url": "/api/firm/%s/invitations" % FIRM_A, "query": None,
     "body": {"email": "planted@example.test", "role": "viewer"},
     "table": "firm_invitations", "key": ("firm_id", FIRM_A), "walls": "firm"},
    {"id": "invitation-revoke", "method": "POST",
     "template": "/api/firm/{firm_id}/invitations/{invitation_id}/revoke",
     "url": "/api/firm/%s/invitations/%s/revoke" % (FIRM_A, INVITATION_A), "query": None, "body": None,
     "table": "firm_invitations", "key": ("id", INVITATION_A), "walls": "firm"},
    {"id": "import", "method": "POST", "template": "/api/firm/{firm_id}/import",
     "url": "/api/firm/%s/import" % FIRM_A, "query": None,
     "body": {"csv": "name,cui\nPlanted Import SRL,98989898\n"},
     "table": "organizations", "key": ("firm_id", FIRM_A), "walls": "firm"},
]
WRITE_IDS = [w["id"] for w in WRITE_ROUTES]

#: The eight Capsule tools, each classified. The registry refuses a tool
#: that does not assert read_only (test below); every one is driven by
#: the intruders against firm-A's client and answers 403 before dispatch.
CAPSULE_TOOL_CENSUS = {
    "get_facts": ("swept-read", {"metric": "total_assets", "period": "December 2025"}),
    "compare_periods": ("swept-read", {"metrics": ["total_assets"], "p1": "December 2025",
                                       "p2": "December 2025"}),
    "get_account": ("swept-read", {"code": "461"}),
    "list_findings": ("swept-read", {}),
    "get_benchmark": ("swept-read", {"peer_group": "food_manufacturing", "metric": "total_assets"}),
    "run_scenario_preview": ("swept-read", {"drivers": [{"metric": "revenue", "mode": "pct", "value": 5}]}),
    "get_public_company": ("swept-read", {"entity": "TLV"}),
    "search_help": ("swept-read", {"topic": "cash"}),
}


def _rows_at(world, table, key):  # type: (FirmWorld, str, Tuple[str, str]) -> List[Dict[str, Any]]
    """The row(s) a write would move, as a stable, comparable snapshot."""
    column, value = key
    rows = [r for r in world.rows(table) if str(r.get(column)) == str(value)]
    return copy.deepcopy(sorted(rows, key=lambda r: json.dumps(r, sort_keys=True, default=str)))


def _table_size(world, table):  # type: (FirmWorld, str) -> int
    return len(world.rows(table))


def _open_python_walls(monkeypatch, intruder, walls):  # type: (Any, str, str) -> None
    """REMOVE the Python wall by hand: every guard the route consults
    waves the intruder through as an OWNER of whatever firm is named,
    with every client theirs. What is left is the database."""
    if walls in ("cockpit", "firm"):
        monkeypatch.setattr(_firm, "resolve_firm",
                            lambda jwt, firm_id: _firm.FirmContext(intruder, str(firm_id), "owner"))
        monkeypatch.setattr(_firm, "require_client", lambda ctx, org_id: str(org_id))
        monkeypatch.setattr(_firm, "require", lambda ctx, action: None)
    if walls == "cockpit":
        monkeypatch.setattr(_firm_requests, "authorize_client",
                            lambda jwt, firm_id, client_org_id, action: (intruder, str(firm_id or FIRM_A)))
        monkeypatch.setattr(_firm_requests, "client_org_ids_for",
                            lambda user_id, firm_id, jwt=None, ac=None: [ORG_A1, ORG_A2])


def _open_sql_wall(world, intruder):  # type: (FirmWorld, str) -> None
    """LOOSEN the SQL wall as a migration edit would: every helper the
    policies and the RPC guards ask answers true, and the intruder owns
    the solo workspace the attach route names. After this, every write
    in the sweep must LAND — which is what proves the refusals were the
    wall and not a broken route."""
    for name in ("firm_can", "is_firm_member_of", "can_read_client_org"):
        world.plant_function(name, "select true")
    if not any(m["org_id"] == ORG_S and m["user_id"] == intruder for m in world.rows("memberships")):
        world.add("memberships", {"user_id": intruder, "org_id": ORG_S, "role": "owner"})


def _send_write(app, w, actor):  # type: (Any, Dict[str, Any], str) -> Any
    return app.request(w["method"], w["url"], params=w["query"], headers=hdr(actor), json=w["body"])


@pytest.mark.parametrize("w", WRITE_ROUTES, ids=WRITE_IDS)
@pytest.mark.parametrize("intruder", INTRUDERS, ids=INTRUDER_IDS)
def test_fc1_every_write_refuses_an_intruder_and_the_row_stays(app, world, intruder, w):
    """THE WRITE SWEEP, Python wall standing: every write, every intruder
    → 403, no marker, and the row that would have moved did not."""
    before = _rows_at(world, w["table"], w["key"])
    size = _table_size(world, w["table"])
    r = _send_write(app, w, intruder)
    _no_marker(w["id"], r, intruder, "write")
    assert r.status_code == 403, (w["id"], intruder, r.status_code, r.text)
    assert _rows_at(world, w["table"], w["key"]) == before and _table_size(world, w["table"]) == size, (
        "FC1 WRITE VIOLATED — route %s by %s moved %s[%s=%s]: before %s, after %s"
        % (w["id"], intruder, w["table"], w["key"][0], w["key"][1], before,
           _rows_at(world, w["table"], w["key"])))


@pytest.mark.parametrize("w", WRITE_ROUTES, ids=WRITE_IDS)
@pytest.mark.parametrize("intruder", [B_OWNER, SOLO], ids=["b_owner", "solo"])
def test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak(app, world, monkeypatch, intruder, w):
    """THE WRITE PLANT (the owner's ruling). Wall 1 removed by hand: the
    write reaches the database AS THE INTRUDER and the policy / RPC
    guard parsed from the migration refuses it — the row that would have
    moved is byte-identical. Then the SQL wall is loosened too and the
    SAME write LANDS: the row moves, which proves the refusal above was
    the wall and not a broken route. A row that moved with the SQL wall
    standing is `FC1 WRITE VIOLATED`, naming route, table and row."""
    _open_python_walls(monkeypatch, intruder, w["walls"])
    before = _rows_at(world, w["table"], w["key"])
    size = _table_size(world, w["table"])
    r = _send_write(app, w, intruder)
    _no_marker(w["id"], r, intruder, "python-wall-open")
    after = _rows_at(world, w["table"], w["key"])
    assert after == before and _table_size(world, w["table"]) == size, (
        "FC1 WRITE VIOLATED — route %s with the Python wall removed: the SQL wall let %s move "
        "%s[%s=%s] (%d rows → %d): before %s, after %s"
        % (w["id"], intruder, w["table"], w["key"][0], w["key"][1], size,
           _table_size(world, w["table"]), before, after))
    assert r.status_code in (403, 404), (
        "route %s answered %s with the SQL wall standing: %s" % (w["id"], r.status_code, r.text[:300]))
    if r.status_code == 403 and w["walls"] != "rls":
        assert ("row-level security" in r.text or "42501" in r.text
                or "not hold" in r.text or "owner" in r.text or "cannot" in r.text
                or "Not a member" in r.text), r.text

    # the leak, deliberately — the exact cross-firm write, with both walls gone
    _open_sql_wall(world, intruder)
    r = _send_write(app, w, intruder)
    moved = _rows_at(world, w["table"], w["key"])
    assert r.status_code < 300, (
        "with both walls removed the write must succeed — %s answered %s: %s"
        % (w["id"], r.status_code, r.text[:300]))
    assert moved != before or _table_size(world, w["table"]) != size, (
        "with both walls removed the row must move — otherwise the assertion above passed "
        "for a reason other than the walls (%s)" % w["id"])
    if w["id"] == "cadence-put":
        row = next(x for x in world.rows("firm_client_cadence") if x["client_org_id"] == ORG_A1)
        assert row["set_by"] == intruder and row["cadence"] == "monthly", row


@pytest.mark.parametrize("route_id", ["requests-create", "requests-revoke", "invitation-revoke"])
def test_fc1_the_write_policy_refuses_on_its_own_when_the_read_policy_is_loosened(
        app, world, monkeypatch, route_id):
    """Three writes the sweep sees refused BEFORE the write policy runs —
    the row (or the client) is invisible under the SELECT policies, so
    the route answers 404 first. Loosen every SELECT policy to `true`
    and remove the Python wall: the row is now readable by the intruder,
    and the WRITE policy / RPC guard alone must refuse the write — the
    insert WITH CHECK, the update USING, the RPC's firm_can."""
    w = next(x for x in WRITE_ROUTES if x["id"] == route_id)
    for table in ("organizations", "firm_file_requests", "firm_invitations", "financial_periods"):
        world.plant_policy(table, "true")
    _open_python_walls(monkeypatch, B_OWNER, w["walls"])
    before = _rows_at(world, w["table"], w["key"])
    size = _table_size(world, w["table"])
    r = _send_write(app, w, B_OWNER)
    _no_marker(route_id, r, B_OWNER, "read-loosened")
    assert r.status_code == 403, (route_id, r.status_code, r.text[:300])
    assert _rows_at(world, w["table"], w["key"]) == before and _table_size(world, w["table"]) == size, (
        "FC1 WRITE VIOLATED — %s: with the read policies loosened, the WRITE policy alone let "
        "%s move %s[%s=%s]" % (route_id, B_OWNER, w["table"], w["key"][0], w["key"][1]))
    if route_id == "requests-create":
        assert "row-level security" in r.text, r.text
    if route_id == "requests-revoke":
        assert "did not apply" in r.text, r.text
        assert next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_A1)["status"] == \
            _firm_requests.STATUS_REQUESTED
    # and with the write wall loosened too, it lands
    _open_sql_wall(world, B_OWNER)
    r = _send_write(app, w, B_OWNER)
    assert r.status_code < 300 and (_rows_at(world, w["table"], w["key"]) != before
                                    or _table_size(world, w["table"]) != size), (route_id, r.text[:200])


def test_fc1_the_write_plant_names_the_route_and_the_row_when_the_service_role_writes(
        app, world, monkeypatch):
    """The exact defect the critics drove (W1): PUT /cadence written
    service-role behind the Python wall. Reproduced here in-memory —
    the route's per-user upsert swapped for `_supabase.admin()` — with
    the Python wall removed, so the gate's own message is on record:
    it names the route, the table, the row, and the identities that
    moved (firm A → firm B, set_by → the intruder)."""
    original = _supabase_module.per_user
    admin = _supabase_module.admin

    def _planted(jwt):
        client = original(jwt)
        service = admin()

        class _WritesAsServiceRole(object):
            def __getattr__(self, name):
                if name in ("insert", "update", "upsert", "delete"):
                    return getattr(service, name)
                return getattr(client, name)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

        return _WritesAsServiceRole()

    monkeypatch.setattr(_supabase_module, "per_user", _planted)
    _open_python_walls(monkeypatch, B_OWNER, "cockpit")
    w = next(x for x in WRITE_ROUTES if x["id"] == "cadence-put")
    before = _rows_at(world, w["table"], w["key"])
    r = _send_write(app, dict(w, body={"client_org_id": ORG_A1, "firm_id": FIRM_B, "cadence": "monthly"}),
                    B_OWNER)
    after = _rows_at(world, w["table"], w["key"])
    assert r.status_code == 200 and after != before, "the planted defect did not reproduce"
    with pytest.raises(AssertionError) as exc:
        assert after == before, (
            "FC1 WRITE VIOLATED — route %s with the Python wall removed: the SQL wall let %s move "
            "%s[%s=%s]: firm_id %s → %s, set_by %s → %s, nudge_days_before %s → %s"
            % (w["id"], B_OWNER, w["table"], w["key"][0], w["key"][1],
               before[0]["firm_id"], after[0]["firm_id"], before[0]["set_by"], after[0]["set_by"],
               before[0]["nudge_days_before"], after[0]["nudge_days_before"]))
    message = str(exc.value)
    assert "FC1 WRITE VIOLATED — route cadence-put" in message
    assert "firm_client_cadence[client_org_id=%s]" % ORG_A1 in message
    assert "firm_id %s → %s" % (FIRM_A, FIRM_B) in message and "set_by %s → %s" % (A_ACCOUNTANT, B_OWNER) in message


def test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients(app, world, monkeypatch):
    """The brief cache (`firm_briefs`) is written AS THE CALLER with the
    CLIENT dimension. A firm-B owner cannot store a brief for firm A
    naming firm A's client (refused, recorded, no row); a firm-A viewer
    can, and firm B never reads it back; the SQL wall loosened, the
    intruder's row lands. At the route, with a model stubbed present,
    the cached row carries exactly the clients the brief named."""
    from engine.api import _firm_brief as FB

    payload = {"version": FB.BRIEF_VERSION, "degraded": False, "notice": SECRET_BRIEF + "-2",
               "advisory": {"available": True, "model_id": "m", "prompt_version": "v"},
               "order": [{"client_org_id": ORG_A1, "client_name": "Client A1"}]}
    intruder = FB.SupabaseBriefStore(jwt=_jwt(B_OWNER, EMAILS[B_OWNER]), firm_id=FIRM_A)
    assert intruder.put(FIRM_A, "2026-03-10", "hash-w1", payload, B_OWNER,
                        client_org_ids=[ORG_A1]) is False
    assert intruder.last_put == "refused"
    assert not [r for r in world.rows("firm_briefs") if r["item_set_hash"] == "hash-w1"], (
        "FC1 WRITE VIOLATED — firm_briefs: a firm-B owner cached a firm-A brief naming Client A1")
    # a firm-B owner cannot even file it under THEIR firm while it names firm A's client
    own = FB.SupabaseBriefStore(jwt=_jwt(B_OWNER, EMAILS[B_OWNER]), firm_id=FIRM_B)
    assert own.put(FIRM_B, "2026-03-10", "hash-w1b", payload, B_OWNER, client_org_ids=[ORG_A1]) is False
    assert own.last_put == "refused"
    # the right role stores it, with the client dimension
    viewer = FB.SupabaseBriefStore(jwt=_jwt(A_VIEWER, EMAILS[A_VIEWER]), firm_id=FIRM_A)
    assert viewer.put(FIRM_A, "2026-03-10", "hash-w1", payload, A_VIEWER, client_org_ids=[ORG_A1]) is True
    row = next(r for r in world.rows("firm_briefs") if r["item_set_hash"] == "hash-w1")
    assert row["client_org_ids"] == [ORG_A1] and row["firm_id"] == FIRM_A and row["user_id"] == A_VIEWER
    assert viewer.get(FIRM_A, "2026-03-10", "hash-w1")["notice"] == SECRET_BRIEF + "-2"
    assert intruder.get(FIRM_A, "2026-03-10", "hash-w1") is None
    # the leak, deliberately
    _open_sql_wall(world, B_OWNER)
    assert intruder.put(FIRM_A, "2026-03-10", "hash-w1-leak", payload, B_OWNER,
                        client_org_ids=[ORG_A1]) is True, "with the SQL wall loosened the write must land"

    # at the route: a present model → the cache row names exactly the brief's clients
    monkeypatch.setattr(FB, "draft_advisory", lambda view, client_factory=None, state_dir=None: {
        "available": True, "kind": "advisory", "reason": "", "opening": "o", "groups": [],
        "suggested_order": [], "facts_used": [], "model_id": "stub", "prompt_version": "v"})
    r = app.post("/api/firm/brief", json={"firm_id": FIRM_A, "as_of": "2026-03-10"}, headers=hdr(A_OWNER))
    assert r.status_code == 200 and r.json()["item_count"] >= 1, r.text
    cached = next(x for x in world.rows("firm_briefs") if x["item_set_hash"] == r.json()["item_set_hash"])
    named = FB.brief_client_ids(DG_items(r.json()["order"]))
    assert cached["client_org_ids"] == named and set(named) <= {ORG_A1, ORG_A2} and named
    assert cached["user_id"] == A_OWNER and cached["firm_id"] == FIRM_A
    again = app.post("/api/firm/brief", json={"firm_id": FIRM_A, "as_of": "2026-03-10"}, headers=hdr(A_OWNER))
    assert again.json()["cached"] is True


def DG_items(order_rows):  # type: (List[Dict[str, Any]]) -> List[Any]
    """The payload rows of a brief's `order` as items, for brief_client_ids."""
    from engine.firm import digest as DG
    return DG.coerce_items(order_rows)[0]


# ── the write-site census over the cockpit modules ───────────────────────

#: Every write a cockpit module makes through the SERVICE ROLE (or through
#: a client handed in as a parameter — the crons), declared with the
#: secret that gates it. A service-role write outside this table is red.
DECLARED_SERVICE_ROLE_WRITES = {
    ("_firm_requests.py", "_prod_insert_document", "documents"):
        "the token landing: the signed link is the auth; the file lands through the normal pipeline",
    ("_firm_requests.py", "queue_email", "firm_email_queue"):
        "the e-mail queue has no policy; queued only after an admitted write; drained admin-only",
    ("_firm_requests.py", "run_nudge_cron", "firm_file_requests"):
        "SCHEDULER cron (ENGINE_API_TOKEN, fail closed): expiry and reminders",
    ("_firm_requests.py", "run_digest_cron", "firm_digest_log"):
        "SCHEDULER cron (ENGINE_API_TOKEN, fail closed)",
    ("_firm_requests.py", "run_digest_cron", "firm_digest_prefs"):
        "SCHEDULER cron (ENGINE_API_TOKEN, fail closed): last_sent_at / last_item_ids",
    ("_firm_requests.py", "create_request", "firm_file_request_tokens"):
        "the secret half, no policy; written only AFTER the caller's own insert was admitted",
    ("_firm_requests.py", "upload_for_request", "firm_file_requests"):
        "the token landing marks the request received / refused",
    ("_firm_requests.py", "drain_email", "firm_email_queue"):
        "ADMIN-gated drain (PRICING_ADMIN_USER_IDS)",
    ("_firm_invites.py", "enqueue_invitation_email", "firm_invite_email_queue"):
        "the invitation queue, no policy; written after the guarded RPC minted the invitation",
}

#: The writes that MUST be the caller's own (per_user): table per module.
EXPECTED_CALLER_WRITES = {
    ("_firm_requests.py", "firm_file_requests"), ("_firm_requests.py", "firm_client_cadence"),
    ("_firm_requests.py", "firm_digest_prefs"), ("_firm_brief.py", "firm_briefs"),
    ("_firm_attention.py", "firm_attention_suppressions"),
}


def _write_sites(source):  # type: (str) -> List[Tuple[str, str, str, int]]
    """Every insert/update/upsert/delete call in a module, as (enclosing
    function, client kind, table, line). The client kind is read from
    the `with _supabase.admin() as X` / `with _supabase.per_user(…) as
    Y` / `with self._writer() as Z` block that bound the receiver —
    "service" / "caller" — or "parameter" when the receiver is a name no
    such block bound (a client handed in, as the crons take)."""
    tree = ast.parse(source)
    constants = {}  # type: Dict[str, str]
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Constant) \
                and isinstance(stmt.value.value, str):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = stmt.value.value
    functions = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]

    def _enclosing(lineno):
        best = None
        for fn in functions:
            if fn.lineno <= lineno <= (getattr(fn, "end_lineno", fn.lineno) or fn.lineno):
                if best is None or (fn.end_lineno - fn.lineno) < (best.end_lineno - best.lineno):
                    best = fn
        return best.name if best is not None else "<module>"

    bound = {}  # type: Dict[int, str]  # id(call node) -> kind
    for node in ast.walk(tree):
        if not isinstance(node, ast.With):
            continue
        for item in node.items:
            ctx = item.context_expr
            name = item.optional_vars.id if isinstance(item.optional_vars, ast.Name) else None
            if name is None or not isinstance(ctx, ast.Call):
                continue
            kind = None
            if isinstance(ctx.func, ast.Attribute) and ctx.func.attr in ("admin", "per_user", "_writer", "_reader"):
                kind = "service" if ctx.func.attr == "admin" else "caller"
            if kind is None:
                continue
            for call in ast.walk(node):
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) \
                        and isinstance(call.func.value, ast.Name) and call.func.value.id == name \
                        and call.func.attr in ("insert", "update", "upsert", "delete"):
                    bound[id(call)] = kind
    out = []  # type: List[Tuple[str, str, str, int]]
    for call in ast.walk(tree):
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr in ("insert", "update", "upsert", "delete") and call.args):
            continue
        receiver = call.func.value
        if isinstance(receiver, ast.Name) and receiver.id == "router":
            continue
        first = call.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            table = first.value
        elif isinstance(first, ast.Name) and first.id in constants:
            table = constants[first.id]
        else:
            continue
        kind = bound.get(id(call), "parameter")
        out.append((_enclosing(call.lineno), kind, table, call.lineno))
    return sorted(out, key=lambda hit: hit[3])


def test_write_site_census_every_write_is_the_callers_or_declared_service_role():
    """THE WRITE-SITE CENSUS (W1). Every table write in the cockpit
    modules and the firm-model modules is either the CALLER's own
    (`per_user`, so RLS is the second wall) or a declared service-role /
    parameter write with the secret that gates it. An undeclared
    service-role write of client data is red; a declared one the code no
    longer makes is red too."""
    found = []  # type: List[Tuple[str, str, str, str, int]]
    for path in FIRM_MODULES + COCKPIT_MODULES:
        for fn, kind, table, line in _write_sites(path.read_text(encoding="utf-8")):
            found.append((path.name, fn, kind, table, line))
    assert len(found) >= 12, "write-site census found %d sites — discovery broken" % len(found)
    service = set((m, fn, t) for m, fn, kind, t, _l in found if kind != "caller")
    undeclared = service - set(DECLARED_SERVICE_ROLE_WRITES)
    assert not undeclared, (
        "FC1 WRITE CENSUS — service-role / parameter write(s) no declaration explains "
        "(a write of client data must be the CALLER's own, through per_user, or declared "
        "with the secret that gates it): %s" % sorted(undeclared))
    stale = set(DECLARED_SERVICE_ROLE_WRITES) - service
    assert not stale, "declared service-role write(s) the code no longer makes: %s" % sorted(stale)
    caller = set((m, t) for m, fn, kind, t, _l in found if kind == "caller")
    assert EXPECTED_CALLER_WRITES <= caller, (
        "write(s) that must be the caller's own are not: %s" % sorted(EXPECTED_CALLER_WRITES - caller))
    for m, t in EXPECTED_CALLER_WRITES:
        assert not [s for s in service if s[0] == m and s[2] == t and s[1] not in
                    ("run_nudge_cron", "run_digest_cron", "upload_for_request", "queue_email")], (
            "%s is written through the service role from a signed-in route: %s" % (t, sorted(service)))


def test_write_site_census_is_not_vacuous():
    src = ("def f(jwt):\n    with _supabase.per_user(jwt) as client:\n        client.upsert('t', {})\n"
           "def g():\n    with _supabase.admin() as ac:\n        ac.insert('u', {})\n"
           "def h(client):\n    client.update('v', {})\n"
           "T = 'w'\ndef k(jwt):\n    with _supabase.per_user(jwt) as c:\n        c.insert(T, {})\n")
    sites = [(fn, kind, table) for fn, kind, table, _l in _write_sites(src)]
    assert sites == [("f", "caller", "t"), ("g", "service", "u"), ("h", "parameter", "v"),
                     ("k", "caller", "w")], sites


# ── the Capsule tools: every tool classified, every tool swept ───────────

def test_every_capsule_tool_is_classified_and_read_only():
    assert set(CAPSULE_TOOL_CENSUS) == set(CT.TOOL_ALLOWLIST), (
        "CAPSULE CENSUS — tools without a classification: %s; classifications without a tool: %s"
        % (sorted(set(CT.TOOL_ALLOWLIST) - set(CAPSULE_TOOL_CENSUS)),
           sorted(set(CAPSULE_TOOL_CENSUS) - set(CT.TOOL_ALLOWLIST))))
    assert len(CT.TOOL_ALLOWLIST) >= 8
    for name in CT.TOOL_ALLOWLIST:
        assert CT.TOOL_REGISTRY[name].read_only is True, name
        assert CAPSULE_TOOL_CENSUS[name][0] == "swept-read", name
    # the registry refuses a write tool at construction — no Capsule tool
    # can mutate, so the Capsule surface has reads to sweep and no writes
    with pytest.raises(CT.ToolRegistryError):
        CT.register_tools(list(CT.TOOL_REGISTRY.values()) + [
            CT.ToolSpec(name="set_facts", fn=lambda ctx, **k: None, description="planted",
                        params=(), returns="", read_only=False)])


@pytest.mark.parametrize("tool", sorted(CAPSULE_TOOL_CENSUS))
def test_fc1_every_capsule_tool_refuses_firm_a_client_data_to_anyone_but_its_members(app, world, tool):
    _kind, args = CAPSULE_TOOL_CENSUS[tool]
    for intruder in (B_OWNER, B_VIEWER, SOLO, NOBODY, A_VIEWER, A_ACCOUNTANT):
        r = app.post("/api/capsule/tools/%s" % tool, headers=hdr(intruder, ORG_A1), json={"args": args})
        assert r.status_code == 403, (tool, intruder, r.status_code, r.text)
        _no_marker("capsule:" + tool, r, intruder, "org-a1")
        assert "12588619251" not in r.text and "values" not in r.text
    # the positive control: the workspace's own member reaches the dispatcher
    r = app.post("/api/capsule/tools/%s" % tool, headers=hdr(A_OWNER, ORG_A1), json={"args": args})
    assert r.status_code == 200, (tool, r.status_code, r.text[:300])
    assert r.json().get("tool") == tool


# ── W3: a client's cadence and brief do not follow it across firms ───────

def test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief(app, world):
    """W3. Firm A stored the client's cadence (firm_id = A, set_by = A's
    accountant, the secret nudge days) and cached a brief naming the
    client. Detach from A, attach to B. Firm B reads NOTHING of A's era
    — the cadence at the route (pack default) AND at RLS alone; the
    brief at RLS alone — and firm A's viewers lose the brief the moment
    the client leaves. B then sets its own cadence and sees exactly
    that, with A's identity gone from the row. After the repair this
    reds on (TC-11): A's row reaching B's viewer at either wall; A's
    firm-only viewer keeping the brief or the cadence after the client
    left; the A-era row being scrubbed instead of hidden; B unable to
    replace the row (the upsert's conflict half) or to read its own; the
    workspace's own members losing their history."""
    a_era = next(x for x in world.rows("firm_client_cadence") if x["client_org_id"] == ORG_A1)
    assert a_era["firm_id"] == FIRM_A and a_era["set_by"] == A_ACCOUNTANT
    x_viewer = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    y_viewer = _supabase_module.per_user(_jwt(B_VIEWER, EMAILS[B_VIEWER]))
    assert x_viewer.select("firm_briefs", filters={"firm_id": "eq." + FIRM_A}), "seed brief unreadable"

    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) is None
    # the moment the client leaves, firm A's viewer loses the brief that names it (RLS alone)
    assert x_viewer.select("firm_briefs", filters={"firm_id": "eq." + FIRM_A}) == [], (
        "W3 VIOLATED — firm A still reads a brief naming a client that left")
    world.add("memberships", {"user_id": B_OWNER, "org_id": ORG_A1, "role": "owner"})
    r = app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(B_OWNER), json={"org_id": ORG_A1})
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) == FIRM_B
    assert next(x for x in world.rows("firm_client_cadence") if x["client_org_id"] == ORG_A1)["firm_id"] == FIRM_A, (
        "the A-era row still exists — the test is about visibility, not scrubbing")

    nudges = json.dumps(SECRET_CADENCE_NUDGES, separators=(",", ":"))
    # at the route: firm B's viewer gets the pack default, never A's row
    r = app.get("/api/firm/cadence/status",
                params={"client_org_id": ORG_A1, "firm_id": FIRM_B, "as_of": "2026-03-10"}, headers=hdr(B_VIEWER))
    assert r.status_code == 200, r.text
    assert r.json()["cadence"]["source"] == "pack_default" and nudges not in r.text, (
        "W3 VIOLATED — firm B reads firm A's cadence at the route: %s" % r.text)
    assert A_ACCOUNTANT not in r.text
    # at RLS alone
    assert y_viewer.select("firm_client_cadence", filters={"client_org_id": "eq." + ORG_A1}) == [], (
        "W3 VIOLATED at the RLS wall alone — firm B's viewer reads firm A's cadence row")
    assert y_viewer.select("firm_briefs") == []
    # firm A's firm-only viewer reads none of it any more either
    assert x_viewer.select("firm_client_cadence", filters={"client_org_id": "eq." + ORG_A1}) == []
    r = app.get("/api/firm/cadence/status",
                params={"client_org_id": ORG_A1, "firm_id": FIRM_A, "as_of": "2026-03-10"}, headers=hdr(A_VIEWER))
    assert r.status_code == 403 and r.json()["detail"] == _firm.NOT_A_CLIENT
    # the attention board of firm B's viewer: the client is graded against the default, not A's quarterly row
    r = app.get("/api/firm/attention", params={"as_of": "2026-03-10", "client_id": ORG_A1}, headers=hdr(B_VIEWER))
    assert r.status_code == 200 and nudges not in r.text and A_ACCOUNTANT not in r.text

    # B sets its own: that, and only that, is B's view — A's identity is gone from the row
    r = app.put("/api/firm/cadence", headers=hdr(B_OWNER),
                json={"client_org_id": ORG_A1, "firm_id": FIRM_B, "cadence": "monthly"})
    assert r.status_code == 200, r.text
    row = next(x for x in world.rows("firm_client_cadence") if x["client_org_id"] == ORG_A1)
    assert row["firm_id"] == FIRM_B and row["set_by"] == B_OWNER and row["nudge_days_before"] is None
    assert [x["client_org_id"] for x in y_viewer.select("firm_client_cadence")] == [ORG_A1]
    r = app.get("/api/firm/cadence/status",
                params={"client_org_id": ORG_A1, "firm_id": FIRM_B, "as_of": "2026-03-10"}, headers=hdr(B_VIEWER))
    assert r.json()["cadence"]["source"] == "stored" and r.json()["cadence"]["cadence"] == "monthly"
    # the workspace's own members keep their own history (the member policy)
    owner = _supabase_module.per_user(_jwt(B_OWNER, EMAILS[B_OWNER]))
    assert [x["client_org_id"] for x in owner.select("firm_client_cadence")] == [ORG_A1]


def test_w3_the_cadence_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened(
        app, world, monkeypatch):
    """Either wall alone leaves firm B nothing of firm A's era: with the
    cadence policies loosened to `true`, the route's own pin
    (`_cadence_row(…, firm_id)`) still answers the pack default; with
    the route's pin removed, RLS alone still answers nothing."""
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200
    world.add("memberships", {"user_id": B_OWNER, "org_id": ORG_A1, "role": "owner"})
    assert app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(B_OWNER),
                    json={"org_id": ORG_A1}).status_code == 200
    q = {"client_org_id": ORG_A1, "firm_id": FIRM_B, "as_of": "2026-03-10"}
    nudges = json.dumps(SECRET_CADENCE_NUDGES, separators=(",", ":"))
    # RLS loosened, route pin standing
    world.plant_policy("firm_client_cadence", "true")
    r = app.get("/api/firm/cadence/status", params=q, headers=hdr(B_VIEWER))
    assert r.json()["cadence"]["source"] == "pack_default" and nudges not in r.text, (
        "W3 VIOLATED at the route alone: %s" % r.text)
    # route pin removed, RLS standing
    world.policies.pop("firm_client_cadence")
    world_fresh = FirmWorld(_sql_text(), _sibling_sql_texts())
    world.policies["firm_client_cadence"] = world_fresh.policies["firm_client_cadence"]
    original = _firm_requests._cadence_row
    monkeypatch.setattr(_firm_requests, "_cadence_row", lambda ac, org, firm_id=None: original(ac, org, None))
    r = app.get("/api/firm/cadence/status", params=q, headers=hdr(B_VIEWER))
    assert r.json()["cadence"]["source"] == "pack_default" and nudges not in r.text, (
        "W3 VIOLATED at the RLS wall alone: %s" % r.text)
    # both removed: the leak, deliberately
    world.plant_policy("firm_client_cadence", "true")
    r = app.get("/api/firm/cadence/status", params=q, headers=hdr(B_VIEWER))
    assert r.json()["cadence"]["source"] == "stored" and nudges in r.text, (
        "with both pins removed firm B must read firm A's row — otherwise the assertions "
        "above passed for a reason other than the pins")


# ── D1: the suppression PATCH hole — closed TWICE; every UPDATE policy swept ──

PLANTED_REASON = "PLANTED-BY-FIRM-B"


def _row_by_id(world, table, row_id):  # type: (FirmWorld, str, str) -> Dict[str, Any]
    return copy.deepcopy(next(x for x in world.rows(table) if str(x.get("id")) == str(row_id)))


def _row_ref(world, table, filters):  # type: (FirmWorld, str, Dict[str, str]) -> Dict[str, Any]
    """THE ROW THAT WOULD MOVE, by object identity — a PATCH that lands
    rewrites it in place (its key columns included), so the same object
    is compared before and after."""
    return next(x for x in world.rows(table) if all(_match_filter(x, c, e) for c, e in filters.items()))


def _patch_as(world, uid, table, patch, filters):  # type: (FirmWorld, str, str, Dict[str, Any], Dict[str, str]) -> Optional[str]
    """A direct PostgREST PATCH as `uid` — what supabase-js sends with the
    anon key and a user JWT; no route, no Python wall. Returns the
    refusal text, or None when the PATCH landed."""
    client = _supabase_module.per_user(_jwt(uid, EMAILS[uid]))
    try:
        client.update(table, patch, filters=filters)
    except RuntimeError as exc:
        return str(exc)
    return None


def _board(app, actor, client_id=None):  # type: (Any, str, Optional[str]) -> Any
    params = {"as_of": "2026-03-10"}
    if client_id:
        params["client_id"] = client_id
    return app.get("/api/firm/attention", params=params, headers=hdr(actor))


def _seed_intruders_own_row(app, world, table):  # type: (Any, FirmWorld, str) -> Tuple[str, Dict[str, str]]
    """Firm B's OWN row on firm B's OWN client, written the way the
    product writes it (through the route where one exists). Returns the
    id and the filter that names THE ROW THAT WOULD MOVE."""
    if table == "firm_attention_suppressions":
        r = app.post("/api/firm/attention/suppress", headers=hdr(B_OWNER),
                     json={"client_id": ORG_B1, "kind": "MISSING_FILE", "reason": "B's own reason"})
        assert r.status_code == 200, r.text
        return r.json()["suppression"]["id"], {"id": "eq.%s" % r.json()["suppression"]["id"]}
    if table == "firm_covenants":
        row = world.add("firm_covenants", {"org_id": ORG_B1, "covenant_id": "cov-b1", "label": "B cov",
                                           "metric": "equity", "comparator": ">=", "limit_value": 1,
                                           "unit": "money", "headroom_warn_share": 0.1,
                                           "created_by": B_OWNER})
        return row["id"], {"id": "eq.%s" % row["id"]}
    if table == "firm_client_cadence":
        r = app.put("/api/firm/cadence", headers=hdr(B_OWNER),
                    json={"client_org_id": ORG_B1, "firm_id": FIRM_B, "cadence": "monthly"})
        assert r.status_code == 200, r.text
        return ORG_B1, {"client_org_id": "eq.%s" % ORG_B1}
    if table == "firm_file_requests":
        return REQUEST_B1, {"id": "eq.%s" % REQUEST_B1}
    if table == "firm_digest_prefs":
        r = app.put("/api/firm/digest/prefs", headers=hdr(B_OWNER),
                    json={"firm_id": FIRM_B, "enabled": True, "frequency": "daily", "send_hour_utc": 7})
        assert r.status_code == 200, r.text
        row = next(x for x in world.rows("firm_digest_prefs") if x["user_id"] == B_OWNER)
        return row["id"], {"id": "eq.%s" % row["id"]}
    if table == "firm_briefs":
        row = world.add("firm_briefs", {"firm_key": FIRM_B, "firm_id": FIRM_B, "user_id": B_OWNER,
                                        "client_org_ids": [ORG_B1], "brief_date": "2026-09-01",
                                        "item_set_hash": "b-own", "payload": {"version": "b"},
                                        "degraded": False})
        return row["id"], {"id": "eq.%s" % row["id"]}
    if table == "firms":
        return FIRM_B, {"id": "eq.%s" % FIRM_B}
    raise AssertionError("no seed for %s — a NEW update policy must be swept here" % table)


#: EVERY table with an UPDATE policy in the three migrations, with the
#: PATCH that moves firm B's own row onto firm A's client (its tenancy
#: columns, and the author column where one exists), and which wall
#: refuses it with the other opened by hand: "privilege" — the column
#: grant refuses BEFORE any policy (the column is non-updatable);
#: "policy" — UPDATE is table-wide by design (the route UPSERTS the whole
#: row) and the WITH CHECK re-pin is the one SQL wall. The census below
#: asserts this table names every update policy the migrations declare.
UPDATE_SWEEP = {
    "firm_attention_suppressions": ({"org_id": ORG_A1, "dismissed_by": A_OWNER, "revoked_by": B_OWNER,
                                     "reason": PLANTED_REASON}, "privilege"),
    "firm_covenants": ({"org_id": ORG_A1, "label": PLANTED_REASON}, "privilege"),
    "firm_client_cadence": ({"client_org_id": ORG_A1, "firm_id": FIRM_A}, "policy"),
    "firm_file_requests": ({"client_org_id": ORG_A1, "firm_id": FIRM_A, "requested_by": A_OWNER,
                            "note": PLANTED_REASON}, "privilege"),
    "firm_digest_prefs": ({"user_id": A_OWNER, "firm_id": FIRM_A}, "privilege"),
    "firm_briefs": ({"firm_key": FIRM_A, "firm_id": FIRM_A, "client_org_ids": [ORG_A1],
                     "user_id": A_OWNER}, "policy"),
    "firms": ({"id": FIRM_A, "name": PLANTED_REASON}, "privilege"),
}


def test_d1_every_update_policy_in_the_migrations_is_swept():
    """TC-3 census: a table that gains an UPDATE policy is red here until
    UPDATE_SWEEP names it with the PATCH that would move its row."""
    w = FirmWorld(_sql_text(), _sibling_sql_texts())
    assert set(w.update_policies) == set(UPDATE_SWEEP), (
        "UPDATE policies drifted from the sweep: unswept %s, stale %s"
        % (sorted(set(w.update_policies) - set(UPDATE_SWEEP)), sorted(set(UPDATE_SWEEP) - set(w.update_policies))))
    assert len(UPDATE_SWEEP) >= 7


@pytest.mark.parametrize("table", sorted(UPDATE_SWEEP))
def test_d1_a_patch_of_the_callers_own_row_toward_another_firms_client_is_refused_by_each_wall_alone(
        app, world, table):
    """D1 (the critics' HIGH). Firm B's owner PATCHes THEIR OWN row's
    tenancy columns toward firm A's client — the exact supabase-js write,
    no route, no Python wall — and Postgres refuses it TWICE: the column
    grant first (42501 permission denied for the table, before any
    policy), and the WITH CHECK re-pin second (42501 row-level security).
    Each wall is shown to refuse with the other opened by hand; with
    both open the SAME PATCH lands, which proves the refusals were the
    walls. The row is byte-identical after every refusal. After the
    repair this reds on (TC-11): a PATCH that lands with either wall
    standing — a column grant widened back to table-wide on a non-
    upserted table, or a WITH CHECK that pins fewer tenancy columns than
    the sweep names; and on a refusal for a reason other than the wall
    (the PATCH must LAND once both are open)."""
    patch, sole_wall = UPDATE_SWEEP[table]
    row_id, filters = _seed_intruders_own_row(app, world, table)
    ref = _row_ref(world, table, filters)
    before = copy.deepcopy(ref)
    size = _table_size(world, table)

    def _unmoved(stage):  # type: (str) -> None
        after = copy.deepcopy(ref)
        assert after == before and _table_size(world, table) == size, (
            "FC1 WRITE VIOLATED — %s: a direct PATCH by %s (firm B's owner, %s) moved %s[id=%s] "
            "onto firm A's client: before %s, after %s"
            % (table, B_OWNER, stage, table, row_id, before, after))

    # 1. both walls standing
    refusal = _patch_as(world, B_OWNER, table, patch, filters)
    assert refusal is not None, "FC1 WRITE VIOLATED — %s: the PATCH landed with both walls standing" % table
    assert "42501" in refusal, refusal
    if sole_wall == "privilege":
        assert "permission denied for table %s" % table in refusal, (
            "%s: the column grant must refuse BEFORE any policy — got %s" % (table, refusal))
    _unmoved("both walls standing")

    # 2. the column grant opened by hand (the Supabase default): the WITH CHECK alone
    world.plant_privileges(table, "update", grant=True)
    refusal = _patch_as(world, B_OWNER, table, patch, filters)
    assert refusal is not None and "row-level security" in refusal, (
        "FC1 WRITE VIOLATED — %s: with UPDATE table-wide again the WITH CHECK alone let the PATCH "
        "land (or refused for another reason): %r" % (table, refusal))
    _unmoved("column grant opened")

    # 3. the WITH CHECK loosened to `true`, the column grant standing
    fresh = FirmWorld(_sql_text(), _sibling_sql_texts())
    for role in API_ROLES:
        world.privileges[(role, table)] = dict(fresh.privileges[(role, table)])
    world.plant_update_check(table, "true")
    refusal = _patch_as(world, B_OWNER, table, patch, filters)
    if sole_wall == "privilege":
        assert refusal is not None and "permission denied for table %s" % table in refusal, (
            "FC1 WRITE VIOLATED — %s: with the WITH CHECK loosened the column grant alone must "
            "refuse: %r" % (table, refusal))
        _unmoved("policy loosened")
    else:
        # UPDATE is table-wide by design here (the route upserts the whole
        # row): the policy IS the wall, so loosening it is the leak.
        assert refusal is None, (table, refusal)
        assert copy.deepcopy(ref) != before, (
            "%s: with the one SQL wall loosened the PATCH must land — otherwise the refusals above "
            "held for a reason other than the wall" % table)
        return

    # 4. both open: the leak, deliberately (non-vacuity)
    world.plant_privileges(table, "update", grant=True)
    refusal = _patch_as(world, B_OWNER, table, patch, filters)
    assert refusal is None, (table, refusal)
    moved = copy.deepcopy(ref)
    assert moved != before, (
        "%s: with both walls removed the PATCH must move the row — otherwise the assertions above "
        "passed for a reason other than the walls" % table)
    for column, value in patch.items():
        assert moved.get(column) == value, (table, column, moved)


def test_d1_the_planted_suppression_never_reaches_firm_as_board(app, world):
    """The critics' exact transcript (crit_suppression_hole.py /
    crit_supp_board.py), on the repaired schema: firm B's owner suppresses
    MISSING_FILE on their own client (legit), PATCHes it onto firm A's
    client with A's owner as the dismisser and revoked_at NULL, and firm
    A's board and suppressions list are read before and after. The
    marker never reaches firm A: no decision on A's board is taken from
    it, the list does not carry it, A's item count is unchanged. Then,
    with BOTH SQL walls opened by hand AND the era pin pointed at A, the
    same PATCH lands and the marker DOES reach A's board — which is what
    proves the silence above was the walls. After the repair this reds on
    (TC-11): the marker reaching A's board or list with either wall
    standing; and on the marker NOT reaching A's board with both walls and
    the era pin open (a refusal for some other reason)."""
    r0 = _board(app, A_VIEWER, ORG_A1)
    assert r0.status_code == 200, r0.text
    items0 = r0.json()["clients"][0]["item_count"] if r0.json()["clients"] else 0
    assert items0 > 0 and r0.json()["suppression_audit"] == [], (items0, r0.json()["suppression_audit"])
    own_id, filters = _seed_intruders_own_row(app, world, "firm_attention_suppressions")
    own = _row_by_id(world, "firm_attention_suppressions", own_id)
    assert own["firm_id"] == FIRM_B, "the era pin trigger must stamp firm B on B's insert: %s" % own
    patch = {"org_id": ORG_A1, "dismissed_by": A_OWNER, "revoked_by": B_OWNER, "reason": PLANTED_REASON}
    refusal = _patch_as(world, B_OWNER, "firm_attention_suppressions", patch, filters)
    assert refusal and "permission denied for table firm_attention_suppressions" in refusal, refusal
    r1 = _board(app, A_VIEWER, ORG_A1)
    assert PLANTED_REASON not in r1.text and r1.json()["suppression_audit"] == [], (
        "FC1 WRITE VIOLATED — a firm-B suppression reached firm A's board: %s" % r1.json()["suppression_audit"])
    assert r1.json()["clients"][0]["item_count"] == items0
    r2 = app.get("/api/firm/attention/suppressions", headers=hdr(A_VIEWER))
    assert r2.status_code == 200 and PLANTED_REASON not in r2.text, r2.text
    r3 = _board(app, A_OWNER)
    assert PLANTED_REASON not in r3.text and r3.json()["suppression_audit"] == []
    # the leak, deliberately: both walls open, and the row re-pinned to A's era
    world.plant_privileges("firm_attention_suppressions", "update", grant=True)
    world.plant_update_check("firm_attention_suppressions", "true")
    assert _patch_as(world, B_OWNER, "firm_attention_suppressions", dict(patch, firm_id=FIRM_A), filters) is None
    r4 = _board(app, A_VIEWER, ORG_A1)
    audit = r4.json()["suppression_audit"]
    assert audit and PLANTED_REASON in r4.text and A_OWNER in json.dumps(audit), (
        "with both walls open the planted suppression must reach firm A's board with A's owner as "
        "the dismisser — otherwise the silence above was not the walls: %s" % (audit,))
    r5 = app.get("/api/firm/attention/suppressions", headers=hdr(A_VIEWER))
    assert PLANTED_REASON in r5.text


def test_d1_the_gate_reds_through_its_own_message_when_the_revoke_check_is_the_old_one(app, world):
    """The D1 plant, in memory: the revoke WITH CHECK back to
    `revoked_by = auth.uid()` alone AND the column grant back to the
    Supabase default (both are what the critics found). The sweep's own
    assertion fires, naming the table, the row and the intruder."""
    table = "firm_attention_suppressions"
    world.plant_update_check(table, "revoked_by = auth.uid()")
    world.plant_privileges(table, "update", grant=True)
    row_id, filters = _seed_intruders_own_row(app, world, table)
    before = _row_by_id(world, table, row_id)
    patch, _wall = UPDATE_SWEEP[table]
    refusal = _patch_as(world, B_OWNER, table, patch, filters)
    after = _row_by_id(world, table, row_id)
    with pytest.raises(AssertionError) as caught:
        assert refusal is not None and after == before, (
            "FC1 WRITE VIOLATED — %s: a direct PATCH by %s (firm B's owner) moved %s[id=%s] "
            "onto firm A's client: before %s, after %s" % (table, B_OWNER, table, row_id, before, after))
    text = str(caught.value)
    assert "FC1 WRITE VIOLATED" in text and table in text and row_id in text and B_OWNER in text
    assert after["org_id"] == ORG_A1 and after["dismissed_by"] == A_OWNER and after["revoked_at"] is None


def test_d1_the_era_pin_is_the_triggers_never_the_callers(world):
    """The BEFORE INSERT trigger stamps firm_of_org(org_id) whatever the
    caller sent, on every insert (a seed, the service role, a user); the
    insert WITH CHECK sees the stamped value. A caller naming another
    firm's id as the pin gets the true one. After the repair this reds on
    (TC-11): a seeded row without a pin; a caller's forged pin surviving
    the insert; a workspace with no firm getting a non-NULL pin; and,
    with the trigger dropped by hand, the insert WITH CHECK admitting a
    forged pin."""
    assert world.triggers.get("firm_attention_suppressions") and world.triggers.get("firm_covenants")
    seeded = _row_by_id(world, "firm_attention_suppressions", SUPPRESSION_A1)
    assert seeded["firm_id"] == FIRM_A
    assert _row_by_id(world, "firm_covenants", COVENANT_A1)["firm_id"] == FIRM_A
    accountant = _supabase_module.per_user(_jwt(A_ACCOUNTANT, EMAILS[A_ACCOUNTANT]))
    stored = accountant.insert("firm_attention_suppressions", {
        "org_id": ORG_A1, "kind": "CASH_RUNWAY", "scope_key": "*", "reason": "signed",
        "dismissed_by": A_ACCOUNTANT, "firm_id": FIRM_B})
    assert stored[0]["firm_id"] == FIRM_A, stored
    solo = _supabase_module.per_user(_jwt(SOLO, EMAILS[SOLO]))
    own = solo.insert("firm_attention_suppressions", {
        "org_id": ORG_S, "kind": "CASH_RUNWAY", "scope_key": "*", "reason": "mine",
        "dismissed_by": SOLO})
    assert own[0]["firm_id"] is None, "a workspace with no firm writes a NULL pin"
    # with the trigger dropped by hand, the insert WITH CHECK still refuses a forged pin
    world.plant_trigger_off("firm_attention_suppressions")
    with pytest.raises(RuntimeError, match="42501"):
        accountant.insert("firm_attention_suppressions", {
            "org_id": ORG_A1, "kind": "CASH_RUNWAY", "scope_key": "*", "reason": "forged",
            "dismissed_by": A_ACCOUNTANT, "firm_id": FIRM_B})


def test_d1_the_privilege_wall_is_parsed_from_the_migrations_not_mirrored():
    """DISCOVERY CANARY: the grants the double enforces come out of the
    three migrations' revoke / grant statements applied over the Supabase
    default; a recorded expectation per table (TC-6). After the repair
    this reds on (TC-11): any table's grant set drifting from this
    record in either direction — a column joining or leaving a grant, a
    table-wide UPDATE returning, DELETE granted anywhere, a new firm
    table without a line here."""
    w = FirmWorld(_sql_text(), _sibling_sql_texts())
    expected = {
        "firm_attention_suppressions": {"insert": True, "update": {"revoked_at", "revoked_by"}, "delete": False},
        "firm_covenants": {"insert": True, "update": {"label", "metric", "comparator", "limit_value", "unit",
                                                     "headroom_warn_share", "test_date", "source"},
                           "delete": True},
        "firm_file_requests": {"insert": True, "update": {"status"}, "delete": False},
        "firm_digest_prefs": {"insert": True, "update": {"enabled", "frequency", "send_hour_utc"}, "delete": False},
        "firm_client_cadence": {"insert": True, "update": True, "delete": False},
        "firm_briefs": {"insert": True, "update": True, "delete": False},
        "firm_file_request_tokens": {"insert": False, "update": False, "delete": False},
        "firm_email_queue": {"insert": False, "update": False, "delete": False},
        "firm_digest_log": {"insert": False, "update": False, "delete": False},
        "firms": {"insert": False, "update": {"name", "archived_at"}, "delete": False},
        "firm_memberships": {"insert": False, "update": False, "delete": False},
        "client_assignments": {"insert": False, "update": False, "delete": False},
        "firm_invitations": {"insert": False, "update": False, "delete": False},
        "firm_audit_log": {"insert": False, "update": False, "delete": False},
        "firm_invite_email_queue": {"insert": False, "update": False, "delete": False},
        "firm_roles": {"insert": False, "update": False, "delete": False},
        "firm_role_permissions": {"insert": False, "update": False, "delete": False},
    }
    assert set(expected) == set(firm_model_tables()), sorted(set(firm_model_tables()) ^ set(expected))
    for table, privs in expected.items():
        assert w.privileges[("authenticated", table)] == privs, (table, w.privileges[("authenticated", table)])
        anon = w.privileges[("anon", table)]
        assert not any(anon[op] for op in ("update", "delete")), (table, anon)
    # the pre-existing tables keep the default (nothing in these files touches them)
    assert w.privileges[("authenticated", "organizations")] == {"insert": True, "update": True, "delete": True}
    # a grant text that widens is honoured (the plant below is visible)
    widened = FirmWorld(_sql_text(), _sibling_sql_texts() + (
        "grant update on firm_attention_suppressions to authenticated;",))
    assert widened.privileges[("authenticated", "firm_attention_suppressions")]["update"] is True
    # the per-user writes the code makes fit the grants: the revocation, the digest patch
    source = (REPO / "src" / "engine" / "api" / "_firm_requests.py").read_text("utf-8")
    assert 'client.update("firm_file_requests", {"status": STATUS_REVOKED}' in source
    assert 'patch = {"enabled": body.enabled, "frequency": body.frequency,' in source


# ── D3: the era pin on suppressions and covenants; a signed link is not an era pin ──

def _attention_sql_policies():  # type: () -> Dict[str, Dict[str, str]]
    return dict((p["name"], p) for p in parse_policies(SQL_ATTENTION_PATH.read_text(encoding="utf-8")))


def test_d3_the_attention_migration_pins_the_era_in_its_text(world):
    """The recorded shape of schema_phase_firm_attention.sql (TC-6): both
    tables carry `firm_id`; ONE trigger function stamps it BEFORE INSERT
    on both; the firm read policies are `can_read_client_org(org_id) and
    (firm_id is null or firm_id = firm_of_org(org_id))` beside a member
    policy; the insert WITH CHECKs pin `firm_id is not distinct from
    firm_of_org(org_id)`; the revoke WITH CHECK re-pins the row AND the
    revoker; the backfill re-stamps only NULL pins. After the repair this
    reds on (TC-11): any of those predicates leaving the text; a table
    losing its trigger; the double no longer parsing the trigger."""
    sql = SQL_ATTENTION_PATH.read_text(encoding="utf-8")
    cols = parse_table_columns(sql)
    assert "firm_id" in cols["firm_attention_suppressions"] and "firm_id" in cols["firm_covenants"]
    triggers = dict(((t, e), (timing, fn)) for t, timing, e, fn in parse_triggers(sql))
    assert triggers[("firm_attention_suppressions", "insert")] == ("before", "firm_attention_pin_era")
    assert triggers[("firm_covenants", "insert")] == ("before", "firm_attention_pin_era")
    fn = parse_functions(sql)["firm_attention_pin_era"]
    assert fn["returns"].lower() == "trigger" and fn["language"] == "plpgsql"
    assert [c for c, _e in parse_trigger_assignments(fn["body"])] == ["firm_id"]
    assert "new.firm_id := firm_of_org(new.org_id)" in fn["body"]
    pols = _attention_sql_policies()
    for table in ("firm_attention_suppressions", "firm_covenants"):
        read = " ".join(pols["%s read" % table]["using"].split())
        assert "can_read_client_org(org_id)" in read and "firm_id is null or firm_id = firm_of_org(org_id)" in read, read
        assert pols["%s member select" % table]["using"].strip() == "is_member_of(org_id)"
        assert "firm_id is not distinct from firm_of_org(org_id)" in pols["%s insert" % table]["check"]
        assert len(world.policies[table]) >= 2, "%s must keep its member policy AND the pinned firm one" % table
    revoke = " ".join(pols["firm_attention_suppressions revoke"]["check"].split())
    assert "is_member_of(org_id)" in revoke and "firm_can(firm_of_org(org_id), 'suppress')" in revoke
    assert "revoked_by = auth.uid()" in revoke
    assert "update firm_attention_suppressions s set firm_id = firm_of_org(s.org_id) where s.firm_id is null;" in sql
    assert "update firm_covenants c set firm_id = firm_of_org(c.org_id) where c.firm_id is null;" in sql
    assert "add column if not exists firm_id uuid references firms(id) on delete set null" in sql


def _reattach_a1_to_firm_b(app, world):  # type: (Any, FirmWorld) -> None
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) is None, r.text
    world.add("memberships", {"user_id": B_OWNER, "org_id": ORG_A1, "role": "owner"})
    r = app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(B_OWNER), json={"org_id": ORG_A1})
    assert r.status_code == 200 and world.firm_of_org(ORG_A1) == FIRM_B, r.text


A_ERA_MARKERS = (SECRET_SUPPRESSION, SECRET_COVENANT, A_ACCOUNTANT, A_OWNER, FIRM_A)


def _a_era_hits(text):  # type: (str) -> List[str]
    return [m for m in A_ERA_MARKERS if m in text]


def _seed_a_era_missing_file_suppression(world):  # type: (FirmWorld) -> Dict[str, Any]
    """Firm A's accountant suppressed MISSING_FILE on the client — the kind
    the board emits for Client A1 as of 2026-03-10 — written before any
    move (the trigger stamps FIRM_A)."""
    return world.add("firm_attention_suppressions", {
        "org_id": ORG_A1, "kind": "MISSING_FILE", "scope_key": "*",
        "reason": SECRET_SUPPRESSION + "-MISSING-FILE", "dismissed_by": A_ACCOUNTANT,
        "dismissed_at": world.now_iso()})


def _covenant_declared(response):  # type: (Any) -> bool
    """Whether the board was computed over at least one declared covenant:
    the payload lists COVENANT_RISK under `kinds_absent` ("no covenant is
    declared for any client") exactly when none reached the compute — the
    seeded covenant's limit is far below the served equity, so it emits
    no ITEM, and the count is the only trace it leaves on a board."""
    return not any(k.get("kind") == "COVENANT_RISK" and "no covenant is declared" in str(k.get("reason"))
                   for k in response.json().get("kinds_absent", []))


def test_d3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_suppressions_or_covenants(app, world):
    """D3 (critic W3-incomplete). Firm A suppressed CASH_RUNWAY on the
    client (dismissed_by = A's accountant, the secret reason) and declared
    a covenant (created_by = A's owner, the secret label). Detach from A,
    attach to B. Firm B — its viewer AND its owner, now a workspace
    member — reads NOTHING of A's era: at RLS alone for the viewer, at
    the board and at /suppressions for both, through a WARM AttentionCache
    (warmed as A before the move) and a cold one. Firm A's firm-only
    viewer loses both rows the moment the client leaves. The A-era rows
    still exist (hidden, never scrubbed); the workspace's own member keeps
    the history at RLS (the member policy — the cadence / requests shape).
    B then suppresses its own and sees exactly that, pinned to B. After
    the repair this reds on (TC-11): an A-era suppression or covenant
    reaching B's viewer at RLS, or either firm-B reader at the board /
    the list, warm or cold; A's row being scrubbed instead of hidden; the
    workspace's own member losing the history; B's own decision not
    stamped with B or not read back by B."""
    x_viewer = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    y_viewer = _supabase_module.per_user(_jwt(B_VIEWER, EMAILS[B_VIEWER]))
    # A second A-era decision, on the kind the board REALLY emits for this
    # client (MISSING_FILE), so the board's own suppression audit is a
    # load-bearing marker — the seeded CASH_RUNWAY one leaves no trace on
    # a board with no CASH_RUNWAY item.
    mf = _seed_a_era_missing_file_suppression(world)
    assert mf["firm_id"] == FIRM_A
    # positive control: firm A's viewer reads every row, and A's board applies the suppression
    assert sorted(r["reason"] for r in x_viewer.select("firm_attention_suppressions")) == \
        sorted([SECRET_SUPPRESSION, mf["reason"]])
    assert [r["label"] for r in x_viewer.select("firm_covenants")] == [SECRET_COVENANT]
    ra = _board(app, A_VIEWER, ORG_A1)
    assert ra.status_code == 200 and _covenant_declared(ra), ra.text[:400]
    assert ra.json()["suppression_audit"] and A_ACCOUNTANT in json.dumps(ra.json()["suppression_audit"])
    assert SECRET_SUPPRESSION in app.get("/api/firm/attention/suppressions", headers=hdr(A_VIEWER)).text

    _reattach_a1_to_firm_b(app, world)
    assert next(x for x in world.rows("firm_attention_suppressions") if x["id"] == SUPPRESSION_A1)["firm_id"] == FIRM_A
    assert next(x for x in world.rows("firm_covenants") if x["id"] == COVENANT_A1)["firm_id"] == FIRM_A, (
        "the A-era rows still exist — the test is about visibility, not scrubbing")

    # at RLS alone: B's viewer reads nothing of A's era; A's firm-only viewer nothing at all
    for table in ("firm_attention_suppressions", "firm_covenants"):
        assert y_viewer.select(table, filters={"org_id": "eq." + ORG_A1}) == [], (
            "D3 VIOLATED at the RLS wall alone — firm B's viewer reads firm A's %s row" % table)
        assert x_viewer.select(table, filters={"org_id": "eq." + ORG_A1}) == []
    # the workspace's own member keeps the history through the member policy
    owner = _supabase_module.per_user(_jwt(B_OWNER, EMAILS[B_OWNER]))
    assert sorted(r["id"] for r in owner.select("firm_attention_suppressions", filters={"org_id": "eq." + ORG_A1})) == \
        sorted([SUPPRESSION_A1, mf["id"]])
    assert [r["id"] for r in owner.select("firm_covenants", filters={"org_id": "eq." + ORG_A1})] == [COVENANT_A1]

    # at every route, for both firm-B readers, warm (A warmed it) and cold
    from engine.api import _firm_attention as FAT
    for pass_name in ("warm", "cold"):
        if pass_name == "cold":
            FAT._CACHE.clear() if hasattr(FAT._CACHE, "clear") else None
        for actor in (B_VIEWER, B_OWNER):
            for client_id in (ORG_A1, None):
                r = _board(app, actor, client_id)
                assert r.status_code == 200, r.text
                hits = _a_era_hits(r.text)
                assert not hits, ("D3 VIOLATED — firm B (%s, %s cache, client_id=%s) reads firm A's era "
                                  "on the board: %s" % (actor, pass_name, client_id, hits))
                assert r.json()["suppression_audit"] == []
                assert any(c["client_id"] == ORG_A1 for c in r.json()["clients"]), r.text[:300]
                if client_id == ORG_A1:
                    assert not _covenant_declared(r), (
                        "D3 VIOLATED — firm A's covenant is still declared on firm B's board of the client")
            r = app.get("/api/firm/attention/suppressions", headers=hdr(actor))
            assert r.status_code == 200 and not _a_era_hits(r.text), (actor, pass_name, r.text)
    # firm A's firm-only viewer: the client is gone from its book entirely
    r = _board(app, A_VIEWER, ORG_A1)
    assert r.status_code == 200 and r.json()["clients"] == []
    assert not _a_era_hits(app.get("/api/firm/attention/suppressions", headers=hdr(A_VIEWER)).text.replace(FIRM_A, ""))

    # B suppresses its own: pinned to B, and that is exactly what B sees
    r = app.post("/api/firm/attention/suppress", headers=hdr(B_OWNER),
                 json={"client_id": ORG_A1, "kind": "CASH_RUNWAY", "reason": "B's own decision"})
    assert r.status_code == 200, r.text
    b_row = next(x for x in world.rows("firm_attention_suppressions") if x["id"] == r.json()["suppression"]["id"])
    assert b_row["firm_id"] == FIRM_B and b_row["dismissed_by"] == B_OWNER
    assert [x["id"] for x in y_viewer.select("firm_attention_suppressions", filters={"org_id": "eq." + ORG_A1})] == [b_row["id"]]
    r = app.get("/api/firm/attention/suppressions", headers=hdr(B_VIEWER))
    assert [x["id"] for x in r.json()["suppressions"] if x["org_id"] == ORG_A1] == [b_row["id"]]


def test_d3_the_era_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened(
        app, world, monkeypatch):
    """Either wall alone leaves firm B nothing of firm A's suppressions
    and covenants: with both read policies loosened to `true`, the route's
    own pin (`current_era_rows`) still drops A's rows; with the route's
    pin removed, RLS alone still answers nothing; with both removed the
    SAME reads carry A's era — which is what proves the silences were the
    pins. After the repair this reds on (TC-11): A's era reaching B with
    either pin standing; or NOT reaching B with both removed."""
    from engine.api import _firm_attention as FAT
    assert _seed_a_era_missing_file_suppression(world)["firm_id"] == FIRM_A
    _reattach_a1_to_firm_b(app, world)
    # RLS loosened, route pin standing
    world.plant_policy("firm_attention_suppressions", "true")
    world.plant_policy("firm_covenants", "true")
    r = _board(app, B_VIEWER, ORG_A1)
    assert r.status_code == 200 and not _a_era_hits(r.text) and not _covenant_declared(r), (
        "D3 VIOLATED at the route alone: %s" % _a_era_hits(r.text))
    r = app.get("/api/firm/attention/suppressions", headers=hdr(B_VIEWER))
    assert not _a_era_hits(r.text), "D3 VIOLATED at the route alone (list): %s" % _a_era_hits(r.text)
    # route pin removed, RLS standing
    fresh = FirmWorld(_sql_text(), _sibling_sql_texts())
    for table in ("firm_attention_suppressions", "firm_covenants"):
        world.policies[table] = fresh.policies[table]
    monkeypatch.setattr(FAT, "current_era_rows", lambda rows, firm_by_org, table: list(rows))
    r = _board(app, B_VIEWER, ORG_A1)
    assert r.status_code == 200 and not _a_era_hits(r.text) and not _covenant_declared(r), (
        "D3 VIOLATED at the RLS wall alone: %s" % _a_era_hits(r.text))
    r = app.get("/api/firm/attention/suppressions", headers=hdr(B_VIEWER))
    assert not _a_era_hits(r.text), "D3 VIOLATED at the RLS wall alone (list): %s" % _a_era_hits(r.text)
    # both removed: the leak, deliberately
    world.plant_policy("firm_attention_suppressions", "true")
    world.plant_policy("firm_covenants", "true")
    r = _board(app, B_VIEWER, ORG_A1)
    assert _covenant_declared(r) and A_ACCOUNTANT in json.dumps(r.json()["suppression_audit"]), (
        "with both pins removed firm B must compute over firm A's covenant and apply A's "
        "suppression — otherwise the assertions above passed for a reason other than the pins: %s"
        % r.text[:400])
    r = app.get("/api/firm/attention/suppressions", headers=hdr(B_VIEWER))
    assert SECRET_SUPPRESSION in r.text and A_ACCOUNTANT in r.text


def _minted_link(world, request_id):  # type: (FirmWorld, str) -> str
    """A REAL signed link for a seeded request row: the token minted under
    the suite's signing key, its hash written where the landing looks."""
    row = next(x for x in world.rows("firm_file_requests") if x["id"] == request_id)
    claims = _firm_requests.TokenClaims(request_id=request_id, client_org_id=str(row["client_org_id"]),
                                        period_end=str(row["period_end"])[:10], nonce="d3-%s" % request_id[-4:],
                                        expires_at="2026-12-31T00:00:00+00:00")
    token = _firm_requests.mint_token(claims, _firm_requests.signing_key())
    row["token_hash"] = _firm_requests.token_hash(token)
    return token


def test_d3_a_signed_request_link_dies_when_the_firm_that_minted_it_no_longer_serves_the_client(
        app, world, monkeypatch):
    """D3 (critic: "firm A's signed link still resolves after the move").
    A signed link is not an era pin. Firm A's open request on the client
    resolves (positive control) — and answers 410 the moment the client
    is detached, and still 410 once firm B serves it; the upload landing
    answers the same 410 and lands nothing. A request the workspace's own
    member minted with NO firm outlives any firm. Re-attached to A, the
    link resolves again: nothing was revoked, the era simply moved. After
    the repair this reds on (TC-11): a firm-minted link resolving or
    landing a file while another firm (or no firm) serves the client; a
    no-firm link dying with the firm; a link staying dead after the client
    returns to the firm that minted it."""
    monkeypatch.setattr(_firm_requests, "_now",
                        lambda: datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc))
    token_a = _minted_link(world, REQUEST_A1)
    own = world.add("firm_file_requests", {
        "firm_id": None, "client_org_id": ORG_A1, "period_end": "2026-02-28",
        "requested_by": A_OWNER, "requested_at": world.now_iso(),
        "expires_at": "2026-12-31T00:00:00+00:00", "token_hash": "pending",
        "status": _firm_requests.STATUS_REQUESTED, "reminder_count": 0, "reminders_sent": [],
        "refusal_count": 0, "expected_identity": {"name": "Client A1"}})
    token_own = _minted_link(world, own["id"])
    upload = {"file": ("balanta.csv", b"cont,nume\n", "text/csv")}
    # positive control: both links resolve while firm A serves the client
    r = app.get("/api/firm/requests/resolve/%s" % token_a)
    assert r.status_code == 200 and r.json()["client_name"] == "Client A1", r.text
    assert app.get("/api/firm/requests/resolve/%s" % token_own).status_code == 200
    # detached: firm A no longer serves the client — its link is dead, the client's own is not
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_A, ORG_A1), headers=hdr(A_OWNER))
    assert r.status_code == 200
    r = app.get("/api/firm/requests/resolve/%s" % token_a)
    assert r.status_code == 410 and "no longer serves this client" in r.text, (
        "D3 VIOLATED — firm A's signed link resolved after the client left firm A: %s %s"
        % (r.status_code, r.text))
    assert app.get("/api/firm/requests/resolve/%s" % token_own).status_code == 200
    # served by firm B now: still dead, and the landing lands nothing
    world.add("memberships", {"user_id": B_OWNER, "org_id": ORG_A1, "role": "owner"})
    assert app.post("/api/firm/%s/clients/attach" % FIRM_B, headers=hdr(B_OWNER),
                    json={"org_id": ORG_A1}).status_code == 200
    r = app.get("/api/firm/requests/resolve/%s" % token_a)
    assert r.status_code == 410 and "no longer serves this client" in r.text, (r.status_code, r.text)
    docs_before = len(world.rows("documents"))
    r = app.post("/api/firm/requests/%s/upload" % token_a, files=upload)
    assert r.status_code == 410, (r.status_code, r.text)
    assert len(world.rows("documents")) == docs_before, "the dead link landed a file"
    row = next(x for x in world.rows("firm_file_requests") if x["id"] == REQUEST_A1)
    assert row["status"] == _firm_requests.STATUS_REQUESTED and row["consumed_at"] is None
    assert app.get("/api/firm/requests/resolve/%s" % token_own).status_code == 200
    # back with firm A: the link resolves again — nothing was revoked, the era moved
    r = app.post("/api/firm/%s/clients/%s/detach" % (FIRM_B, ORG_A1), headers=hdr(B_OWNER))
    assert r.status_code == 200
    assert app.post("/api/firm/%s/clients/attach" % FIRM_A, headers=hdr(A_OWNER),
                    json={"org_id": ORG_A1}).status_code == 200
    r = app.get("/api/firm/requests/resolve/%s" % token_a)
    assert r.status_code == 200 and r.json()["client_name"] == "Client A1", (r.status_code, r.text)


# ── W4: identity on every route; the double's fidelity in both directions ──

GARBAGE_BEARERS = ("Bearer not-a-jwt", "Bearer a.b", "Bearer %s" % "x" * 40,
                   "Bearer " + base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=") + ".e30.sig")


def test_w4_the_double_refuses_an_undecodable_jwt_in_both_directions(world):
    """FIDELITY (W4). The double used to alias an undecodable JWT to the
    service role — a garbage bearer read EVERYTHING, so a route with no
    identity check passed as if it had one. Both directions are pinned:
    an undecodable bearer is `anon` (nothing visible, nothing writable,
    no RPC), a decodable one sees its rows, and only `admin()` is the
    service role."""
    for bearer in GARBAGE_BEARERS:
        client = _supabase_module.per_user(bearer.split(" ", 1)[1])
        assert client.service_role is False and client.uid is None, bearer
        assert not client.get_user(bearer.split(" ", 1)[1]).get("id"), bearer
        for table in ("firm_attention_suppressions", "firm_file_requests", "organizations",
                      "financial_periods", "firm_client_cadence", "firm_briefs", "firm_memberships"):
            assert client.select(table) == [], (bearer, table)
        with pytest.raises(RuntimeError):
            client.insert("firm_attention_suppressions", {"org_id": ORG_A1, "kind": "CASH_RUNWAY",
                                                          "scope_key": "*", "reason": "x"})
        with pytest.raises(RuntimeError):
            client.rpc("create_firm", {"p_name": "Ghost"})
    decodable = _supabase_module.per_user(_jwt(A_VIEWER, EMAILS[A_VIEWER]))
    assert decodable.service_role is False and decodable.uid == A_VIEWER
    assert [r["reason"] for r in decodable.select("firm_attention_suppressions")] == [SECRET_SUPPRESSION]
    service = _supabase_module.admin()
    assert service.service_role is True and service.uid is None
    assert len(service.select("firm_attention_suppressions")) == 1


#: Every swept route, filled for firm A's client, for the identity sweep.
IDENTITY_SWEEP = (
    [("read:" + p, m, _fill(p, firm_id=FIRM_A, org_id=ORG_A1, user_id=A_VIEWER, invitation_id=INVITATION_A),
      None, (dict((k, (_fill(v, org_id=ORG_A1) if isinstance(v, str) else v)) for k, v in b.items())
             if b is not None else None))
     for m, p, b in CROSS_FIRM_ROUTES]
    + [("cockpit:" + i, m, _fill(p, request_id=REQUEST_A1),
        (dict((k, _fill(v, firm=FIRM_A, org=ORG_A1)) for k, v in q.items()) if q else None),
        (dict((k, (_fill(v, firm=FIRM_A, org=ORG_A1) if isinstance(v, str) else v)) for k, v in b.items())
         if b else None))
       for i, m, p, q, b, _n in COCKPIT_ROUTES]
    + [("attention:" + i, m, p,
        (dict((k, _fill(v, org=ORG_A1)) for k, v in q.items()) if q else None),
        (dict((k, (_fill(v, org=ORG_A1) if isinstance(v, str) else v)) for k, v in b.items()) if b else None))
       for i, m, p, q, b in ATTENTION_ROUTES]
    + [("write:" + w["id"], w["method"], w["url"], w["query"], w["body"]) for w in WRITE_ROUTES]
    + [("capsule:" + t, "POST", "/api/capsule/tools/%s" % t, None, {"args": CAPSULE_TOOL_CENSUS[t][1]})
       for t in sorted(CAPSULE_TOOL_CENSUS)]
)


@pytest.mark.parametrize("route_id,method,url,query,body", IDENTITY_SWEEP, ids=[r[0] for r in IDENTITY_SWEEP])
def test_w4_every_swept_route_refuses_a_bearer_it_cannot_read_with_401(app, world, route_id, method, url,
                                                                       query, body):
    """IDENTITY (W4). A bearer that passes the `startswith("bearer ")`
    shape test but is not a JWT this backend can read is 401 on EVERY
    route that serves or moves client data — before any read, with no
    marker and nothing moved. GET /attention/suppressions was the one
    route with no identity check; the double's aliasing hid it."""
    snapshot = json.dumps(world.tables, sort_keys=True, default=str)
    for bearer in GARBAGE_BEARERS:
        headers = {"Authorization": bearer, "X-Org-Id": ORG_A1}
        r = app.request(method, url, params=query, headers=headers, json=body)
        assert r.status_code == 401, (route_id, bearer[:24], r.status_code, r.text[:300])
        _no_marker(route_id, r, "garbage-bearer", "identity")
    assert json.dumps(world.tables, sort_keys=True, default=str) == snapshot, (
        "a bearer with no identity moved a row through %s" % route_id)


def test_w4_the_suppressions_route_checks_identity_like_its_siblings(app, world):
    """The route the critics named: a garbage JWT used to answer 200 with
    every suppression (through the double's service-role aliasing). Now
    401 at the route; and the positive control still reads the marker."""
    r = app.get("/api/firm/attention/suppressions", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and SECRET_SUPPRESSION not in r.text, r.text
    r = app.get("/api/firm/attention/suppressions", headers=hdr(A_VIEWER))
    assert r.status_code == 200 and SECRET_SUPPRESSION in r.text
    r = app.get("/api/firm/attention/suppressions", headers=hdr(B_OWNER))
    assert r.status_code == 200 and SECRET_SUPPRESSION not in r.text
    source = (REPO / "src" / "engine" / "api" / "_firm_attention.py").read_text(encoding="utf-8")
    route = source[source.index('@router.get("/suppressions")'):source.index('@router.post("/suppress")')]
    assert "_org.resolve_user_id(jwt)" in route, "the identity check left the suppressions route"
