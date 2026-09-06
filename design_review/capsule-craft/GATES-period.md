# The Capsule — G4's `period` family: from a pinned zero to a measurement

Run context: vite :5173 + engine :8000 PUBLIC_TEST_MODE, workspace
"Test workspace", 2026-09-01. Lane owns `e2e/design/capsule-craft.spec.ts`
and `design_review/capsule-craft/**`. **No plant was committed**;
`check_no_plants.mjs` re-run clean after every revert, and the reverted
file's md5 checked against the pre-plant copy each time.

---

## 0. The state this round inherited

G4 pinned the `period` family at **exactly zero** and justified the pin:

> `usePeriodStepper().periods` is EMPTY on the test-mode stack: the demo
> period (`demo-meridian`) is a resolved sample id and is not a row in
> `financial_periods`, so the palette's period loop iterates nothing.

That is FALSE, and the pin — the two-sided device whose entire job is to
make a zero honest — was resting on it. So the category-column ban had
**never been checked against the `period` family at any viewport in any
theme**, while the gate printed green over 10 families.

A critic also found the pin **could not report itself when it broke**:
starvation was assertion (1), the pin assertion (2), and `expect` throws
— so under any other failure the census printed `period: 1` while the
thrown error named a different family.

---

## 1. What was actually wrong: the harness, not the product

`boot()` navigated ONCE and read the palette on a cold mount.

**Measured** (`design_review/capsule-craft/period-census.mjs`, output in
`period-r0/census.json`):

```
COLD MOUNT (one navigation + 8s settle — today's boot()):
  q="202"    rows=1  fam={"ask":1}
  q="aug"    rows=1  fam={"ask":1}
  q="(rest)" rows=1  fam={"suggestion":1}
  q="a"      rows=18 fam={"page":8,"action":5,"glossary":1,"category":4}

SAME MOUNT + 20s MORE:
  q="202"    rows=1  fam={"ask":1}          ← waiting is not the fix
  q="aug"    rows=1  fam={"ask":1}

SECOND NAVIGATION:
  q="202"    rows=4  fam={"period":4}  ["Sept 2026","Aug 2026","Jul 2026","Dec 2025"]
  q="aug"    rows=1  fam={"period":1}
  q="a"      rows=18 fam={"page":8,"action":5,"glossary":1,"period":1,"category":3}
```

### It was never "the data has not arrived"

`lib/queryPersist.ts` mirrors the TanStack cache to localStorage, which
makes the cache readable from the harness. Dumped at **t=8s on the cold
mount** — inside `boot()`'s own settle — the very entry
`usePeriodStepper` reads is already there and already successful:

```
COLD MOUNT, cache @8s: { "blob": "PRESENT", "total": 4, "periodish": [
  {"key":"[\"periods-with-documents\"]","status":"success"},
  {"key":"[\"period-documents\",\"demo-meridian\",\"financial\"]","status":"success"},
  {"key":"[\"org-periods\",\"00000000-0000-4000-8000-000000000002\"]","status":"success","n":4}
]}
```

…and the palette paints none of it.

### Where it actually breaks

Read out of the React fiber, palette open, same instant:

```
=== COLD MOUNT ===
  (no fiber in the chain holds an org list or a period payload)
  palette q=202 -> {"ask":1}

=== NAV 2 ===
  CommandPalette: h77.data: PAYLOAD{periods:1}
  AppShell: h13: ORGS[1000] | h30: ORGS[2] | h37.data: PAYLOAD{periods:4}
  palette q=202 -> {"period":4}
```

Network trace of the cold mount explains the shape:

```
+173ms  NET GET 200 /api/test-mode/session
+479ms  CONSOLE [org] auto-created default workspace: Test workspace
+721ms  NET POST 200 arr[1000] /rest/v1/rpc/list_workspaces
+1313ms NET GET 200 arr[4]     /rest/v1/financial_periods?select=…
```

