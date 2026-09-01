# The Canvas — gates

Every gate below names what it examines, the floor it examines against, and
the plant that was observed RED. A gate with no recorded red is an untested
assertion about an assertion (TC-2).

Subjects: `frontend/lib/canvasThread.ts`, `frontend/components/cfo/canvas/**`,
the ⌘J wiring in `frontend/components/cfo/AppShell.tsx`, and the ⌘J hand-over
in `frontend/components/instrument/shell/CommandPalette.tsx`.

---

## Unit — `frontend/components/cfo/canvas/__tests__/canvasStore.test.ts`

`npx vitest run frontend/components/cfo/canvas/` — 18 passed (both files).

| Gate | Examines | Floor / expectation |
|---|---|---|
| CV-P1 | the serialized localStorage payload for one entry | detector proven to fire on a leaked object first; `CANVAS_PERSISTED_KEYS` must equal `CanvasEntry`'s field set (≥8); 7-case `isSafeTitleParam` table |
| CV-P2 | `isEntryLive` over a 4-case truth table | exactly 4 cases, asserted after the loop |
| CV-P3 | `deriveCanvasTitle` (5 cases) and `fitToBudget` | 5 cases; eviction below 80 threads; payload ≤ 192 000 bytes |
| CV-P4 | pin round-trip through storage; attach staging | no figure in the pins payload; take is consuming; TTL honoured |
| CV-S1 | every slash command parses | 6 commands; **5 free + 1 generative**; canary `chart` |
| CV-S2 | the slash menu at `/`, `/c`, `/chart `, `revenue` | 6 / 2 / 0 / 0 |
| CV-PL1 | every plan trigger; per-plan step count; determinism | ≥14 triggers claim; every plan non-generative; ≥3 steps each; longest-trigger ordering on an ambiguous input |
| CV-P5 | two workspaces | org-b sees 0 of org-a's threads |

### Plants

| # | Plant | Result |
|---|---|---|
| P1 | *(not planted — went red on its first run)* `looksLikeFigure("390000")` is false, so a bare digit run reached storage through `titleParams`. RED: *"the serialized payload contains 390000 — a figure reached storage."* Fixed with `isSafeTitleParam`. | RED → fixed → GREEN |
| P2 | `isEntryLive` returns `hasLiveTurn` only (scope check dropped) | RED: *"an entry answered against p:p-dec was reported LIVE under scope p:p-jan…"* → reverted → GREEN |
| P3 | `/compare` marked `generative: true` | RED: *"4 of 6 commands are engine-only; the recorded expectation is 5 free and 1 generative…"* → reverted → GREEN |
| P4 | `planFor` returns the first match instead of the longest | **first attempt: NO RED.** For every input the assertion tested, the two rules agree. Not counted as evidence (TC-2). The assertion moved to `"board pack for the full review"`, which carries triggers for both plans; re-planted → RED naming both plans → reverted → GREEN |

---

## Render — `frontend/components/cfo/canvas/__tests__/canvasRender.test.tsx`

Every `CapsuleTurn` here is produced by the REAL pipeline (`runAnswerTurn` over
`planRetrieval`'s plan, through the capsule lane's contract-following fixture
transport). None is hand-built (TC-1).

| Gate | Examines | Control that must fire first |
|---|---|---|
| CV-R1 | digit-bearing text nodes under a rendered entry | a LIVE card must paint ≥1 digit, and must not be stale |
| CV-R1b | the same turn under a changed scope | — must paint 0 (period labels excluded by an exact-string allowlist) |
| CV-R1c | an entry with no live turn (a reload) | — must paint 0, and offer Recompute |
| CV-R2 | fabricated fragments in the DOM | the card must render block prose when the prose IS in `turn.blocks` |
| CV-R3 | the question row and the plan checklist | 3 step rows with their statuses |

### Plants

| # | Plant | Result |
|---|---|---|
| R1 | `stale={!turn}` (scope half dropped) in `CanvasEntryView` | RED on CV-R1b → reverted → GREEN |
| R2 | render `turn.streaming` (raw pre-guard text) | **NO RED.** Measured why: on a refused turn the pipeline leaves `streaming=""`, `blocks=[]`, `deterministic=true`, 1 violation — there was nothing at that field to leak. Discarded rather than counted. CV-R2 was rebuilt around a control that injects the fabricated sentence into `blocks` on a real turn and requires it to APPEAR, then requires the unmodified turn to show none of it. |

