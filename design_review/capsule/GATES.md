# THE CAPSULE — GATES K1–K9, AND THE STALE-GATE CENSUS

> **The law (permanent):** the Capsule leads with ASK, answers before it
> talks, grows out of the control the reader clicked, and never invents a
> figure, never writes, never guesses at absent data, never spends a
> model call on navigation, and never falls apart when the model is gone.
> Enforced by test, not by prompt.
>
> Every gate below has a **PLANT**: the defect, made real, run, observed
> to trip the gate, and reverted. The exact text each gate emits is
> recorded verbatim. **A gate whose plant was never run is a gate nobody
> has proven is wired to anything.**

---

## THE FINDING THAT JUSTIFIES THIS WHOLE FILE

Before this wave, the Capsule carried nine gates — C1 through C9 — across
three files and a battery entry. On 2026-08-30, against the surface the
owner described as broken, **all ten live tests passed in 1.5 minutes.**

```
  10 passed (1.5m)
```

That surface: told the reader to *"Search pages, actions, periods,
companies…"*, buried "Ask a question" as row 2 of 16 among navigation
destinations, stacked five zones into the empty state, and rendered its
overlay as a viewport-centred panel 67 px below the control that opened
it.

Every correctness law held. Every one. **C1–C9 measured whether the
Capsule lies. Nothing measured whether it works.** K1–K9 are the second
half of that sentence.

---

## WHERE EACH GATE LIVES

Four enforcement layers, cheapest first.

| Layer | File | Runs | Covers |
|---|---|---|---|
| Static | `scripts/check_capsule_ask.mjs` | `node scripts/check_capsule_ask.mjs` (~0.4 s) — battery gate **`capsule-ask`** | K1 copy, K8 number, S1–S3 census |
| Unit (jsdom) | `frontend/lib/__tests__/capsuleAskGates.test.ts` | `npx vitest run frontend/lib/__tests__/capsuleAskGates.test.ts` (~1 s) | K2 counter, K3, K4, K5, K9 |
| Live DOM | `e2e/design/capsule.spec.ts` | `npx playwright test e2e/design/capsule.spec.ts --project=chromium` (~4.5 min; needs vite :5173 + engine :8000 `PUBLIC_TEST_MODE`) | K1–K9, all of them |
| Producer | `tests/engine/test_capsule_gates.py` | battery gate **`capsule-gates`** | C1-E, C2-E, C3-E, C5-E, C6-E, C9-E (unchanged by this wave) |

`scripts/run_battery.py` gained **one** line, `capsule-ask`, beside
`stale-gates` — the static half, because a copy regression is decidable
from a JSON file and a gate that is cheap gets run. The live half is not
in the battery for the same reason `capsule.spec.ts` never was: it needs
a running stack.

---

## STATUS, AS MEASURED — 2026-08-30

```
node scripts/check_capsule_ask.mjs   →  PASS   (exit 0)
npx vitest run …/capsuleAskGates     →  11 passed · 1 failed   (K3 coverage)
npx playwright test …/capsule.spec   →  23 passed · 2 failed   (K1 aria-label, K6 centre)
npx tsc --noEmit                     →  exit 0
```

Three REDs stand, and all three are **real product findings, not harness
faults**. They are stated at the bottom of this file as cross-lane needs.
None of them was made green by moving a threshold.

---

## K1 — ASK-FIRST

**The verb is ASK, "Ask" is not a row, and Enter answers.**

Five enforcement points, because production got the verb wrong in three
different places at once and a single check would have caught one of them.

| | Where | What it proves |
|---|---|---|
| **K1-a** | `check_capsule_ask.mjs` → `gateAskFirstCopy` | Every *rendered* command-surface placeholder leads with an ask verb, EN and RO. |
| **K1-b** | `check_capsule_ask.mjs` → `gateAskIsNotARow` | The ask-row i18n keys have no component rendering them. |
| **K1-c** | `capsule.spec.ts` → "the placeholder contains an ask verb" | The live `placeholder` attribute, whatever key produced it. |
| **K1-d** | `capsule.spec.ts` → "the trigger's ACCESSIBLE NAME says ask" | The `aria-label` / `title` a screen-reader user is actually read. |
| **K1-e** | `capsule.spec.ts` → "Enter … ANSWERS" | Enter on a question produces an answer. No Tab. |

