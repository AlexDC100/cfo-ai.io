# The Capsule — closing critique, round 2

Round 1 said both defects were closed on the measurement that defined
them. Round 2 stopped looking at the product and looked at **the gates I
had just written**, which is where the last four rounds of this lane
found their defects. It found three, two of them in my own work.

**Captures:** `design_review/capsule-craft/critique-r2` (16 frames).
Geometry byte-identical to `critique-r1`.

---

## 1. My own per-family floor had the TC-6 disease

`FAMILY_EXPECT` records a query per family. The first draft asserted the
family's **sum across the whole sweep**:

```ts
.map(([family, exp]) => ({ family, got: familyTally[family] ?? 0 }))
.filter(({ exp, got }) => got < exp.floor)
```

`sku` is painted by `range` (7 rows) **and** `core` (3). Floor 5. So
`range` could paint zero SKUs and the total would still clear the floor
on `core` alone — and the recorded query, the thing the whole table is
built around, was used by nothing. It was printed in the failure message
and could have been wrong without consequence.

**That is the disease this gate was rewritten to cure, reintroduced one
level down.** A floor on a sum cannot see one addend collapse — the rule
says so in those words, and I wrote the sum anyway.

Fixed: the count is read from the state the expectation NAMES, per
(state × family). Proven with **PLANT G**: emptying `category` from the
`range` state only gives

```
category: 0 row(s) in state "typing:range", floor 2 (total across the whole sweep: 5)
```

Total 5 against floor 2 — the sum-based draft prints GREEN over a state
that renders nothing.

## 2. An expectation could name a state nobody visits

The companion hole: a family whose recorded query is not in
`SWEEP_QUERIES` names a state that is never measured, so its floor can
never fire — a floor that is structurally unable to fail, which is the
same false green with better paperwork. Now an explicit failure
(**PLANT H**), listing the states that were visited.

## 3. The jsdom row test had a decorative assertion

The vitest half checks "no supplied string reaches the DOM" by giving
each row the string its old category column carried and asserting the
rendered text does not contain it. The SKU row I added carried
`wasHint: "Protect"` with `searchText: "SKU"` — so "Protect" was a word
no code path could print, and the assertion passed **by construction**.

Fixed: that row's `searchText` is now the literal `"Protect"`, so the
check is a real one — a string the host supplied, that the reader must
not see. Proven with **PLANT I** (render `item.searchText`): six rows
red, `Core 200g → "Protect"` among them.

---

## 4. Two smaller things, fixed

- **`data-rest-budget` was stamped at 390, where it governs nothing.**
  Below `CAPSULE_NARROW_MAX` the bottom edge is the viewport's; the
  budget plays no part. A stamp naming a number that governs nothing is
  how a future gate ends up asserting against the wrong quantity. Now
  wide-only.
- **`CAPSULE_ANCHOR_TOP`'s doc comment was false after the change.** It
  said "where the RESTING card's top edge sits at ≥640px" — true only
  when the content fills the budget. Corrected, with a pointer to the
  algebra.

---

## 5. The K6 alternative, built and priced rather than argued

Round 1 asserted that keeping K6 would cost the answer canvas. Round 2
**built it and measured it** rather than leaving that as a claim — see
`critique-final-r1.md` §"The open conflict" for the table. Summary:
`CAPSULE_REST_BUDGET = 208` turns K6 green (gap 23.5px) and costs the
typing and answering cards 90px each at 1440, and it is a fit to one
data point: a three-chip workspace then rests at y=8, **covering the
pill it grew out of**, and K6 passes that because a negative gap is
≤ 24.

---

## Still open after round 2

| # | finding | status |
|---|---|---|
| 1 | K6 gap 113.5px vs 24px tolerance | **owner decision**, priced, not edited |
| 2 | Typing list clips 1.5 rows at 1440 with no scroll affordance | pre-existing, outside both defects, recorded |
| 3 | `suggestion` family depends on a network-fed chip | mitigated by a bounded wait in `openSurface` |
| 4 | Harness flake: 2 of 6 full runs failed one test each | r3 §5 — confounded by a concurrent lane in the same tree; instrument NOT given a retry on a guess |
| 5 | G4's `rightAligned` test is `row.right − text.right < 40` | a trailing node parked >40px from the edge would be missed; threshold inherited, recorded |
| 6 | `scripts/check_capsule_craft.mjs` is in NO battery gate and NO CI workflow | **new this round** — see round 3 |
