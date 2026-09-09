"""A service-role storage call may not touch another tenant's object.

THE DEFECT (P0, found 2026-09-09 while ingesting a real client's books):
`documents.storage_path` is written by the BROWSER. RLS on the `documents`
table constrains which org a row may be filed under, and the storage
bucket's own policy binds the first path segment to `is_member_of(...)`.
But the engine signs and deletes with the SERVICE ROLE, which bypasses
storage RLS entirely, and it read the path straight off the row without
ever comparing it to that row's `org_id`. Filing a row in your own
workspace whose `storage_path` pointed into another workspace's folder
therefore minted a signed URL to their raw trial balance, and the
permanent-delete path destroyed it. Neither id is secret — both travel in
URLs the user sees.

THE FIX is a required keyword, not a check a caller may remember: every
storage method on SupabaseClient takes `org_id` with no default, so a new
call site cannot compile without declaring whose object it is.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · `assert_tenant_path` accepting a path whose first segment is not the
    declared org (including "" and "..", the traversal shapes)
  · a storage method regaining a default for `org_id`, or dropping the
    assertion
  · a production call site calling one of them without `org_id`
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from engine.api import _supabase
from engine.api._supabase import (
    CrossTenantStoragePath,
    SupabaseClient,
    assert_tenant_path,
)

MINE = "11111111-1111-1111-1111-111111111111"
THEIRS = "22222222-2222-2222-2222-222222222222"
SRC = Path(__file__).parents[2] / "src" / "engine" / "api"
SCRIPTS = Path(__file__).parents[2] / "scripts"
STORAGE_METHODS = ("signed_url", "upload_object", "delete_object")


# ── the validator itself ────────────────────────────────────────────

def test_a_path_in_my_own_org_is_allowed():
    assert_tenant_path("documents", f"{MINE}/uploads/doc.xlsx", MINE, op="sign") is None


@pytest.mark.parametrize("op", ["sign", "upload", "delete"])
def test_another_orgs_path_is_refused_for_every_operation(op):
    with pytest.raises(CrossTenantStoragePath) as e:
        assert_tenant_path("documents", f"{THEIRS}/uploads/doc.xlsx", MINE, op=op)
    # The message must name the operation and both ids, or an operator
    # reading the log cannot tell what was attempted against whom.
    assert op in str(e.value)
    assert THEIRS in str(e.value) and MINE in str(e.value)


@pytest.mark.parametrize("path", [
    "",                                   # empty
    "/uploads/x.xlsx",                    # leading slash -> empty first segment
    f"../{THEIRS}/uploads/x.xlsx",        # traversal
    f"..%2F{THEIRS}/uploads/x.xlsx",      # encoded traversal
    "uploads/x.xlsx",                     # no org segment at all
    f"{MINE}extra/uploads/x.xlsx",        # prefix collision, not equality
])
def test_malformed_and_traversal_paths_are_refused(path):
    with pytest.raises(CrossTenantStoragePath):
        assert_tenant_path("documents", path, MINE, op="sign")


@pytest.mark.parametrize("org", [None, "", "   "])
def test_an_absent_owner_refuses_rather_than_waving_through(org):
    """ABSENT is not a permit. A row whose org_id failed to load must not
    become a free pass to sign anything."""
    with pytest.raises(CrossTenantStoragePath):
        assert_tenant_path("documents", f"{MINE}/uploads/x.xlsx", org, op="sign")


def test_a_bucket_that_is_not_tenant_scoped_is_left_alone():
    assert _supabase.TENANT_SCOPED_BUCKETS == frozenset({"documents"})
    assert assert_tenant_path("some-other-bucket", "anything/at/all", None,
                              op="sign") is None


# ── the seam cannot be re-opened ────────────────────────────────────

@pytest.mark.parametrize("method", STORAGE_METHODS)
def test_org_id_is_required_with_no_default(method):
    """A default would let a call site silently inherit "no tenant"."""
    sig = inspect.signature(getattr(SupabaseClient, method))
    assert "org_id" in sig.parameters, f"{method} lost its org_id parameter"
    p = sig.parameters["org_id"]
    assert p.kind is inspect.Parameter.KEYWORD_ONLY, f"{method}: org_id must be keyword-only"
    assert p.default is inspect.Parameter.empty, (
        f"{method}: org_id acquired a default ({p.default!r}) — a call site "
        f"can now omit the tenant and the assertion becomes advisory"
    )


@pytest.mark.parametrize("method", STORAGE_METHODS)
def test_each_storage_method_actually_calls_the_assertion(method):
    src = inspect.getsource(getattr(SupabaseClient, method))
    assert "assert_tenant_path(" in src, (
        f"{method} no longer calls assert_tenant_path — the required keyword "
        f"is then decoration, not enforcement"
    )


def _storage_calls_missing_org(path: Path):
    """Every `.signed_url(...)`/`.upload_object(...)`/`.delete_object(...)`
    call in `path` that does not pass org_id."""
    tree = ast.parse(path.read_text())
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not isinstance(fn, ast.Attribute) or fn.attr not in STORAGE_METHODS:
            continue
        if not any(k.arg == "org_id" for k in node.keywords):
            out.append(f"{path.name}:{node.lineno} .{fn.attr}(...)")
    return out


def test_no_production_call_site_omits_the_tenant():
    """Static sweep. The signature makes omission a TypeError at runtime,
    but a path that only runs on a rare branch would find that out in
    production; this finds it now."""
    offenders = []
    for f in sorted(SRC.glob("*.py")) + sorted(SCRIPTS.glob("*.py")):
        if f.name == "_supabase.py":
            continue  # the definitions themselves
        offenders += _storage_calls_missing_org(f)
    assert offenders == [], (
        "these storage calls do not declare an owning org:\n  "
        + "\n  ".join(offenders)
    )


def test_the_sweep_is_not_vacuous():
    """TC-3. If the AST walk stopped matching, the sweep above would pass
    by inspecting nothing."""
    found = 0
    for f in sorted(SRC.glob("*.py")) + sorted(SCRIPTS.glob("*.py")):
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in STORAGE_METHODS):
                found += 1
    assert found >= 8, f"expected to find the known storage call sites, saw {found}"
