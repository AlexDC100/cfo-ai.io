# Capsule answer surface — critique r5 (final)

Shots: `design_review/capsule/capsule-r5/` — 7 beats × {1440, 390} × {light, dark}.
Stack: vite :5173 + engine :8000 (PUBLIC_TEST_MODE). **Reads stubbed**
(`--stub-tools 1`, the local engine 404s on `/api/capsule/tools/*`);
**the model call is live**, so the guard, the placeholder resolution and the
money path are genuinely exercised. Figures on these shots are fixture
figures — the formatting, provenance and citation around them are not.

## Beat by beat

**1 · capsule-rest** — the header is unchanged: five sanctioned controls,
the Capsule still one of them (C8). Nothing was added for answer mode; ⌘J is
claimed in the capture phase inside the palette rather than by a new control.

**2 · palette-search** — 16 rows, Ask at index 1, directly under the best
match. The empty-query Ask row reads "Ask a question" rather than quoting an
empty string.

**3 · palette-ask-row** — a question collapses the list to the single Ask
row at index 0. The lane decision is the router's; the palette only honours
the placement. Enter here is the only keystroke in the surface that spends a
model call.

**4 · answer-retrieval** — the trace is honest work, not a spinner:
"● Reading revenue" with a live state dot per planned read, then two shimmer
bars while the model writes. The dot goes amber and the line strikes through
when a read does not land.

**5 · answer-done** — question pinned, prose with the figure resolved
in place, FIGURES receipt with a provenance dot, citation
(`Period · Dec 2025 · Snapshot · snap-a1b · Not verified by the engine`),
four actions, focused follow-up. The live model, asked for a comparison it
had one side of, answered: *"Only December revenue is available
({{money:revenue}}); no prior-month figure is in the snapshot, so the
month-over-month change can't be stated."* That is the "never fabricate"
invariant on real output, not on a fixture.

**6 · answer-evidence** — the heading changes to "Everything this answer was
built from" and the list widens from cited facts to every retrieved fact.

**7 · answer-followup** — the input keeps focus with the thread above it;
both hints ("Enter to ask · Shift+Enter for a new line", "⌘Enter opens this
thread in full chat") stay visible at 390.

## Motion and layout

- The overlay is `position: fixed`, so growing it moves nothing behind it:
  **CLS is zero by construction**, not by measurement. Search → answer swaps
  the max-width (600 → 680) over `duration-overlay` (200 ms, the same token
  the pill→overlay transition uses).
- Answer blocks reveal one at a time, appending downward at 70 ms. Block
  granularity, not word: re-wrapping a paragraph mid-reveal is a layout jump
  *inside* the block, which is what the contract forbids.
- `prefers-reduced-motion` skips the stagger entirely (`useBlockReveal`
  returns the full count) and the shimmer/pulse classes carry
  `motion-reduce:animate-none`.
- Raw streamed text is never painted. It cannot be checked for invented
  numerals until it is complete, and a half-arrived placeholder renders as
  literal braces. `firstTokenMs` is still stamped on the transport's first
  chunk, so the latency number stays honest whatever the surface paints.

## Contrast

Search mode keeps the glass at `surface/0.9`. Answer mode raises it to
`surface/0.97` — dense body prose at 13px cannot sit on whatever happens to
be behind it and still clear AA. The blur stays, so it still reads as the
app's one glass surface; what was dropped is the transparency, per
"AA contrast or drop the glass".

## Keyboard (verified live, not asserted in a unit test)

| Binding | Observed |
|---|---|
| type-to-open | `r` with nothing focused → palette open, query `r`, Ask at 1 |
| ⌘J | answer mode directly, URL stays `/dashboard` (AppShell's ⌘J→/chat intercepted in capture phase) |
| Esc | overlay closes, thread kept |
| ⌘J again | thread resumed, 1 turn intact |
| ArrowDown ×5 | active 5 of 16 |
| Tab | active → 1 (the Ask row) from anywhere |
| Enter on a navigate query | navigated to `/workspace`, **no model call** |
| ⌘Enter | `/chat` |

## Remaining, deliberately

- **The provenance dot is quiet** (5px, `ink-mute`, brand on hover). It is a
  receipt, not a call to action; the figure it sits beside is the content.
- **A single-row FIGURES list carries a heading** it barely needs. Left
  because dropping the heading at n=1 makes the surface's structure change
  shape with the data, which is worse than one extra line.
- **`net_result` has no statement row to jump to** in `traceableSource`, so
  its dot does not render. Refusing is correct — an unnavigable dot is trust
  chrome with nothing behind it — but the map is worth extending.

---

## r6 addendum — the suggestions lane, mounted

`design_review/capsule/capsule-r6/`. The neighbouring lane's barrel
(`shell/capsuleEmpty/index.ts`) names this file as its host, so three
mount points landed:

- **`<CapsuleEmptyState>` on an empty box** — their context zone, their
  suggestions, their recents, above the palette's own rows. Mounted
  CLICK-ONLY (no `activeIndex` / `indexOffset`): wiring their rows into the
  flat arrow-key order changes every index below them, and the router's
  placement invariant is stated in terms of that order. Both lanes should
  design that together rather than one guessing.
- **The ask-budget guard**, which matters most: `reserveCapsuleAsk` is taken
  before every dispatch and released if the dispatch throws, and the Ask row
  renders `<CapsuleAskRowNotice>` in place of its label when the assistant is
  down or the burst limit is hit. Credits are live and billing; a stuck Enter
  key now costs one answer, not six. The follow-up input goes through the
  same gate as the Ask row — one function, `askModel`.
- **⌘K → ArrowUp recalls the last question** on an empty box, shell-style.

One defect inherited from their side, not fixed here because the file is
theirs: their context zone labels the workspace name as `PERIOD`
("PERIOD · Meridian Industries SRL"), which is the same D2 this lane fixed
on its own surfaces. `useCapsuleSnapshot` wants the period's month, not
`activePeriod.label`.
