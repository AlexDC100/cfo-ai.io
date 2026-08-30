# THE CAPSULE — LATENCY, MEASURED

> **K5.** Every number on this page was measured on this machine, on the
> dates given, by the gates named. None of it is a target, a projection,
> or a number someone remembered. Where a number cannot honestly be
> measured — model time, chiefly — this page says so instead of quoting
> one.
>
> The owner's report was *"answers are perceived as slow."* Perception is
> not a metric, so the first job was to find out which of the four things
> a reader waits for was actually slow. It turned out to be none of
> them individually: the surface opened in 34 ms and painted a figure in
> 408 ms. What was slow was **the number of steps between wanting an
> answer and getting one** — type, read a list of destinations, find
> "Ask a question" among them, Tab to it, Enter, wait. The fix was
> structural (K1, K3), not a stopwatch problem, and the numbers below
> are what let that be said with confidence rather than asserted.

---

## THE MACHINE, AND WHY THAT MATTERS

| | |
|---|---|
| Host | darwin 25.3.0, local dev |
| Browser | Chromium (Playwright), viewport 1440×900 |
| Stack | vite dev :5173 + engine :8000 `PUBLIC_TEST_MODE` |
| Workspace | `demo-meridian` (five-period fictional manufacturer) |
| Generation | **fulfilled from a fixture** — NO model time is included anywhere on this page |
| Date | 2026-08-30 |

A vite **dev** server is slower than the built bundle and noisier than
CI. That is deliberate for a regression gate: the numbers are an upper
bound a user will not experience, and a regression big enough to matter
still shows through the noise. It is the wrong basis for a marketing
claim, and this page does not make one.

---

## THE MACHINE-READABLE BASELINE

`capsule.spec.ts` §K5 and `capsuleAskGates.test.ts` §K5 both parse this
block. If it drifts from the prose table below, the prose is wrong.

```latency-baseline
surface_open_ms 34 47
keystroke_rows_ms 70 74
question_first_figure_ms 408 418
pipeline_overhead_ms 0.05 0.09
router_fixture_ms 0.021 0.092
tier0_resolve_ms 0.02 0.13
```

Regression allowance, stated so nobody has to read the gate to find it:

* live measures — fail above `max(baseline_p95 × 2.5, baseline_p95 + 60 ms)`
* jsdom measures — fail above `max(baseline_p95 × 3, 30 ms)`

Generous on purpose. A gate that fires on a noisy neighbour is a gate
people learn to re-run until it passes, and at that point it protects
nothing. These thresholds still catch every order-of-magnitude
regression, which is the class a reader actually feels.

---

## THE LIVE TABLE

Measured by `e2e/design/capsule.spec.ts`. Three consecutive runs, so the
spread is visible rather than averaged away.

| What the reader is waiting for | p50 | p95 | run 1 | run 2 | run 3 | Gate |
|---|---:|---:|---:|---:|---:|---|
| **Surface open** — click the capsule → overlay visible | **34 ms** | **47 ms** | 43 / 446 | 34 / 47 | 33 / 46 | K5 |
| **Keystroke → rows** — a destination typed → rows repainted | **70 ms** | **74 ms** | 71 / 74 | 70 / 71 | 70 / 72 | K5, K9 |
| **Question → first figure** — Enter → a provenanced number on screen | **408 ms** | **418 ms** | 418 | 408 | 406 | K5 |
| **Tier-0 answer while typing** — keystroke → instant answer, zero spend | **16 ms** | — | 16 | — | — | K3 |
| **Router, live** — includes React's commit | **10 ms** | **14 ms** | 10 / 14 | — | — | K9 |

**The 446 ms outlier in run 1 is left in the table on purpose.** It was a
single `surface_open` sample taken while the dev server was hot-reloading
another lane's edit mid-run. Deleting it would have made the spread look
tighter than it is and would have hidden the one thing this table can
teach a future reader: on a dev stack, one sample in fifteen is garbage,
which is exactly why the gate keys on p95 with a 2.5× allowance rather
than on a max.

### CLS — the shift budget (K6)

| Moment | CLS |
|---|---:|
| Overlay open | **0.0000** |
| Overlay close | **0.0000** |
| Answer streaming in | **0.0000** |

