"""Retroactive document-quota restore — the PURE half (engine.api._quota_recompute).

`scripts/recompute_document_quota.py` loads rows and writes the result;
everything that decides a number lives here, with no I/O, so it is unit
tested (tests/engine/test_quota_recompute.py) and the script has nothing
left to get wrong but the plumbing.

THE RULE (owner spec, 2026-09-21): a document counts when it was analysed
successfully, once per (company, content, period) — a duplicate is not
counted and a failure is never counted. So, for every user and month:

  uploads (user_usage)                → the unique successful documents
                                        that user uploaded that month (a
                                        document the quota ledger records as
                                        counted is successful even after a
                                        correction re-run of it failed);
  extra_docs_billed_period (current)  → the unique successful documents
                                        this month beyond the plan's
                                        included documents;
  extra_docs_pending                  → 0.

RESTORE, NEVER CHARGE. Every target is capped at the value already stored
(`min(stored, computed)`): the script gives credits back and can never take
new ones. A counter BELOW the computed number (a user who was unmetered, or
analysed with enforcement off) is reported and left alone — back-filling it
would bill for the past.

Past months' reservations (`uploads_reserved`) go to 0: a month that is over
holds no run in flight. The current month's reservations are left untouched
— a run may be in flight while the script runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from ._doc_dedupe import _ts, is_archived_duplicate, month_of, normalize_hash, unique_successful


@dataclass(frozen=True)
class UsageChange:
    row_id: str
    user_id: str
    month: str
    unique_successful: int
    uploads_before: int
    uploads_after: int
    reserved_before: int
    reserved_after: int
    note: str = ""

    @property
    def changed(self) -> bool:
        return (self.uploads_before, self.reserved_before) != (self.uploads_after, self.reserved_after)


@dataclass(frozen=True)
class SubscriptionChange:
    user_id: str
    plan_key: str
    included_docs: int
    unique_this_month: int
    extra_before: int
    extra_after: int
    pending_before: int
    pending_after: int
    note: str = ""

    @property
    def changed(self) -> bool:
        return (self.extra_before, self.pending_before) != (self.extra_after, self.pending_after)


@dataclass
class RecomputePlan:
    current_month: str
    usage: List[UsageChange] = field(default_factory=list)
    subscriptions: List[SubscriptionChange] = field(default_factory=list)

    def usage_writes(self) -> List[UsageChange]:
        return [u for u in self.usage if u.changed]

    def subscription_writes(self) -> List[SubscriptionChange]:
        return [s for s in self.subscriptions if s.changed]


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def unique_successful_by_user_month(documents: Iterable[Dict[str, Any]],
                                    period_end_of: Optional[Dict[str, str]] = None,
                                    counted_ids: Optional[Iterable[str]] = None) -> Dict[tuple, int]:
    """{(user_id, 'YYYY-MM'): unique successful documents}. `uploaded_by` is
    the account; a unique document counts in the month its FIRST analysed
    copy was created (UTC).

    Uniqueness is decided over the account's WHOLE history, not per month
    (2026-09-21, verifier lens Q): the live gate refuses a re-upload of any
    earlier analysed copy with no month limit, so a September copy of an
    August book is the same (company, content, period) and never a new
    September document — per-month buckets counted it again.

    `counted_ids` — the quota ledger's committed documents: a book the meter
    counted stays counted after a correction re-run of it failed (verifier
    lens S), so the restore never hands back a count the meter still holds."""
    counted = set(str(i) for i in (counted_ids or ()))
    by_user: Dict[str, List[Dict[str, Any]]] = {}
    for d in documents:
        uid = str(d.get("uploaded_by") or "")
        if not uid or not month_of(d.get("created_at")):
            continue
        by_user.setdefault(uid, []).append(d)
    counts: Dict[tuple, int] = {}
    for uid, rows in by_user.items():
        for kept in unique_successful(rows, period_end_of, counted_ids=counted):
            key = (uid, month_of(kept.get("created_at")))
            counts[key] = counts.get(key, 0) + 1
    return counts


def recompute(
    documents: Sequence[Dict[str, Any]],
    usage_rows: Sequence[Dict[str, Any]],
    subscriptions: Sequence[Dict[str, Any]],
    *,
    current_month: str,
    included_docs_for: Callable[[Dict[str, Any]], "tuple[str, int]"],
    period_end_of: Optional[Dict[str, str]] = None,
    counted_ids: Optional[Iterable[str]] = None,
) -> RecomputePlan:
    """The whole restore, decided. `included_docs_for(subscription_row)` →
    (plan_key, included documents per month); `period_end_of` (period id →
    period_end) lets an undated copy take the period it was analysed into,
    as the live gate does; `counted_ids` (the quota ledger's committed
    documents) keeps a counted book counted after its analysis failed."""
    counts = unique_successful_by_user_month(documents, period_end_of, counted_ids)
    plan = RecomputePlan(current_month=current_month)
    for u in sorted(usage_rows, key=lambda r: (str(r.get("user_id")), str(r.get("month")))):
        uid, month = str(u.get("user_id") or ""), str(u.get("month") or "")
        unique = counts.get((uid, month), 0)
        before = _int(u.get("uploads"))
        after = min(before, unique)
        reserved_before = _int(u.get("uploads_reserved"))
        reserved_after = reserved_before if month >= current_month else 0
        note = ""
        if unique > before:
            note = "counter below unique successful documents — left as is (a restore never raises a counter)"
        plan.usage.append(UsageChange(
            row_id=str(u.get("id") or ""), user_id=uid, month=month, unique_successful=unique,
            uploads_before=before, uploads_after=after,
            reserved_before=reserved_before, reserved_after=reserved_after, note=note,
        ))
    for s in sorted(subscriptions, key=lambda r: str(r.get("user_id"))):
        uid = str(s.get("user_id") or "")
        plan_key, included = included_docs_for(s)
        unique = counts.get((uid, current_month), 0)
        extra_before = _int(s.get("extra_docs_billed_period"))
        target = max(0, unique - int(included))
        extra_after = min(extra_before, target)
        note = ""
        if target > extra_before:
            note = "fewer extras recorded than documents beyond the plan — left as is (never charge retroactively)"
        plan.subscriptions.append(SubscriptionChange(
            user_id=uid, plan_key=plan_key, included_docs=int(included), unique_this_month=unique,
            extra_before=extra_before, extra_after=extra_after,
            pending_before=_int(s.get("extra_docs_pending")), pending_after=0, note=note,
        ))
    return plan


# ──────────────────────────────────────────────────────────────────────
# The duplicate-charge audit (scripts/list_duplicate_charges.py)
# ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MeteredFinding:
    user_id: str
    document_id: str
    created_at: str
    filename: str
    status: str
    reason: str               # "failed" | "duplicate" | "failed+duplicate"
    duplicate_of: Optional[str]
    stripe: str               # what the account's subscription says about billing


def _earlier_live_copy(doc: Dict[str, Any], by_key: Dict[tuple, List[Dict[str, Any]]]) -> Optional[str]:
    """An earlier copy that was a LIVE original when `doc` was uploaded:
    analysed (a queued copy whose run was refused — a dismissed 402 — never
    ran and is not one; nor is a failure), not itself an archived duplicate,
    and not deleted before `doc` was uploaded (a re-upload after the user
    deleted the original is the live gate's "not a duplicate" too). Same
    rule as `_doc_dedupe.pick_original`, read retrospectively (2026-09-21,
    verifier lens Q: a legitimate paid extra was listed as a duplicate)."""
    h = normalize_hash(doc.get("content_hash"))
    if not h:
        return None
    key = (str(doc.get("org_id") or ""), str(doc.get("uploaded_by") or ""), h)
    me = (str(doc.get("created_at") or ""), str(doc.get("id") or ""))
    my_created = _ts(doc.get("created_at"))
    for other in by_key.get(key, []):
        them = (str(other.get("created_at") or ""), str(other.get("id") or ""))
        if them >= me:
            break
        if str(other.get("status") or "") != "analyzed" or is_archived_duplicate(other):
            continue
        deleted = _ts(other.get("deleted_at"))
        if deleted is not None and my_created is not None and deleted <= my_created:
            continue
        return str(other.get("id"))
    return None


def classify_metered_documents(
    documents: Sequence[Dict[str, Any]],
    subscriptions: Sequence[Dict[str, Any]],
) -> List[MeteredFinding]:
    """Every `metered_extra` document that was a FAILURE or a DUPLICATE (an
    earlier non-failed copy of the same account, company and content, or an
    archived-duplicate marker), with the account's Stripe position: without
    a `stripe_subscription_id` nothing was ever metered — `record_metered_
    extra_doc` answers `no_stripe_subscription` before touching Stripe."""
    by_key: Dict[tuple, List[Dict[str, Any]]] = {}
    for d in sorted(documents, key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or ""))):
        h = normalize_hash(d.get("content_hash"))
        if h:
            by_key.setdefault((str(d.get("org_id") or ""), str(d.get("uploaded_by") or ""), h), []).append(d)
    subs = {str(s.get("user_id")): s for s in subscriptions}
    out: List[MeteredFinding] = []
    for d in sorted(documents, key=lambda r: (str(r.get("uploaded_by") or ""), str(r.get("created_at") or ""))):
        if not d.get("metered_extra"):
            continue
        failed = str(d.get("status") or "") == "failed"
        dup = _earlier_live_copy(d, by_key)
        if is_archived_duplicate(d) and not dup:
            from ._doc_dedupe import duplicate_of
            dup = duplicate_of(d.get("error"))
        if not failed and not dup:
            continue
        uid = str(d.get("uploaded_by") or "")
        sub = subs.get(uid) or {}
        if not sub.get("stripe_subscription_id"):
            stripe = "no Stripe subscription — never billed"
        else:
            stripe = ("Stripe subscription %s — a meter event may exist under idempotency "
                      "key extra_doc:%s; verify in Stripe before any credit" % (sub.get("stripe_subscription_id"), d.get("id")))
        out.append(MeteredFinding(
            user_id=uid, document_id=str(d.get("id")), created_at=str(d.get("created_at") or ""),
            filename=str(d.get("original_filename") or ""), status=str(d.get("status") or ""),
            reason="failed+duplicate" if (failed and dup) else ("failed" if failed else "duplicate"),
            duplicate_of=dup, stripe=stripe,
        ))
    return out
