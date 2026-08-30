# Findings UX — round 1 critique (2026-08-30)

Shots: `design_review/findings-r1/` — 1440 / 1280 / 390 × light+dark ×
simple+pro, over the REAL engine payload (`__tests__/engineFixture.ts`,
`RankedReport.to_payload()` dumped verbatim for the BASELINE.md 461 case).

## What the round proved

The seven elements each have a labelled region and all seven render from
one payload. Re-running BASELINE.md's own two measurements against the
rendered DOM: the card carries 8 figures (baseline: 58% carried < 2) and
two imperative verbs, "Pull" and "Recompute" (baseline: 80% carried
none). The threshold — the element eleven live rules never printed — is
on the page with its limit, its observed value and the `profiles.yaml`
path the parameter came from.

## Defects found

1. **A demoted finding was listed TWICE under All checks** (count read 4
   where 3 rules ran). `checkRowFor` keyed its row by the finding's
   `rule_key` while `_finding.check_record` keys by the THRESHOLD's rule
   id, so the dedupe never matched the engine's own row. This is the
   worst class of bug on this surface: the panel whose entire job is
   "here is what ran" was over-counting the run.
   → Mirror the engine: `rule_id = threshold ? threshold.rule_id : rule_key`.

2. **The threshold source wrapped across three lines mid-token** at 390px
   (`...concentration_related_party.th / resholds.default...`). A dotted
   path is provenance, not prose. → one line, truncated, full string on
   hover.

3. **The meter read as a decorative smear.** Only the breach segment was
   drawn, with no scale and no labels, so a reader could not tell which
   end was the limit. → fill 0→limit as the allowed range, breach in the
   severity tone, LIMIT / OBSERVED captions under the ticks.

4. **Simple mode leaked Pro vocabulary.** The materiality chip read
   "19.63% OF TOTAL ASSETS (FLOOR 0.50%, MATERIAL)" — that is the policy
   that let the row through, not something a Simple reader acts on. Six
   action buttons compounded it. → materiality is Pro-only; Simple keeps
   the four moves that act on THIS finding (evidence, recompute, ask,
   dismiss) and hands Compare / Export pack to the full check.

5. **"Did not fire" repeated per row** under a group already headed "RAN,
   DID NOT FIRE" — a column of one word. → the Note column carries a real
   note or nothing.

6. **The figure label clipped**: "related-party balance on 4…" cost the
   reader the account number, which is the part that makes the figure
   checkable. → wrap instead of truncate.

## Accepted, not a defect

Evidence money renders at full native precision in RON display
(`7.692.202,74 RON`) and rounds when converted, because
`resolveMoneyDisplay`'s same-currency path always formats at 2dp. Both
sides are one-currency, so the 461 defect does not recur; the evidence
panel showing the exact cited value is arguably better than the prose's
rounded one. `narrativeMoney.tsx` is import-only for this lane — flagged,
not touched.