### PLANT K1-a — the production placeholder, restored

The gate was written against the surface as the owner described it, and
run before any lane had landed. That state IS the plant:

```
[K1] frontend/components/instrument/shell/shellStrings.json → en.shell.palette.placeholder carries no ask verb: "Search pages, actions, periods, companies…"
        The Capsule's verb is ASK. A user who reads "search" types a noun, gets a list, and never learns the surface answers.
[K1] frontend/components/instrument/shell/shellStrings.json → ro.shell.palette.placeholder carries no ask verb: "Caută pagini, acțiuni, perioade, companii…"
[K1] "capsuleRouter.ask.row" is still rendered by frontend/components/instrument/shell/CommandPalette.tsx
        ASK IS NOT A ROW. It is the DEFAULT ACTION of the prose input — Enter answers.
[K8] HEADER_BUDGET is 5; the H1 budget for this wave is 4 (brand · capsule · bell · avatar).

FAIL check_capsule_ask — 5 violation(s)
```

Not reverted — **fixed**, by the shell lane, during the wave. The
placeholder now reads *"Ask anything — or jump anywhere"* and the gate
passes.

### K1-e is planted permanently, in the harness itself

The pre-wave `ask()` helper had to press **Tab** before **Enter**,
because "Ask a question" was a row and Enter ran whatever row happened to
be selected — the first navigation destination. **The defect was written
into the test harness.** The new helper is:

```ts
await input.fill(question);
await input.press("Enter");
```

If the surface ever regresses to needing that Tab, every gate that asks a
question fails at once. That is the correct blast radius, and it is
cheaper than a dedicated assertion.

### K1-d — FOUND BY A PLANT FOR A DIFFERENT GATE

This one is worth reading in full, because it is the argument for plants.

The K8 plant (below) injects a fifth header control and prints the
inventory. In that inventory:

```
  · <button> testid=header-command-bar aria=Search "Aug 2026Ctrl+K"
```

`aria-label="Search"` — months after the placeholder was rewritten. The
static gate could not see it: the label is built through `t(...)` and
resolves only at runtime. **A sighted user reads "Ask anything"; a blind
user is told "Search".** Same control, two different products.

K1-d was written in response and fails today:

```
Error: K1: the capsule's aria-label is "Search". That is the name a screen-reader
user is read; the placeholder they cannot see says "Ask anything". Same control,
two different products.
```

Nobody planned this gate. A plant for an unrelated law printed a
diagnostic, and the diagnostic contained a defect. **Plants are worth
running even when you are confident the gate works.**

---

## K2 — THE EMPTY-STATE BUDGET

**≤3 zones and ≤8 rows before a keystroke.**

The counting rules matter more than the numbers, because a lane that
wants to keep five zones will reach for the definition first:

* A **ZONE** is a region with a heading, `role="group"`, `role="region"`,
  `<section>`, or an `aria-label` on a container holding rows. Restyling
  a heading into an uppercase `<div>` does not stop it being a zone.
* A **ROW** is anything pickable: `role="option"`, `role="menuitem"`,
  `<li>` with a click target, a `<button>` inside a list region. Turning
  options into buttons is a refactor, not a reduction. A `<li><button>`
  counts **once**.
* The **prose input is not a row.** It is the surface.

Defined in `capsuleAskGates.test.ts::budgetCensus`, mirrored into
`capsule.spec.ts` as an in-page evaluator — an in-page function cannot
import a module, the same reason `figuresIn` is mirrored across three
files.

### PLANT K2 — production's own empty state, permanently in-suite

Not a temporary edit: the pre-wave DOM is reconstructed from the live
census taken on /dashboard and asserted to breach both budgets on every
run.

```ts
it("PLANT: production's five-zone, sixteen-row empty state trips both budgets", …
    expect(`${c.zones} zones / ${c.rows} rows`).toBe("5 zones / 16 rows");
```

