# The Capsule — closing gates, plant record

Every gate touched or added by this lane, with the plant that proves it
can fail. TC-2: plant → RED → revert → GREEN, with the diff and the red
output recorded. **No plant was ever committed**; `check_no_plants.mjs`
was re-run clean after each revert.

Run context: vite :5173 + engine :8000 PUBLIC_TEST_MODE, workspace
"Test workspace · Aug 2026", 2026-08-31.

---

## PLANT A — the resting floor comes back

**Target:** G1's `REST_LEADING_GAP_PX` (`e2e/design/capsule-craft.spec.ts`).

```diff
--- frontend/components/instrument/shell/CommandPalette.tsx
   const card = useCapsuleHeight({
-    min: 0,
+    min: typing || answerMode ? 0 : frame.restBudget - CAPSULE_BORDER,
     max: frame.maxHeight - CAPSULE_BORDER,
```

**RED (both viewports):**

```
[G1 1440 rest] 680×298 (33.1vh) ink=5.62% runs=7 lead=113px interior=29px
[G1 390  rest] 374×298 (35.3vh) ink=8.74% runs=5 lead=134px interior=35px
  ✘  G1 @1440 — the card carries what its size promises
  ✘  G1 @390  — the card carries what its size promises
Error: G1 @1440: 113px of air ABOVE the rest card's first painted thing (ceiling 32px).
Error: G1 @390:  134px of air ABOVE the rest card's first painted thing (ceiling 32px).
  2 failed
```

**GREEN after revert:**

```
[G1 1440 rest] 680×208 (23.1vh) ink=8.05%  runs=7 lead=24px interior=29px
[G1 390  rest] 374×187 (22.2vh) ink=13.93% runs=5 lead=24px interior=35px
  ✓ ✓
```

Note the old ceiling was **130px** and the defect measured **113px**.
The budget had been set above the defect it was pointed at, and the
file's own comment said so. At 32px the plant is 3.5× outside it.

---

## PLANT B — the trailing bucket chip comes back

**Target:** `check_capsule_craft.mjs` F2 (static) and G4 (live).

```diff
--- frontend/components/instrument/shell/CapsulePaletteRow.tsx
+import type { ReactNode } from "react";
   kbd?: string;
+  trailing?: ReactNode;
   destination?: boolean;
...
+      {item.trailing}
       {item.kbd && (
--- frontend/components/instrument/shell/CommandPalette.tsx
+import { BucketChip } from "@/components/cfo/BucketChip";
             searchText: s.category ?? "SKU",
+            trailing: <BucketChip bucket={s.bucket as import("@/lib/cfoApi").Bucket} />,
```

**RED — static, 200 ms:**

```
FAIL check_capsule_craft — 2 violation(s)
  [F2 no-category-column] .../CapsulePaletteRow.tsx:210 — a Capsule row renders `<x>.trailing (the generic trailing slot)`.
  [F2 no-category-column] .../CapsulePaletteRow.tsx:144 — a Capsule row renders `a `trailing` field on a row item`.
```

**RED — live G4:**

```
[G4 typing:range] rows=9  fam={"category":2,"sku":7}            offenders=7
[G4 typing:core]  rows=10 fam={"category":1,"sku":3,"concept":6} offenders=3
Error: G4: 10 row(s) carry a right-aligned trailing label:
  [palette-row · sku] "Core 200g"          → "Protect"  glyph gutter 515px (element gutter 12px)
  [palette-row · sku] "Core Smoked 250g"   → "Protect"  glyph gutter 465px (element gutter 12px)
  [palette-row · sku] "Core 1kg"           → "Protect"  glyph gutter 524px (element gutter 12px)
  [palette-row · sku] "Tinned 100g"        → "Fix"      glyph gutter 527px (element gutter 12px)
  [palette-row · sku] "Tinned 125g"        → "Fix"      glyph gutter 527px (element gutter 12px)
  [palette-row · sku] "Tinned in Oil 200g" → "Fix"      glyph gutter 496px (element gutter 12px)
  [palette-row · sku] "Orange Juice 1L"    → "Scale"    glyph gutter 495px (element gutter 12px)
  …
```

**GREEN after revert:** 0 offenders across all 15 states.

> **A note worth keeping.** The first attempt at this plant was
> malformed — the `BucketChip` import did not land, so the palette threw
> on render and unmounted. G4 failed, but with
> `locator.evaluate: Timeout … waiting for locator('[data-testid="command-palette"]')`
> instead of an offender list. A red is not evidence until you have read
> *which* red. It also identified the meaning of that message for
> finding 5 in `critique-final-r1.md`.