`fetchOrgsForUser()` ran before the test-mode session was applied, so
`auth.getSession()` had no user and it returned `{orgs: [], error:false}`
— a FALSE zero, which tripped `shouldEnsureDefaultWorkspace` into
creating a workspace. The first page load of a fresh browser context
therefore ends with **no active workspace resolved**, so
`usePeriodStepper`'s direct feed is `enabled: !!org?.id` = false and the
merged list is empty.

**Measured:** it never recovers on that page load (20 further seconds
change nothing) and a reload fixes it in under 25 ms.
**Inferred from source, and marked as inference:** it cannot recover
because `lib/org.ts` memoises the list in the module-global
`cachedOrgListPromise` and `load()`'s deps are `[status, userId]`, both
stable.

> **Flagged to the owner, not fixed here:** this reads like a product
> defect in its own right — a first-time visitor on a cold browser gets a
> workspace-less dashboard until they reload. This lane owns the gate.

---

## 2. What was built

### 2.1 `boot()` navigates twice, and the populated state is AWAITED

The second navigation is the **precondition**. Nothing in `boot()`
asserts the list is populated; its own readiness signal is the app-shell
header carrying the Capsule trigger, awaited rather than slept for.

`warmUpFamily(page, family, query)` is the **await**, and it says what it
waited for: a painted `[data-row-family="<family>"]` row inside the
overlay with that family's recorded query typed. That is the closest
observable to `usePeriodStepper().periods` being non-empty, because
`CommandPalette` is the hook's **only live consumer** — `PeriodBreadcrumb`,
the other surface that reads it, is imported by nothing (verified by
grep), so no upstream DOM proxy exists to await instead.

Two properties stop this becoming the gate measuring its own wait:

* **it does not throw.** The outcome is returned and printed. A family
  whose warm-up expired is reported `UNMEASURED` — a violation — never a
  silent zero and never a Playwright timeout that hides the finding;
* **it waits for ONE row; the recorded floor demands FOUR.** Clearing the
  wait cannot clear the floor, and the ban itself is untouched by it.

Measured cost: the warm-up returns in **8-10 ms** after the reload.

### 2.2 `period` has a recorded expectation like every other family

Measured 2026-09-01 through the corrected boot, at **1440 and 390, dark
and light — four configurations, identical censuses**:

| query   | period rows | labels |
|---|---|---|
| `"202"` | **4** | Sept 2026 · Aug 2026 · Jul 2026 · Dec 2025 |
| `"aug"` | 1 | Aug 2026 |
| `"dec"` | 1 | Dec 2025 |
| `"sep"` | 1 | Sept 2026 |
| `"jul"` | 1 | Jul 2026 |
| `"a"`   | 1 | Aug 2026 (the visible cap displaces one `category` row) |

Recorded: **`period: { query: "202", floor: 3 }`**.

`"202"` because it summons the WHOLE family at once and nothing else
matches it — the census for that state is `{"period":4}` and nothing
else. Floor **3, not 4**, because the count only grows as months roll
(`useEnsureCurrentPeriod` adds the current month; every month label
contains "202" until 2030), so 3 is headroom against a rolled month while
still detecting the collapse this family can actually suffer — the list
going empty.

Every period row measured **one text run** (`glyphGutter: null`), with
the label parked 577-588px from the right edge at 1440 and 271-282px at
390. The ban holds — now measured rather than assumed.

### 2.3 UNVERIFIED is a first-class state the census prints

`FAMILY_UNREACHABLE` → **`FAMILY_UNVERIFIED`**, and the census computes a
state per family:

```
VERIFIED · STARVED · UNMEASURED · UNVERIFIED · PIN BROKEN · NO STATE · UNDECLARED
```

`UNVERIFIED` means the family paints nothing on this stack, so the ban is
true of nothing there. It is printed, counted **separately**, and
excluded from the evidence tally — the same discipline the battery gives
VACUOUS. It stays two-sided: a family here that paints a row is
`PIN BROKEN`.