The plant IS the test, so the counter cannot rot into a tautology between
plant sessions.

**Measured, live:**

| | Before | After | Budget |
|---|---:|---:|---:|
| Zones | 5 | **1** | 3 |
| Rows | 16 | **4** | 8 |

---

## K3 — TIER-0 COVERAGE

**≥60% of the 30-question corpus answered with ZERO model calls, each
under 100 ms.**

### The corpus, and what it honestly is

The brief asked for coverage *"against the real recent-questions log."*
**There is no such log, and saying so is the finding.** Recent questions
live in `localStorage` under `cfo:capsule-recents:v1:<org>`, are declared
device-local on purpose (`capsuleRecents.ts`; CLAUDE.md §16 Milestone C's
"deliberately NOT synced" list), and are never mirrored to Supabase.
Nothing server-side has ever recorded a Capsule question. Quoting a
percentage against a log that does not exist would be exactly the
fabrication these gates were built to stop.

So the corpus is assembled from the three places in this repository where
real product questions are written down, each named in the source:

| | Source | Why it counts |
|---|---|---|
| **A** | `capsuleEmptyStrings.json` → `capsuleEmpty.suggest.*` | The questions **the product puts in front of the user**, generated from live workspace state, Simple and Pro register, EN and RO. A user clicking one *is* an asked question. Highest fidelity available anywhere in the repo. |
| **B** | `capsuleAnswerFixtures.ts` → `ANSWER_FIXTURES` (12) | The answer lane's retrieval-branch corpus. |
| **C** | `capsuleRouterFixtures.ts` → `ask` + `ambiguous` lanes | Written as "forty queries a real operator of this product actually types". |

Thirty, deterministically ordered, so the percentage is reproducible.

### The fact index comes from REAL ENGINE OUTPUT

`served_balanced.json` and `served_reconciled_bs.json` — served envelopes
(`docs/served_envelope.schema.json`, served_v1), the same contract
`servedFactsContract.test.ts` pins field by field. Two periods, so the
compare branch has a real baseline.

**This convention paid for itself on the gate's first run.** An earlier
draft invented a `{ metrics: [{name, value, unit}] }` snapshot from the
suggestion engine's shape. `buildFactIndex` takes `{ periods: [...] }`.
The index came back empty, `resolveTier0` short-circuited, and coverage
measured **0/30**. The gate reported a real contract mismatch on its
first execution — which is the entire argument for building fixtures out
of the engine's own bytes rather than by hand.

### The failure message is split, because a number nobody can act on is not a finding

An earlier draft printed 22 misses and sent the reader to read 22
strings. It now classifies them against **an independently written**
judgement-verb list — deliberately *not* `capsuleTier0`'s own
`INTERPRETATION_TRIGGERS`, since importing the resolver's vocabulary to
excuse the resolver's misses would classify every miss as "correctly
refused" by construction.

**Measured today: 56.7% (17/30) — 12 correct refusals, 1 real gap.**

```
[K3] tier-0 coverage 56.7% (17/30) · max 0.12ms · refused-by-design 12 · real gaps 1

  CORRECTLY REFUSED (12) — these want a judgement, not a lookup:
    · what if revenue drops 10%          · why is cash down this month?
    · how are we doing overall           · de ce a scăzut profitul?
    · explain the 461 balance            · show me the biggest risk in this period
    · can we afford a 500k capex         · Why doesn't Dec 2025 balance?
    · Dec 2025 has no file yet — what should I upload?
    · Dec 2025 is unattached — which document unlocks the statements?
    · Why did inventory get flagged this month?
    · inventory — what drove it, and what does the first fix cost?

  REAL COVERAGE GAPS (1):
    · how do i export the balance sheet
```

Coverage rose from **26.7% → 56.7%** during the wave as the speed lane
landed. It is 3.3 points under the floor. **The floor was not moved.**

### PLANT K3 — a Tier-0-eligible question routed to the model

