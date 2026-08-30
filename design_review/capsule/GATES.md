# THE CAPSULE — GATES C1–C9

> **The law (permanent):** the Capsule may answer a question, and it may
> never invent a figure, never write, never guess at absent data, never
> spend a model call on navigation, and never fall apart when the model
> is gone. Enforced by test, not by prompt.
>
> Every gate below has a **PLANT**: the defect, made real, run, observed
> to trip the gate, and reverted. The exact text each gate emits is
> recorded verbatim. A gate whose plant was never run is a gate nobody
> has proven is wired to anything.

Three enforcement layers, cheapest first:

| Layer | File | Runs | Covers |
|---|---|---|---|
| Producer | `tests/engine/test_capsule_gates.py` | `pytest tests/engine/test_capsule_gates.py` (~1.5 s) — battery gate **`capsule-gates`** | C1-E, C2-E, C3-E, C5-E, C6-E, C9-E |
| Surface (jsdom) | `frontend/lib/__tests__/capsuleGates.test.ts` | `npx vitest run frontend/lib/__tests__/capsuleGates.test.ts` (~0.6 s) | C1, C3, C4, C6, C7, C9 |
| Live DOM | `e2e/design/capsule.spec.ts` | `npx playwright test e2e/design/capsule.spec.ts --project=chromium` (~1.5 min, needs vite :5173 + engine :8000 `PUBLIC_TEST_MODE`) | C3, C4, C7, C8, C9 |

`scripts/run_battery.py` carries one new entry, `capsule-gates`, beside
`period-integrity` and `finding-specificity` — named separately from
`pytest` because a fabricated figure fails **silently**, and a silent
failure class needs a gate with its own name in the record.

---

## THE FIGURE LAW — one rule, three files

Every numeral gate below turns on one distinction, and it is stated once
here because the rule **is** the gate:

| | |
|---|---|
| **IDENTIFIER** | Names a thing the reader can look up: a period label (`December 2024`), an account code (`461`), a served line id (`I18`), a contract version (`ct1`). Prose may carry these. |
| **FIGURE** | States a quantity: a separator between digits (`3,900`, `19.6`), a currency or percent beside it (`RON 400`, `10.3%`), or a number that names nothing in the context. Prose may **never** carry one. |

