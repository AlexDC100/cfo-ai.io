"""The retroactive quota restore — unit tests for the pure rule
(`engine.api._quota_recompute`) and the two operator scripts run end to end
over the in-memory double.

The rule (owner spec, 2026-09-21): a document counts once — analysed, not a
duplicate, one per (company, content, period); a failure never counts. A
restore gives credits back and never takes new ones.

WHAT THESE RED ON: a duplicate or a failure counted in a target; a target
ABOVE the stored counter (a retroactive charge); a past month keeping a
reservation; pending extras surviving; the dry run writing anything;
`--apply` writing a row that does not change or not re-reading what it
wrote; the audit listing a clean paid extra, missing a failed or duplicate
one, or claiming Stripe billed an account with no subscription.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Dict

import pytest

from engine.api import _doc_dedupe, _supabase
from engine.api._quota_recompute import classify_metered_documents, recompute, unique_successful_by_user_month

from dedupe_fakes import FakeDB

ROOT = Path(__file__).resolve().parents[2]
U1 = "fd91f61f-489d-46d2-8bd3-58f922afa03e"
U2 = "c8a7883b-5198-40db-be3a-b08a78bfe4e2"
ORG, ORG_B = "org-a", "org-b"
H1, H2, H3 = "1" * 64, "2" * 64, "3" * 64


def d(doc_id, *, user=U1, org=ORG, h=H1, status="analyzed", created="2026-09-20T10:00:00+00:00",
      hint=None, error=None, deleted=None, metered=False) -> Dict[str, Any]:
    return {"id": doc_id, "uploaded_by": user, "org_id": org, "content_hash": h, "status": status,
            "created_at": created, "period_end_hint": hint, "error": error, "deleted_at": deleted,
            "metered_extra": metered, "original_filename": doc_id + ".xls",
            "storage_path": "%s/uploads/%s.xls" % (org, doc_id)}


def _included(sub):
    return ("pro", 15) if sub.get("tier") == "pro" else ("trial", 1)


def test_unique_successful_collapses_copies_and_drops_failures():
    docs = [
        d("a1"), d("a2", created="2026-09-21T10:00:00+00:00"),                 # same file twice → 1
        d("a3", status="failed"), d("a4", status="queued"),                     # never count
        d("a5", error=_doc_dedupe.duplicate_marker("a1"), deleted="2026-09-21T11:00:00+00:00"),
        d("b1", org=ORG_B),                                                     # same file, other company → +1
        d("c1", h=H2, hint="2025-12-31"), d("c2", h=H2, hint="2024-12-31"),   # confirmed other period → +2
        d("c3", h=H2),                                                          # no date → collapses
        d("n1", h=None), d("n2", h=None),                                       # unhashed: nothing proves equal
        d("x1", user=U2),                                                       # another account
        d("old", h=H3, created="2026-08-31T23:59:59+00:00"),                    # another book, another month
    ]
    counts = unique_successful_by_user_month(docs)
    assert counts[(U1, "2026-09")] == 1 + 1 + 2 + 2
    assert counts[(U2, "2026-09")] == 1
    assert counts[(U1, "2026-08")] == 1


def test_a_copy_of_an_earlier_months_book_is_not_a_new_document():
    """The live gate refuses a re-upload of ANY earlier analysed copy — no
    month limit — so a September copy of an August book is the same
    (company, content, period): it counts once, in August. Per-month
    buckets counted it again in September (verifier lens Q)."""
    docs = [d("aug", created="2026-08-15T10:00:00+00:00"), d("sep-copy", created="2026-09-15T10:00:00+00:00"),
            d("sep-new", h=H2, created="2026-09-16T10:00:00+00:00")]
    counts = unique_successful_by_user_month(docs)
    assert counts == {(U1, "2026-08"): 1, (U1, "2026-09"): 1}
    usage = [{"id": "u", "user_id": U1, "month": "2026-09", "uploads": 2, "uploads_reserved": 0}]
    plan = recompute(docs, usage, [], current_month="2026-09", included_docs_for=_included)
    assert plan.usage[0].uploads_after == 1


def test_uploads_restore_to_unique_successes_and_never_rise():
    docs = [d("a1"), d("a2"), d("b1", h=H2), d("f", h=H3, status="failed")]
    usage = [
        {"id": "u1-09", "user_id": U1, "month": "2026-09", "uploads": 51, "uploads_reserved": 0},
        {"id": "u2-09", "user_id": U2, "month": "2026-09", "uploads": 0, "uploads_reserved": 0},
        {"id": "u1-05", "user_id": U1, "month": "2026-05", "uploads": 10, "uploads_reserved": 2},
        {"id": "u1-10", "user_id": U1, "month": "2026-10", "uploads": 0, "uploads_reserved": 1},
    ]
    usage.append({"id": "u2-08", "user_id": U2, "month": "2026-08", "uploads": 1, "uploads_reserved": 0})
    docs.append(d("u2a", user=U2, created="2026-08-10T00:00:00+00:00"))
    docs.append(d("u2b", user=U2, h=H2, created="2026-08-11T00:00:00+00:00"))
    plan = recompute(docs, usage, [], current_month="2026-09", included_docs_for=_included)
    by = {u.row_id: u for u in plan.usage}
    assert (by["u1-09"].uploads_before, by["u1-09"].uploads_after) == (51, 2)
    assert by["u1-05"].uploads_after == 0 and by["u1-05"].reserved_after == 0   # past month: nothing in flight
    assert by["u1-10"].reserved_after == 1                                      # current/future: untouched
    # 2 unique successes but the counter says 1: a restore never raises it
    assert (by["u2-08"].uploads_before, by["u2-08"].uploads_after) == (1, 1) and by["u2-08"].note
    assert all(u.uploads_after <= u.uploads_before for u in plan.usage)
    assert {u.row_id for u in plan.usage_writes()} == {"u1-09", "u1-05"}


def test_extras_restore_to_the_documents_beyond_the_plan_and_pending_clears():
    docs = [d("s%02d" % i, h=("%064x" % i)) for i in range(20)]          # 20 unique this month for U1
    docs += [d("s00-copy", h="%064x" % 0, created="2026-09-21T00:00:00+00:00")]
    subs = [
        {"user_id": U1, "tier": "pro", "extra_docs_billed_period": 13, "extra_docs_pending": 1},
        {"user_id": U2, "tier": "pro", "extra_docs_billed_period": 6, "extra_docs_pending": 0},
    ]
    plan = recompute(docs, [], subs, current_month="2026-09", included_docs_for=_included)
    by = {s.user_id: s for s in plan.subscriptions}
    assert (by[U1].unique_this_month, by[U1].extra_before, by[U1].extra_after, by[U1].pending_after) == (20, 13, 5, 0)
    assert (by[U2].extra_before, by[U2].extra_after) == (6, 0)            # nothing this month
    fewer = recompute(docs, [], [{"user_id": U1, "tier": "pro", "extra_docs_billed_period": 2,
                                  "extra_docs_pending": 0}], current_month="2026-09", included_docs_for=_included)
    assert fewer.subscriptions[0].extra_after == 2 and fewer.subscriptions[0].note  # never charge retroactively


def test_the_audit_lists_failed_and_duplicate_paid_extras_only():
    docs = [
        d("orig", metered=False),
        d("dup", created="2026-09-21T00:00:00+00:00", metered=True),
        d("fail", h=H2, status="failed", metered=True),
        d("clean", h=H3, metered=True),
        d("fail-copy", h=H2, status="failed", created="2026-09-22T00:00:00+00:00", metered=True),
        d("other-co", org=ORG_B, created="2026-09-22T00:00:00+00:00", metered=True),
    ]
    subs = [{"user_id": U1, "stripe_subscription_id": None}]
    found = {f.document_id: f for f in classify_metered_documents(docs, subs)}
    assert set(found) == {"dup", "fail", "fail-copy"}
    assert found["dup"].reason == "duplicate" and found["dup"].duplicate_of == "orig"
    assert found["fail"].reason == "failed" and found["fail-copy"].duplicate_of is None
    assert all(f.stripe == "no Stripe subscription — never billed" for f in found.values())
    subscribed = classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": "sub_1"}])
    assert all("sub_1" in f.stripe and "extra_doc:%s" % f.document_id in f.stripe for f in subscribed)


@pytest.mark.parametrize("earlier", [
    pytest.param(d("refused", status="queued", created="2026-09-20T10:00:00+00:00"),
                 id="the earlier copy was the 402 the user dismissed (never ran)"),
    pytest.param(d("gone", created="2026-09-10T10:00:00+00:00", deleted="2026-09-11T00:00:00+00:00"),
                 id="the user deleted the original before re-uploading"),
    pytest.param(d("arch", created="2026-09-10T10:00:00+00:00", deleted="2026-09-10T10:00:01+00:00",
                   error=_doc_dedupe.duplicate_marker("x")), id="the earlier copy is itself an archived duplicate"),
])
def test_the_audit_never_lists_a_legitimate_paid_extra(earlier):
    """A copy is a duplicate only of one that was a LIVE original when it
    was uploaded — the live gate's own rule (verifier lens Q: a legitimate
    paid extra was listed for a credit)."""
    docs = [earlier, d("paid", created="2026-09-20T10:05:00+00:00", metered=True)]
    assert classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}]) == []


def test_the_audit_still_lists_a_copy_of_an_original_deleted_after_it():
    docs = [d("orig", created="2026-09-10T10:00:00+00:00", deleted="2026-09-12T00:00:00+00:00"),
            d("copy", created="2026-09-11T10:00:00+00:00", metered=True)]
    found = classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}])
    assert [(f.document_id, f.duplicate_of) for f in found] == [("copy", "orig")]


def test_a_counted_book_whose_correction_failed_is_never_handed_back():
    """Verifier lens S: the meter counted `book` at its first /run; a free
    correction re-run of it then FAILED (its status is `failed`). The meter
    never gives that count back — neither may the restore. The quota
    ledger's committed documents stay successful; a copy of the same bytes
    re-uploaded afterwards collapses into it."""
    docs = [d("book", status="failed"), d("reupload", created="2026-09-21T10:00:00+00:00"),
            d("never", h=H2, status="failed")]
    usage = [{"id": "u", "user_id": U1, "month": "2026-09", "uploads": 1, "uploads_reserved": 0}]
    assert unique_successful_by_user_month(docs, counted_ids={"book"}) == {(U1, "2026-09"): 1}
    plan = recompute(docs, usage, [], current_month="2026-09", included_docs_for=_included,
                     counted_ids={"book"})
    assert plan.usage[0].uploads_after == 1 and not plan.usage_writes()
    # without the ledger the failed original drops out and the re-upload
    # alone is the book — still one, never two
    assert unique_successful_by_user_month(docs) == {(U1, "2026-09"): 1}


def test_the_audit_never_lists_a_products_extra_of_a_dashboard_workbook():
    """Verifier lens R, R7: the SCOPE clause. The same workbook analysed on
    the dashboard and then on Products is two analyses — the Products one
    is a legitimate paid extra, not a duplicate charge."""
    docs = [d("fin", created="2026-09-10T10:00:00+00:00"),
            dict(d("sku", created="2026-09-11T10:00:00+00:00", metered=True), scope="sku")]
    assert classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}]) == []


def test_the_audit_never_lists_a_paid_extra_of_another_confirmed_period():
    """Verifier lens R, R8: the PERIOD clause. The same bytes confirmed for
    another closing date are another book — to the gate, to the restore and
    to the audit."""
    docs = [d("fy2024", created="2026-09-10T10:00:00+00:00", hint="2024-12-31"),
            d("fy2025", created="2026-09-11T10:00:00+00:00", hint="2025-12-31", metered=True)]
    assert unique_successful_by_user_month(docs)[(U1, "2026-09")] == 2
    assert classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}]) == []
    # an undated original analysed into 31.12.2024 vs a copy confirmed for 2025
    docs = [dict(d("undated", created="2026-09-10T10:00:00+00:00"), period_id="p24"),
            d("fy2025", created="2026-09-11T10:00:00+00:00", hint="2025-12-31", metered=True)]
    assert classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}],
                                      period_end_of={"p24": "2024-12-31"}) == []


def test_the_audit_still_lists_a_paid_copy_of_the_same_book_and_period():
    """Positive control for R7 / R8."""
    docs = [d("orig", created="2026-09-10T10:00:00+00:00", hint="2025-12-31"),
            d("copy", created="2026-09-11T10:00:00+00:00", hint="2025-12-31", metered=True),
            d("undated-copy", created="2026-09-12T10:00:00+00:00", metered=True)]
    found = classify_metered_documents(docs, [{"user_id": U1, "stripe_subscription_id": None}])
    assert [(f.document_id, f.duplicate_of) for f in found] == [("copy", "orig"), ("undated-copy", "orig")]


# ── The scripts, end to end over the double ─────────────────────────────


def _load(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name[:-3], str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture()
def prod_like(monkeypatch):
    db = FakeDB({
        "documents": [d("a1", metered=True), d("a2", created="2026-09-21T10:00:00+00:00", metered=True),
                      d("f1", h=H2, status="failed", metered=True), d("b1", h=H3)],
        "user_usage": [{"id": "uu1", "user_id": U1, "month": "2026-09", "uploads": 51, "uploads_reserved": 0}],
        "subscriptions": [{"user_id": U1, "tier": "professional", "stripe_subscription_id": None,
                           "extra_docs_billed_period": 13, "extra_docs_pending": 0}],
    })
    monkeypatch.setattr(_supabase, "admin", lambda: db)
    from engine.api import _pricing_tiers
    monkeypatch.setattr(_pricing_tiers, "current_month_bucket", lambda now=None: "2026-09")
    return db


def test_recompute_script_dry_run_writes_nothing(prod_like, capsys):
    mod = _load("recompute_document_quota.py")
    assert mod.main(["--no-hash-missing"]) == 0
    out = capsys.readouterr().out
    assert prod_like.updates == []
    assert "DRY RUN" in out and "51" in out


def test_recompute_script_apply_writes_only_what_changes_and_recounts(prod_like, capsys):
    mod = _load("recompute_document_quota.py")
    assert mod.main(["--apply", "--no-hash-missing"]) == 0
    usage = prod_like.rows("user_usage")[0]
    sub = prod_like.rows("subscriptions")[0]
    assert usage["uploads"] == 2                       # a1/a2 are one book; b1 the other; f1 failed
    assert sub["extra_docs_billed_period"] == 0 and sub["extra_docs_pending"] == 0
    assert {t for t, _p, _f in prod_like.updates} == {"user_usage", "subscriptions"}
    assert "OK " in capsys.readouterr().out
    # a second run finds nothing left to change
    prod_like.updates.clear()
    assert mod.main(["--apply", "--no-hash-missing"]) == 0
    assert prod_like.updates == []


def test_duplicate_charges_script_is_read_only(prod_like, capsys):
    mod = _load("list_duplicate_charges.py")
    assert mod.main([]) == 0
    out = capsys.readouterr().out
    assert prod_like.updates == []
    assert "no Stripe subscription — never billed" in out
    assert "a2" in out and "f1" in out and " a1 " not in out


def test_apply_never_overwrites_a_run_that_committed_after_the_read(prod_like, monkeypatch):
    """load() → a run commits (uploads+1, reserved-1) and its document lands
    → apply(). The stale snapshot used to be written back: the committed
    document lost and a phantom reservation re-written (verifier lens Q)."""
    prod_like.rows("user_usage")[0]["uploads_reserved"] = 1          # one run in flight at load time
    mod = _load("recompute_document_quota.py")
    real_load = mod.load

    def load_then_commit(user, hash_missing):
        data = real_load(user, hash_missing)
        row = prod_like.rows("user_usage")[0]
        row["uploads"] += 1
        row["uploads_reserved"] = max(row["uploads_reserved"] - 1, 0)
        prod_like.rows("documents").append(d("new", h="4" * 64, created="2026-09-21T12:00:00+00:00"))
        return data

    monkeypatch.setattr(mod, "load", load_then_commit)
    assert mod.main(["--apply", "--no-hash-missing"]) == 0
    row = prod_like.rows("user_usage")[0]
    assert (row["uploads"], row["uploads_reserved"]) == (3, 0), row   # a1/a2 + b1 + the new one


def test_apply_keeps_exactly_the_current_months_reservations_a_live_run_holds(prod_like):
    """This gate used to assert the current month's reservations are NEVER
    written — the defect verifier lens S (S8) found: a run a restart killed
    kept its slot for the rest of the month and the restore "reconciled"
    nothing. The rule now: down to the reservations still LIVE in the quota
    ledger (their owning engine process heartbeats), never below them —
    a run in flight while the script runs keeps its slot."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    prod_like.rows("user_usage")[0]["uploads_reserved"] = 3
    prod_like.rows("document_quota_ledger").append({
        "document_id": "in-flight", "user_id": U1, "month": "2026-09", "was_extra": False,
        "reservation_id": "r1", "reserved_at": now, "heartbeat_at": now, "owner": "engine:1"})
    mod = _load("recompute_document_quota.py")
    assert mod.main(["--apply", "--no-hash-missing"]) == 0
    assert prod_like.rows("user_usage")[0]["uploads_reserved"] == 1
    # and a second run changes nothing: the live run's slot stays
    prod_like.updates.clear()
    assert mod.main(["--apply", "--no-hash-missing"]) == 0
    assert [p for t, p, _f in prod_like.updates if t == "user_usage"] == []
