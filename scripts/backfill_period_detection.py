#!/usr/bin/env python3
"""Backfill the DETECTION RECORD onto periods written before detection
existed — so a file row can say what month its document covers.

WHY THIS IS NEEDED
------------------
`period_detection` is stamped at write time, so every period that
predates the period-integrity work carries none. The file row then
honestly says "File date not recorded" — correct, but true of 100% of
existing files, which hides exactly the mismatch the feature exists to
show (Carniprod-2025 sitting under Dec 2017).

WHAT IT DOES AND DOES NOT DO
----------------------------
It runs the SAME detection service the upload flow uses, on the
document's filename, and records the result for DISPLAY.

It does NOT move any document. It does NOT change any period_end. It
does NOT touch line items, snapshots or envelope figures. A mismatch it
discovers is SURFACED for a human to correct through the move-period
path — never silently rewritten. That is the whole point: the audit
found four mis-filed documents and the correct response is to show
them, not to migrate them behind the operator's back.

`--dry-run` (default) prints what it would write and writes nothing.
`--apply` performs the display-only write.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "src"))

from engine.api import _supabase  # noqa: E402
from engine.api._period_detect import detect_period  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="write the records (default is a dry run)")
    args = ap.parse_args(argv)

    with _supabase.admin() as c:
        periods = c.select(
            "financial_periods",
            columns="id,org_id,period_end,source_document_id,"
                    "assembled_canonical_v1",
            limit=5000,
        ) or []
        docs = c.select(
            "documents", columns="id,original_filename,period_end_hint",
            limit=5000,
        ) or []
    by_doc = {d["id"]: d for d in docs}

    planned, skipped, mismatches = [], 0, 0
    for p in periods:
        env = p.get("assembled_canonical_v1") or {}
        if not isinstance(env, dict):
            skipped += 1
            continue
        if env.get("period_detection"):
            skipped += 1          # already stamped — never overwrite
            continue
        doc = by_doc.get(p.get("source_document_id"))
        if not doc:
            skipped += 1
            continue
        det = detect_period(extracted=None,
                            filename=doc.get("original_filename"))
        if not det.get("proposed_period_end"):
            # No signal is a real answer; record it so the row can say
            # "not detected" rather than "not recorded".
            det_record = {"resolved_period_end": p.get("period_end"),
                          "signal_used": "none", "confidence": 0.0,
                          "evidence_snippet": None,
                          "hint": doc.get("period_end_hint"),
                          "detected": det, "mismatch": False,
                          "backfilled": True}
        else:
            same = str(det["proposed_period_end"])[:7] == str(p.get("period_end"))[:7]
            det_record = {"resolved_period_end": p.get("period_end"),
                          "signal_used": det["signal_used"],
                          "confidence": det["confidence"],
                          "evidence_snippet": det["evidence_snippet"],
                          "hint": doc.get("period_end_hint"),
                          "detected": det, "mismatch": not same,
                          "backfilled": True}
            if not same:
                mismatches += 1
        planned.append((p, det_record, doc))

    print("periods: %d · to stamp: %d · skipped: %d · mismatches found: %d"
          % (len(periods), len(planned), skipped, mismatches))
    for p, rec, doc in planned:
        if rec["mismatch"]:
            print("  MISMATCH %s  stored %s  file says %s  (%s)  %s" % (
                p["id"][:8], str(p.get("period_end"))[:7],
                str(rec["detected"]["proposed_period_end"])[:7],
                rec["signal_used"], doc.get("original_filename")))

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return 0

    written = 0
    with _supabase.admin() as c:
        for p, rec, _doc in planned:
            env = dict(p.get("assembled_canonical_v1") or {})
            env["period_detection"] = rec
            c.update("financial_periods",
                     {"assembled_canonical_v1": env},
                     filters={"id": "eq.%s" % p["id"]})
            written += 1
    print("\nwrote %d detection record(s). NO period_end was changed." % written)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