### Two things the render gates learned that are worth keeping

- **`linkifyAlertBody` REFORMATS a numeral it finds in legacy text.**
  `"RON 411,222,333"` renders as `"411.222.333,00 RON"`. A gate matching the
  literal string the model typed would report a clean DOM while the model's
  figure sat on screen in different clothes. The fragments are matched
  separator-stripped for exactly this reason.
- **The forbidden value must not also be an expected one.** The first draft
  used `293,050,085`, which is the fixture's real `total_assets` — the ban
  could never have distinguished a leak from a correct render.

---

## Live — `e2e/design/canvas.spec.ts`

`E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/design/canvas.spec.ts --project=chromium`

| Gate | Measured (r1 run) |
|---|---|
| CV-G1 | 9/9 anchors resolve; ⌘K opens the Capsule and not the canvas; ⌘J the reverse; panel height == viewport ±2px; width ≥ 480 |
| CV-G2 | `composer bottom: empty=859 · typing=859 · answered=859` — **0px drift** |
| CV-G3.a | control: **1** model request on a Tier-1 question |
| CV-G3.b | **0** requests to either seam on a Tier-0 question, with an artifact painted and figures in it |
| CV-G4 | `tools=6 model=0` on `/table …`; slash menu lists 6 |
| CV-G5 | 1 computed suggestion (≤3 cap), 6 commands listed, 0 figure-shaped lines |
| CV-G6 | 16 captures: {1440,390} × {dark,light} × {empty,streaming,artifact,thread} |

**CV-G6 is itself gated**, after r1 found it wasn't: the streaming capture now
asserts `canvas-artifact-pending` is on screen *before* the shutter, and the
generation stub is held open for 3.5s to give the in-flight state a duration.
The capture run also asserts ≥3 entries in the thread — a screenshot loop over
an empty surface is a gate that scores well by examining nothing (TC-9).

---

## Known reds NOT caused by this lane

`frontend/components/cfo/__tests__/headerLaw.test.tsx` — 2 failures
(`H1s`, `H7`: "the Simple|Pro dial is back in TopHeader's own markup").
Another lane restored `<ModeSwitch />` to `TopHeader.tsx` (its own comment:
*"RESTORED TO THE HEADER, 2026-08-31, by owner instruction"*) without updating
that spec. Confirmed by `git diff` — this lane touches neither file. Full suite
otherwise: **1577 passed / 108 files**.

---

# Part F — the law gates (A1–A10)

A second lane, working the same afternoon. Everything above proves the canvas
is a **surface**; this half proves it is **honest** — that every figure it
paints is the engine's and not the model's.

Two files, because the two lanes collided on one. `canvas.spec.ts` was written
twice on 2026-09-01 and the second write replaced the first wholesale. Rather
than re-clobber live-proven work (CV-G3 carries a positive control, the
property hardest to get right), the law gates went to
`e2e/design/canvas-law.spec.ts`, and `scripts/check_canvas.mjs` now
**discovers** every `e2e/design/canvas*.spec.ts` instead of naming one — a
hardcoded filename made its anchor law blind to whichever file it was not
pointed at, which is a census that walks one of two halves.

## Static — `scripts/check_canvas.mjs`

`node scripts/check_canvas.mjs`. Runs in ~1s, no browser. It also OWNS the
anchor list, so the live specs and the source laws cannot drift.

```
GATE-WORK canvas-files      units=37  floor=20
GATE-WORK canvas-testids    units=106 floor=60
GATE-WORK canvas-anchors    units=48  floor=35
GATE-WORK canvas-renderers  units=11  floor=5
GATE-WORK canvas-amounts    units=8   floor=8
```

| Law | Asserts | State |
|---|---|---|
| L1 | every declared anchor exists in canvas source, **per group** | ✓ 48/48 |
| L2 | every literal testid the live specs touch is classified, **with a floor on how many they name** | ✓ 20 distinct across 2 files |
| L2b | foreign anchors (`command-palette`, `account-menu-trigger`, `public-test-mode-banner`) still exist in `frontend/` | ✓ |
| L3a | zero raw number formatters on the surface | ✓ 37 files |
| L3b | every **discovered** renderer reaches a declared money path, directly or by delegation | ✓ 11 (5 direct, 6 delegating) |
| L3c | the delegation graph has leaves | ✓ 5 |
| L4a | every `localStorage.setItem` is declared with what it may hold | ✓ 3 sites |
| L4b | the thread store still serializes through `CANVAS_PERSISTED_KEYS` | ✓ |
| L4c | pins sanitize through the thread store's **own** predicate | ✓ `isSafeTitleParam` |
| L5 | no undeclared write path (one allowlisted endpoint) | ✓ |
| L6 | no `dangerouslySetInnerHTML`, no `JSON.stringify` in JSX | ✓ |
| L7 | `CanvasPanel` is mounted and rendered outside its own directory | ✓ `AppShell.tsx` |
| **L8** | **the artifact renderer registry is non-empty** | **✗ — see below** |

