"""Retroactive document-quota restore — every account, every month.

WHY (2026-09-21). `user_usage.uploads` was bumped twice per successful
upload and once per failure, plus once per re-run (pipeline.py, the ledger
note above `_commit_pipeline_quota`); re-uploads of the same file were
analysed and counted again. The owner's account read 51 for September. This
script puts every counter back to what the owner's rule says it is:

  uploads                   = unique successful documents that month
                              (analysed, not an archived duplicate, one per
                              company + content + period);
  extra_docs_billed_period  = unique successful documents this month beyond
                              the plan's included documents;
  extra_docs_pending        = 0.

RESTORE, NEVER CHARGE: every target is min(stored, computed) — the rule
lives in `engine.api._quota_recompute`, unit tested. Stripe is never
touched: no Stripe subscription exists in production (billing_report
2026-09-21: 0 subscriptions, 0 invoices, 0 charges), and a Stripe credit is
a human decision this script does not make.

READ-ONLY BY DEFAULT. `--dry-run` (the default) prints before → after per
account and month and writes nothing. `--apply` writes ONLY the rows whose
value changes, each write CONDITIONAL on the values it was planned from (a
run committing meanwhile is re-read and re-planned, never overwritten), then
re-reads them and prints the recount; it exits 1 if any re-read disagrees
with its target. The current month's reservations are never written.

Rows stored without a content hash (uploads before the hash existed) are
hashed from their storage object so identical files collapse — a READ of
the bucket. `--no-hash-missing` skips that (those rows then count once
each: nothing proves them equal).

Usage (inside the backend container):
    docker exec cfo-ai-backend python3 /app/scripts/recompute_document_quota.py
    docker exec cfo-ai-backend python3 /app/scripts/recompute_document_quota.py --user <uuid>
    docker exec cfo-ai-backend python3 /app/scripts/recompute_document_quota.py --apply
Exit codes: 0 done · 1 a write did not land as planned · 2 could not run.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _add_src_to_path() -> None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "engine").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return
    try:
        import engine  # noqa: F401
    except ImportError:
        raise SystemExit("recompute_document_quota: `engine` is not importable")


_add_src_to_path()

from engine.api import _doc_dedupe, _pricing_config, _pricing_tiers, _supabase  # noqa: E402
from engine.api._quota_recompute import RecomputePlan, recompute  # noqa: E402

PAGE = 1000


def _select_all(ac: Any, table: str, filters: Optional[Dict[str, str]] = None,
                order: str = "id.asc") -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        params = dict(filters or {})
        params["offset"] = str(offset)
        page = ac.select(table, filters=params, order=order, limit=PAGE) or []
        out.extend(page)
        if len(page) < PAGE:
            return out
        offset += PAGE


def included_docs_for(sub: Dict[str, Any]) -> "tuple[str, int]":
    plan = _pricing_config.plan_for(str(sub.get("tier") or sub.get("plan") or ""))
    if plan is None:
        plan = _pricing_config.CONFIG.plans["trial"]
    return plan.key, int(plan.included_docs)


def load(user: Optional[str], hash_missing: bool) -> Dict[str, List[Dict[str, Any]]]:
    return _read(user, hash_missing)


def _read(user: Optional[str], hash_missing: bool) -> Dict[str, List[Dict[str, Any]]]:
    user_filter = {"user_id": f"eq.{user}"} if user else {}
    with _supabase.admin() as ac:
        usage = _select_all(ac, "user_usage", user_filter)
        subs = _select_all(ac, "subscriptions", user_filter)
        docs = _select_all(ac, "documents", {"uploaded_by": f"eq.{user}"} if user else {},
                           order="created_at.asc,id.asc")
    hashed = 0
    if hash_missing:
        for d in docs:
            if d.get("status") == "analyzed" and not _doc_dedupe.normalize_hash(d.get("content_hash")):
                h = _doc_dedupe.hash_stored_object(d)  # a READ of the bucket; nothing is written
                if h:
                    d["content_hash"] = h
                    hashed += 1
    print("[recompute] loaded %d user_usage rows, %d subscriptions, %d documents (%d hashed from storage)"
          % (len(usage), len(subs), len(docs), hashed))
    return {"usage": usage, "subs": subs, "docs": docs}


def print_plan(plan: RecomputePlan) -> None:
    print("\n== user_usage.uploads (per account, per month) — current month %s" % plan.current_month)
    print("%-38s %-8s %8s %8s %8s %10s %10s  %s" % ("user", "month", "unique", "before", "after",
                                                  "rsv.before", "rsv.after", "note"))
    for u in plan.usage:
        print("%-38s %-8s %8d %8d %8d %10d %10d  %s%s" % (
            u.user_id, u.month, u.unique_successful, u.uploads_before, u.uploads_after,
            u.reserved_before, u.reserved_after, "CHANGE " if u.changed else "", u.note))
    print("\n== subscriptions (extras this month = unique beyond included)")
    print("%-38s %-10s %8s %8s %8s %8s %8s %8s  %s" % ("user", "plan", "incl.", "unique",
                                                    "xtr.bef", "xtr.aft", "pnd.bef", "pnd.aft", "note"))
    for s in plan.subscriptions:
        print("%-38s %-10s %8d %8d %8d %8d %8d %8d  %s%s" % (
            s.user_id, s.plan_key, s.included_docs, s.unique_this_month, s.extra_before,
            s.extra_after, s.pending_before, s.pending_after, "CHANGE " if s.changed else "", s.note))
    print("\n[recompute] %d user_usage row(s) and %d subscription(s) would change"
          % (len(plan.usage_writes()), len(plan.subscription_writes())))


#: Rounds of "write if unchanged since read, else re-read and re-plan".
APPLY_ROUNDS = 3


def _write_if_unchanged(ac: Any, plan: RecomputePlan) -> None:
    """Every write is CONDITIONAL on the values the plan was computed from
    (optimistic concurrency, 2026-09-21, verifier lens Q): a run that
    commits or reserves between the read and the write is never overwritten
    with the stale snapshot — the row simply does not match and is re-planned.
    The current month's reservations are never written at all (a run may be
    in flight); a past month's go to 0."""
    for u in plan.usage_writes():
        patch: Dict[str, Any] = {"uploads": u.uploads_after}
        if u.reserved_after != u.reserved_before:
            patch["uploads_reserved"] = u.reserved_after
        ac.update("user_usage", patch, filters={
            "id": f"eq.{u.row_id}", "user_id": f"eq.{u.user_id}",
            "uploads": f"eq.{u.uploads_before}", "uploads_reserved": f"eq.{u.reserved_before}"})
    for s in plan.subscription_writes():
        ac.update("subscriptions", {"extra_docs_billed_period": s.extra_after,
                                    "extra_docs_pending": s.pending_after},
                  filters={"user_id": f"eq.{s.user_id}",
                           "extra_docs_billed_period": f"eq.{s.extra_before}",
                           "extra_docs_pending": f"eq.{s.pending_before}"})


