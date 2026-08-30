# Capsule r3 — honest critique

Rounds captured: `capsule-r3` (EN), `capsule-r3-ro` (RO), `capsule-r4`,
`capsule-r5-final`, `capsule-r6-final`. Two A/B rounds
(`capsule-r5b-blurtest`, `capsule-r5c-scrim`) were deleted after they had
served their purpose; what they proved is written down below, which is the
part worth keeping.

## Confirmed fixed from r2

Verb icon, hugging question chip, adjacent provenance dot, de-duplicated
figure list, single "type to…" hint — all hold in both themes at both
viewports. The r2 AA sweep holds: 0 failures, 15–16 text nodes measured
per state.

## Romanian: shipped, and it fits

`capsule-r3-ro` — informal tu-form, full diacritics, no clipping at
desktop or 390:

- "Întreabă orice — sau sari oriunde" · "Perioadă fără dată · Neverificată"
- "SARI LA…" · "Scrie ca să întrebi sau ca să sari oriunde"
- "↑↓ navighezi · Tab întrebi · Esc închizi"
- answer canvas: "RĂSPUNS", "Arată dovezile", "Adaugă în pachetul de export",
  chips "față de anul trecut?" / "Ce conturi au determinat asta?"

Note the strip reads **"Neverificată"** — feminine, agreeing with
*perioadă*. That is the bundle being right, not luck; it is why this copy
lives in a hand-written RO file rather than a machine pass.

## The one real defect this round, and the two wrong diagnoses on the way

**Symptom.** In every MOBILE capture, and only mobile, the fact card's
headline figure rendered as pale washed-out teal while every other string
on the panel was crisp.

**Wrong diagnosis 1 — "mid-flight smooth scroll."** The canvas
auto-scrolled to the bottom on every turn, including the first, where
there is nothing to scroll to. Plausible: a scroll in progress smears text
in a capture. Fixed it (`turns.length <= 1` now returns early — a genuine
improvement, the first answer should be still), re-shot as `capsule-r4`,
**and the wash was unchanged.** Wrong.

**Wrong diagnosis 2 — "the panel is too translucent."** Next hypothesis:
page content bleeding through the glass. A/B'd it — `backdrop-blur-none`
at a 0.96 fill (`capsule-r5b-blurtest`) — and the result was decisive but
about something else: **the page's own text became readable straight
through the panel.** The dashboard heading and its Export button are
legible over the answer in that capture. So translucency *does* bleed, and
the blur is what makes it glass rather than a hole. Useful, but still not
the wash: a heavier scrim (`capsule-r5c-scrim`, 60%) left the headline
exactly as pale.

**Actual cause,** found by cropping that region and magnifying it 15×: the
figure was pale teal **with a dotted underline**, which is a *state*, not
an artifact. The headline renders through `TraceableNumber` — the app-wide
"jump to the source row" affordance — and that component carries
`hover:text-accent`. The screenshot driver clicks the Ask row, the pointer
stays where it clicked, and on a 390px panel that is exactly where the
fact card paints a moment later. Desktop never reproduced it because the
pointer landed elsewhere.

So it was never a rendering bug. It was a **hover state that repaints the
most important number on the surface in a colour that fails AA.** At 12px
inside a sentence, `hover:text-accent` is a fine affordance. At 26px, as
the answer, it is not.

`TraceableNumber` belongs to another lane, so the colour is pinned from
the fact card with `[&_button:hover]:!text-brand-d` (and `brand-l` in
Terminal). `!` is not laziness: Tailwind resolves competing `hover:`
colours by stylesheet order, not by the order they appear in a class
attribute, so an unmarked override would win or lose by accident.

**Measured, both themes, hovering the real element:**

| theme | rest | hover (before) | hover (after) |
|---|---|---|---|
| Paper | 19.0 : 1 | pale accent — fails | **7.22 : 1** |
| Terminal | 15.7 : 1 | pale accent — fails | **10.25 : 1** |

## What the failed hypotheses cost, and what they bought

Two rounds and two A/B captures. Both hypotheses were reasonable and both
were wrong, and the loop is what said so — `capsule-r4` falsified the
first, `capsule-r5b` falsified the second. Neither change was reverted,
because each turned out to be independently right:

- **not scrolling the first turn** is correct on its own merits;
- **the blur is load-bearing** — that A/B is the only reason the glass is
  not sitting at some thinner value that looked fine in a still capture.

Final glass, every number measured rather than chosen: scrim **50%**, fill
**0.92**, blur **24px**. The honest caveat: contrast under a translucent
panel depends on what is behind it. The measurement composites through the
real stack and the blur reduces the backdrop to a low-frequency wash,
which is what makes that measurement meaningful — but it is an
approximation, and the scrim exists to keep it a close one.

## The morph's destination was wrong, and the anchor fixing it was dead code

The gates lane's K6 measures the morph as geometry: centre drift from the
capsule ≤24px, vertical gap ≤24px, scale ≤2×. It reported **28.0px drift —
RED**, with the gap already green. That is the owner's "detached panel"
complaint surviving in a form small enough to be dismissed as taste, so it
was worth chasing.

**Cause 1 — the panel centred on the wrong thing.** `sm:mx-auto` centres on
the VIEWPORT; the header capsule is centred in what is left of the header
after the 240px rail. Those are different places, permanently, by about
half the rail. `anchoredLeft()` now puts the panel's centre under the
trigger's centre, clamped into the viewport.

**Cause 2 — and this is the one worth writing down.** The anchor was
written, exported, unit-tested, and it did **nothing**. Measured live, the
panel's inline `style` attribute read only `pointer-events: auto` — the
hook's style had never been applied.

The panel is a Radix `Dialog.Content` inside a Portal, and Presence mounts
it **one commit after** `open` flips. The layout effect was keyed on
`[open, enabled]`, so it ran while the node ref was still null, took its
early return, and never ran again, because its dependencies had not
changed. A `useRef` cannot wake an effect. The node is now `useState` set
from the callback ref, so its arrival re-renders and the effect re-runs
with a real element to measure.

This is the failure mode unit tests are worst at: `anchoredLeft` was green
the whole time, because the arithmetic was never the problem — the
arithmetic was never *called*.

**Measured after, both themes:**

| law | before | after | tolerance |
|---|---:|---:|---:|
| centre drift | 28.0 px | **0.0 px** | ≤24 |
| centre drift, answer canvas | — | **0.0 px** | ≤24 |
| vertical gap | 23.5 px | 22.5 px | ≤24 |
| scale vs capsule | 1.34× | 1.29× | ≤2 |

One design consequence, taken deliberately: the anchor is computed
**outside** the motion path. Where the panel sits and how it got there are
different questions, and only the second is animation — so a reader with
`prefers-reduced-motion`, and the answer canvas which never morphs at all,
still get a panel centred under the capsule. The first version of the file
wired the anchor into the morph's bail-out, which quietly made "no
animation" also mean "back to centring on the viewport".

Shots: `capsule-r7-anchored/`.

## Still open — named, not hidden

1. **`capsuleTier0`'s K3 coverage gate fails at 46.7% against a 60%
   floor.** That is the speed lane's resolver, not this surface. The
   consequence here is that the Tier-0 preview paints less often than
   intended; when it does paint, it is correct.
2. **`hover:text-accent` is wrong at every size, not just 26px.** This
   lane pinned it on the one surface it owns. `TraceableNumber` is used
   across the app and every large figure it renders has the same problem.
   Cross-lane, recorded for whoever owns `components/cfo/`.
3. **`TopHeader.tsx:166` trips `check_design_lint`** (`shadow-lg` outside
   the floating-layer allowlist). Pre-existing, untouched by this lane —
   the file has no diff in this tree.
4. **Reduced motion is verified by construction, not by capture.** The
   morph bails to the plain fade when `prefers-reduced-motion` matches,
   asserted in `capsuleShell.test.ts`; there is no screenshot of it.

## Before / after

`design_review/capsule/capsule-r0-before/` → `capsule-r7-anchored/`, same
beats, both themes, both viewports. The wave-level document is
`BEFORE_AFTER.md`, owned by the gates lane; this file is the surface
lane's round-by-round trail behind it.