Mechanically, in all three files: strip the identifiers this context
licenses (period labels, account codes, snapshot ids, metric names, the
user's own words — never a hard-coded list), then any digit run still
standing, or any grouped/currency-adjacent run, is a FIGURE. Digits glued
to a letter (`I18`, `ct1`, `sha256`) are identifiers. Stripping runs
**before** the hard rules so a licensed identifier that contains a
separator is not mistaken for a quantity, while a longer number that
merely starts with one still is.

Implementations, deliberately mirrored rather than shared (Python,
TypeScript and an in-page evaluator cannot import one module):

- `tests/engine/test_capsule_gates.py::figures_in`
- `frontend/lib/__tests__/capsuleGates.test.ts::figuresIn`
- `e2e/design/capsule.spec.ts::unprovenancedFigures` (in-page)

---

## C1 — NO MODEL NUMERALS

**A numeral in model output that is not a resolved placeholder is
rejected at parse, regenerated once, then falls back deterministically.**

Four independent enforcement points, because the numeral can enter at
four different seams:

| | Where | What it proves |
|---|---|---|
| **C1-E-a** | `test_c1_no_figure_ever_reaches_the_language_channel` | The model is never HANDED a figure in prose. Sweeps every gap detail/fix, limitation detail/alternative, note and value scope across a 30-entry provocation matrix. |
| **C1-E-b** | `test_c1_narrative_rows_ship_a_template_the_answer_lane_can_rerender` | An engine-authored finding arrives WITH its placeholder template and bindable facts, so the answer lane re-renders instead of quoting. |
| **C1-S** | `capsuleGates.test.ts` → "the live guard" | The real `guardAnswer` refuses a fabricated figure; `runAnswerTurn` regenerates **exactly once** and then discards the prose whole. |
| **C1-D** | `capsuleGates.test.ts` + `capsule.spec.ts` | The DOM law: a figure that reaches the screen without a provenance attribute is a violation, whatever produced it. |

### PLANT C1-E-a — a fabricated total in a refusal

```python
# in _no_file_gap, temporarily:
detail="%s has no attached file (last known total 7,692,203 RON)." % label
```

```
FIGURE IN THE LANGUAGE CHANNEL — get_facts gap.detail[no_source_file] carries ['7,6', '2,2', '3 RON']: 'October 2024 has no attached file (last known total 7,692,203 RON).'
FIGURE IN THE LANGUAGE CHANNEL — compare_periods gap.detail[no_source_file] carries ['7,6', '2,2', '3 RON']: …
FIGURE IN THE LANGUAGE CHANNEL — get_account gap.detail[no_source_file] carries ['7,6', '2,2', '3 RON']: …
FIGURE IN THE LANGUAGE CHANNEL — list_findings gap.detail[no_source_file] carries ['7,6', '2,2', '3 RON']: …
FIGURE IN THE LANGUAGE CHANNEL — run_scenario_preview gap.detail[no_source_file] carries ['7,6', '2,2', '3 RON']: …
```

Reverted. The scanner's teeth are additionally proven on **every run** by
`test_c1_the_scanner_itself_catches_a_planted_figure`, which plants the
same fabrication in-process against the real refusal text — so this gate
cannot rot into a tautology between plant sessions.

### PLANT C1-E-b — a template that lags its rendered body

One `{{money:…}}` removed from a finding's `body_template`, body intact:

```
TEMPLATE LAGS THE BODY — finding data_quality_bs_imbalance: 4 money figure(s) rendered, 3 placeholder(s) in body_template
TEMPLATE LAGS THE BODY — finding concentration_related_party: 3 money figure(s) rendered, 2 placeholder(s) in body_template
TEMPLATE LAGS THE BODY — finding input_cost_exposure: 2 money figure(s) rendered, 1 placeholder(s) in body_template
```

Reverted. This is the 461 defect in template form: a figure rendered
outside the money path.

### PLANT C1-S — the model writes the number itself

Generation transport stubbed to answer, twice,
`"Total assets are RON 3,900 for December 2024."`:

- attempt 1 → `guardAnswer` → `violations: [{kind: "numeral"}]`
- the pipeline regenerates **once** (transport call count asserted `=== 2`)
- attempt 2 → same violation → `turn.deterministic === true`,
  `turn.blocks === []`, `turn.streaming === ""`, and `3,900` appears
  nowhere in the rendered blocks
- the same run twice produces byte-identical output (the fallback is
  deterministic, not a second guess)

Permanently in-suite — the plant IS the test.

### PLANT C1-D — a bare numeral in the answer surface

```
C3: 1 figure(s) in the answer carry no provenance:
      · "Total assets stand at RON 3,900 for December 2024."  in  <p>Total assets stand at RON 3,900 for December 2024.</p>
```

Reverted.

---

## C2 — READ-ONLY

**No write tool is reachable from this surface, at construction and at
runtime.**

The tool lane's own suite plants a write tool at the three registry seams
(`register_tools`, the `MappingProxyType`, `dispatch`). This lane gates
the three seams *outside* the registry, where a write path would not be
called a "tool" at all:

| | Gate | Catches |
|---|---|---|
| **a** | static source tripwire | a mutating route decorator or a client write call anywhere in the surface's source |
| **b** | live route census | anything FastAPI actually mounted, however it was registered |
| **c** | schema sweep + dispatch | a write verb in the JSON handed to the model, and a planted callable never executing |

### PLANT C2-a / C2-b — a delete route on the capsule router

```python
@router.delete("/api/capsule/period/{period_id}")
def drop_period(period_id: str):
    return {"ok": True}
```

```
MUTATING ROUTE — src/engine/api/_capsule_tools.py:1642 @_ROUTER.delete("/api/capsule/period/{period_id}")
CLIENT WRITE — src/engine/api/_capsule_tools.py:1642 @_ROUTER.delete("/api/capsule/period/{period_id}")
```
```
WRITE METHOD MOUNTED — DELETE /api/capsule/period/{period_id}
```

Reverted. (Both static rules fire on the same line — the decorator is
also a `.delete(` call. Belt and braces, on purpose.)

### PLANT C2-c — a write tool in a replaced registry

`TOOL_REGISTRY` monkeypatched wholesale to a dict containing
`set_period_status`, then dispatched with three argument shapes. Every
call returns a typed refusal (`tool_not_allowlisted`), the payload still
reports `read_only: true`, and the planted callable's invocation list
stays empty. Permanently in-suite.

---

## C3 — GROUNDING

**Every figure in an answer traces to a snapshot fact with provenance.**

Producer half: every value carries `entity_id` + `source`, a period
identity (`period_id`+`period_label`, or `from_period_id`+`to_period_id`
for a delta), and a snapshot anchor — unless it DECLARES itself derived,
in which case the result must also carry an anchored value it derives
from. Nothing floats free.

DOM half: every figure inside `[data-testid="capsule-answer"]` sits in an
element carrying `data-narrative-money` / `data-traceable-source-*` /
`data-provenance`, or inside a figure/citation/trace row whose own markup
is the provenance.

### PLANT C3 — provenance stripped at the producer

`_provenance()` returns `{}`:

```
UNGROUNDED VALUE — get_facts total_assets: provenance missing ['entity_id', 'source']
UNGROUNDED VALUE — get_facts current_ratio: provenance missing ['entity_id', 'source']
UNGROUNDED VALUE — get_facts equity_share: provenance missing ['entity_id', 'source']
UNGROUNDED VALUE — get_facts net_margin: provenance missing ['entity_id', 'source']
UNGROUNDED VALUE — get_facts revenue: provenance missing ['entity_id', 'source']
UNGROUNDED VALUE — compare_periods total_assets_a: provenance missing ['entity_id', 'source']
```

Reverted.

---

## C4 — ROUTER ACCURACY

**The 40-query fixture set classifies correctly, and navigation queries
never burn a model call.**

Measured 2026-08-30, `frontend/lib/__tests__/capsuleGates.test.ts`:

| Lane | Fixtures | Correct |
|---|---|---|
| navigate | 12 | **12 / 12** |
| entity | 8 | **8 / 8** |
| action | 8 | **8 / 8** |
| ask | 12 | **12 / 12** |
| **total** | **40** | **40 / 40** |

Beyond the label, four properties, all asserted over **every prefix of
every fixture** (607 keystrokes — because typing is prefixes, and a
router that only behaves on complete words bills you while you type):

1. **Zero network.** `fetch`, `XMLHttpRequest`, `WebSocket`,
   `EventSource` and `navigator.sendBeacon` are all replaced with traps
   that record and throw. Attempts: **0**.
2. **Enter is free** on every navigate / entity / action prefix that has
   matched something. (A prefix that has matched *nothing* offers only
   the Ask row; offering is not spending.)
3. **Exactly one paid row** per result, and Tab always reaches it.
4. **Purity** — same query, same rows, twice, memo cleared between.

Live half (`capsule.spec.ts`): 12 queries typed character-by-character
into the real palette with every request watched; requests matching
`chat-llm | /api/capsule/tools | anthropic`: **0**.

### PLANTS C4

| Plant | Gate output |
|---|---|
| `"cash flow"` starts classifying as `ask` | `"cash flow" wanted navigate, got ask` |
| the Ask row promoted to the default selection | `navigate fixture "dashboard" spends at "dashboard"` (and `"scenarios"`, `"benchmark"`) |
| a per-keystroke suggestion call | `C4: navigation spent a model/tool call:` `POST http://127.0.0.1:8000/api/capsule/tools/get_facts` |

All reverted.

---

## C5 — MISSING-DATA HONESTY

**Asking about an absent period yields the explicit gap answer, never an
estimate.**

Five tools asked about the month with no file. Each must refuse, name the
month, name the fix, carry no values and no bindable facts — and no
number belonging to a month that *does* have a file may appear anywhere
in the payload.

### PLANT C5 — the month next door

The single most plausible wrong thing in this product, and it is one
`if`:

```python
def substituting(context, ref):
    period, gap = original(context, ref)
    if period is not None and not period.has_source_file:
        for candidate in context.periods:
            if candidate.has_source_file:
                return candidate, None        # THE ESTIMATE
    return period, gap
```

The plant produces a confident, well-formed, correctly-provenanced,
completely wrong answer. The gate:

```
get_facts answered about a period with no file
```

Reverted — and kept permanently in-suite as
`test_c5_a_planted_estimator_is_caught_by_this_suite`, which asserts the
plant *takes* (`result.ok`, values non-empty, the month unnamed, the
figure equal to December's) so the gate is provably wired to the defect
rather than to a string.

Also gated, permanently: a refusal may OFFER another period ("Ask about
one of: …") but may never state its number; and no refusal anywhere may
hedge (`approx`, `roughly`, `estimated`, `circa`, `aproximativ`, … ).

---

## C6 — UNIT LAW

**An answer is identical in RON and EUR display except for presentation;
ratios are invariant.**

Producer: there is no display-currency input to reach for — every tool
refuses a `currency` argument with `bad_arguments`. A currency TWIN
(identical trial-balance rows, identical label, declared EUR) produces
identical ratio values, identical integer operands, identical money minor
units, and a payload that is byte-identical once the currency label and
the period id are normalised.

Surface: the same template rendered under both dials keeps the same DOM
skeleton, the same fact names in the same places, one currency per claim,
and a ratio that does not move.

### PLANT C6-E — a converting ratio

```
RATIO MOVED WITH THE CURRENCY — current_ratio RON=2.8000000 EUR=13.9020000
```

### PLANT C6-S — a ratio declared as money (one word in a unit table)

| | RON display | EUR display |
|---|---|---|
| sound | `Current ratio is 2.80.` | `Current ratio is 2.80.` |
| planted | `Current ratio is 2,80 RON.` | `Current ratio is 0,56 €.` |

This is the 1553% / 461 class exactly: a dimensionless number that
acquires a currency and then gets converted. Both reverted.

---

## C7 — DEGRADED PARITY

**With AI mocked dead, search / navigation / actions work, the message is
calm, and the DOM contains zero raw payload.**

- Routing is a pure function and is asserted **with the network trapped**:
  every non-ask fixture still yields rows, and every default row resolves
  to a destination, a command or an entity — none of which needs a model.
- Every failure shape collapses onto one of three kinds
  (`service | usage | network`), including the Edge Function's
  wrapped-upstream sentinel, which is intercepted rather than rendered as
  a successful answer.
- The degraded copy (EN + RO) carries no `{`, `}`, `request_id`,
  `req_011`, `invalid_request_error`, `max_tokens` — and no figure.
- Through the live pipeline: a throwing transport sets `turn.degraded`,
  `deterministic = true`, empties `blocks` and `streaming`, and the
  retrieved figures survive. `JSON.stringify(turn)` carries no fragment
  of the raw payload.
- A **tool** read that throws becomes a stated absence, not a failed turn.
- Live: with generation 500-ing, the whole `page.content()` is swept for
  the forbidden fragments and something calm is on screen; then the
  palette is reopened and navigation still resolves.

### PLANT C7 — the payload rendered

```
C7: raw payload fragment "request_id" reached the DOM
```
```
en.reasonService leaks {: expected "CFO AI failed: {\"error\":{\"type\":\"invalid_request_error\"},\"re"… not to contain "{"
```

Reverted.

---

## C8 — HEADER BUDGET UNCHANGED

**The Capsule stays ONE control and `e2e/design/header.spec.ts` still
passes at its sanctioned count.**

The budget number is not re-declared here: `capsule.spec.ts` **parses
`HEADER_BUDGET` out of `header.spec.ts`** and asserts it is still 5, so
the two specs cannot drift about what the budget IS. The census is then
run with the same definition (visible, not in an overlay, no interactive
ancestor, a `role="radiogroup"` counts once).

Measured 2026-08-30, `/dashboard` and `/chat` at 1440×900:

| Control | |
|---|---|
| brand mark | `aria=Go to dashboard` |
| Simple\|Pro dial | `testid=mode-switch` (`role="radiogroup"`, counts once) |
| **THE CAPSULE** | `testid=header-command-bar` |
| notifications | `testid=notifications-button` |
| account | `testid=account-menu-trigger` |
| **total** | **5 / 5** |

The Capsule contributes **one** counted control. The trust dot is the one
sanctioned second hit target inside the pill (the verdict stays one tap
away) and is asserted to live *inside* `[data-testid="header-capsule"]`;
it did not render on the test-mode period, so the live count is 5.

### The state of `header.spec.ts` itself — measured, not assumed

Run in full on the same stack, 2026-08-30: **10 passed, 5 failed**. All
five are **pre-existing** and none is caused by this lane (which added no
control and touched no product file):

| Failing test | Why |
|---|---|
| `H1 budget holds on /dashboard` · `on /chat` | its census double-counts the `role="radiogroup"` dial and reports 6; the header holds 5 (cross-lane need #1) |
| `H5 currency: 2 interactions` | drives `[data-testid="currency-menu-trigger"]`, which the header does not render — currency moved into the avatar menu in the committed Capsule consolidation (`TopHeader.tsx` header law, commit `9b3db78` and earlier) |
| `H5 period switch via the ContextObject` | drives `[data-testid="context-object"]`; `TopHeader` now shows the period through `useCapsuleLabel()` inside the Capsule, and no longer mounts `ContextObject` |
| `H6 Escape closes each header popover` | same two missing triggers |

So "the sanctioned count is unchanged" is true and is what this lane
gates; "header.spec.ts is green" is not true today, for reasons that
predate the gates lane and belong to the header lane.

### PLANT C8 — one more header control

```
C8: header carries 6 top-level interactive elements (budget 5). Inventory:
  · <button> testid=null aria=Go to dashboard
  · <div> testid=mode-switch aria=View mode
  · <button> testid=header-command-bar aria=Search
  · <button> testid=notifications-button aria=Notifications
  · <button> testid=account-menu-trigger aria=Account menu · Test visitor
  · <button> testid=planted-header-control aria=Planted
```

Reverted.

---

## C9 — LATENCY

**Reported, not promised.** Measured 2026-08-30 on this machine
(M-series, local vite + engine).

| What | p50 | p95 | max | n |
|---|---|---|---|---|
| Router, cold keystroke (memo cleared each time) | **0.006 ms** | 0.011 ms | 0.044 ms | 607 |
| Engine retrieval, one `dispatch` | **0.01 ms** | 0.36 ms | 4.69 ms (`list_findings`) | 60 |
| Surface first token (tools + model stubbed) | **0.01 ms** | 0.04 ms | 0.06 ms | 30 |
| **Live** palette open | **58–66 ms** | | | 2 runs |
| **Live** keystroke → rows | **9–10 ms** | | 12 ms | 8 queries |
| **Live** question → first painted answer | **289–321 ms** | | | 2 runs |

**What the first-token number does and does not include.** The live
289–321 ms is question → figures painted, with the tool endpoint and the
generation endpoint both fulfilled from fixtures — so it is the
*surface's* budget: routing, planning, the retrieval merge, the guard,
block splitting, and paint. Anthropic's own time and the engine's HTTP
round trip are excluded **by construction**, because this gate must not
spend live credits on every run. The p50 < 1.5 s contract therefore reads
as: the surface consumes ~0.3 s of it and leaves the model ~1.2 s.

Ceilings the gates enforce (chosen with headroom, so a red means a
regression and not a busy laptop): navigation results < 100 ms; engine
retrieval p95 < 250 ms; first painted answer < 1.5 s.

### PLANT C9

| Plant | Gate output |
|---|---|
| 300 ms added to every `dispatch` | `retrieval p95 321.09ms exceeds the 250ms budget — the first-token p50 cannot hold` |
| 3 s added to the generation route | `C9: first painted answer 3524ms: expected 3524 to be less than 1500` |

Both reverted.

---

## KNOWN VIOLATIONS — quarantined by name

A ratchet, not an exemption (the convention
`scripts/check_narrative_units.mjs` established). Each entry is a real
violation of a law above, in a file **this lane does not own**. A NEW
violation fails the gate; a FIXED one prints a notice so the list can
shrink without this suite going red on someone else's improvement.

| # | Where | The violation | The fix |
|---|---|---|---|
| 1 | `engine/api/findings` → `list_findings` notes | `"17 detector check(s) ran on December 2024."` — a count stated in prose the model reads | carry the count as a declared fact and state the sentence as a template, the way findings already do for money |
| 2 | `_capsule_tools.get_benchmark` limitation | `"niche_group has 3 peer(s) for ebitda_margin — below the 5 needed to state a band."` | same: sample size and threshold as facts, sentence as template |
| 3 | `_capsule_tools.get_account` note | `"1 sub-accounts of 5 are listed individually; no subtotal is computed here."` | same |
| 4 | `frontend/lib/narrativeMoney.tsx` | a resolved **dimensionless** fact renders as a bare `<span>2.80</span>` — no `data-` attribute, so in the DOM it is indistinguishable from a numeral a model typed | give the dimensionless branch a `data-narrative-fact={fact}` span, as the money branch already has. When it lands, delete `dimensionlessRenderings()` in `capsuleGates.test.ts` and `KNOWN_UNATTRIBUTED_DIMENSIONLESS` in `capsule.spec.ts` — the gates get stricter for free |

---

## CROSS-LANE NEEDS

1. **`header.spec.ts::countHeaderInteractive` double-counts radiogroups.**
   The `role="radiogroup"` selector is already in `INTERACTIVE_SELECTOR`,
   so the dial is captured by the `topLevel` filter *and* pushed again by
   the trailing `groups` block. Its census therefore reports **6** where
   the header holds **5**, and `H1 — budget holds` fails on both
   `/dashboard` and `/chat` today for that reason alone. Verified by
   running it: the inventory prints `mode-switch` twice.
   `capsule.spec.ts` de-duplicates by identity and measures 5. One-line
   fix in the header lane: drop the `topLevel.push(...groups)` block, or
   de-dupe with a `Set`.
2. **`header.spec.ts` H5/H6 drive controls the header no longer has.**
   `currency-menu-trigger` and `context-object` are gone from
   `TopHeader` (currency lives in the avatar menu; the period is the
   Capsule's own label via `useCapsuleLabel`). Three tests fail on
   element-not-found, which reads as "the header is broken" when the
   header is fine and the spec is stale. Re-point them at the current
   homes or retire them.
3. **The four quarantined violations above** — three belong to the
   findings/tool lanes, one to whoever owns `narrativeMoney.tsx`.
4. **`capsuleAnswerGuard.ts` cites a test that does not exist.** Its
   header says drift "is caught by `capsuleAnswerGuard.test.ts`, which
   round-trips a guarded string through `parseNarrativeTemplate`";
   `capsuleAnswer/__tests__/` is empty. The gates lane binds to
   `guardAnswer` and `runAnswerTurn` from the outside
   (`capsuleGates.test.ts` → "the live guard"), but the round-trip the
   comment promises — guard's `PLACEHOLDER_RE` against the renderer's
   `PLACEHOLDER_RX` — is still unwritten and is the one drift this lane
   cannot see from outside.
5. **Nothing in this lane touched product code.** Four new files plus one
   gate entry in `scripts/run_battery.py`. No shared file was edited.

---

## Running them

```bash
# producer (in the battery as `capsule-gates`)
.venv/bin/python -m pytest tests/engine/test_capsule_gates.py -q

# surface
npx vitest run frontend/lib/__tests__/capsuleGates.test.ts

# live (needs vite :5173 + engine :8000 PUBLIC_TEST_MODE)
npx playwright test e2e/design/capsule.spec.ts --project=chromium
```
