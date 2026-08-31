# Capsule — CLOSE lane, round 2: the geometry, and two configurations that looked right

Measured against `close-r1/` … `close-r4/`. Each round is a full
4 states × 2 viewports × 2 themes capture plus `PROBE.json`.

---

## What landed in round 2

| | Change | Measured after |
|---|---|---|
| 3 | the category column removed from `CapsulePaletteRow` — the component that actually paints the rows | `trail=0` at 1440 and 390, every query |
| 4 | `title` deleted at source in the three files this lane owns; the two foreign ones re-homed at the card's boundary | 0 in-overlay in every state, including two answered turns |
| — | the card bottom-anchored, `max-h-[70vh]` at every width, border accounted for | 390 typing **590px = 69.9vh** (was 617 / 73.0vh) |
| G2 | constant bottom edge | **0px drift** at 1440 and at 390 |

## The 2px that made 70vh into 70.2vh

The ceiling was applied to the STACK; the gate measures the CARD. The card's
1px border top and bottom put 390's typing state at 591px = 70.02vh against
a 70vh budget. `Math.round(844 × 0.7)` is 591 and 591/844 is 0.7002, so the
rounding contributed the rest. `CAPSULE_BORDER` is a named constant now and
the ceiling floors instead of rounding.

## Three configurations, and why the first two were wrong

The owner's ruling — constant bottom edge above capsule anchoring above
content-sized rest — was implemented three times before it was right. All
three are recorded because two of them measured *better* on the gate that
was looking and worse on the one that was not.

**A. Answer card pinned to `maxHeight`, thread bottom-pinned everywhere.**
Chosen to stop the card resizing while text streamed. G5 still read
**0.0049**, and at 390 a short Tier-0 answer sat in a 590px card at
**11.41% ink with a 217px band above it** — a fixed canvas that is only
honest when it is full.

**B. Same, thread top-pinned in answer mode.** Moved the slack to where it
could be seen: **141px of air UNDER the answer at 390.** That is complaint 1
rebuilt one state to the left, and the new G1 said so.

**C. What shipped.** Neither A nor B addressed the cause, because the cause
was not in answer mode at all. G5's shift report was taught to name its node
— it had been printing `"DIV"` — and it named
`DIV.mt-auto.pb-3.pt-3.5 in [capsule-stack]`: **the TYPING thread**,
bottom-pinned, whose top-left moved every time the query changed the row
count under it. Recorded in the streaming phase, produced by the query change
before it.

So: the thread is bottom-pinned only at REST, the one state whose content
does not change under the reader. Everywhere else it is top-pinned and grows
downward. With that one line changed, the card can be content-sized in every
state, which is what it wanted to be:

```
[G5 open] cls=0   [G5 typing] cls=0   [G5 streaming] cls=0   [G5 close] cls=0
```

A gate whose red says `"DIV"` cost two wrong fixes. It says
`DIV.mt-auto.pb-3.pt-3.5 in [capsule-stack]` now.

## Final geometry

| state | 1440×900 | 390×844 |
|---|---|---|
| rest | 298px · 33.1vh · 5.62% ink | 268px · 31.8vh · 9.72% |
| typing (13 rows) | 358px · 39.8vh · 13.71% | 590px · 69.9vh · 14.16% |
| typing (Tier-0, no rows) | 227px · 25.2vh · 5.30% | 206px · 24.4vh · 7.88% |
| answering | 358px · 39.8vh · 14.59% | 499px · 59.1vh · 18.13% |

Composer bottom: **355px in all three states at 1440; 825px in all three at
390.** Card bottom edge: 366 / 836, constant by construction.

## Still wrong at the end of round 2

- **113px of air above the resting card's content at 1440** (104px at 390).
  Named and bounded, not fixed. See round 3.
- The result list clips its last row mid-height against the composer's
  hairline. Pre-existing (the 522px list did it too) and more visible now
  that the card is shorter.
