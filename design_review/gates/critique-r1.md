# Gates lane — round 1 critique (verification round)

This lane ships CI, not UI, so the screenshot loop is used here to verify the
gates report real defects, judged on /dashboard (both themes, gates-r1 shots).

1. Hierarchy — page reads correctly top-down (context object → health → KPI
   row → recommendations); no gate finding contradicts the visible order.
2. Density — sidebar group labels render at 9.5px uppercase in an ink-faint
   tone; the D1 axe color-contrast hit on exactly those nodes is CONFIRMED
   visually — they are near-invisible on paper.
3. Contrast — computed matrix matches what the shot shows: ink/bg pairs are
   deep and comfortable; the one token failure (dark alert-on-tint 4.41) is
   not visible on this route but is arithmetically real.
4. Soul — the metric grid still shows serif "mil. RON" display numbers on an
   authenticated screen; D10-SERIF's 127 hits are not lint pedantry, the
   drift is on screen.
5. Consistency — KPI row (mono, MRON) vs metrics grid (serif, mil. RON) use
   two different numeric voices on one page; the gates catch this as serif
   violations, migration lanes own the fix.

Verdict: gates pass their own round — every automated finding sampled here is
visible in the shots, none is a false positive. No further rounds needed for
this lane; the failing counts belong to migration lanes and are reported in
GATES.md.
