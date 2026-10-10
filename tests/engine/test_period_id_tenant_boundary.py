"""`documents.period_id` is browser-written; a service-role operation may
not act on the period it names without checking whose period it is.

THE DEFECT (P0, 2026-09-09 — the storage-path bug's twin, found by
sweeping for the pattern after fixing that one).

`documents` RLS is `is_member_of(org_id)` for INSERT/UPDATE with NO column
restriction (supabase/schema_phase3.sql:209-212), and
frontend/lib/supabase.ts inserts the row from the browser including
`period_id`. The FK `documents.period_id -> financial_periods(id)` is
EXISTENCE-only; nothing constrains it to the same organization.

The write wall `_verify_user_may_write_document` validates membership in
the DOCUMENT's org and never looks at `period_id`. So a row filed in your
own workspace carrying another workspace's period id walked through it,
and then:

  · POST /api/documents/{id}/make-active  hard-deleted that period's
    statement_line_items, calculated_metrics, briefings and valuations,
    nulled assembled_canonical_v1 and re-pointed source_document_id at
    the attacker's file;
  · POST /api/pipeline/retry              deleted the financial_periods
    row outright, cascading its derivatives away.

A firm viewer holding only a read cell has every client period id by
design (schema_phase_firm.sql), so the adversary is exactly the one the
write wall was written for.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · `_period_row` losing its required `org_id`, or accepting a period
    whose org differs from the caller's
  · a service-role delete of `financial_periods` filtered by id alone
  · a new call site fetching a period by a caller-supplied id without
    naming the tenant
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from engine.api import _period_move
from engine.api._period_move import MoveRefused, _period_row, make_document_active

MINE = "11111111-1111-1111-1111-111111111111"
THEIRS = "22222222-2222-2222-2222-222222222222"
SRC = Path(__file__).parents[2] / "src" / "engine" / "api"


class _Client:
    """Records what a service-role client would have been asked to do."""

    def __init__(self, period):
        self._period = period
        self.deletes = []
        self.updates = []

    def select(self, table, *, filters=None, columns="*", single=False, **_):
        if table == "financial_periods":
            return [self._period] if self._period else []
        return []

    def delete(self, table, *, filters=None):
        self.deletes.append((table, dict(filters or {})))

    def update(self, table, patch, *, filters=None):
        self.updates.append((table, dict(patch), dict(filters or {})))


VICTIM_PERIOD = {
    "id": "period-belonging-to-someone-else",
    "org_id": THEIRS,
    "period_end": "2025-12-31",
    "source_document_id": "their-doc",
    "assembled_canonical_v1": {"real": "analysis"},
}

MY_DOC_POINTING_AT_THEIRS = {
    "id": "my-doc",
    "org_id": MINE,                       # the wall checks THIS and passes
    "period_id": VICTIM_PERIOD["id"],     # ...and never checked THIS
}


# ── the attack ──────────────────────────────────────────────────────

#: The ONE answer a correction gives a pin that names another company's
#: period AND a pin that names nothing — stated here, never read from the
#: module: the refusal must not tell a caller holding a UUID that it is some
#: other tenant's (re-verification 2026-10-10; until then the foreign pin
#: answered `period_not_in_workspace` / "That period belongs to a different
#: workspace.", the missing one `period_missing`).
ONE_ANSWER = ("period_missing", "The file's period no longer exists.")


def test_make_active_refuses_a_period_in_another_workspace():
    client = _Client(VICTIM_PERIOD)
    with pytest.raises(MoveRefused) as e:
        make_document_active(client, document=MY_DOC_POINTING_AT_THEIRS,
                             now="2026-09-09T00:00:00Z")
    assert (e.value.code, e.value.message) == ONE_ANSWER
    assert "workspace" not in e.value.message.lower()
    # The refusal must happen BEFORE anything is written.
    assert client.deletes == [], (
        "refused, but derived tables were already deleted: %s" % (client.deletes,)
    )
    assert client.updates == [], (
        "refused, but the period was already re-pointed: %s" % (client.updates,)
    )


def test_make_active_still_works_inside_my_own_workspace():
    """The guard must not break the legitimate correction path."""
    mine = dict(VICTIM_PERIOD, org_id=MINE)
    client = _Client(mine)
    record = make_document_active(client, document=MY_DOC_POINTING_AT_THEIRS,
                                  now="2026-09-09T00:00:00Z")
    assert record["changed"] is True
    assert [t for t, _f in client.deletes] == list(_period_move._DERIVED_TABLES)
    assert client.updates, "the period should have been re-pointed"


def test_period_row_refuses_a_foreign_period_and_allows_my_own():
    client = _Client(VICTIM_PERIOD)
    with pytest.raises(MoveRefused):
        _period_row(client, VICTIM_PERIOD["id"], org_id=MINE)
    assert _period_row(_Client(dict(VICTIM_PERIOD, org_id=MINE)),
                       VICTIM_PERIOD["id"], org_id=MINE) is not None


@pytest.mark.parametrize("org", [None, "", "   "])
def test_an_absent_caller_org_refuses_rather_than_waving_through(org):
    """ABSENT is not a permit — the same rule as the storage guard."""
    with pytest.raises(MoveRefused):
        _period_row(_Client(VICTIM_PERIOD), VICTIM_PERIOD["id"], org_id=org)


def test_a_missing_period_is_still_reported_as_missing_not_as_foreign():
    assert _period_row(_Client(None), "nope", org_id=MINE) is None


_CORRECTIONS = {
    "make_active": lambda client, doc: make_document_active(client, document=doc, now="2026-10-10T00:00:00Z"),
    "move_period": lambda client, doc: _period_move.move_document_to_period(
        client, document=doc, target_period_end="2024-12", now="2026-10-10T00:00:00Z"),
}


@pytest.mark.parametrize("correction", sorted(_CORRECTIONS))
def test_a_foreign_pin_and_a_missing_pin_are_one_answer_at_every_correction(correction):
    """A pin to ANOTHER company's period and a pin that names NOTHING are
    refused with the same code and the same sentence, at `make-active` and
    at `move-period`, and nothing is written for either. (A move used to
    treat a pin that names nothing as "no period" and re-file the document;
    a foreign pin was refused with its own code — the two answers told them
    apart.) `_period_row` still returns None for a missing row: the callers
    turn it into the one answer."""
    answers = {}
    for what, period in (("foreign", VICTIM_PERIOD), ("missing", None)):
        client = _Client(period)
        with pytest.raises(MoveRefused) as e:
            _CORRECTIONS[correction](client, MY_DOC_POINTING_AT_THEIRS)
        answers[what] = (e.value.code, e.value.message)
        assert client.deletes == [] and client.updates == [], (correction, what, client.deletes, client.updates)
    assert answers["foreign"] == answers["missing"] == ONE_ANSWER, answers


# ── the seam cannot be re-opened ────────────────────────────────────

def test_period_row_requires_the_tenant_with_no_default():
    sig = inspect.signature(_period_row)
    p = sig.parameters["org_id"]
    assert p.kind is inspect.Parameter.KEYWORD_ONLY
    assert p.default is inspect.Parameter.empty, (
        "org_id acquired a default — a call site can now omit the tenant"
    )


def test_no_service_role_delete_of_a_period_is_filtered_by_id_alone():
    """Static sweep of pipeline.py. A service-role delete on
    `financial_periods` keyed only by an id the caller can influence is
    the retry-path defect; the org must be in the filter."""
    src = (SRC / "pipeline.py").read_text()
    tree = ast.parse(src)
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "delete"):
            continue
        if not node.args or not isinstance(node.args[0], ast.Constant):
            continue
        if node.args[0].value != "financial_periods":
            continue
        filters = next((k.value for k in node.keywords if k.arg == "filters"), None)
        rendered = ast.dump(filters) if filters is not None else ""
        if "org_id" not in rendered:
            offenders.append(f"pipeline.py:{node.lineno}")
    assert offenders == [], (
        "service-role delete of financial_periods filtered without org_id at "
        + ", ".join(offenders)
        + " — under the service role the filter IS the access control"
    )


def test_the_delete_sweep_is_not_vacuous():
    """TC-3: the walk must actually find the delete it is guarding."""
    src = (SRC / "pipeline.py").read_text()
    tree = ast.parse(src)
    found = sum(
        1 for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and n.func.attr == "delete" and n.args
        and isinstance(n.args[0], ast.Constant)
        and n.args[0].value == "financial_periods"
    )
    assert found >= 1, "no financial_periods delete found — the sweep guards nothing"


# ── Tenancy hotfix 2026-10-02: two more service-role reads keyed by a ─────
# browser-written column, found by sweeping for the valuation-override class.
#
# 1. `_period_move._live_siblings` read `documents` by `period_id` alone. A
#    row of ANOTHER workspace pointing at this period came back as a sibling,
#    was picked as the rebuild document (analysed, newest) and the victim's
#    period was wiped and re-pointed at it on the victim's own move.
# 2. POST /api/sales-datasets/{id}/rerun read `documents` by the dataset
#    row's `document_id` alone and signed the object against the foreign
#    document's OWN org — another workspace's workbook was downloaded and its
#    per-category DIO written into the caller's SKU rows.
#
# REDS ON, with the defects repaired (TC-11): either read losing `org_id`; a
# foreign row surviving when the store ignores the filter; a signed URL
# minted for a document outside the dataset's org.
# CANNOT SEE: the live row-level policies of `documents` / `sales_datasets`;
# the `_correction_rerun` branch that starts a run on an unreadable row.

class _DocStore:
    """A service-role stand-in over `documents` that HONOURS `eq.` /
    `is.null` filters (or, with `honour=False`, ignores them — the store
    must not be the only wall) and records every select."""

    def __init__(self, rows, honour=True):
        self.rows, self.honour, self.selects = rows, honour, []

    def select(self, table, *, filters=None, **_):
        self.selects.append((table, dict(filters or {})))
        if not self.honour:
            return [dict(r) for r in self.rows]
        out = []
        for r in self.rows:
            ok = True
            for k, v in (filters or {}).items():
                v = str(v)
                if v.startswith("eq.") and str(r.get(k)) != v[3:]:
                    ok = False
                if v == "is.null" and r.get(k) is not None:
                    ok = False
            if ok:
                out.append(dict(r))
        return out


PERIOD = "period-of-mine"
_PLANTED = {"id": "doc-planted", "org_id": THEIRS, "period_id": PERIOD, "deleted_at": None,
            "status": "analyzed", "updated_at": "2099-01-01T00:00:00Z"}
_GENUINE = {"id": "doc-sibling", "org_id": MINE, "period_id": PERIOD, "deleted_at": None,
            "status": "analyzed", "updated_at": "2025-01-01T00:00:00Z"}
_MOVED = {"id": "doc-moved", "org_id": MINE, "period_id": PERIOD, "deleted_at": None,
          "status": "analyzed", "updated_at": "2025-02-01T00:00:00Z"}
_FROM = {"id": PERIOD, "org_id": MINE}


@pytest.mark.parametrize("honour", [True, False])
def test_another_workspaces_document_is_never_a_sibling_of_my_period(honour):
    store = _DocStore([_PLANTED, _GENUINE, _MOVED], honour=honour)
    siblings = _period_move._live_siblings(store, _FROM, "doc-moved")
    assert [s["id"] for s in siblings] == ["doc-sibling"], siblings
    table, filters = store.selects[-1]
    assert table == "documents" and filters.get("org_id") == "eq.%s" % MINE, filters
    assert filters.get("period_id") == "eq.%s" % PERIOD


def test_a_planted_foreign_document_leaves_a_lone_period_with_no_sibling():
    """Without a genuine sibling the plan must be the honest one (no
    sibling → the period is deleted), not a rebuild from the plant."""
    store = _DocStore([_PLANTED, _MOVED])
    assert _period_move._live_siblings(store, _FROM, "doc-moved") == []
    assert _period_move.pick_rebuild_document([]) is None


def _sales_world(monkeypatch, document_org):
    """The real router; a dataset of MINE whose `document_id` names a
    document of `document_org`. Records admin selects and signed URLs."""
    import contextlib

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.api import pipeline as P

    tables = {
        "sales_datasets": [{"id": "ds-1", "org_id": MINE, "document_id": "doc-wb"}],
        "documents": [{"id": "doc-wb", "org_id": document_org,
                       "storage_path": "%s/workbook.xlsx" % document_org, "deleted_at": None}],
        "sku_aggregates": [{"id": "agg-1", "dataset_id": "ds-1", "product_name": "SKU 1", "category": "CAT",
                            "niv_krn": 100.0, "gm_krn": 30.0, "days_inventory_on_hand": None}],
    }
    seen = {"selects": [], "signed": [], "updates": []}

    class _Admin:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def select(self, table, *, filters=None, **_):
            seen["selects"].append((table, dict(filters or {})))
            return _DocStore(tables.get(table, [])).select(table, filters=filters)

        def signed_url(self, bucket, path, *, org_id, expires_in=300):
            seen["signed"].append({"path": path, "org_id": org_id})
            return "https://storage.invalid/%s" % path

        def update(self, table, patch, *, filters=None):
            seen["updates"].append((table, dict(patch)))

    monkeypatch.setattr(P._supabase, "admin", lambda *a, **k: _Admin())
    monkeypatch.setattr(P._supabase, "per_user", lambda *a, **k: _Admin())
    monkeypatch.setattr(P._org, "verified_user_id", lambda jwt: "user-mine")
    monkeypatch.setattr(P._org, "require_org_member", lambda jwt, org_id: "user-mine")

    def _no_network(url, **_):
        raise RuntimeError("the test fetches nothing")
    monkeypatch.setattr(P.httpx, "get", _no_network)
    app = FastAPI()
    app.include_router(P.build_router())
    resp = TestClient(app).post("/api/sales-datasets/ds-1/rerun", headers={"Authorization": "Bearer t"})
    return resp, seen


def test_a_dataset_pointing_at_another_workspaces_document_signs_nothing(monkeypatch):
    resp, seen = _sales_world(monkeypatch, THEIRS)
    assert resp.status_code == 200, resp.text[:300]
    assert seen["signed"] == [], "a signed URL was minted for another workspace's file: %s" % seen["signed"]
    doc_reads = [f for t, f in seen["selects"] if t == "documents"]
    assert doc_reads and all(f.get("org_id") == "eq.%s" % MINE for f in doc_reads), doc_reads
    assert not any("days_inventory_on_hand" in patch for _t, patch in seen["updates"])


def test_a_dataset_in_its_own_workspace_still_signs_its_own_workbook(monkeypatch):
    """The positive control: the fix must not stop the legitimate re-extract."""
    resp, seen = _sales_world(monkeypatch, MINE)
    assert resp.status_code == 200, resp.text[:300]
    assert seen["signed"] == [{"path": "%s/workbook.xlsx" % MINE, "org_id": MINE}], seen["signed"]


# ── Re-verification 2026-10-10: a third service-role write keyed by the ─────
# browser-written pin, pre-existing and untouched by the re-run lane.
#
# `DELETE /api/period/{id}` ("Clear period") read the documents attached to
# the period by `period_id` ALONE and soft-deleted each by id alone. A member
# of ANOTHER company can pin their own row to this period (the pin's foreign
# key asks only that the period exist): that row was soft-deleted by this
# company's action, counted in the answer, and — thirty days later — purged.
# Measured on the real app over the test double (gate rerun-data-loss, O16);
# here the route is held to the FILTER and the RE-CHECK, with a store that
# honours the filter and one that ignores it (the store must not be the only
# wall).
#
# REDS ON, with the defect repaired (TC-11): the attached-documents read
# losing `org_id`; a foreign row surviving the read and being written; an
# update of a document that does not name the company; the answer counting
# the foreign row.

def _clear_period_world(monkeypatch, honour):
    """The real router; `financial_periods` holds the period of MINE; two
    documents are pinned to it — one of MINE, one of THEIRS."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.api import pipeline as P

    tables = {
        "financial_periods": [{"id": PERIOD, "org_id": MINE, "period_end": "2025-12-31",
                               "source_document_id": "doc-mine"}],
        "documents": [{"id": "doc-mine", "org_id": MINE, "period_id": PERIOD, "deleted_at": None},
                      {"id": "doc-planted", "org_id": THEIRS, "period_id": PERIOD, "deleted_at": None}],
        "organizations": [{"id": MINE, "archived_at": None}],
    }
    seen = {"selects": [], "updates": [], "deletes": []}

    class _Admin:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def select(self, table, *, filters=None, **_):
            seen["selects"].append((table, dict(filters or {})))
            return _DocStore(tables.get(table, []), honour=honour).select(table, filters=filters)

        def update(self, table, patch, *, filters=None):
            seen["updates"].append((table, dict(patch), dict(filters or {})))

        def delete(self, table, *, filters=None):
            seen["deletes"].append((table, dict(filters or {})))

    monkeypatch.setattr(P._supabase, "admin", lambda *a, **k: _Admin())
    monkeypatch.setattr(P._supabase, "per_user", lambda *a, **k: _Admin())
    monkeypatch.setattr(P._org, "verified_user_id", lambda jwt: "user-mine")
    monkeypatch.setattr(P._org, "require_org_member", lambda jwt, org_id: "user-mine")
    app = FastAPI()
    app.include_router(P.build_router())
    resp = TestClient(app).delete("/api/period/%s" % PERIOD, headers={"Authorization": "Bearer t"})
    return resp, seen


@pytest.mark.parametrize("honour", [True, False])
def test_clearing_a_period_soft_deletes_only_this_companys_documents(monkeypatch, honour):
    resp, seen = _clear_period_world(monkeypatch, honour)
    assert resp.status_code == 200, resp.text[:300]
    assert resp.json()["documents_soft_deleted"] == 1, resp.json()
    attached_reads = [f for t, f in seen["selects"] if t == "documents"]
    assert attached_reads and all(f.get("org_id") == "eq.%s" % MINE and f.get("period_id") == "eq.%s" % PERIOD
                                  for f in attached_reads), attached_reads
    on_documents = [(patch, f) for t, patch, f in seen["updates"] if t == "documents"]
    assert [f.get("id") for _p, f in on_documents] == ["eq.doc-mine"], (
        "another company's document was written: %r" % on_documents)
    assert all(f.get("org_id") == "eq.%s" % MINE for _p, f in on_documents), on_documents
    assert all(patch.get("deleted_at") and patch.get("period_id") is None for patch, _f in on_documents)
    assert ("financial_periods", {"id": "eq.%s" % PERIOD, "org_id": "eq.%s" % MINE}) in seen["deletes"]
