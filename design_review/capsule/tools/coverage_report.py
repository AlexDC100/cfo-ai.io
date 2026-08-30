#!/usr/bin/env python3
"""Read `coverage-e2e.json` and print the tables the write-up quotes, so
no number in the prose is retyped by hand."""
import json, sys, collections, pathlib

REPO = pathlib.Path(__file__).resolve().parents[3]
path = REPO / "design_review/capsule/coverage-e2e.json"
d = json.loads(path.read_text())
rows = d["rows"]

print("total %d | answered_free %d | routed_free %d | spent %d | free_unanswered %d | errors %d"
      % (d["total"], d["answered_free"], d.get("routed_free", 0), d["spent"],
         d["free_but_unanswered"], d["errors"]))
print("zero-spend %.1f%%  (K3 unit figure: 51.4%%, 37/72)" % d["zero_spend_coverage_pct"])
print()

# Bucket by source, the corpus's own provenance column.
by_src = collections.defaultdict(lambda: collections.Counter())
for r in rows:
    b = ("spent" if r["spend"] > 0
         else "free_answered" if r["answered"]
         else "free_routed" if r.get("navigated")
         else "free_unanswered")
    by_src[r["source"]][b] += 1
print("BY CORPUS SOURCE")
print("%-18s %6s %6s %6s %6s %6s" % ("source", "n", "free", "routed", "spent", "none"))
for src in ("production_log", "answer_fixture", "router_fixture", "brief", "suggestion"):
    c = by_src[src]
    n = sum(c.values())
    if not n:
        continue
    print("%-18s %6d %6d %6d %6d %6d"
          % (src, n, c["free_answered"], c["free_routed"], c["spent"], c["free_unanswered"]))
print()

# The Tier-0 preview's own verdict — refused / resolved / absent.
pv = collections.Counter(r.get("previewState", "?") for r in rows)
print("TIER-0 PREVIEW VERDICT (the resolver's own, on this data):", dict(pv))
spent_pv = collections.Counter(r.get("previewState", "?") for r in rows if r["spend"] > 0)
print("  among the payers:", dict(spent_pv))
print()

print("RESOLVED IN PREVIEW, THEN PAID (a spend-boundary leak if non-empty):")
leaks = [r for r in rows if r.get("previewState") == "resolved" and r["spend"] > 0]
print("  none" if not leaks else "")
for r in leaks:
    print("  ·", r["q"][:78], "| seams:", r["seams"])
print()

print("FREE BUT UNANSWERED (not coverage):")
uns = [r for r in rows if r["spend"] == 0 and not r["answered"] and not r.get("navigated")]
print("  none" if not uns else "")
for r in uns:
    print("  ·", r["q"][:78], "| preview:", r.get("previewState"), "| dom:", r.get("dom"))
print()

print("RETRIED BY THE DRIVER (Enter raced the surface once):",
      sum(1 for r in rows if r.get("retried")))
print("SEAMS:", d.get("seam_breakdown"))
