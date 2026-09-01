# The Canvas — critique r1

Captures: `design_review/canvas/shots/canvas-{1440,390}-{dark,light}-{empty,streaming,artifact,thread}.png`
(16 files, produced by `CV-G6` in `e2e/design/canvas.spec.ts`).

Measured on the live authed stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE),
demo workspace "Meridian Industries SRL".

---

## What is already right

- **The composer does not move.** Measured, not eyeballed:
  `[CV-G2] composer bottom: empty=859 · typing=859 · answered=859` — 0px drift
  across the three states. The flip is applied correctly.
- **⌘J and ⌘K are two surfaces.** CV-G1 passes in both directions: ⌘K opens the
  Capsule and does not open the canvas; ⌘J opens the canvas and does not open
  the Capsule.
- **Zero spend held on a new surface.** `CV-G3.a` control saw 1 model request on
  a Tier-1 question; `CV-G3.b` saw 0 requests to *either* seam on a Tier-0 one,
  with an artifact painted and figures in it.
- **The engine computes.** `[CV-G4] tools=6 model=0` — `/table …` performed six
  read-only tool reads and never touched `chat-llm`.
- **Artifact-first reads correctly.** In `1440-dark-thread` the figure block
  leads and the sentence sits under it as a caption. That inversion is visible
  at a glance and it is the thing that stops this reading as a chat log.

---

## Defects — ranked

### D1 (severe, 390) — the composer collapses to a 40px column

`canvas-390-light-empty.png`. The placeholder wraps over **five lines**
("Ask, or / type / for / a / commmand…") and the input is roughly 40px wide
while the Send button and the attach glyph take the rest of the row.

Cause: the textarea carries `w-full flex-1` inside a flex row. `w-full` sets
`width:100%` and, with no `min-w-0`, the flex item refuses to shrink below its
content while the row's other children hold their intrinsic widths — so the
text field is the one that loses. This is the standard flexbox min-content trap
and it only shows up at narrow widths, which is why 1440 looked fine
(measured there: 241.5px, adequate).

**Fix:** `min-w-0 flex-1`, drop `w-full`.

### D2 (severe, 390) — the thread rail eats 46% of a phone screen

The rail is a fixed `w-[180px]`. At 390 that leaves ~205px for the thread,
which is narrower than a single artifact card wants and narrower than the
480px minimum the panel itself declares for exactly this reason. The rail is
also the *least* useful thing on a phone: it holds one row.

**Fix:** hide the rail below `md` and give the header a toggle, so the
threads are still reachable rather than removed.

### D3 (real, both sizes) — the header says "No period" while the page says FY2025

`canvas-1440-dark-thread.png`: the canvas header and the grounding line both
read "Meridian Industries SRL · No period", three inches from a dashboard
header reading "Meridian Industries SRL · FY2025", over figures the thread
itself labels "Dec 2025".

Cause: `periodMonth = selectedMonth ?? formatPeriodMonth(activePeriod.periodEnd)`
— copied from the Capsule, and correct there. The demo period has
`periodEnd: null` (`activePeriod.ts:485`) and never reaches the stepper, so
both sources are null.

This is the same defect the Capsule hit twice in its own screenshot loop (its
r0 put a COMPANY NAME in the month slot; its r1 removed the fallback and said
nothing at all). The lesson recorded there is the fix here: **ask the app the
same question the page header asks.** The page reads
`statements.periodLabel`, which is a period label by construction and cannot
become a company name.

**Fix:** third source, `activePeriod.statements?.periodLabel`, after the two
month sources.

### D4 (gate defect — TC-9 shape) — the "streaming" capture captured nothing

`canvas-1440-dark-streaming.png` and `canvas-1440-dark-artifact.png` are
**byte-identical in size** (191,509 both). The stub fulfils instantly, so by
the 600ms mark the turn had already settled: the capture named a state it
never observed.

This is the exact shape this project keeps catching — an instrument whose
"clean" output is indistinguishable from "there was no subject". A screenshot
of a settled thread filed as `streaming` is worse than no screenshot, because
a reviewer looks at it and concludes the streaming state is fine.

**Fix:** a deliberately slow generation stub for the capture run, and assert
inside the capture that the streaming state was actually on screen when the
shutter fired.

### D5 (self-inflicted, cross-lane) — the sidebar's "⌘J" hint now lies

`Sidebar.tsx:294` renders a `⌘J` hint on the "Ask CFO AI" row, which navigates
to `/chat`. ⌘J now opens the canvas. The row's destination is a product
decision for the lane that owns that rail; the false keyboard claim is
something **this** change invalidated.

**Fix:** remove the hint (3 lines), leave the navigation alone, and flag the
destination question for the coordinator.

### D6 (moderate, 1440) — 560px default, minus a 180px rail, is a 380px document

The panel meets its declared 480px floor, but the *thread* does not get 480px —
the rail takes 180 of it. Artifact cards at 380px wrap their figure rows.

**Fix:** default width 560 → 620 and rail 180 → 156. The floor stays 480
(that is the panel's own minimum and it is enforced), but the shipped default
should not be the worst case.

### D7 (minor) — command hints truncate at 390

"/compare  Two periods, side by…". Acceptable at 390 while the rail is there;
re-check after D2.

### D8 (harness, not design) — the test-mode banner's dismiss button sits on the header

The circular × over the canvas header in every capture is
`public-test-mode-banner`'s dismiss control at `z-60`; the canvas is `z-40`.
It is not canvas chrome, but it is *read* as canvas chrome by anyone looking
at these files.

**Fix:** dismiss it immediately before each shot, not only during boot.

---

## Not changed, and why

- **The rail's date line under each thread title** looks redundant next to a
  one-item list, but it is the only thing distinguishing two threads with
  similar first questions. Keeping it.
- **The `Show the spec` disclosure is Pro-only and collapsed by default.** At
  1440 there is room to leave it open; it stays closed because the artifact is
  the subject and the metric ids are the footnote.