```
[G4 @1440 evidence] VERIFIED 10/11 declared families · UNVERIFIED 1 (jump-row)
                    — pinned at zero and NOT counted as evidence
```

`jump-row` is the only one left, and its entry now records how the claim
was checked (grep: the module is exported and imported by nothing that
renders) rather than asserting it.

Cross-lane touch: `scripts/check_capsule_craft.mjs` (F2b) cross-checks
the two tables **by name**, so its one identifier was updated with them.
Leaving it would have made F2b read nothing and pass — the exact vacuity
both gates exist to refuse.

### 2.4 Every verdict is computed before any is asserted

Re-ordering alone does **not** fix the masking the critic found: putting
the pin first only moves the blind spot onto starvation. Any total order
over throwing assertions has this hole. So every verdict is computed
first, the full census is printed unconditionally, and **one** assertion
carries all of them, in a fixed presentational order (instrument
condition before reading). Nothing can mask anything.

Offenders now carry the STATE they were found in, not just the family, so
a finding names the keystroke that reproduces it.

### 2.5 G4 runs at both viewports

The expectation table carried "Both viewports produced identical
censuses, so one table serves both" while the gate ran at 1440 only. The
claim was true (re-measured) but unchecked — and a category column is a
LAYOUT, measured with `rb.right - last.right < 40` against a glyph
gutter, which is exactly the kind of thing that differs when the row is
374px wide instead of 680px. G4 is now per-viewport like G1 and G2, and
every log line names its viewport.

---

## 3. GREEN

```
[G4 @1440 warm-up] period via "202": populated after 8ms
[G4 @1440 family verdicts]
  page        VERIFIED     8 row(s) in typing:a       floor 6
  action      VERIFIED     5 row(s) in typing:a       floor 4
  glossary    VERIFIED     1 row(s) in typing:glossary floor 1
  concept     VERIFIED    13 row(s) in typing:cash    floor 8
  category    VERIFIED     2 row(s) in typing:range   floor 2
  sku         VERIFIED     7 row(s) in typing:range   floor 5
  company     VERIFIED     6 row(s) in typing:trans   floor 4
  suggestion  VERIFIED     1 row(s) in rest           floor 1
  ask         VERIFIED     1 row(s) in typing:zzqqxx  floor 1
  period      VERIFIED     4 row(s) in typing:202     floor 3  — awaited 8ms
  jump-row    UNVERIFIED   0 row(s) in (whole sweep)  pinned at 0  — …
[G4 @1440 evidence] VERIFIED 10/11 declared families · UNVERIFIED 1 (jump-row)
[G4 @1440 family census] {"suggestion":1,"page":14,"concept":22,"company":7,
                          "action":6,"glossary":2,"period":5,"category":6,
                          "sku":10,"ask":1}
[G4 @1440 TC-7 census] {"suggestion":1,"palette-row":72,"ask-fallback":1}
[G4 @390  warm-up] period via "202": populated after 9ms
[G4 @390  evidence] VERIFIED 10/11 declared families · UNVERIFIED 1 (jump-row)
[G4 @390  family census] {…identical…}
  2 passed (32.9s)
```

Note `period: 5` in the whole-sweep census against `4` in the recorded
state — the fifth is the one row `typing:a` paints. The floor is checked
per (STATE × FAMILY), so the total is reported but never asserted on.

---

## PLANT 1 — the trailing label comes back on a period row

**Target:** G4's ban, on the family that had never been checked.

```diff
--- frontend/components/instrument/shell/CapsulePaletteRow.tsx
+      {item.family === "period" && (
+        <span className="ml-auto shrink-0 text-[11px] text-ink-soft">Switch period</span>
+      )}
       {item.kbd && (
```

**RED, both viewports** — naming the family, both summoning queries, the
component, and the planted string:

```
G4 @1440 FAILED — 1 finding(s). Every check ran; none was masked by an earlier throw.

(1) THE BAN ITSELF — 5 row(s) carry a right-aligned trailing label, in family
    `period`, summoned by `typing:a`, `typing:202`.
      [typing:a   · palette-row · period] "Aug 2026"  → "Switch period"  glyph gutter 499px (element gutter 12px)
      [typing:202 · palette-row · period] "Sept 2026" → "Switch period"  glyph gutter 496px (element gutter 12px)
      [typing:202 · palette-row · period] "Aug 2026"  → "Switch period"  glyph gutter 499px (element gutter 12px)
      [typing:202 · palette-row · period] "Jul 2026"  → "Switch period"  glyph gutter 506px (element gutter 12px)
      [typing:202 · palette-row · period] "Dec 2025"  → "Switch period"  glyph gutter 499px (element gutter 12px)

G4 @390 FAILED — 1 finding(s).
(1) THE BAN ITSELF — 5 row(s) … in family `period`, summoned by `typing:a`, `typing:202`.
      [typing:a   · palette-row · period] "Aug 2026"  → "Switch period"  glyph gutter 193px (element gutter 12px)
      [typing:202 · palette-row · period] "Sept 2026" → "Switch period"  glyph gutter 190px (element gutter 12px)
      …
  2 failed
```

The two element gutters are both **12px** — pinned by the label's
`flex-1` — while the glyph gutters are 499px and 193px. That is the
difference between the box and the reader, and the reason the 390 lane is
not decoration: the same defect measures a quarter of the width there.

**GREEN after revert:** 2 passed. `check_no_plants.mjs` PASS; reverted
file md5 `f7c33fa51cf3ef2a5e469f205487c339`, identical to the pre-plant
copy.

---

## PLANT 2 — the old harness, restored

**Target:** the new `UNMEASURED` state. This is the "would the fix have
caught the original bug" plant — the one that matters most, because the
original bug was a green.

```diff
--- e2e/design/capsule-craft.spec.ts   (boot)
+  // the reload disabled, restoring the ONE-NAVIGATION boot
+  if (process.env.G4_PLANT_COLD_BOOT === "1") return;
   await page.goto(route, { waitUntil: "domcontentloaded" });
```

**RED:**

```
[G4 warm-up] period via "202": NEVER POPULATED after 20008ms

G4 FAILED — 2 finding(s). Every check ran; none was masked by an earlier throw.

(1) UNMEASURED — a family whose data is awaited (FAMILY_WARMUP) never populated,
    so its ban was checked against nothing. This is a RED and not a zero, and
    that is the entire lesson of this round: `period` spent weeks reported as a
    clean zero produced by a harness that never summoned it.
      period: warm-up expired after 20010ms without a single row — the family's
      data never arrived on this run, so its ban was checked against nothing

(2) PER-STATE VACUITY — a state painted fewer palette-rows than it is supposed to.
    Census: … typing:zzqqxx=0 typing:202=0
      typing:202: 0 palette-rows, expected 1
```

Under the old harness this exact situation printed **green**. It now reds
twice and names the cause.

**GREEN after revert:** spec md5 back to `0b6bc4e3629ecbb9c2ffcdc921c5e450`.

---

## PLANT 3 — the pin breaks *and* a family starves, in one run

**Target:** the masking defect the critic named — "the pin cannot report
itself when it breaks". Two plants at once, because one is not a proof: a
single failure cannot demonstrate that nothing was hidden behind it.

```diff
--- e2e/design/capsule-craft.spec.ts
-  period: { query: "202", floor: 3 },        // out of FAMILY_EXPECT
+  period: { expectRows: 0, why: "the palette's period loop iterates nothing" },
                                              // …and back into FAMILY_UNVERIFIED
-  concept: { query: "cash", floor: 8 },
+  concept: { query: "cash", floor: 99 },     // simultaneous starvation
```

**RED — both findings, pin first:**