```diff
+ const plantedAway = "what are our total assets";
+ const resolveTier0Planted = (q, i) => (q === plantedAway ? null : resolveTier0(q, i));
- const answer = resolveTier0(q, index);
+ const answer = resolveTier0Planted(q, index);
```

```
[K3] tier-0 coverage 53.3% (16/30) · max 0.13ms · refused-by-design 12 · real gaps 2
AssertionError: K3: Tier-0 coverage 53.3% (16/30) is below the 60% floor.
  REAL COVERAGE GAPS (2) — these name a fact the index either holds or should:
    · what are our total assets
```

Reverted. Both halves proved: the coverage number moved, **and** the
classifier put the planted question under REAL GAPS rather than under
correct refusals.

### The live half

`capsule.spec.ts` §K3 — and the first draft of it was **wrong, and the
gate was wrong, not the product**. It typed a question, pressed Enter,
and waited for a figure row; it failed with two model calls. The speed
lane put Tier 0 *before* Enter: the answer resolves from the in-memory
index **as you type**. Enter is the escalation to Tier 1, which is
allowed to spend because the reader asked for more.

```
[K3 live] tier-0 resolved=true in 16ms · spends=0
```

Network is counted, not mocked, so "zero spend" is observed.

---

## K4 — FACT BEFORE PROSE

**The ORDERING, not timing luck.**

`runAnswerTurn` pushes every intermediate state through `onUpdate`. The
gate records the sequence and asserts a property of the **sequence**: the
first state carrying any prose already carries the facts — and carries
*all* of them, so the card is whole before the text starts rather than
filling in underneath it. A transport made instant or made slow changes
nothing about whether that holds. Generation is deliberately configured
to yield in **one chunk with zero delay** — the most hostile ordering
available.

The live half arms a `MutationObserver` **before** asking; an observer
attached afterwards can only report what it did not see.

```
[K4] 11 of 12 fixtures carry facts and were ordering-checked · no-fact answers (outside the law): help
[K4 live] figure at 9546ms · prose at 9546ms
```

### PLANT K4 — and the correction it forced

The gate initially failed on the `help` fixture:

```
"help: prose appeared at state 2 (status generating) with 0 facts in hand"
```

**The gate was wrong.** A help answer has no figures, and demanding a
fact card for one would *invent a figure* — the exact defect C1 exists to
stop. ABSENT is not ZERO applies to the gate as much as to the product. A
turn that legitimately ends with no facts is outside this law, not a
violation of it; the law was rewritten to say so, and the skip is
reported by name (`help`) rather than silently applied.

---

## K5 — LATENCY, MEASURED AND GATED

