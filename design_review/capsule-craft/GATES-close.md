# CLOSE LANE — the gates, and the proof each one can fail

Companion to `GATES.md` (the surface lane's record). This file covers only
what the CLOSE lane changed: G1 replaced, G2 and G1 parameterised over two
viewports, G3's tooltip census rescoped, G4 re-measured, the TC-7 predicate
added, and one new static check.

Everything below was run on 2026-08-31 against the authed test-mode stack
(vite :5173 + engine :8000 `PUBLIC_TEST_MODE`), Chromium.

---

## 1. THE RUN

`npx playwright test e2e/design/capsule-craft.spec.ts --project=chromium`
→ **22 passed** (was 16 passed / 4 failed before this lane, over 20 tests;
G1 and G2 are now two tests each, one per viewport).

`.venv/bin/python scripts/run_battery.py`
→ **PASS — 30/31 gates green, 1 VACUOUS (public-sitemaps)**.

`npx playwright test e2e/design/capsule.spec.ts --project=chromium`
→ **27 passed**. The K1–K9 regression suite, which this lane may not edit.
K6 (the morph and the capsule anchor) and K7 (dead space) both still hold
under a bottom-anchored card, because both measure the RESTING state and the
resting card's top still lands on the anchor.

`node scripts/check_capsule_craft.mjs` → **PASS**, `units=143 floor=12`.
`node scripts/check_capsule_craft.mjs --probe-vacuity` → **fails, as it must.**

`npx vitest run frontend/components/instrument/shell frontend/lib/__tests__`
→ **1065 passed, 1 skipped**.

`node scripts/check_tsc.mjs` → 671 files, 10 errors, baseline 10, **new 0**.
`node scripts/check_design_lint.mjs` → **PASS** (0 hex, 0 shadow, 0 serif).
`node scripts/check_no_plants.mjs` → **PASS**, 861 product source files.

---

## 2. G1 REPLACED — the old metric could not see its own defect

**Removed:** trailing dead space (`overlay.bottom − deepest descendant.bottom`,
budget 8px) and a 440px resting-height ceiling.

Both are blind to complaint 1. Dead space measured **3px on the build that
was complained about and 3px on the build that replaced it** — invariant to
the thing that changed. The 440px ceiling would have passed the original
376px surface outright.

**Added,** and these are the two things the adversarial critic actually used:

- **INK DENSITY** — Σ(area of every text run's client rects, taken with a
  `Range` over the text node — glyph boxes, not element boxes) ÷ card area.
  Cannot be gamed by hugging the last child, because it never looks at the
  last child.
- **GAPS** — the tallest band inside the card that no ink crosses, split into
  the LEADING band (above the first ink) and the INTERIOR ones. Air *between*
  children counts here and counted nowhere before.

**A correction the metric forced on itself.** The first draft counted the
dialog's own `<h2 class="sr-only">` title as ink: `sr-only` is a 1×1 clipped
box, but a `Range` over its text reports the text's natural, unclipped layout
boxes. It inflated rest density 5.62% → 8% and split the resting card's one
113px hole into a 2px lead and a 91px interior gap — moving the number the
gate exists to bound under a different budget. Text nobody can see is not
ink. Parents smaller than 2×2 are skipped.

### The floors, and where they come from

Measured on the shipped design, both themes identical, then rounded DOWN with
roughly a tenth of headroom:

| state | 1440×900 | floor | 390×844 | floor |
|---|---|---|---|---|
| rest | 298px · 33.1vh · **5.62%** | 5.0 | 268px · 31.8vh · **9.72%** | 8.5 |
| typing (13 rows) | 358px · 39.8vh · **13.71%** | 12.0 | 590px · 69.9vh · **14.16%** | 12.5 |
| typing (Tier-0) | 227px · 25.2vh · **5.30%** | 4.6 | 206px · 24.4vh · **7.88%** | 6.8 |
| answering | 358px · 39.8vh · **14.59%** | 12.5 | 499px · 59.1vh · **18.13%** | 15.5 |

`INTERIOR_GAP_PX = 56` (worst measured 49, at 390 answering).
`REST_LEADING_GAP_PX = 130` (measured 113 at 1440, 104 at 390).

Per state and per viewport, never a worst-of over the set — TC-6: a single
global floor survives one half collapsing while the other holds.

### PLANT P-A — the 700px mostly-empty overlay

```diff
-export const CAPSULE_REST_HEIGHT = 298;
+export const CAPSULE_REST_HEIGHT = 640; /* G8 PLANT P-A */
```

RED:
```
[G1 1440 rest] 680×630 (70vh) ink=2.66% runs=7 lead=445px interior=29px
Error: G1 @1440: the rest card is 2.66% ink against a 5% floor. 680×630
carrying 7 text runs.
```

### PLANT P-A2 — the same defect INSIDE the old gate's budget

```diff
+export const CAPSULE_REST_HEIGHT = 430; /* G8 PLANT P-A2 */
```

RED:
```
[G1 1440 rest] 680×430 (47.8vh) ink=3.89% runs=7 lead=245px interior=29px
Error: G1 @1440: the rest card is 3.89% ink against a 5% floor.
```

430px is under the old G1's 440px ceiling and the card still hugs its last
child, so **the old G1 was green on this**. 245px of air, and it passed.
That is the whole reason the metric was replaced.

**GREEN after revert:** rest 298px, 5.62%, lead 113px.

---

## 3. TWO VIEWPORTS — the reason 73vh shipped

`const VIEWPORT = { width: 1440, height: 900 }` was the only viewport in the
entire craft suite and there was no `setViewportSize` anywhere in it. G1 and
G2 now run under `test.use({ viewport })` for 1440×900 **and** 390×844.

### PLANT P-E — the shipped narrow branch, restored exactly

```diff
-              max-h-[70vh]
+              max-h-[82vh] sm:max-h-[70vh]
-    enabled: open,
+    enabled: open && !narrow,
-  const cardHeight = card.height ?? frame.restHeight - CAPSULE_BORDER;
+  const cardHeight = card.height ?? undefined;
```

RED:
```
[G1 390 typing] 374×617 (73vh) ink=12.27% runs=15 lead=27px interior=41px
Error: G1 @390: the typing card is 617px — 73vh, over the 590px (70vh)
ceiling. … 1440×900 was the only viewport in this suite, and the 390 typing
panel sat at 73vh through a round that certified it.
```

**617px / 73vh is the critic's reported number, reproduced to the pixel.**

---

## 4. G2 — the owner's ruling, and the plant

```
[G2 @1440 drift] rest=355 typing=355 answering=355 → 0px
[G2 @390  drift] rest=825 typing=825 answering=825 → 0px
```

### PLANT P-D — top-anchor the panel again

```diff
-          style={{ ...morph.style, top: "auto", bottom: frame.bottomOffset }}
+          style={{ ...morph.style, top: 68, bottom: "auto" }} /* G8 PLANT P-D */
```

RED:
```
[G2 drift] rest=355 typing=355 answering=415 → 60px
Error: G2 @1440: the composer moves 60px between states (rest=355,
typing=355, answering=415). The budget is 2px.
```

---

## 5. G4 — the glyph gutter, and why the old one fired 0 of 17

The old gate measured `trailing.left − label.right` between ELEMENT boxes.
The label span is `min-w-0 flex-1`, so its box stretches to fill the row and
its right edge sits `gap-3` = **12px** from the trailing span however short
the label is. Pinned at 12px against a 24px threshold.

### PLANT P-B — the category column back on the component that paints

```diff
+      {/* G8 PLANT P-B — the trailing category column, restored. */}
+      {item.searchText && !item.trailing && (
+        <span className="max-w-[38%] shrink-0 truncate text-[11px] text-ink-soft">
+          {item.searchText}
+        </span>
+      )}
       {item.trailing}
```

RED — 22 offenders, and note the two gutters on every line:
```
[G4 typing:cash] rows=13 by={"palette-row":13} offenders=13
Error: G4: 22 row(s) carry a right-aligned trailing label:
  [palette-row] "Dashboard" → "Overview"    glyph gutter 514px (element gutter 12px)
  [palette-row] "Scenarios" → "Analyze"     glyph gutter 528px (element gutter 12px)
  [palette-row] "Cash from Investing" → "Cash Flow"  glyph gutter 458px (element gutter 12px)
  … 19 more, every element gutter 12px
```

Element gutter 12px on all 22. Glyph gutter 375–531px. The reader sees the
second number.

---

## 6. TC-7 — the predicate that names the renderer

Every row-painting component stamps `data-row-source`. G4 prints the census
before it judges anything and asserts three things about it: no `UNSTAMPED`
row, no undeclared source, and `palette-row` clears the same floor the row
count does.

```
[G4 TC-7 census] {"suggestion":1,"palette-row":24}
```

### PLANT P-F — the renderer stops naming itself

```diff
-      data-row-source="palette-row"
```

RED:
```
[G4 TC-7 census] {"suggestion":1,"UNSTAMPED":24}
Error: TC-7: 24 row(s) carry no `data-row-source`.
```

### PLANT P-G — one state's row stops naming itself

The final 20-frame capture found `capsule-ask-fallback` — the only row in the
NO-MATCH state — carrying no stamp, in the one state G4's nine-query sweep
never visited, because every query in it matched something. The row is
stamped and `"zzqqxx"` joined the sweep. Removing the stamp again:

```
[G4 typing:zzqqxx] rows=1 by={"UNSTAMPED":1} offenders=0
[G4 TC-7 census] {"suggestion":1,"palette-row":24,"UNSTAMPED":1}
Error: TC-7: 1 row(s) carry no `data-row-source`.
```

GREEN after revert: `{"suggestion":1,"palette-row":24,"ask-fallback":1}`.

---

## 7. G3 — the tooltip census, rescoped; and a finding about the guard

Was: ROWS, inside the OVERLAY, at rest and while typing. Returned `[]` and
the complaint was closed. Now: whole document, four states including two
answered turns, with an explicit growth clause.

```
[G3 tooltips rest]               onSurface=0 elsewhere=9 guard=on re-homed=0/0
[G3 tooltips typing]             onSurface=0 elsewhere=9 guard=on re-homed=0/0
[G3 tooltips answered]           onSurface=0 elsewhere=9 guard=on re-homed=4/4
[G3 tooltips answered+follow-up] onSurface=0 elsewhere=9 guard=on re-homed=4/4
```

`elsewhere=9` is a positive control on the detector. `guard=on` and
`re-homed=4` are a positive control on the guard: a zero satisfied by an
answer that painted no figures, or by a guard that DELETED the strings
instead of moving them, is refused.

### PLANT P-C — and the finding it produced

```diff
+      title={label} /* G8 PLANT P-C */
       aria-label={label}
       data-testid="capsule-provenance-dot"
```

**The live gate stayed GREEN.** `re-homed` went 4 → 5; the guard neutralised
the plant at runtime, exactly as it neutralises the two foreign-owned sites.

That is a real weakness and it is why the static half exists. **F6** — new,
in `scripts/check_capsule_craft.mjs` — bans `title=` across every file the
Capsule owns (the shell tree plus `TopHeader.tsx`), licensing only the two
foreign files by name. Under the same plant:

```
FAIL check_capsule_craft — 1 violation(s)
  [F6 no-native-tooltip-anywhere] frontend/components/instrument/shell/
  capsuleAnswer/CapsuleFigures.tsx:164 — `title=` on the Capsule surface
```

F1's original exemption — "a `title` on a provenance dot is a control
describing an action" — is the exemption that let three tooltips per answered
turn ship. F6 has no exemptions, only a two-name license for files another
lane owns.

**A correction F6 forced on F1 and F2.** Both scanned raw source, and this
surface's components quote the banned patterns in the comments explaining why
they were removed. F1 fired on `CapsuleTooltipGuard`'s own header and F2 on
`CommandPalette`'s. All three now scan through `codeOnly()`, which blanks
comments and preserves line numbers. A gate that cannot tell prose from code
teaches people to stop naming defects in comments.

---

## 8. G5 — a red that could not be acted on

G5's shift report printed `nodes: ["DIV"]`. Two wrong fixes were built and
measured against it (both recorded in `critique-close-r2.md`) before the
report was taught to name its node:

```
Sources: [{"v":0.0049,"nodes":["DIV.mt-auto.pb-3.pt-3.5 in [capsule-stack]"]}]
```

— the TYPING thread, bottom-pinned, whose top-left moved every time the query
changed the row count under it. One line: the thread is bottom-pinned only at
REST, the one state whose content does not change under the reader.

```
[G5 open] cls=0  [G5 typing] cls=0  [G5 streaming] cls=0  [G5 close] cls=0
```

Same lesson as P3 in `GATES.md`: a gate whose red does not name the defect
gets triaged as flake, or — worse, here — gets two plausible fixes aimed at
the wrong thing.
