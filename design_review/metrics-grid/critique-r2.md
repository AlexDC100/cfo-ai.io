# METRICS GRID — critique r2 (shots: metrics-grid-r2/)

Fixes applied after r1 and re-verified:

1. **Unit joint fixed** — badge figure + unit now live in ONE
   `font-mono tabular-nums whitespace-nowrap` span, so the chip's flex
   gap can't split them: "+5.6%/yr", "-0.2 pp" (deliberate NNBSP before
   pp), "+0.03×". Verified in both themes.
2. **Ratio delta precision** — ratio deltas render 2 fraction digits
   ("+0.03×"), matching the level's precision. Days keep integer digits.
   Residual nit, accepted: a truly negligible ratio delta still shows a
   signed zero ("-0.00×") because <Amount> signs on the raw value, not
   the rounded display — the sign carries direction honestly (ledger
   convention) and the pre-migration rendering had the same trait.
3. **Dark theme re-shot** — Terminal theme now captured correctly:
   hairline borders hold, brand-l sparkline and neutral chips read
   cleanly on the dark tiles.

Behavior contract probes (Playwright, this round):
- ⓘ definition tip appears on hover with the plain-language one-liner —
  unchanged behavior; content now shadow-3 (floating layer — file added
  to the lint's floating-layer allowlist with per-entry justification).
- ⋯ menu opens: Rearrange / Size (Small ✓ / Medium / Large) / Remove —
  all present, Remove in alert (destructive = legitimate red).
- Rearrange enters edit mode: drag handles + per-card remove + brand
  ring + Done button (brand-tint) — verified, exited via Done.

Design-lint: the family contributes ZERO violations (was: 2 hex in
Sparkline, 1 shadow in MetricInfoTip, plus the num-hero serif value and
seven raw hsl() literals outside the lint's reach).

Verdict: the METRICS grid now speaks the instrument voice — mono ledger
figures under one magnitude, flat hairline panels, caps labels, red only
for destruction. No further rounds needed for this lane.
