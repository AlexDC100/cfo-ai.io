# Capsule craft — SURFACE lane, round 3

Against `craft-r3/` and `craft-r4/` (zoomed close-ups from
`design_review/capsule-craft/zoom.mjs`, at deviceScaleFactor 2 and 4 —
the two things a full-page shot cannot settle are the composer's edge
treatment and whether the coach mark reads as attached).

---

## Closed this round

**The typing state stopped being a list.** `maxCardHeight` is now
`min(70vh, 520)` on desktop. 70vh is the ceiling the brief sets; 520 is
the one proportion sets — a 680×630 rectangle of nine glossary rows is
the menu this pass exists to stop being, and 680×520 is a card. The tail
goes behind the internal scroll, where a tail belongs. Whichever is
smaller wins, so a short viewport still gets 70vh and never more.

**The repeated `LEARN` tag is gone.** Ten identical accent-coloured
words down the right edge, under a section label that already said
LEARN, competing with the ten different words on the left that are the
actual choice. Same defect as `Overview`/`Analyze`. The concept's own
category (`Cash Flow`, `Liquidity`) stays — it differs per row and is
the only thing separating two similarly-named metrics.

**The `hint` suppression got a rule instead of a blanket.** `hint` is
hidden for a `destination` (where it was the rail group) and for any row
carrying a `trailing` node; it is kept everywhere else, because
elsewhere it is identity, not category — a company row is labelled
"Banca Transilvania" and reached by "TLV", and dropping the hint would
take the ticker off the screen. Deleting decoration, not information.

**Complaint 5 — the detached coach mark — is closed.** The caret was
correct and invisible, so the mark now also **rings the control it
names**: a `ring-2 ring-brand/70` around the avatar, drawn by the coach
mark itself from the box it measured, in its own portal at z-45 so it
clears the header's opaque z-40 background. `pointer-events-none`
throughout, so it can no more swallow a click than the caret can; the
card stays at z-30 for exactly the reason its header gives.
`craft-r4/coach-ring--light.png` is the before/after: the avatar is
circled, the caret notches the card's top edge directly under it, and
`gapBelowAvatar = 9px`. `headerLaw.test.tsx` (20 tests) still green —
portaled out of `<header>`, Escape-dismissible, never re-shown.

Why the mark rings the avatar instead of `AccountMenu` doing it: that is
another lane's file, and threading an "I am being pointed at" state out
of it and back would put a cross-lane dependency in the header for a
one-time hint. The mark already measures the box; it can draw on it.

## Measured, r3/r4 @1440

| state | height | dead | composer top | notes |
|---|---|---|---|---|
| rest | 208 | 2px | 201 | composer is `lastElementChild` |
| typing | 522 | (scrolls) | 515 | 520 cap + 2px border — the cap is live |
| answer | 387 | 2px | 380 | |

Contrast census: 0 failures both themes, worst 7.66:1 (dark).
`[title]` sweep: `[]`. Coach: `anchored=true`, `hasCaret=true`,
`insideHeader=false`.

---

## The resting height, stated plainly

**208px at 1440. The brief asked for 360–420.** I am reporting the
number rather than reaching it.

The brief's own first clause is "height fits content", and on this
workspace the content is: one context line, one question chip, one basis
line. That is 208px including the composer. There is nothing honest to
put in the other 150px. Padding to 360 would reintroduce the exact defect
the target exists to prevent, measured by lane 2's G1 as dead space —
which currently reads **1px**.

Extrapolating from the measured parts, a workspace that yields the full
three chips lands at roughly **250–280px**: chips wrap two-per-row at
680px (+34px per extra row, +8px gap), and two or three distinct bases
grow the basis line by ~13px per line. Still short of 360.

If the owner wants 360 at rest, the honest way to get there is more
content — a fourth zone, or recent questions back on the surface — not
more padding. That is a product decision, not a craft one, so it is
flagged rather than taken.

---

## Still wrong after r3

1. **Two contrast tokens below AA**, found by lane 2's G6 (a census I
   was also running, on a narrower scope — theirs walks the answering
   state, mine stopped at rest):
   - `text-ink-soft/60` on the context strip's `·` separator → **3.5:1**
   - `text-ink-soft/70` on the fact card's period label → **4.33:1**
   Both fixed to full `ink-soft` in r4. The second one matters most: it
   names the period the headline figure belongs to.
2. **The legend is still below the input** (moved in r4).
3. **The composer moves 243px between rest and answering.** The one that
   does not have a fix. Round 4.