### L8 — the finding

**Nothing calls `registerCanvasArtifactRenderer`.** `CanvasArtifactCard` asks
`canvasArtifactRenderer(kind)` and falls back to a figure list when it returns
null, and the registry is empty, so **all eleven renderers under
`canvas/artifacts/` — ~2,900 lines — are unreachable from the running app**:
`TableArtifact`, `ChartArtifact`, `ComparisonArtifact`, `ScenarioArtifact`,
`FindingArtifact`, `SpreadsheetArtifact`, `DocumentArtifact`, and the
`ArtifactCard` chrome that carries `artifact-export`, `artifact-refine` and
`artifact-evidence`.

This is why L8 had to exist at all. **L1 can only see that an anchor exists in
SOURCE**, which is a weaker claim than "this anchor can render" — and the gap
between them is where a whole gate goes vacuous. Every `artifact-*` testid is
present in source, so L1 reports 48/48 green, while nothing on that list can
appear on screen. A gate pointed at a latent anchor is a false green with
extra steps, and the live A6 found it the hard way: *"the artifact card offers
no `artifact-export`"* — a true sentence that reads like a broken selector and
is actually an unwired product layer.

### Plants — every law observed RED, then reverted

| Law | Plant | RED observed |
|---|---|---|
| L1 | `canvas-artifact-PLANT` added to the artifact group | *"declared anchor(s) render nowhere … artifact: canvas-artifact-PLANT"* |
| L3a | `_plantProbe.tsx` with `n.toFixed(2)` | *"raw number formatter(s) on the canvas surface: …_plantProbe.tsx:1"* |
| L4a | `_plantProbe.tsx` with an undeclared `localStorage.setItem` | *"undeclared persistence site(s): …_plantProbe.tsx"* |
| L5 | `_plantProbe.tsx` with `fetch("/api/company/update", {method:"POST"})` | *"write path(s) reachable from the canvas: …[mutating-fetch]"* |
| L6 | `_plantProbe.tsx` with `dangerouslySetInnerHTML` | *"raw payload can reach the DOM: …:1 innerHTML"* |
| CENSUS | `walk()` skips `artifacts/` | *"files: 17 unit(s), floor 20"* — names the component, not the sum |
| L7 | **not planted — observed naturally.** Before `AppShell` mounted the panel it printed `SUBJECT NOT MOUNTED`, exit 1; after, `mounted by …/AppShell.tsx`. A real red→green transition on real state beats a plant. |
| L8 | `_plantProbe.tsx` registering a renderer | flipped to ✓ *"1 renderer registration(s) — the artifact layer is reachable"*, then back to ✗ on removal |

### Four laws that were WRONG first, and what each cost

Recorded because a gates lane that only publishes its successes is publishing
half a measurement. Each of these was a **false red aimed at correct work**,
which is as corrosive as a false green — it teaches the next reader to silence
the gate.

1. **L3b floored per-file `<Amount>` COUNTS.** The counts had been taken with
   `grep -c "<Amount"`, which counts a comment mentioning `<Amount>` and a line
   opening `<AmountGroup>`; the gate counted comment-stripped element opens.
   Two rules, two numbers, and the difference reads as a regression. Then the
   build lane consolidated rendering and the total fell 15 → 10 → 6 while every
   figure still reached the money path. Volume is not the property. Replaced by
   a **binary, per-component** claim (bound + at least one site) plus a floor on
   direct **leaves**.
2. **L3b knew only one money path.** It reported `DocumentArtifact` as unbound.
   That renderer is prose, and prose figures go through `<NarrativeText>` — the
   templatize-then-check path the narrative-units gate already guards.
   `MONEY_PATHS` is now an explicit two-entry list.