Google's "good" threshold is 0.1. The gate fails above 0.01 — one order
of magnitude stricter — because a morph that jumps is not a morph, and
0.0046 was observed once on an intermediate build before the morph lane
settled.

### Overlay height vs content height (K7)

| State | Overlay | Content | Δ |
|---|---:|---:|---:|
| Empty | 307 px | 306 px | 1 px |
| One match | 159 px | 158 px | 1 px |
| No match | 130 px | 129 px | 1 px |
| Answer | 427 px | 426 px | 1 px |

Budget is ±8 px. Nothing is close to it.

---

## THE JSDOM TABLE

Measured by `frontend/lib/__tests__/capsuleAskGates.test.ts`. No browser,
no network, no model — this is the cost of **our own code**, which is the
only part this lane can make faster.

| What | p50 | p95 | max | n | Gate |
|---|---:|---:|---:|---:|---|
| Pipeline overhead — plan → fan-out → merge → guard | **0.05 ms** | **0.09 ms** | — | 12 | K5 |
| Router — classify one query | **0.021 ms** | **0.092 ms** | 0.382 ms | 40 | K9 |
| Tier-0 resolve — question → answer off the index | **0.02 ms** | — | **0.13 ms** | 30 | K3 |

The Tier-0 budget is 100 ms per question. The measured maximum is
**0.13 ms — roughly 770× inside budget.** The index is not the thing that
will ever make an answer feel slow, and that is worth writing down
because it tells the next person where *not* to look.

**Sub-millisecond numbers do not survive being run alone.** The pipeline
overhead recorded above (p50 0.05 / p95 0.09 ms) is from a full-file run,
where the JIT is warm by the time K5 executes. Running `-t "K5"` in
isolation on the same machine, minutes apart, measured **p50 0.15 / p95
1.86 ms** — a 20× swing that is entirely warm-up, not code. This is why
the jsdom allowance is `max(baseline_p95 × 3, 30 ms)` and not a
multiplier alone: at these magnitudes a pure multiplier measures the JIT.
The 30 ms floor is what makes the gate mean "the pipeline got materially
slower" instead of "vitest was invoked differently."

---

## WHAT IS NOT MEASURED HERE, AND WHY

**Model time.** The live generation transport is the Ask CFO AI Edge
Function, which is not a streaming endpoint — it returns the whole
completion in one response. On production hardware "first token" equals
"whole answer". Every generation on this page is fulfilled from a
fixture, so `question → first figure` is the cost of *retrieval, merge,
guard and paint* and nothing else. Quoting it as an end-to-end answer
time would be theatre.

**Production hardware.** These are dev-server numbers. The built bundle
is faster; by how much is not measured, so no figure is given.

**Cold start.** Every measurement is taken after an 8 s settle. First
paint after a hard navigation is a different question with a different
owner.

---

## THE BEFORE COLUMN

Measured on the pre-wave surface, same machine, same viewport, before any
lane in this wave had landed (`design_review/capsule/BEFORE_AFTER.md`
carries the full comparison):

| | Before | After | |
|---|---:|---:|---|
| Surface open | 68 ms | 34 ms | 2.0× faster |
| Keystroke → rows | 8 ms | 70 ms | **9× slower** |
| Question → first painted answer | 300 ms | 408 ms | 1.4× slower |
| Instant answer with zero spend | — | 16 ms | new |
| Steps from question to answer | type · Tab · Enter | type · Enter | one fewer |

**Two of these got worse, and the honest reading is that both are real
costs of the rebuild, not measurement noise.**

*Keystroke → rows, 8 ms → 70 ms.* The pre-wave palette filtered a static
list. The new surface resolves a Tier-0 answer from the fact index on
every keystroke as well. 70 ms is comfortably inside the 100 ms at which
typing stops feeling direct, so it is a good trade — but it is a trade,
and it is now a gated number so that the next thing added to the
keystroke path has to argue with a measurement.

*Question → first figure, 300 ms → 408 ms.* The answer now assembles a
provenanced fact card before any prose renders (K4). The reader waits
~108 ms longer for the first pixel and gets a checkable number instead of
a sentence they would have to trust. Also a trade, also now gated.

