"""CAEN COMES FROM `organizations`, ON EVERY SURFACE — and no test double
may invent a column the database does not declare.

WHAT HAPPENED
=============
`schema_phase7_benchmarks.sql:17` put `caen_code` on `organizations`.
`financial_periods` has never carried it. THREE surfaces read it off a
`financial_periods` row anyway, and each failed differently:

  · `_radar.light_input` — `select=*`, so PostgREST answered 200 with the
    key absent. Every served radar finding ran `caen=None`,
    industry-unqualified, silently.
  · `_capsule_tools._context` — the same shape, the same silence, on a
    router mounted UNCONDITIONALLY. Every Capsule finding too. LIVE.
  · `_firm_attention.LIGHT_PERIOD_COLUMNS` — an EXPLICIT projection, so
    PostgREST answers `400 42703`, which `classify_read_error` grades
    `bad_column` and `get_board` turns into a **500 for the whole
    attention board**. Latent only because FIRM_COCKPIT_ENABLED is unset.

None of it was caught, because `firm_postgrest_double.py` hand-wrote the
`financial_periods` column list and invented THREE columns the table does
not have — `period_label`, `status`, `caen_code`. The double answered 200
where production answers 400, and `test_firm_route.py` then asserted the
fabricated value came back: a green gate pinning the defect as the
contract.

WHAT THIS REDS ON (TC-11)
  · any module naming `caen_code` in a projection against
    `financial_periods`, or reading it off a row from that table;
  · a test double declaring a column no migration adds;
  · the two hand-written column maps drifting from each other;
  · `_org.caen_for_org` reading anything but `organizations`.
WHAT IT CANNOT SEE
  · whether the CAEN on an org is the RIGHT code. Nothing in a repo can
    know that.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SUPABASE = REPO / "supabase"
ENGINE = REPO / "src" / "engine"


def _declared_columns(table):
    """Every column any migration declares for `table`, parsed from the
    real SQL — never a hand-written list, which is the defect."""
    cols = set()
    create = re.compile(
        r"create\s+table\s+(?:if\s+not\s+exists\s+)?%s\s*\((.*?)\n\)\s*;" % table,
        re.IGNORECASE | re.DOTALL)
    alter = re.compile(
        r"alter\s+table\s+(?:if\s+exists\s+)?%s\s+(.*?);" % table,
        re.IGNORECASE | re.DOTALL)
    for path in sorted(SUPABASE.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for body in create.findall(text):
            for line in body.split("\n"):
                line = line.strip().strip(",")
                if not line or line.startswith("--"):
                    continue
                head = line.split()[0].lower()
                if head in ("primary", "unique", "check", "constraint", "foreign"):
                    continue
                cols.add(head)
        for body in alter.findall(text):
            for m in re.finditer(r"add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)",
                                 body, re.IGNORECASE):
                cols.add(m.group(1).lower())
    return cols


@pytest.fixture(scope="module")
def period_columns():
    cols = _declared_columns("financial_periods")
    assert "org_id" in cols and "period_end" in cols, (
        "the SQL parser found nothing — this gate would pass vacuously: %s" % sorted(cols))
    return cols


def test_the_schema_says_what_it_says(period_columns):
    """The measurement the rest of this file stands on. RED ON: the parse
    collapsing, or a migration finally adding one of the three."""
    assert "caen_code" in _declared_columns("organizations")
    for phantom in ("caen_code", "period_label", "status"):
        assert phantom not in period_columns, (
            "financial_periods now declares %r — if a migration added it, "
            "this whole file needs rereading, not deleting" % phantom)


def test_no_module_names_caen_code_in_a_financial_periods_projection():
    """RED ON: an explicit projection naming the column — the shape that
    500s the entire Firm Attention board rather than returning None."""
    offenders = []
    for path in sorted(ENGINE.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if "caen_code" not in text:
            continue
        for m in re.finditer(r"^([A-Z_]*PERIOD[A-Z_]*COLUMNS)\s*=\s*\((.*?)\)",
                             text, re.DOTALL | re.MULTILINE):
            if "caen_code" in m.group(2):
                offenders.append("%s:%s" % (path.relative_to(REPO), m.group(1)))
    assert offenders == [], (
        "these projections name caen_code against financial_periods, which "
        "answers 400 42703 and becomes a 500: %s" % offenders)


def test_caen_is_read_from_the_org_and_from_one_place():
    """RED ON: a second implementation appearing. Three surfaces read this
    and they must not drift again."""
    from engine.api import _org

    src = (ENGINE / "api" / "_org.py").read_text(encoding="utf-8")
    assert "TABLE_ORGS" in src and 'TABLE_ORGS = "organizations"' in src
    assert "caen_code" in _org.CAEN_COLUMNS

    class _Client(object):
        def __init__(self):
            self.calls = []

        def select(self, table, filters=None, columns=None, limit=None):
            self.calls.append((table, dict(filters or {}), columns))
            return [{"id": "org-7", "caen_code": "1013"}]

    client = _Client()
    assert _org.caen_for_org(client, "org-7") == "1013"
    table, filters, columns = client.calls[0]
    assert table == "organizations", table
    assert filters == {"id": "eq.org-7"}
    assert "caen_code" in columns


def test_an_absent_or_blank_caen_is_absent():
    """RED ON: `""` reaching the engine as an industry code."""
    from engine.api import _org

    class _Rows(object):
        def __init__(self, rows):
            self.rows = rows

        def select(self, *a, **kw):
            return self.rows

    for rows in ([{"caen_code": None}], [{"caen_code": "   "}], []):
        assert _org.caen_for_org(_Rows(rows), "o") is None
    assert _org.caen_of_org_row({"caen_code": "  "}) is None
    assert _org.caen_of_org_row(None) is None
    assert _org.caen_of_org_row({"caen_code": "5610"}) == "5610"


def test_a_failed_lookup_does_not_take_the_payload_down():
    """RED ON: a classification raising a 500."""
    from engine.api import _org

    class _Boom(object):
        def select(self, *a, **kw):
            raise RuntimeError("RLS said no")

    assert _org.caen_for_org(_Boom(), "o") is None


# ── the doubles ──────────────────────────────────────────────────────────


def _double_columns(path, table):
    text = path.read_text(encoding="utf-8")
    m = re.search(r'"%s":\s*\[(.*?)\]' % table, text, re.DOTALL)
    assert m, "no %s column list in %s" % (table, path.name)
    return set(re.findall(r'"([^"]+)"', m.group(1)))


DOUBLES = (
    Path("tests/engine/firm_postgrest_double.py"),
    Path("tests/engine/test_firm_tenancy.py"),
)


@pytest.mark.parametrize("rel", DOUBLES, ids=lambda p: p.name)
def test_a_double_never_declares_a_column_the_table_does_not_have(rel, period_columns):
    """THE ROOT CAUSE. A double that invents a column answers 200 where
    production answers 400 — the fake-store failure mode with a narrower
    blast radius, and it hid a 500 on a whole board.

    RED ON: any column in a hand-written map that no migration declares.
    """
    declared = _double_columns(REPO / rel, "financial_periods")
    invented = sorted(declared - period_columns)
    assert invented == [], (
        "%s declares %s on financial_periods; no migration adds them, so "
        "this double answers 200 where PostgREST answers 400 42703"
        % (rel.name, invented))


def test_the_two_column_maps_agree_with_the_schema(period_columns):
    """RED ON: the two hand-written copies drifting apart. They invented
    the same three columns independently, which is how a double comes to
    disagree with the database twice over."""
    a = _double_columns(REPO / DOUBLES[0], "financial_periods")
    b = _double_columns(REPO / DOUBLES[1], "financial_periods")
    assert a == b, "the two doubles disagree: %s" % sorted(a ^ b)
    assert a <= period_columns