3. **L3b did not understand delegation.** `SpreadsheetArtifact` hands its
   sheets to `TableArtifact` and holds no figure of its own. Compliance is now
   computed to a fixpoint, so the law follows the figure to wherever it is
   actually printed.
4. **L4c named an identifier, not a law.** It required `looksLikeFigure`; the
   build lane replaced it with `isSafeTitleParam` imported from the thread
   store — a strictly better version of the same rule — and the gate went red
   on the improvement. It now asserts that the pin store consults the *thread
   store's own* predicate, whatever it is called.

Two more, of a different kind:

5. **L7 matched only the aliased import specifier.** `AppShell` imports
   `from "./canvas"`, so when the panel was wired in, L7 kept printing
   `SUBJECT NOT MOUNTED` against a mounted surface. A gate that cannot see its
   subject arrive fails in the safe direction, which is how it survives review.
   Caught by running it, not by reading it.
6. **L1 matched only `data-testid="…"`.** `ArtifactCard`'s action row takes a
   `testId` prop, so `artifact-export`, `artifact-refine`, `artifact-pin`,
   `artifact-copy` and `artifact-evidence` never appear as literal attributes —
   L1 reported `artifact-export` as rendering nowhere while the button sits in
   the source. This is the documented `check_stale_gates.mjs` trap verbatim
   (twenty live sidebar ids reported stale because they are declared as
   `testId: "…"` in a config array). Three spellings, one set: testid discovery
   went 99 → 106.

## Live — `e2e/design/canvas-law.spec.ts`

`npx playwright test e2e/design/canvas-law.spec.ts --project=chromium`
against the authed test-mode stack (vite :5173 + engine :8000).

**The engine tool seam is NOT stubbed** in A1/A6/A7. Those gates compare what
the reader sees against what the facts gateway actually returned; a fixture in
the middle would make the comparison circular — the screen checked against a
file the test wrote. Only the model seam is intercepted, because credits are
live and because in A2 the model's output IS the plant.

### Measured — run of 2026-09-01, `5 passed / 3 failed`

| Gate | Result | Measured |
|---|---|---|
| A2 | ✓ | model seam hit **2×**, planted digits leaked **0**. `987654321` as prose, as `spec.series` and as `spec.labels` — three hats, because unknown-key refusal alone would let the third through |
| A4 | ✓ | `canvas-artifact-empty` rendered for *"what was EBITDA in 1997"*; **0** unprovenanced numerals in the card |
| A5 | ✓ | RON vs EUR: element set **9 = 9**, rows **0 = 0**, digit-stripped prose identical |
| A7 | ✓ | 1 204 requests; **5** raw shell writes at baseline, **3** classified out, **0** canvas-attributed |
| A9 | ✓ | skeleton `28,18,16,16,20` ms → **p50 18** (budget 400); first value `32,22,20,20,24` ms → **p50 22** (budget 1200); **CLS inside the canvas 0**, outside 0 |
| A1 | ✗ | blocked — see below |
| A6 | ✗ | blocked on L8: no `ArtifactCard` mounts, so `artifact-export` cannot exist and the export path cannot be exercised |
| A8 | ✗ | blocked on the same control as A1; raw-payload half **passed** — `0` leaks of `request_id` / `req_011CQZk9x8PROBEONLY` / `invalid_request_error` / `anthropic` with the model returning a real 400 |

### A1 / A8 — the gate refuses to answer, and that is the answer

First live run: the Tier-0 card rendered
`{figures:1, empty:0, stale:0, pending:0, card:0}` — a live, non-stale,
fact-bearing card — with **zero `[data-provenance]` elements** inside it. That
reads like a provenance defect.

It is not, and the difference took one more measurement: `[data-provenance]`
count **on the whole page is also zero** — canvas, dashboard, everything.
`<Amount>` emits the attribute only when `hasProvenance(provenance)` holds, so
a workspace whose served facts carry no provenance block renders none anywhere.

A gate that read the canvas's zero as a canvas defect would be blaming the
surface for the fixture. A gate that read it as "no orphan numerals found,
clean" would be worse — and that is the shape A1 would have had without a
control, because "no numerals lacking provenance" is trivially satisfied by a
page with no provenance at all. **So A1 and A8 now carry a positive control in
the same run**: if the detector cannot find provenance on a surface that is
supposed to have it, the run cannot answer the question and says so.