Neither regression was noticed by any gate before this wave, because
before this wave nobody was measuring these two paths at all. That is
the point of publishing the table rather than the verdict.

---
---

# SECOND PASS — MEASURED ON THE SHIPPED SURFACE

> Everything above this line was measured with the generation transport
> **fulfilled from a fixture** and, in the screenshot lane, with the
> engine's tool layer replaced by a literal inside the driver
> (`design_shots_capsule.mjs --stub-tools 1`). It left the two numbers a
> reader actually waits for — the Tier-1 fact card and the model's first
> output — **unmeasured**, and said so.
>
> This pass measures them on the real surface, against a live stack,
> with a real Romanian trial balance behind it. Two of the three answers
> are numbers. The third is that the question, as posed, has no answer on
> this surface — and that is a finding rather than a gap in the ruler.
>
> Driver `scripts/capsule_demo.mjs latency` · raw
> `latency-as-shipped.json`, `latency-repaired.json` · code state
> `MEASURED_TREE.md` · 2026-08-30.

---

## THE STACK UNDER MEASUREMENT

| | |
|---|---|
| Surface | vite dev :5173, the real app, viewport 1440×900 |
| Data | `files/prod_scandia_frozen_31.12.2025.xlsx` — a real 382-row SAGA 10-col Romanian trial balance, run through the real engine. Total assets **52,764,717.79 RON**, cross-checked to the cent against `corpus/saga_10_col/expected/gateway_facts.json` |
| Engine | `design_review/capsule/tools/demo_engine.py` — the REAL `pipeline.build_router()` and `_capsule_tools.build_router()` over an in-memory store seeded by the real pipeline |
| Generation | **REAL.** The deployed `chat-llm` Edge Function. Ten billed calls across the two runs; nothing is fixture-fulfilled on this page |
| Stubs | none that carries a number. Supabase is an in-memory store bound at the `_supabase` seam; the JWT gate is bypassed |

## HOW A NUMBER IS TAKEN

The instrument runs **in the page**. A `MutationObserver` fires, one
`requestAnimationFrame` passes, and `performance.now()` is read — as
close to "the reader can now see it" as a page can get. Node polls the
page for the stored reading rather than awaiting it, so Node's polling
granularity cannot enter any measured value.

Polling from Node directly would have had 10–50 ms granularity. The
fastest phase here is ~35 ms. Measuring that with a 30 ms ruler is how a
fast path gets published as a slow one.

### The reading that had to be thrown away

The first instrument stopped the clock as soon as an element matching
`\d` existed. It reported **0.5 ms, 0.5 ms, 0.5 ms**.

That was not a fast path. Typing `"what are our total assets"` minus its
last character leaves `"…total asset"` — which already resolves. The
preview was on screen with a figure in it before the measured keystroke,
so the observer's first check succeeded and what got timed was one
animation frame over an unchanged DOM.

Three identical readings of a physical process is the tell. The
instrument now records the text on screen when the clock starts, requires
a **change** from it, and discards any sample whose baseline already
matched (`baselineMatched`). Same phase, honest ruler: **34.7 ms**.

---

## THE TABLE

Nine samples for Tier-0, five for each model phase. Every sample is a
fresh page — `capsuleAskGuard` is module state (1.5 s gap, 6 per minute),
and reusing a page would let a later sample be *refused* and recorded as
instant.

### As shipped — `latency-as-shipped.json`

| What the reader waits for | p50 | p95 | min | max | n |
|---|---:|---:|---:|---:|---:|
| **Tier-0 first paint** — keystroke → a provenanced figure in the preview | **34.7 ms** | **38.6 ms** | 26.4 | 38.6 | 9 |
| **Tier-1 fact-card paint** | — | — | — | — | **0** |
| **First model text painted** — Enter → the model's answer on screen | **4 870.9 ms** | **5 552.2 ms** | 3 772.7 | 5 552.2 | 5 |

**Tier-1 fact-card paint is UNMEASURED, and the reason is a defect, not a
missing ruler.** As shipped, `POST /api/capsule/tools/*` returns `422` for
every call (**FINDINGS.md F1**), so no facts ever reach the turn and the
fact card is never rendered. There is no number to publish. It is not
filled from a budget, and it is not filled from the repaired run below.

