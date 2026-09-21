"""Every document flagged as a PAID EXTRA that was a duplicate or a failure — READ-ONLY.

For each account: every `documents.metered_extra = true` row that either
failed or re-uploaded a file the same account already held in the same
company (an earlier non-failed copy with the same content hash, or the
archived-duplicate marker), with its date, filename and what billing could
have done with it. The account's `subscriptions` row decides the last
column: without a `stripe_subscription_id`, `_billing.record_metered_extra_doc`
answers `no_stripe_subscription` before it touches Stripe, so the document
was never billed. With one, the line names the idempotency key a meter event
would carry — verifying and crediting it is a human decision in Stripe.

Writes nothing, anywhere. Makes no Stripe call.

Usage (inside the backend container):
    docker exec cfo-ai-backend python3 /app/scripts/list_duplicate_charges.py
    docker exec cfo-ai-backend python3 /app/scripts/list_duplicate_charges.py --user <uuid>
Exit codes: 0 listed (possibly nothing) · 2 could not run.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
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
        raise SystemExit("list_duplicate_charges: `engine` is not importable")


_add_src_to_path()

from engine.api import _supabase  # noqa: E402
from engine.api._quota_recompute import classify_metered_documents  # noqa: E402

PAGE = 1000


def _select_all(ac: Any, table: str, filters: Dict[str, str], order: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        page = ac.select(table, filters=dict(filters, offset=str(offset)), order=order, limit=PAGE) or []
        out.extend(page)
        if len(page) < PAGE:
            return out
        offset += PAGE


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--user", help="one account only (uuid)")
    args = ap.parse_args(argv)
    try:
        with _supabase.admin() as ac:
            doc_filter = {"uploaded_by": f"eq.{args.user}"} if args.user else {}
            docs = _select_all(ac, "documents", doc_filter, "created_at.asc,id.asc")
            subs = _select_all(ac, "subscriptions",
                               {"user_id": f"eq.{args.user}"} if args.user else {}, "user_id.asc")
    except Exception as exc:  # noqa: BLE001
        print("[duplicate-charges] could not load: %s: %s" % (type(exc).__name__, exc))
        return 2
    findings = classify_metered_documents(docs, subs)
    metered = sum(1 for d in docs if d.get("metered_extra"))
    print("[duplicate-charges] %d documents read, %d flagged metered_extra, %d of them a duplicate or a failure"
          % (len(docs), metered, len(findings)))
    by_user: Dict[str, List[Any]] = defaultdict(list)
    for f in findings:
        by_user[f.user_id].append(f)
    for uid in sorted(by_user):
        rows = by_user[uid]
        print("\n== account %s — %d document(s); %s" % (uid, len(rows), rows[0].stripe))
        for f in rows:
            print("  %s  %-18s %-9s %-36s %s%s" % (
                f.created_at[:19], f.reason, f.status, f.document_id, f.filename,
                ("  (copy of %s)" % f.duplicate_of) if f.duplicate_of else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