```
G4 FAILED — 2 finding(s). Every check ran; none was masked by an earlier throw.

(1) PIN BROKEN — a family declared UNVERIFIED on this stack painted rows.
    Reported first because it means the ground moved: a family nobody has ever
    checked the category-column ban against is now on screen. …
      period: 5 row(s). the palette's period loop iterates nothing

(2) PER-FAMILY VACUITY — a row family this surface can paint was not summoned to
    its recorded floor BY THE QUERY RECORDED FOR IT …
      concept: 13 row(s) in state "typing:cash", floor 99 (total across the whole sweep: 22)
```

Under the previous version, (2) was assertion **(1)** and would have
thrown before the pin ran — the critic's finding exactly, reproduced and
then closed. Note also that finding (1) prints the false justification
verbatim, so the reader sees the claim that the evidence just refuted.

**GREEN after revert.**

---

## PLANT 4 — the warm-up itself aimed at nothing

**Target:** the one silent skip the new machinery introduced. The warm-up
loop originally did `if (!exp) continue;` — so a family listed in
`FAMILY_WARMUP` with no recorded expectation would have been skipped
without a word, disarming the await this round exists to add. Collected
and reported instead.

```diff
--- e2e/design/capsule-craft.spec.ts
-const FAMILY_WARMUP: readonly string[] = ["period"];
+const FAMILY_WARMUP: readonly string[] = ["period", "jump-row"];
```

**RED, both viewports:**

```
G4 @1440 FAILED — 1 finding(s). Every check ran; none was masked by an earlier throw.
(1) WARM-UP AIMED AT NOTHING — a family in FAMILY_WARMUP has no recorded
    expectation, so nothing was awaited for it and its rows were read whenever
    they happened to be there. That is the pre-fix harness wearing the fix's clothes.
      jump-row: listed in FAMILY_WARMUP but has no FAMILY_EXPECT entry, so there
      is no recorded query to summon it with and nothing was awaited
G4 @390 FAILED — 1 finding(s). … (identical)
```

**GREEN after revert:** spec md5 back to `faa46a6dd6af460b922a50cb6e02b562`.

---

## Verification

```
$ node scripts/check_tsc.mjs                → PASS (673 files, 10 known, 0 new)
$ node scripts/check_no_plants.mjs          → PASS (862 product source files)
$ node scripts/check_capsule_craft.mjs      → PASS (F2b families=8 covered=11)
$ node scripts/check_capsule_craft.mjs --probe-vacuity → PROBE PASSED
$ npx playwright test e2e/design/capsule-craft.spec.ts → 22 passed (pre-viewport-split)
                                                       → 23 passed (G4 now ×2)
$ .venv/bin/python scripts/run_battery.py   → PASS 32/33 green, 1 VACUOUS (public-sitemaps)
```

**`e2e/` is typechecked by NO tsconfig project** — `tsconfig.app.json`
includes `frontend` only, `tsconfig.node.json` includes `vite.config.ts`,
and Playwright transpiles without checking. So `check_tsc.mjs` passing
says **nothing** about this spec (TC-9, again, one directory over). This
file was typechecked directly:

```
$ npx tsc --noEmit --skipLibCheck --strict --target es2022 --module esnext \
      --moduleResolution bundler --lib es2022,dom,dom.iterable \
      e2e/design/capsule-craft.spec.ts   → exit 0
```

---

## Open, and named rather than left implicit

1. **`e2e/` is outside every tsconfig project.** A type error in any spec
   in this suite is invisible to the battery's `tsc` gate. Not this
   lane's to fix; recorded because the next lane will otherwise assume
   coverage that does not exist.
2. **`jump-row` remains UNVERIFIED.** Its ban is unchecked because no
   surface paints one. That is now stated on its own line in every run
   rather than living inside a passing green.
3. **The cold-boot workspace resolution** (§1) is a candidate product
   defect, flagged not fixed.
4. **`period`'s floor is time-dependent in one direction only.** It grows
   as months roll. If this stack is ever reset to a single period, the
   floor of 3 reds — correctly, as a coverage collapse — and the fix is
   to re-measure and record, never to lower it.
