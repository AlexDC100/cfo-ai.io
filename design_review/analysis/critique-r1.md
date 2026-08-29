# Analysis lane — round 1 critique (benchmark / scenarios / variance)

- Hierarchy: hero eviction landed on all three — compact eyebrow→title header reads instantly; variance table's double-hairline totals give the P&L its spine. Benchmark still shows only the sample-period empty state in test mode (serif allowed there); loaded report unverifiable visually.
- Density: 32px rows and one AmountGroup per table tightened variance and scenario tables well; scenario driver cards still slightly airy but match the results column height.
- Contrast: BUG FOUND — ScenarioComparison sticky header pinned 56px INTO its panel (overflow-hidden made the Panel the scrollport). Fixed after this round: overflow removed there, table headers made lg:sticky where wrappers scroll horizontally.
- Soul: figures are mono tabular everywhere; red now appears only on unfavorable variances/breaches, green only on favorable/pass — the semantic ladder holds in both themes.
- Consistency: chips, panels, hairlines all from the kit; the r0 "AppShell is not defined" crash on /benchmark (sample period) is fixed. Re-shoot as r2 to confirm the sticky fix.