Full table: **`design_review/capsule/LATENCY.md`**, which carries a
machine-readable ` ```latency-baseline ` block that both the vitest and
Playwright halves parse. If the file is missing or the block does not
parse, the gate **fails** — it does not skip.

Headline: surface open **34 ms** p50, keystroke→rows **70 ms** p50,
question→first figure **408 ms**, tier-0 **16 ms**, CLS **0.0000**.

Two numbers got **worse** and are recorded as such rather than omitted:
keystroke→rows 8 → 70 ms (the fact index now resolves on every keystroke)
and question→first figure 300 → 408 ms (the fact card now assembles
before any prose renders). Both are real costs of the rebuild, both are
good trades, and both are now gated so the next addition to those paths
has to argue with a measurement.

---

## K6 — MORPH INTEGRITY

**The overlay's geometry originates from the capsule's bounding box, and
nothing jumps.**

The owner's words were *"the overlay renders as a detached flat panel
BELOW the capsule, no morph, large dead space."* Made measurable:

| Law | Measured before | Measured now | Tolerance |
|---|---:|---:|---:|
| Centre drift from the capsule | 35.7 px | **28.0 px** | ≤24 px |
| Vertical gap below the capsule | 67.5 px | **23.5 px** | ≤24 px |
| Scale vs the capsule | 1.12× | 1.34× | ≤2× |
| CLS on open / close / stream | not measured | **0 / 0 / 0** | <0.01 |

### PLANT K6 — the product planted it

No edit was needed. Mid-wave, between two runs minutes apart, the morph
lane changed the overlay and the gate went from green to red on its own:

```
run A:  capsule x423 w538 bottom45 · overlay x410 w562 top10 · drift 1.2px  gap -35.0px  ✓
run B:  capsule x423 w538 bottom45 · overlay x360 w720 top68 · drift 28.0px gap  23.5px  ✘
```

The failure message names the cause exactly:

```
Error: K6: the overlay's centre is 28.0px from the capsule's and 0.0px from the
VIEWPORT's. A panel centred on the viewport did not come out of the control the
user clicked — that is exactly "a detached flat panel, no morph", stated in
pixels. Origin the geometry on the capsule's box (its centre, its edges), not on
the viewport's midline, not `left-1/2`.
```

**0.0 px from the viewport's centre.** That is not an inference; the
overlay is `left-1/2`.

### A proxy replaced by a measurement — and NOT a loosening

The first draft compared overlay width to capsule width at one viewport
and failed anything beyond ±25%. That was a bad proxy: a morph is allowed
to **grow** as it becomes an answer panel, so the ratio banned a
legitimate design and caught the illegitimate one only by luck.

The real question is whether the width is **derived** or **constant**,
and one measurement cannot tell those apart. Two can: change the viewport
so the capsule's own width changes, and watch whether the overlay
follows. On this build the capsule is a **fixed 538 px** at both 1440 and
1120, so the discrimination is impossible — and **a test that always
skips is the same false green as a selector that never matches.** The
measurement is therefore reported as an annotation, and a law that *can*
fail is asserted instead (scale ≤2×).

This is not a loosening: the centre law still fails on the same defect
the ratio was failing on.

---

## K7 — NO DEAD SPACE

**Overlay height == content height ±8 px at every state.** A region that
is genuinely scrolling is honestly full; dead space is a region taller
than what it holds with nothing to scroll.

```
[K7] empty h307/c306 · one-match h159/c158 · no-match h130/c129 · answer h427/c426
```

Every state within **1 px**. A finding worth recording: the pre-wave
surface *also* passed K7 in search mode (h505/c504, h169/c168, h133/c132).
The "large dead space" the owner saw was **the 67 px gap between the
capsule and the panel** — K6's subject, not K7's. The gate that names the
defect is not always the gate whose name matches the complaint.

---

## K8 — THE HEADER HOLDS FOUR

Counted live, independently of the header lane's own spec, on
`/dashboard` and `/chat`.

```
[K8 /dashboard] 4 controls
  · <button> testid=header-brand aria=Go to dashboard
  · <button> testid=header-command-bar aria=Search "Aug 2026Ctrl+K"
  · <button> testid=notifications-button aria=Notifications
  · <button> testid=account-menu-trigger aria=Account menu · Test visitor
[K8 /chat] 4 controls
```

### PLANT K8 — a fifth header control

```ts
await appHeader(page).evaluate((el) => {   // PLANT C
  const b = document.createElement("button");
  b.setAttribute("data-testid", "planted-fifth-control");
  b.setAttribute("aria-label", "Simple | Pro");
  b.textContent = "Pro";
  b.style.cssText = "width:40px;height:24px";
  el.appendChild(b);
});
```

```
Error: K8: the header carries 5 top-level interactive elements (budget 4 — brand · capsule · bell · avatar).
  · <button> testid=header-brand aria=Go to dashboard ""
  · <button> testid=header-command-bar aria=Search "Aug 2026Ctrl+K"
  · <button> testid=notifications-button aria=Notifications ""
  · <button> testid=account-menu-trigger aria=Account menu · Test visitor "TM"
  · <button> testid=planted-fifth-control aria=Simple | Pro "Pro"
