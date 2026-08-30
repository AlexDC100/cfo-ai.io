# Findings UX — round 2 critique (2026-08-30)

Shots: `design_review/findings-r2/` (same matrix as r1).

## Fixed since r1

All six r1 defects. The All-checks count reads 3 for three rules — the
duplicate row is gone, and `findingsContract.test.ts` now pins it
("lists a demoted finding ONCE, not once per name it goes by"). The
meter reads as a measurement: grey to the limit, severity tone across
the breach, LIMIT / OBSERVED under the ticks. Simple mode is a headline,
one impact line, one action and four buttons.

## Still open

1. **PRO does not state the METHOD.** The brief asks Pro for "rule id,
   threshold, method, the full ratio math". Rule id, threshold and the
   score breakdown are there; nothing named which metric was restated or
   how. The engine ships `impact.kind` / `impact.metric` / `impact.unit`
   but NOT the operands, so the honest fix is to print what it knows —
   `recomputed_ratio · equity_ratio_ex_related_party · percent` — rather
   than reconstruct an equation the payload never carried.
   → added as a Pro-only line under the impact sentence.

2. **The delta orphaned onto its own line** ("(−11.0 pp)" alone). → the
   delta span is `whitespace-nowrap`; it still wraps as a unit when the
   column is narrow, which is correct.

3. **The allowed-range fill was near-invisible in light** at
   `bg-ink-faint/60`. → full-strength `bg-ink-faint`.

4. **Column balance.** The right column (impact + why-here + action) runs
   ~120px longer than the left (evidence + threshold), leaving a gap
   above the confidence rule at 1280+. Not fixed: closing it means either
   masonry or reordering the seven, and the reading order — what is it,
   what was measured, what rule, what it costs, why here, what to do — is
   worth more than a flush baseline.

## Not a defect, worth recording

`/dashboard`'s Overview tab renders a THIRD recommendation surface:
`RecommendationsSection`, defined inside
`frontend/pages/cfo/FinancialStatements.tsx`. It is not
`RecommendationsView` and not `StatementNotes`, and it still shows the
pre-contract shape (title → "Why:" paragraph → Actions → Triggered by).
Out of this lane's file ownership; flagged as a cross-lane need. The
contract DOES reach that page today through the three `StatementNotes`
mounts on the P&L / Balance Sheet / Cash Flow tabs.
