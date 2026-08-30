# Capsule craft — SURFACE lane, round 1

Written against `design_review/capsule-craft/craft-r0/` (the surface as
shipped in 62fba00) and `craft-r1/` (the first pass of the compositional
flip). Numbers come from `craft-r*/MEASURE.json`, produced by
`design_review/capsule-craft/shoot.mjs`, which drives the overlay into
each state and reads `getBoundingClientRect()` — the states this surface
lives in do not exist in a route capture, so `scripts/design_shots.mjs`
cannot see any of this.

> Lane note: `e2e/design/capsule-craft.spec.ts` and
> `frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx`
> are **lane 2's**, written during this same session. I did not touch
> them. Where a number below is theirs it is labelled `[G…]`.

---

## r0 — the seven complaints, checked one by one against the capture

| # | Complaint | Verdict on r0 | Evidence |
|---|---|---|---|
| 1 | overlay ~700px and mostly empty | **PARTLY WRONG, and the real number is worse in a different way** | 376px at rest / 524px typing at 1440. Not 700. But the panel is 720px WIDE and the input sits alone at the top with an 8-row list under it — the emptiness is horizontal and structural, not vertical |
| 2 | the input is a wide hard-bordered box | **CONFIRMED, and the cause was not in the component** | see "the box nobody wrote" below |
| 3 | suggestions and navigation are identical flat rows with right-aligned category labels | **CONFIRMED** | 40px rows both; `Dashboard … Overview`, `Scenarios … Analyze`, and ten `Cash Flow … LEARN` pairs in the typing capture |
| 4 | a native browser tooltip duplicates the suggestion text | **CONFIRMED** | `CapsuleSuggestionList` set `title={question — basis}` |
| 5 | the Simple/Pro coach mark floats detached | **CONFIRMED** | `right-3 top-[60px]` — a viewport-corner offset, not a position derived from the control it is about |
| 6 | the footer hint restates the placeholder | **CONFIRMED** | placeholder "Ask anything — or jump anywhere" / footer "Type to ask, or to jump anywhere" |
| 7 | nothing communicates "conversation" | **CONFIRMED** | input at top, list below, and Enter swapped the whole card for a second one with an `← ANSWER … Esc` bar |

Complaint 1 is the one I have to be straight about: **the panel was not
700px.** Reporting it as if it were would make every later number
suspect. What is true is that the resting panel was a 720×376 rectangle
whose content was one context line, one suggestion and four navigation
rows, and that the ratio of chrome to substance is what reads as
emptiness.

---

## The box nobody wrote

Complaint 2 has a cause worth recording, because rewriting the markup
would not have fixed it and I would have shipped r1 believing it had.

`frontend/index.css` carries

```css
:where(button, [role="button"], a, input, select, textarea, …):focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
  border-radius: var(--radius-sm);
}
```

and the Capsule's input is focused the instant the surface opens (Radix
`Dialog.Content` autofocuses its first focusable child). So the ring was
on in **every screenshot ever taken of this surface**, permanently, and
it is the 616px rounded rectangle in the r0 frame. The old component set
no border at all.

r1 moved the input to the bottom, deleted the border it never had, and
**the box was still there** — visible in `craft-r1/rest--1440--dark.png`.
The fix is `focus-visible:shadow-none` on the textarea: `:where()`
contributes zero specificity, so the global rule is `(0,1,0)` and one
utility class beats it. The stylesheet is another lane's file and was not
edited. The focus indicator is not lost — it is replaced by the 2px
accent underline plus a brand caret, which is a visible focus indicator
under WCAG 2.4.7 and a better one for a composer.

---

## What r1 changed, and what it did not

| | r0 | r1 |
|---|---|---|
| rest height @1440 | 376 | 192 |
| typing height | 524 | 632 |
| answer height | 363 | 381 |
| panel width | 720 | 680 |
| input position | top | bottom |
| mode switch on Enter | header bar swap | none |
| `title` attributes on the surface | 2 kinds | 0 |

### Still wrong after r1 — named, in the order I intend to fix them

1. **The focus ring box survives.** Complaint 2 is not closed. (Fixed in
   r2.)
2. **The key legend sits between the content and the input.** I put it in
   the composer's `above` slot; it reads as a label stranded in the
   middle of the card rather than as anything's caption.
3. **The coach mark has moved by 0px.** The anchor runs
   (`data-anchored="true"`) and computes `left = 1164`, which is
   *identical* to the `right-3` fallback because the clamp binds at that
   viewport. A caret was added and is invisible at 1x. Complaint 5 is
   not closed by arithmetic alone.
4. **192px at rest is under the brief's 360–420 target**, and I am not
   going to pad it. Stated properly in r3.
5. **The typing state is 632px = 70vh of list.** Capping at 70vh is the
   brief; filling 70vh with nine glossary rows is the menu this pass
   exists to stop being.
6. **The `LEARN` tag repeats once per row** under a section label that
   already says LEARN — the same defect as `Overview`/`Analyze`, which I
   removed, in a colour I did not remove.

### What I deliberately did NOT do, and will defend

- **The legend says "Tab to ask", not the brief's "Tab to jump".** Tab on
  this surface sets `askForced` and guarantees Enter answers; it does not
  jump. Printing the brief's wording would put a false key legend on
  screen. Changing the binding to match the wording is a product change
  nobody asked for, and K1 gates the current one.
- **⌘↵ carries two words.** ⌘↵ hands the thread to the full chat page —
  it does not send. A bare `⌘↵` beside a send button reads as "this is
  how you send", so the hint says `⌘↵ full chat` and only while the
  composer is focused and non-empty.