```

Reverted. (This is the plant whose *inventory line* exposed K1-d.)

### The cross-lane half, and why it is shape-tolerant

The header lane owns `header.spec.ts`; this lane pins the same number
from the other side so **neither lane can move the budget alone.**

Mid-wave, the header lane moved its law from a scalar ceiling
(`HEADER_BUDGET = 5`) to an exact sanctioned set
(`SANCTIONED_DESKTOP = [...]`, 4 identities — strictly stronger, since a
bare count would let brand and bell swap silently). Both gates here
initially reported:

```
Error: K8: HEADER_BUDGET not found in header.spec.ts
[K8] HEADER_BUDGET not found in header.spec.ts — the number moved or was renamed.
```

**That reads as this lane's bug rather than the header lane's
improvement**, which is a bad failure to hand somebody. Both gates now
accept either shape and fail only when **neither** is present — because
then nothing pins the number on that side at all.

```
   ok  K8: header.spec.ts pins SANCTIONED_DESKTOP (4 identities)
```

---

## K9 — EVERY EXISTING INVARIANT, RE-PROVEN ON THE NEW SURFACE

| | Law | Where | Status |
|---|---|---|---|
| C1 | No model numerals | `capsule.spec.ts` → "a fabricated figure never reaches the reader" | ✓ |
| C2 | Read-only at the wire | `capsule.spec.ts` → "no non-GET request reaches the tool endpoint" | ✓ |
| C3 | Provenance on every figure | `capsule.spec.ts` → "renders its figures through the money path" | ✓ |
| C4 | Navigation never spends | `capsule.spec.ts` + `capsuleAskGates.test.ts` | ✓ |
| C5 | Missing-data honesty | `capsule.spec.ts` → "a refused read shows the absence and renders no zero" | ✓ |
| C7 | Degraded parity | `capsule.spec.ts` → "the model is dead and the instrument still works" | ✓ |
| — | Router <5 ms | `capsuleAskGates.test.ts` → p95 **0.092 ms** over 40 fixtures | ✓ |

### PLANT K9-a — a model-authored numeral in a fact card

```diff
  await expect(answer.locator(ANCHORS.figureRow).first()).toBeVisible({ timeout: 15_000 });
