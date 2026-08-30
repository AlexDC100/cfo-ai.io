# Capsule craft — SURFACE lane, round 2

Against `craft-r2/` + `craft-r2/MEASURE-FULL.json`
(`design_review/capsule-craft/measure.mjs` — geometry, a WCAG contrast
census over the composited pixel, a `[title]` sweep, and the coach
mark's anchor).

---

## Closed this round

**Complaint 2 — the form field.** `focus-visible:shadow-none` on the
textarea. `craft-r2/rest--1440--light.png` is the first capture of this
surface in which the input has no box around it. The composer now reads
as: sparkles · text · send. Contrast census over the resting surface:
**0 failures in either theme**, worst node 5.58:1 against 4.5.

**Complaint 4 — the native tooltip.** `[title]` sweep over the whole
overlay returns `[]` in all four (theme × viewport) combinations.

**Complaint 6 — the restated footer.** Deleted. One right-aligned legend.

**Complaint 7 — conversation.** `craft-r2/answer--1440--dark.png`: the
question is a right-aligned accent bubble, the answer is left-aligned
under it, the fact card is first, the citation is one quiet line, the
follow-up chips sit directly above the composer, and the composer has
not moved or changed. No `← ANSWER` bar. It reads as a thread.

## Measured, r2 @1440

| state | height | dead space | composer top | focused | underline |
|---|---|---|---|---|---|
| rest | 190 | 2px | 183 | yes | 678px |
| typing | 630 | 2px | 623 | yes | 678px |
| answer | 382 | 2px | 375 | yes | 678px |

---

## THE DEFECT I FOUND IN MY OWN WORK — the animated height never animated

The stack was

```html
<div class="flex min-h-0 flex-1 flex-col …" style="height: 520px">
```

`flex-1` expands to `flex: 1 1 0%`, and **a flex item's `flex-basis`
replaces `height` as its main size.** So `useCapsuleHeight` measured the
content, set state, React wrote the inline style to the DOM — and the
browser used `0% + grow`, which resolves to the content height. Every
capture through r2 was content-sized and un-animated while the code, its
header comment and its 60-line rationale all claimed otherwise.

Nothing failed. The panel looked *right*, because content-height is what
it wanted anyway. This is the same disease as the morph anchor that was
"written, exported, unit-tested and never called" — the CSS form of it,
where the code runs and the platform silently discards the result.

Two consequences, both kept:

- `flex-1` removed from the stack (the list inside keeps it — it is
  supposed to fill whatever the stack turns out to be);
- the stack now carries `data-measured="<px>"`, written only on a frame
  where a real measurement exists, so a gate can assert the hook was
  **invoked** rather than merely correct.

The proof it is live: after the fix, the typing state at 1440 dropped
from 630 → **522**, which is the 520px cap plus the card's 2px border.
Before the fix that cap did nothing at all.

---

## Still wrong after r2

1. **The coach mark is still detached.** `centreDrift = 110px` — the
   card cannot centre under an avatar that sits 34px from the viewport
   edge, so the clamp puts it in the same place `right-3` did. A 4x
   close-up (`craft-r4/coach-caret-4x--light.png`) shows the caret is
   genuinely rendering and genuinely under the avatar — and that at 1x it
   is a 1px hairline notch in a near-white edge on a near-white page.
   Correct arithmetic, invisible result.
2. **The legend is below the input.** Moved there in r2 to stop it
   floating mid-card. Lane 2's G2 then measured it at +25px below the
   composer and failed, with a better reason than I had for either
   placement: *anything under the input is the surface asking the reader
   to look away from where they type.* Their call, not mine — the legend
   goes back above, on the composer's own raised fill.
3. **The typing state is 70vh of list.**
4. **The repeated `LEARN` tag.**
5. **190px at rest.** Under the brief's target and I am still not
   padding it.
6. **`composerIsLast` reads false** — I wrapped the composer in a ref
   div, so the card's last child is a wrapper. A measurement artifact,
   but "the composer is the bottom-most thing on the surface" is a claim
   a gate reads off `lastElementChild`, so the ref moves onto the block.