Both are therefore **UNPROVEN, not failing**. They need either a test-mode
workspace whose facts carry provenance, or the fixture fixed. Nothing about
the canvas is implicated by them today.

### What this lane could NOT prove, stated plainly

- **A1, A6, A8 have never been observed GREEN.** A1/A8 are blocked on the
  provenance-less fixture above; A6 on L8. A gate with no observed green is
  half-tested, exactly as a gate with no observed red is (TC-2), and neither
  is claimed here as passing.
- **A3 was proven on the CAPSULE, not on the canvas.** Planting
  `if (false && answer.answerLocally(…))` in `CommandPalette.tsx` — the plant
  that shipped to main in `36d34ef` — turned K10 from 13/13 green to 7 failed,
  RED naming both seams by URL:
  `http://api.test.invalid/api/capsule/tools/get_facts` and
  `https://test.supabase.co/functions/v1/chat-llm`. Reverted, 13/13 green,
  `check_no_plants` clean over 904 files. The canvas has TWO such
  short-circuits (`useCanvas.ts` in the slash branch and in the main branch);
  the sibling spec's CV-G3 covers the surface with a positive control, but
  neither of the two canvas short-circuits has been individually planted. A
  floor on one addend cannot see the other collapse.
- **A10 is a property of the other nine, and it does not hold uniformly.**
  Every static law is plant-proven; A2/A4/A5/A7/A9 are live-proven; A1/A6/A8
  are not.

---

## The two open items that blocked this wave

### 1. `e2e/` was in NO tsconfig project

`npx tsc --noEmit` checking zero files was fixed once, and the fix left the
Playwright suite out. `tsconfig.app.json` includes `["frontend"]`,
`tsconfig.node.json` includes `["vite.config.ts"]` — measured, the app project
loaded **682 files, every one under `frontend/`**. The 37 spec and helper files
that ARE the gates were typechecked by nothing. TC-9 one directory over: the
gate's "clean" output for `e2e/` was byte-identical to its "no subject" output.

**`tsconfig.e2e.json`** now covers `e2e/`, `playwright.config.ts` and
`vitest.config.ts`, with the app project's exact non-strict posture plus three
deltas that are properties of a test runner (`types: ["node"]` for `node:fs`,
DOM lib for `page.evaluate`, `allowJs` because `header.spec.ts` imports a real
`.mjs` gate script).

**It surfaced exactly one error** — `e2e/real-e2e.spec.ts(115,7): TS2578:
Unused '@ts-expect-error' directive`, a directive suppressing nothing, invisible
for as long as the suite was unchecked. Fixed rather than baselined; one dead
line is not worth a baseline slot. **`design_review/TSC_BASELINE.txt` is
therefore UNCHANGED at 10 entries.**

```
                              before          after
projects                      2               3
project files typechecked     673             760   (app 717, node 1, e2e 42)
baseline errors               10              10    (new 0, healed 0)
```

**The gate itself needed changing more than the config did.** It carried ONE
canary (`frontend/main.tsx`) and ONE floor (400) over the SUM — the
`import-boundary` shape verbatim. With `tsconfig.e2e.json` added, a mistyped
`include` would have dropped the total 714 → 675, still **1.7× the global
floor**, with the canary intact, and the gate would print GREEN while the whole
Playwright suite went unchecked again. Canary and floor are now **per project**
and asserted after every project has run.

| Plant | RED observed |
|---|---|
| a real type error in `e2e/design/_axeVacuity.ts` | `11 errors (baseline 10, new 1)` → `e2e/design/_axeVacuity.ts TS2322` |
| `"include": ["e2ee", …]` | `DISCOVERY BROKEN … FAIL e2e (tsconfig.e2e.json): 2 file(s), floor 30; canary e2e/_helpers.ts NOT seen`, exit 1. Counterfactual printed alongside: under the old single-floor scheme, sum 675 ≥ 400 and the canary seen ⇒ **PASS** |

### 2. `/benchmark`'s axe main-floor of 15 passed on a crashed route

**Measured, not reasoned.** Blocking each route's lazy chunk makes the inner
`RouteErrorBoundary` (`App.tsx:447`, keyed by pathname, mounted INSIDE `<main>`)
render instead of the page:

| route, crashed | `<main>` | axe nodes | shell canary | recorded floors | verdict |
|---|---|---|---|---|---|
| `/benchmark` | 21 | 343 | present | 15 / 130 | **PASSED** |
| `/workspace` | 21 | 343 | present | 30 / 220 | main floor red |
| `/chat` | 21 | 342 | present | 45 / 190 | main floor red |