+ await answer.evaluate((el) => {  // PLANT A
+   const span = document.createElement("span");
+   span.textContent = "RON 1,234";
+   el.appendChild(span);
+ });
  const offenders = await unprovenancedFigures(answer, [
```

```
Error: K9/C3: 1 figure(s) in the answer carry no provenance:
  · "RON 1,234"  in  <span>RON 1,234</span>
```

Reverted. This plants the figure **past** the guard, straight into the
DOM, so it proves the *detector* rather than re-proving the guard the
`FABRICATED_ANSWER` fixture already exercises on every run.

### PLANT K9-b — a navigation query burning a model call

**The first attempt did not trip the gate, and that was the useful
result.** Appending an ask-shaped query to the typed list changed
nothing:

```
✓ K9/C4 — no spend for any navigation, entity or action query (12.6s)
```

Because **typing never spends — only Enter does.** Correct product
behaviour, wrong plant. Re-planted at the seam that actually bills:

```diff
+ await input.fill("what are our total assets");
+ await input.press("Enter");
+ await page.waitForTimeout(2500);
```

```
Error: K9/C4: typing destinations spent 2 request(s). Anthropic credits are live;
this is a bug with an invoice attached.
  POST http://127.0.0.1:8000/api/capsule/tools/get_facts
  POST https://cjclenykwlngqvapmisb.supabase.co/functions/v1/chat-llm
```

Reverted. Both spend seams named. **A plant that fails to trip is worth
as much as one that trips**, when what it teaches is where the money
actually leaves.

### The new tension ASK-FIRST creates, asserted explicitly

Promoting ASK to the default Enter action is the change most likely to
break C4: if "answer on Enter" is implemented by making the Ask row the
default selection, typing `dashboard` and pressing Enter starts billing.
So the law is stated as a conjunction, over **every prefix** of every
fixture, because typing is prefixes:

```
ask query      → Enter costs a model call   (the feature)
nav/entity/act → Enter costs nothing        (the invariant)
```

The `noResults` carve-out is adopted deliberately from the router lane's
own law: at `"d"` nothing has matched yet, Ask is the only row on offer,
and offering is not spending. ASK-FIRST *does* move where the remaining
risk lives — once Enter's default is the answer, a one-character query
plus Enter is a billed turn — and that is a property of the live input,
not the router, so it is asserted where it is true (`capsule.spec.ts`
§K9, counting real requests).

---

## THE ANCHOR LAW — this file may not carry the disease it treats

Every selector `capsule.spec.ts` depends on is declared once in `ANCHORS`
and **proved live** in the first test, in three states: closed, open,
answered. Any negative assertion downstream is therefore a real ban — the
thing it forbids is a thing this surface can render.

### The anchor law caught itself

On its first run it reported `capsule-figure-row` as dead. It was not:
`ask()` returns when the answer surface is visible, and the figures
resolve a beat later, so the gate was **snapshotting instead of
waiting** — a false RED, the mirror of the false green it exists to stop.
Fixed by waiting with a timeout.

---

## S1–S3 — THE STALE-GATE CENSUS

**A gate whose selector matches nothing is a FALSE GREEN, and a false
green is the same failure as a false red — worse, because nobody looks at
it.**

Swept: all 8 files in `e2e/design/`. Machine-run on every battery
execution by `check_capsule_ask.mjs`, so the census cannot rot into a
document nobody re-runs.

Two severities, and the distinction is the point — a gate that shouted
equally at both would be ignored:

* **FALSE-GREEN** — the assertion can never fail. Fails the gate.
* **DEAD-LIMB** — the selector is dead but the assertion can still fail
  (a live sibling in a union, or a scope that widens rather than
  narrows). Reported, does not fail.

### Census — as found, 2026-08-30

| # | Location | Selector | Severity | Verdict |
|---|---|---|---|---|
| 1 | `header.spec.ts:197` | `[data-testid="topheader-ask-cfo-ai"]` → `toHaveCount(0)` | **FALSE-GREEN** | **Retargeted by the header lane during the wave** — H2 now checks the ban *behaviourally* (accessible name + destination) rather than by a testid that can be renamed around. Zero producers existed anywhere in `frontend/`; the assertion had passed every run since it was written and would have kept passing if the control it bans returned under any other name. |
| 2 | `axe.spec.ts:47` | `.exclude('[data-testid="test-mode-banner"]')` | DEAD-LIMB | **Retarget to `public-test-mode-banner`** (the real id emitted by `TestModeBanner.tsx:44`). The exclusion excludes nothing, so the comment above it — "if a remnant survives dismissal it must not pollute the gate" — is not true. Widens the scan rather than narrowing it, so it can still fail; debt, not a lie. *Axe lane's file; reported, not edited.* |
| 3 | `axe-dark.spec.ts:48` | same | DEAD-LIMB | same |
| 4 | `modes.spec.ts:223` | same | DEAD-LIMB | same. *Modes lane's file; reported, not edited.* |
| 5 | `keyboard.spec.ts:77` | `[role="dialog"], [cmdk-root]` | DEAD-LIMB | **Delete the `[cmdk-root]` limb.** `cmdk` is in `package.json` but **imported nowhere in `frontend/`** (0 references) — the palette is a Radix `DialogPrimitive`. The live sibling `[role="dialog"]` carries the assertion, so nothing is broken today. *Bonus finding: `cmdk` is an unused dependency.* |
| 6 | `modes.spec.ts:304` | same | DEAD-LIMB | same |
| 7 | `capsule.spec.ts:563` | `[data-zone]` in the K2 zone-selector union | DEAD-LIMB | **Deleted.** My own file, and my own dead limb — removed from both mirrored counters the moment the census named it. |

### Three false positives the census had to be taught not to report

1. **`[data-coachmark]`** (`header.spec.ts:416, 430`) — a hand `grep` said
   it had no producer; `TopHeader.tsx` emits it. The manual sweep was
   wrong and the automated one was right. **This is the argument for
   making the census a gate rather than a document.**
2. **`[data-radix-popper-content-wrapper]`** (3 sites) — stamped by Radix
   at runtime, not by any file under `frontend/`. The census now resolves
   library-owned attribute prefixes against the **installed package**, so
   an attribute whose library was removed is still correctly reported as
   dead.
3. **`topheader-ask-cfo-ai` graded DEAD-LIMB, not FALSE-GREEN** — the
   classifier read one line, and a Playwright assertion is routinely
   spread over four; the `toHaveCount(0)` was two lines below the
   locator. It now classifies over the **statement**, not the line, which
   is what promoted the repo's most dangerous stale selector to the
   severity that fails the gate.

### And one the census caused

`scripts/check_stale_gates.mjs` (a sibling lane's repo-wide checker,
already in the battery) flagged `scripts/check_capsule_ask.mjs:395`. The
"testid" was `x` — from an **illustrative code sample inside a comment**
in this lane's own file. Fixed by rewriting the sample as prose: *a
census must not be a source of the noise it exists to remove.*

Two identical false positives remain in `scripts/check_header_law.mjs`
(`([^` at :384 and `…` at :66), and they are that checker's own regex
source being matched by its own pattern. Reported below as a cross-lane
need; not this lane's file.

---

## CROSS-LANE NEEDS — the three REDs, and four reports

### RED 1 — K1-d: the capsule's accessible name is still "Search"

`aria-label="Search"`, `title="Search (Ctrl+K)"` on
`data-testid="header-command-bar"`, while the placeholder reads *"Ask
anything — or jump anywhere."* **Owner: the header/shell lane.** A
screen-reader user is handed a different product from a sighted one. The
static gate cannot see it (the label resolves through `t(...)` at
runtime); `capsule.spec.ts` §K1 asserts it live.

### RED 2 — K6: the overlay is centred on the viewport, not on the capsule

Measured **0.0 px from the viewport's centre, 28.0 px from the
capsule's.** **Owner: the morph lane.** Origin the geometry on the
capsule's box — its centre and its edges — rather than on `left-1/2`.
The vertical gap (23.5 px) and CLS (0.0000) are already inside budget;
this is the last piece of "no morph" still measurable.

### RED 3 — K3: Tier-0 coverage 56.7%, floor 60%

3.3 points short — one question. **Owner: the speed lane.** The single
real gap is *"how do i export the balance sheet"*, which is arguably an
**action** query rather than a Tier-0 lookup and may belong to the router
lane instead. Twelve of the thirteen misses are correct refusals. The
floor was not moved to meet the measurement.

### REPORT 1 — `check_stale_gates.mjs` matches its own regex source

Two false positives in `scripts/check_header_law.mjs` (`([^`, `…`) come
from that file's own `data-testid` regex literals being matched by
`check_stale_gates.mjs`'s `REF_RX`. Suggested fix: skip capture groups
containing regex metacharacters, or exclude files that declare themselves
censuses. Currently masked by the baseline ratchet, which is exactly how
a real stale gate would hide.

### REPORT 2 — `topheader-ask-cfo-ai` is healed; drop it from the baseline

`check_stale_gates.mjs` already says so: *"These are FIXED — remove them
from the baseline so the ratchet cannot loosen."*

### REPORT 3 — dead copy in `shellStrings.json`

`shell.palette.placeholder` still holds *"Search pages, actions, periods,
companies…"* / *"Caută pagini, acțiuni, perioade, companii…"*. No
component renders it. Not a violation — **the gate says so explicitly**
rather than failing — but a stale string is how old wording finds its way
back. **Owner: the shell lane.**

### REPORT 4 — the C3 dimensionless-figure gap persists

`NarrativeText` attributes MONEY parts (`data-narrative-money` +
provenance in `title`) but renders a resolved **dimensionless** fact — a
ratio, a percent, a day count — as a bare `<span>2.80</span>`. In the DOM
that is indistinguishable from a numeral a model typed, which is the
exact distinction C1 and C3 exist to make. `narrativeMoney.tsx` is
import-only for this lane, so the gate stays strict and licenses only the
one string the fixture resolves to
(`KNOWN_UNATTRIBUTED_DIMENSIONLESS = ["2.80"]`).

**The fix (whoever owns `narrativeMoney.tsx`):** give the dimensionless
branch a `data-narrative-fact={fact}` span, as the money branch already
has. When that lands, delete the constant — **the gate gets stricter for
free.**