---

## PLANT C — the sweep narrows back to its original nine queries

**This is the plant that matters.** It reproduces the exact
configuration that printed GREEN last round: the offending product
(PLANT B still applied) plus the nine-query sweep.

```diff
--- e2e/design/capsule-craft.spec.ts
 const SWEEP_QUERIES = [
-  "dash", "sce", "work", "bench", "prod", "sett", "cash", "bal",
-  "a", "range", "core", "trans", "glossary", "zzqqxx",
+  "dash", "sce", "work", "bench", "prod", "sett", "cash", "bal", "zzqqxx",
 ];
```

**RED — and note it does NOT report zero offenders, it reports that it
never looked:**

```
[G4 family census] {"suggestion":1,"page":6,"concept":16,"company":1,"action":1,"ask":1}
Error: G4 PER-FAMILY VACUITY: a row family this surface can paint was not
summoned to its recorded floor, so "no row of that family has a category
column" is true of nothing THERE.
  action:   1 row(s) across the sweep, floor 4 (recorded query "a")
  glossary: 0 row(s) across the sweep, floor 1 (recorded query "glossary")
  category: 0 row(s) across the sweep, floor 2 (recorded query "range")
  sku:      0 row(s) across the sweep, floor 5 (recorded query "range")
  company:  1 row(s) across the sweep, floor 4 (recorded query "trans")
```

The old gate, in this exact configuration, printed green over 20
offending rows. The new one cannot: the families it did not summon are
named, with the queries that would have summoned them.

---

## PLANT D — a new row family, ungated

**Target:** `check_capsule_craft.mjs` F2b. Fails in 200 ms, before a
browser starts.

```diff
--- frontend/components/instrument/shell/CapsulePaletteRow.tsx
   "company",  // a listed company
+  "account",  // PLANT: a family the G4 sweep has no expectation for
 ] as const;
```

**RED:**

```
  F2b families=9 covered=11 in e2e/design/capsule-craft.spec.ts
FAIL check_capsule_craft — 1 violation(s)
  [F2b family-coverage] e2e/design/capsule-craft.spec.ts has no expectation
  for row family `account`, declared in .../CapsulePaletteRow.tsx.
```

**GREEN after revert.**

---

## PLANT E′ — the unreachable pin

`period` is pinned at **exactly zero**, not floored at zero. The plant
makes one row claim that family while leaving every other floor
satisfied, so the pin is the only thing that can fire.

```diff
--- frontend/components/instrument/shell/CommandPalette.tsx
         id: "page-/settings",
-        family: "page",
+        family: "period",
```

**RED:**

```
[G4 family census] {"suggestion":1,"page":13,"concept":22,"company":7,
                    "period":1,"action":6,"glossary":2,"category":7,"sku":10,"ask":1}
Error: G4 PIN BROKEN: a family recorded as unreachable on this stack painted rows.
  period: 1 row(s). `usePeriodStepper().periods` is empty on the test-mode stack,
  so the palette's period loop iterates nothing. If a period row appears, this
  stack now has periods: move `period` into FAMILY_EXPECT with the query that
  summoned it and the count it produced.
```

(A first attempt stamped `period` on the glossary row instead. That
tripped the *glossary* floor first and the pin never got to speak —
`page` has census 14 against floor 6, so the Settings row was the only
surgical choice. Recorded because "the gate went red" was not the same
as "the assertion I meant went red".)

**GREEN after revert.**

---

## Vacuity self-test

```
$ node scripts/check_capsule_craft.mjs --probe-vacuity
VACUITY PROBE PASSED: with discovery emptied the gate FAILS, as it must.
The floor is asserted after the loops, against the totals — not inside them,
where an empty discovery would skip the check entirely.
```

`familiesGated` is part of the `discoveryBroken` disjunction, so an F2b
that reads nothing is a FAIL and never a quiet pass.

---

## Post-revert state

```
$ node scripts/check_no_plants.mjs
GATE-WORK no-plants units=862 floor=400 label=product-source-files
PASS — no planted defects in 862 product source files.
```

---

## PLANT G — one state's family emptied while the TOTAL stays healthy

Found by adversarially re-reading this lane's own new gate (round 2).
The first draft of the per-family floor summed each family **across the
sweep**, which is the TC-6 disease wearing the new axis's clothes: `sku`
is painted by both `range` (7) and `core` (3), so `range` could collapse
to zero and the total would still clear the floor on `core` alone. The
recorded query was decoration — printed in the message, used by nothing,
and wrong without consequence.

