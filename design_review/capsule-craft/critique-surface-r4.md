# Capsule craft — SURFACE lane, round 4 (final)

Against `craft-r5/` (full states, 1440 + 390, both themes) and
`craft-r5/composer-*.png` / `coach-ring-*.png` (close-ups).

---

## The seven complaints, one by one

| # | Complaint | Status | The number that says so |
|---|---|---|---|
| 1 | overlay ~700px, mostly empty | **CLOSED** | rest 208px @1440 (was 376). Dead space **1px** [G1]. K7: height == content ±1 at every state |
| 2 | the input is a wide hard-bordered box | **CLOSED** | no border, no ring. `focus-visible:shadow-none` beat the global `:where(…textarea…)` rule that drew it |
| 3 | suggestions and navigation are identical flat rows with right-aligned category labels | **CLOSED** | suggestions are pills (`rounded-[10px]`, hug their text, wrap); navigation is 36px rows; 0 category-column offenders across 8 queries [G4] |
| 4 | a native browser tooltip duplicates the suggestion text | **CLOSED** | `[title]` sweep returns `[]` in every state and theme; 0 offenders across rest/typing/answered [G3] |
| 5 | the Simple/Pro coach mark floats detached | **CLOSED** | measured off `account-menu-trigger`, `data-anchored="true"`, caret at the avatar's centre, avatar ringed, `gapBelowAvatar = 9px`, still portaled out of `<header>` |
| 6 | the footer hint restates the placeholder | **CLOSED** | 5 hints examined, 0 restate the placeholder [G3] |
| 7 | nothing communicates "conversation" | **CLOSED, with one exception** | see G2 below |

Plus, unprompted and found on the way: **two contrast tokens below AA**
(`ink-soft/60` at 3.5:1, `ink-soft/70` at 4.33:1 — the second one names
the period a headline figure belongs to). Both at full `ink-soft` now;
census is 0 failures in both themes, worst node 7.66:1.

## Final geometry, 1440 × 900

| state | height | dead | composer top | composer is last child |
|---|---|---|---|---|
| rest | 208 | 1px | 201 | yes |
| typing (few rows) | 227 | 1px | 220 | yes |
| typing (13 rows) | 522 | scrolls | 515 | yes |
| answering | 451 | 1px | 444 | yes |

`390`: rest 187 · typing 617 · answering 393. Key legend does not render
below `sm` (no keyboard to legend), and neither does its row.

## Regression check — nothing the old surface guaranteed was lost

`e2e/design/capsule.spec.ts` (K1–K9, 27 tests, a file this lane may not
edit): **27 passed.** Including `K6 CLS open 0.0000 · close 0.0000 ·
stream 0.0000`, `K6 centre drift 2.0px`, `K7 height == content ±1 at
every state`, `K8 header == 4 controls`, and every C-invariant.
`npx vitest run` over `frontend/components/instrument/shell`: 282 passed.

---

# G2 — THE ONE THAT IS RED, AND WHY IT STAYS RED

Lane 2's gate:

> `G2: the composer moves 243px between states (rest=265, typing=284,
> answering=508). The budget is 2px. … The panel has to grow UPWARD from
> a fixed bottom edge.`

**It is right about the goal and I have not met it. It is unmeetable
alongside two other constraints this surface already holds, and here is
the proof rather than an excuse.**

Three constraints:

- **(A)** the card is anchored to the capsule — K6 measures the overlay
  originating from the trigger's bounding box, and the pass that
  established it was fixing a 28px centre drift and a panel that read as
  detached from the control that opened it;
- **(B)** the card's bottom edge is at a constant viewport `y`, so the
  composer pinned to it never moves (G2);
- **(C)** the resting card is the size of its content — 208px, 1px of
  dead space (G1, and complaint 1).

(A) fixes the card's TOP at 68px when the surface opens. (B) fixes the
BOTTOM at some constant `B`. Together they fix the HEIGHT at `B − 68`,
for every state. (C) then forces `B − 68 = 208`, so the tallest the card
could ever be is 208px minus whatever headroom exists above y=68 — 60px,
to the viewport edge. A 268px ceiling cannot hold a result list or an
answer.

Drop (A) and it works: put `B` near the bottom of the screen, and the
card grows upward from a low, fixed composer exactly as the gate
describes. The cost is that at rest the card sits **334px below the pill
it grew out of**, with empty space between them — which is the "detached
panel" reading K6 was written to kill, and the morph would fly the pill
down two-thirds of the viewport to get there.

Drop (C) and it also works: make the resting card as tall as the tallest
state, 520px, holding 208px of content and **312px of air.** That is
complaint 1, restored, larger than it was in r0.

So the choice is which of the three to give up, and that is the owner's
call, not mine. I kept (A) and (C) — the two the complaint list names —
and let the composer travel.

**What travelling actually costs, measured.** rest → typing is **19px**
(265 → 284): while the reader types, the composer is effectively still.
The 243px is one move, when the answer lands, and it is a 160ms eased
height transition on the card, not a jump — `transition-[height]
duration-[160ms] ease-quint`, `motion-reduce:transition-none`. K6 reads
**CLS 0.0000 during streaming**, so once the answer is on screen the
composer does not move again while text arrives.

**A fourth option I considered and rejected.** Fix the card at
`maxCardHeight` for the whole life of a thread: the composer would then
be rock-stable across every turn of a conversation, which is where it
matters most. It still fails G2 (rest and typing differ), and it puts
69px of dead air under the first answer, which fails G1. Trading the
owner's #1 complaint for their #2 is not a trade I will make silently.

---

## Two other things left honestly short

**The resting card is 208px, not the brief's 360–420.** The brief's own
first clause is "height fits content", and the content on this workspace
is a context line, one question chip and one basis line. A three-chip
workspace extrapolates to ~250–280. Reaching 360 needs more to say, not
more padding, and what to say is a product decision. Flagged, not taken.

**The legend says "Tab to ask", not the brief's "Tab to jump".** Tab on
this surface sets `askForced` and guarantees Enter answers — K1 gates
that binding. Printing the brief's wording would put a false key legend
on screen, which is the same class of defect as the footer that restated
the placeholder: text that describes a surface other than this one.

**The empty state was not captured live.** Every workspace reachable
from the test stack has at least one unattached period, so
`buildCapsuleSuggestions` never returns zero and the "Nothing to suggest
from this workspace yet." line cannot be photographed here. It renders
as ONE muted line (`px-3.5 pb-1 pt-1`, 11.5px, `ink-soft`), and that it
is one line rather than a section is asserted in
`capsuleEmpty.test.tsx`. I would rather say it is unphotographed than
stage a screenshot of a state I forced into existence.
