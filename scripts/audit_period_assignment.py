#!/usr/bin/env python3
"""Part A / W5 — report documents whose STORED period disagrees with the
period their own content/filename implies, and periods holding more than
one entity.

READ-ONLY BY CONSTRUCTION. It opens no write client and calls no
mutating helper; the whole point is to surface bad rows for a human to
correct (Part D), never to silently rewrite history. Re-running it is
always safe.

Detection mirrors the engine's own ranked signals (stage_persist), minus
the hint — because the hint is exactly what is under suspicion:
    1. in-document / extracted closing date  (financial_periods.period_end
       of a period whose source doc parsed one, when available)
    2. filename date  (_detect_period_end_from_filename — the SAME helper
       the engine uses, imported, never reimplemented)

Usage:
    python3 scripts/audit_period_assignment.py            # all orgs
    python3 scripts/audit_period_assignment.py --org <id>
"""
from __future__ import annotations

import argparse
from datetime import date
import collections
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "src"))

from engine.api import _supabase  # noqa: E402
from engine.api.pipeline import _detect_period_end_from_filename  # noqa: E402


def _month(iso):
    return str(iso)[:7] if iso else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--org", default=None, help="limit to one org_id")
    args = ap.parse_args(argv)

    filters = {}
    if args.org:
        filters["org_id"] = "eq.%s" % args.org

    with _supabase.admin() as c:
        docs = c.select(
            "documents",
            filters=dict(filters, scope="eq.financial"),
            columns="id,org_id,original_filename,period_id,period_end_hint,"
                    "status,created_at,detected_type",
            limit=5000,
        ) or []
        periods = c.select(
            "financial_periods",
            filters=filters,
            columns="id,org_id,period_end,source_document_id",
            limit=5000,
        ) or []

    by_id = {p["id"]: p for p in periods}
    doc_by_id = {d["id"]: d for d in docs}
    print("AUDIT — period assignment")
    print("  documents (financial): %d   periods: %d" % (len(docs), len(periods)))
    print()

    # ── 1. stored vs detected ────────────────────────────────────────
    mismatches = []
    no_signal = []
    for d in docs:
        stored_end = None
        if d.get("period_id") and d["period_id"] in by_id:
            stored_end = by_id[d["period_id"]].get("period_end")
        else:
            # documents.period_id may be null; fall back to the period
            # whose source_document_id is this doc (the engine's key).
            for p in periods:
                if p.get("source_document_id") == d["id"]:
                    stored_end = p.get("period_end")
                    break
        if not stored_end:
            continue
        detected = _detect_period_end_from_filename(d.get("original_filename"))
        # ABSENT != ZERO, applied to the audit itself: when the filename
        # carries no date the helper returns TODAY with a warning. That
        # is the absence of a signal, not evidence of disagreement —
        # counting it would manufacture findings. Such files are
        # reported separately as "no filename signal".
        if detected and _month(detected) == _month(date.today().isoformat()):
            no_signal.append((d, stored_end))
            continue
        if detected and _month(detected) != _month(stored_end):
            mismatches.append((d, stored_end, detected))

    if mismatches:
        print("STORED vs DETECTED-FROM-FILENAME — %d disagreement(s):" % len(mismatches))
        for d, stored, det in sorted(mismatches, key=lambda x: str(x[1])):
            print("  stored %s  detected %s   %s" % (
                _month(stored), _month(det), d.get("original_filename")))
            print("      doc=%s  hint=%s" % (d["id"][:8], d.get("period_end_hint")))
    else:
        print("STORED vs DETECTED-FROM-FILENAME: no disagreements found.")
    if no_signal:
        print()
        print("NO FILENAME DATE SIGNAL — %d file(s) (content detection is the"
              " only evidence; not a disagreement):" % len(no_signal))
        for d, stored in no_signal:
            print("  stored %s   %s   hint=%s" % (
                _month(stored), d.get("original_filename"),
                d.get("period_end_hint")))
    print()

    # ── 2. periods (by month) holding more than one entity ───────────
    by_month = collections.defaultdict(list)
    for p in periods:
        by_month[(p["org_id"], _month(p.get("period_end")))].append(p)

    multi = []
    for key, rows in sorted(by_month.items()):
        names = set()
        for r in rows:
            src = doc_by_id.get(r.get("source_document_id"))
            if src:
                names.add((src.get("original_filename") or "").strip())
        names.discard("")
        if len(names) > 1:
            multi.append((key, names, rows))

    if multi:
        print("MONTHS HOLDING MORE THAN ONE SOURCE FILE — %d:" % len(multi))
        for (org, month), names, rows in multi:
            print("  %s  org=%s  source files: %s" % (month, str(org)[:8], ", ".join(sorted(names))))
            for r in rows:
                src = doc_by_id.get(r.get("source_document_id")) or {}
                print("      period=%s  file=%s" % (
                    r["id"][:8], src.get("original_filename")))
    else:
        print("MONTHS HOLDING MORE THAN ONE SOURCE FILE: none found.")
    print()
    print("Read-only: nothing was modified. Correct these through the UI's")
    print("move-to-period path (Part D), which re-runs both periods.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