So the thinnest route reported *"axe clean"* with its content replaced by
*"This page needs a refresh"*. All three signals held: the canary lives in the
shell and survives, the node floor of 130 is cleared 2.6× by the shell alone,
and 21 > 15. The crash also carried one serious violation today (the shell's
own contrast), so the spec still went red — **for the wrong reason**, and that
cover disappears the day the contrast debt is paid.

Error-card size, both branches, measured rather than assumed: **21** on the
ChunkLoadError branch, **22** on the render-throw branch (the dev-only `<pre>`
stack).

**Two fixes, because either alone is the failure this file documents.**

1. **An exact discriminator.** `ERROR_CARD` names
   `[data-testid="route-error-clear-restart"]` — the one element the boundary
   always paints — and the content region must hold zero of them. A count can
   only be lucky about this; a named element cannot, and it covers every route
   and every route added later.
2. **No floor may sit below the error card.** `/benchmark` 15 → 30, and the
   rule is enforced **mechanically per route**, so the next thin surface cannot
   join the table under 22 and read as covered.

The discriminator is itself anchored to product code, so it is **proven against
its source on every call** — otherwise a rename turns it into an assertion that
an element nothing can render is absent, which is free.

| Plant | RED observed |
|---|---|
| block `/benchmark`'s chunk | *"the content region `<main>` holds the RouteErrorBoundary card … so this route THREW"* |
| `data-testid="route-error-clear-restart-RENAMED"` | **first attempt: NO RED.** `includes("route-error-clear-restart")` is still true of the renamed string — a stale anchor certified by its own anti-stale-anchor check. Tightened to the full attribute literal; re-planted → RED |
| `/benchmark` floor back to 15 | *"its content-region floor is 15, at or below the 22 elements RouteErrorBoundary paints"* |
| revert all | healthy `/benchmark` GREEN through the guard; full `axe.spec.ts` over all ten routes shows **zero** `[axe vacuity]` failures — every red is the pre-existing violations assertion |

### The registry was wired mid-session — L8 red → green, and what moved

**L8 went green during this lane.** The build lane added
`canvas/canvasArtifactBridge.tsx` registering `table`, `comparison` and
`chart`, side-effect-imported from `CanvasPanel.tsx`. The gate went red on a
real gap and green on the real fix, hours apart, without either lane
coordinating — which is the whole argument for a static half.

**L8b was added the same hour**, because "the calls exist" is still not "the
calls run": module-scope registration only executes if something imports the
module, and a bare side-effect import (`import "./canvasArtifactBridge";`) is
the first line a cleanup deletes for "importing nothing". Planted by commenting
that import out → RED naming the orphaned module. The plant also caught a bug
in the law's own first draft: it tested the RAW source, so a commented-out
import read as a live one. Every other law here reads comment-stripped source;
this one did not, and only the plant said so.

**Re-run of A1 / A6 / A8 against the wired layer:**

- **A6 advanced two legs.** `artifact-export` now exists, the click fires, the
  payload is captured. It stops at the THIRD leg: *"the facts gateway returned
  no figure at all"*. The tool seam is deliberately not stubbed for this gate,
  and a Tier-0-answerable question never reaches it — which is the correct
  zero-spend behaviour and makes the gateway leg unmeasurable on that question.
  A6 needs a question that genuinely goes through `/api/capsule/tools/*`.
  Recorded rather than papered over: two of three legs proven, the third
  unmeasured.
- **A1 and A8 are unchanged** — still blocked on the provenance-less workspace,
  which the renderer wiring does not touch.

## Hand-over

| Item | Owner | State |
|---|---|---|
| A1, A8 | whoever owns the test-mode fixture | need a workspace whose served facts carry a provenance block. `[data-provenance]` count is **0 page-wide** today, so the law cannot be measured — and would pass vacuously if the control were removed |
| A6 third leg | this gate | needs a question that reaches `/api/capsule/tools/*`; `total assets` is answered by Tier 0 and never does |
| A3 on the canvas | gates | `useCanvas.ts` has TWO Tier-0 short-circuits (slash branch, main branch). Neither has been individually planted. A floor on one addend cannot see the other collapse |
| `__repr__` three-seam refusal | the Python suite | A7's browser half is proven; the engine half is not this lane's |