**"First model token" does not exist on this surface.** `edgeGeneration
Transport` awaits `cfoApi.chatLlm` and yields the whole answer in one
chunk; `supabase/functions/chat-llm/index.ts` contains no streaming path
at all. The number above is the **complete answer landing**, and calling
it a first-token time would be inventing a quantity the architecture does
not produce.

### With the tool-layer defect bypassed — `latency-repaired.json`

Same driver, same data, against a sidecar started with
`--repair-tool-body`. **These are not shipped numbers.**
They exist so the Tier-1 phase is not published as an unknown when the
only thing standing between it and a measurement is one parameter
binding.

| What the reader waits for | p50 | p95 | min | max | n |
|---|---:|---:|---:|---:|---:|
| Tier-0 first paint | 20.5 ms | 22.4 ms | 19.2 | 22.4 | 3 |
| **Facts arrive at the client** — Enter → the tool response lands | **24.5 ms** | **33.0 ms** | 21.3 | 33.0 | 5 |
| **Tier-1 fact-card paint** | **7 317.2 ms** | **7 359.3 ms** | 5 382.4 | 7 359.3 | 5 |
| First model text painted | 7 317.0 ms | 7 359.2 ms | 5 382.4 | 7 359.2 | 5 |

Tier-0 stays in the same band across both runs (34.7 ms p50 over 9
samples as shipped; 20.5 ms over 3 here) — the expected result, since
Tier 0 never touches the tool layer, and the control that says the two
runs are comparable. Only the as-shipped run's 9-sample figure is quoted
as the Tier-0 number; three samples is a sanity check, not a p95.

*This repaired run shared the machine with a full `run_battery.py`.*
That inflates every number on the row rather than deflating it, and the
finding below survives three orders of magnitude of it, but it is said
rather than left out.

The model phase is **slower** with the tools working (4.9 s → 7.3 s p50).
That is not a regression introduced by the repair: with evidence actually
retrieved, the brief handed to the model is larger, so generation costs
more. A grounded answer is more expensive than an ungrounded one. The
ungrounded 4.9 s is the cheaper number and the worthless one — see the
verbatim answer quoted in F1.

---

## THE FINDING INSIDE THE TABLE

Look at the last three rows of the repaired run:

```
Facts arrive at the client     24.5 ms      ← the client HAS the number
Tier-1 fact-card paint       7317.2 ms      ← it puts it on screen
First model text painted     7317.0 ms      ← and the prose lands with it
```

**The card and the prose are 0.2 ms apart, in all five samples.** The
fact card does not arrive before the prose; it arrives *with* it, on the
same frame.

`CapsuleAnswerPanel.tsx` intends otherwise, in its own comment — *"THE
FACT CARD. Before the prose, because it is the answer and the prose is
the commentary"* — and then gates it on `done`, which means the whole
turn including the model call. The comment is true about DOM order and
false about time.

And the number they are waiting for **had arrived 24.5 ms after Enter**
— measured in the same `performance.now()` origin as the paint, via a
`PerformanceObserver` on the tool response. The engine answered in
single-digit milliseconds. The client then sat on a provenanced,
checkable figure for a median of **7 292.7 ms**
(`fact_card_held_behind_the_model`) while a model wrote commentary about
it.

That is a **300×** gap between having the answer and showing it.

Gating the card on retrieval completing rather than on `done` would put
the number on screen at ~25 ms instead of ~7.3 s, without changing one
value — and the reserved-height skeleton already sits below it, so it
would cost no layout shift. See **FINDINGS.md F4**.

This is the most likely remaining share of *"answers are perceived as
slow."* The first pass looked for it in the milliseconds. It is in the
seconds, and it is a render gate.

---

## WHAT THIS PASS STILL DOES NOT MEASURE

* **Production hardware.** Dev-server numbers. The built bundle is
  faster; by how much is not measured, so no figure is given.
* **Tier-1 fact-card paint AS SHIPPED.** Impossible until F1 is closed.
  When it is, re-run against `:8010` and this table gets its real row.
* **Model time variance at scale.** Five samples each. Enough to see 4.9 s
  vs 8.3 s; not enough for a p99, and none is quoted.