The assertion now reads the count from the **state the expectation
names**. This plant isolates exactly the hole:

```diff
--- frontend/components/instrument/shell/CommandPalette.tsx
       for (const name of categories) {
+        if (q === "range") continue; // PLANT G — empty ONE state's category rows
         if (name.toLowerCase().includes(q)) {
```

**RED:**

```
[G4 typing:range]  rows=7  fam={"sku":7}     ← category rows gone
[G4 family census] {…,"category":5,"sku":10,…}
Error: G4 PER-FAMILY VACUITY: a row family this surface can paint was not
summoned to its recorded floor BY THE QUERY RECORDED FOR IT …
  category: 0 row(s) in state "typing:range", floor 2 (total across the whole sweep: 5)
```

Read the two numbers together: the **total is 5 against a floor of 2**,
so the sum-based draft of this assertion would have printed GREEN over a
state that renders nothing. **GREEN after revert.**

---

## PLANT H — an expectation aimed at a state nobody visits

The companion hole: a recorded query that is not in `SWEEP_QUERIES`
names a state that is never measured, so its floor can never fire.

```diff
--- e2e/design/capsule-craft.spec.ts
-  "a", "range", "core", "trans", "glossary", "zzqqxx",
+  "a", "core", "trans", "glossary", "zzqqxx", // PLANT H — "range" dropped
```

**RED:**

```
Error: G4 EXPECTATION AIMED AT NOTHING: a family's recorded query is not in
SWEEP_QUERIES, so the state it names was never measured.
  category: recorded query "range" → state "typing:range", which the sweep never visited
  sku:      recorded query "range" → state "typing:range", which the sweep never visited
States visited: rest typing:dash typing:sce typing:work typing:bench typing:prod
                typing:sett typing:cash typing:bal typing:a typing:core typing:trans
                typing:glossary typing:zzqqxx
```

**GREEN after revert.**

---

## Final state of the four axes G4 now floors on

| axis | assertion | proven by |
|---|---|---|
| FAMILY × QUERY | the query recorded for a family summons it to its floor | PLANT G |
| QUERY EXISTS | the recorded query is in the sweep | PLANT H |
| PIN | a family recorded unreachable is at exactly 0 | PLANT E′ |
| STATE | each typing state paints its recorded palette-row count | inherited (kept) |
| SOURCE | which component painted every row; no UNSTAMPED | inherited (kept) |
| TOTAL | 70 rows / 68 palette-rows across the sweep, floor 40 | inherited (raised) |
| COMPLETENESS | every declared family has an expectation, no stale ones | PLANT D (static) |

---

## Every gate command, final state

```
$ node scripts/check_tsc.mjs                → PASS (673 files, 10 known, 0 new)
$ node scripts/check_no_plants.mjs          → PASS (862 product source files)
$ node scripts/check_capsule_craft.mjs      → PASS (units=155 floor=12, familiesGated=11)
$ node scripts/check_capsule_craft.mjs --probe-vacuity → PROBE PASSED (fails when emptied)
$ node scripts/check_design_lint.mjs        → PASS (0 hex, 0 shadow, 0 serif)
$ npx playwright test e2e/design/capsule-craft.spec.ts --project=chromium → 22 passed
$ npx vitest run                            → 104 files, 1488 passed, 1 skipped
$ .venv/bin/python scripts/run_battery.py   → PASS 30/31 green, 1 VACUOUS (public-sitemaps)
$ npx playwright test e2e/design/capsule.spec.ts -g "K6"  → 3 passed, 1 FAILED (reported, not edited)
```

---

## PLANT I — the jsdom "no supplied string is printed" assertion

The vitest half gives each row the string its old category column
carried and asserts the rendered text does not contain it. Round 2 found
that the SKU row added this round carried `wasHint: "Protect"` with
`searchText: "SKU"` — so "Protect" was a word no code path could print
and the assertion passed **by construction**. That row's `searchText` is
now the literal `"Protect"`.

```diff
--- frontend/components/instrument/shell/CapsulePaletteRow.tsx
+      {item.searchText && <span className="text-ink-soft">{item.searchText}</span>}
       {item.kbd && (
```

**RED:**

```
 × G4 — the palette row prints no category column > no supplied string is
   parked against the row's right edge
   → G4: 6 row(s) print the string the old category column carried:
       Dashboard          → "Overview"
       Free cash flow     → "Cash Flow"
       Dec 2025           → "Switch period"
       Salami             → "Category"
       Core 200g          → "Protect"
       Banca Transilvania → "Open company"
```

**GREEN after revert:** 16 tests passed.