def _recount(ac: Any, plan: RecomputePlan, final: bool) -> "tuple[int, set]":
    """(rows that did not land, users whose rows changed under us)."""
    bad, moved = 0, set()
    if final:
        print("\n== recount (re-read after --apply)")
    for u in plan.usage_writes():
        row = (ac.select("user_usage", filters={"id": f"eq.{u.row_id}"}, single=True) or [{}])[0]
        got = (int(row.get("uploads") or 0), int(row.get("uploads_reserved") or 0))
        ok = got == (u.uploads_after, u.reserved_after if u.reserved_after != u.reserved_before else got[1])
        if not ok:
            bad += 1
            moved.add(u.user_id)
        if final:
            print("  %s user_usage %s %s uploads=%s reserved=%s" % (
                "OK " if ok else "BAD", u.user_id, u.month, row.get("uploads"), row.get("uploads_reserved")))
    for s in plan.subscription_writes():
        row = (ac.select("subscriptions", filters={"user_id": f"eq.{s.user_id}"}, single=True) or [{}])[0]
        ok = (int(row.get("extra_docs_billed_period") or 0), int(row.get("extra_docs_pending") or 0)) == (s.extra_after, s.pending_after)
        if not ok:
            bad += 1
            moved.add(s.user_id)
        if final:
            print("  %s subscriptions %s extra_docs_billed_period=%s extra_docs_pending=%s" % (
                "OK " if ok else "BAD", s.user_id, row.get("extra_docs_billed_period"), row.get("extra_docs_pending")))
    return bad, moved


def apply(plan: RecomputePlan, *, user: Optional[str] = None, hash_missing: bool = False) -> int:
    """Write the plan conditionally; a row that changed since it was read
    (a run committed meanwhile) is re-read and re-planned — at most
    APPLY_ROUNDS rounds — rather than overwritten or silently dropped."""
    with _supabase.admin() as ac:
        for attempt in range(1, APPLY_ROUNDS + 1):
            _write_if_unchanged(ac, plan)
            last = attempt == APPLY_ROUNDS
            bad, moved = _recount(ac, plan, final=False)
            if not bad or last:
                break
            print("[recompute] %d row(s) changed while the plan was computed (%s) — "
                  "re-reading and re-planning (round %d)" % (bad, ", ".join(sorted(moved)), attempt + 1))
            fresh = _read(user, hash_missing)
            plan = recompute(fresh["docs"], [u for u in fresh["usage"] if str(u.get("user_id")) in moved],
                             [s for s in fresh["subs"] if str(s.get("user_id")) in moved],
                             current_month=plan.current_month, included_docs_for=included_docs_for)
        bad, _moved = _recount(ac, plan, final=True)
    return bad


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True, help="print only (default)")
    mode.add_argument("--apply", action="store_true", help="write the rows that change, then recount")
    ap.add_argument("--user", help="one account only (uuid)")
    ap.add_argument("--no-hash-missing", action="store_true",
                    help="do not hash rows that lack content_hash from storage")
    args = ap.parse_args(argv)
    try:
        data = load(args.user, hash_missing=not args.no_hash_missing)
    except Exception as exc:  # noqa: BLE001
        print("[recompute] could not load: %s: %s" % (type(exc).__name__, exc))
        return 2
    plan = recompute(data["docs"], data["usage"], data["subs"],
                     current_month=_pricing_tiers.current_month_bucket(),
                     included_docs_for=included_docs_for)
    print_plan(plan)
    if not args.apply:
        print("\n[recompute] DRY RUN — nothing written. Re-run with --apply to write.")
        return 0
    bad = apply(plan, user=args.user, hash_missing=not args.no_hash_missing)
    print("\n[recompute] applied: %d row(s) failed to land as planned" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
