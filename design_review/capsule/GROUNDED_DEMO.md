# THE CAPSULE — THE GROUNDED NUMERIC DEMO

> **What was owed:** *"a real number and a working provenance jump."*
>
> **What this page delivers:** the real number, on the shipped surface,
> cross-checkable to the cent against a golden this repo already
> replays. And the provenance jump — **which does not work**, for a
> reason this page names, reproduces, and proves with a one-value
> experiment.
>
> Every frame: `design_review/capsule/grounded-r2/`. Both themes.
> Machine-readable receipt: `grounded-r2/demo-report.json`.

---

## 1 · THE COMPANY, THE PERIOD, AND WHERE THE BALANCE CAME FROM

| | |
|---|---|
| File | `files/prod_scandia_frozen_31.12.2025.xlsx` |
| sha256 | `d9a520ba7b50b8de3777c7eac5e9d8ee20cd6c3a681aaa89210606659fd2ca07` |
| What it is | A real SAGA/ContSal **10-column** Romanian trial-balance export. 382 rows, multi-level analytic codes, the blank-code totals row printed first. |
| Party data | **Anonymized upstream.** `corpus/saga_10_col/meta.yaml` records this as the one case using the reviewed `anonymized_upstream: true` escape hatch: real export, real structure, no real party data. `scripts/check_corpus_policy.py` prints it as a notice on every run, and passes with everything on this page in the tree. |
| Displayed as | Scandia Food SRL · Dec 2025 (the calibration label this repo uses throughout) |
| Period id | `3f2a1c88-0000-4000-8000-0000000c0ffe` |

**This file is byte-identical to `corpus/saga_10_col/input.xlsx`** — the
same bytes `scripts/corpus_replay.py` replays 18/18 on every battery run.
That is not a coincidence; it is the reason this file was chosen over the
other four real balances in `files/`. It means the number the Capsule
puts on screen has an independent expected value already committed to
this repository, produced by a different code path, months ago.

---

## 2 · THE REAL NUMBER, AND ITS CROSS-CHECK

The question typed into the Capsule was **"what are our total assets"**.

The answer on screen:

```
TOTAL ASSETS · DEC 2025
52.764.717,79 RON
```

Read off the DOM by the driver, not typed into this file
(`grounded-r2/demo-report.json` → `themes.light.answer.figure`).

Now the cross-check. `corpus/saga_10_col/expected/gateway_facts.json`,
committed and byte-compared by the corpus gate:

```json
{ "total_assets_cents": 5276471779, "equity_cents": 775658915, ... }
```

| | Value |
|---|---:|
| On screen, in the Capsule | **52.764.717,79 RON** |
| `expected/gateway_facts.json` ÷ 100 | **52,764,717.79 RON** |
| Difference | **0.00** |

The Balance Sheet tab prints the same figure twice on the same row —
opening and closing — with a difference column of `0`, and
`TOTAL EQUITY & LIABILITIES` prints `52.764.717,79` beneath it.
`canonical_bs.status` is `BALANCED`, `difference` `0.0`, and the header
chip reads **"Verified · extraction drift 0.00%"**.

### How the number got there — and what was substituted

```
files/prod_scandia_frozen_31.12.2025.xlsx        the real bytes
  │
  ├─ RomaniaPack.parse_trial_balance             REAL. no AI: the producer
  │                                              installs sys.modules["anthropic"]=None
  ├─ RomaniaPack.assemble_parsed_tb              REAL
  ├─ pipeline.stage_persist                      REAL (the production seam)
  ├─ pipeline.stage_compute                      REAL — 68 calculated_metrics
  ├─ GET /api/period/{id}                        REAL handler, from
  │                                              pipeline.build_router()
  │                                              — the factory server.create_app includes
  ├─ fetchPeriodFromApi → useActivePeriod        REAL, over HTTP
  ├─ buildFactIndex → resolveTier0               REAL, in the browser
  └─ CapsuleFactCard → NarrativeText             REAL, on screen
```

Substituted, and only this:

* **Supabase.** An in-memory table store, bound at the `_supabase` seam
  that `stage_persist` and `get_period` already talk through. The rows
  the endpoint reads are the rows the pipeline wrote. No number passes
  through the substitution.
* **The API host.** The browser's requests to the app's configured
  origin are re-pointed at the sidecar. Same routers, same handler code,
  a different port.
* **The session.** A structurally valid unsigned JWT seeded into
  `localStorage`, so `fetchPeriodFromApi` has a token to send. It gates
  access, not arithmetic.

Nothing else. In particular: **no tool payload is stubbed.** The previous
wave's screenshots were captured with
`design_shots_capsule.mjs --stub-tools 1`, which answered
`/api/capsule/tools/*` from a literal inside the driver. Those figures
were the driver's. These are the engine's.

Producer: `design_review/capsule/tools/make_period_fixture.py`
Sidecar:  `design_review/capsule/tools/demo_engine.py`
Driver:   `scripts/capsule_demo.mjs demo`

---

## 3 · THE CITATION FOOTER

Verbatim from the DOM:

```
Period · Dec 2025    Source file · prod_scandia_frozen_31.12.2025.xlsx    Balanced
```

Four of the four things owed: the **period**, the **source file**, the
**trust verdict** (the engine presenter's own wording, passed through),
and — one line above it — **"Answered from this period's own figures —
no model call."** The snapshot rides on the tool payload's provenance
block as `snapshot_id: sha256-d9a520ba…`, i.e. the content hash of the
very file named in the footer.

---

## 4 · `<Amount>` — WHERE IT RENDERS, AND WHERE IT DELIBERATELY DOES NOT

The ask was for a number rendered through `<Amount>`. Both halves of
the honest answer:

**Money does not go through `<Amount>`, on purpose.** `CapsuleFigures.tsx`
routes a money fact through the same `{{money:FACT}}` placeholder the
prose uses, because `money.ts` formats by the CURRENCY's locale
(`52.764.717,79 RON` in any UI language) while `<Amount>` formats by the
ACTIVE UI locale (`52,764,717.79 RON` in English). The fact card is a
receipt for the sentence above it; two spellings of one number reads as
a disagreement about the number. The headline instead carries
`data-narrative-money="total_assets"`, which is the grounding claim the
C3 gate walks the DOM for.

**A dimensionless fact does go through `<Amount>`, and does carry
provenance.** Frame 6, same surface, same period:

| | |
|---|---|
| Question | "what is the equity ratio" |
| On screen | **+14.7%** |
| Renderer | `<Amount kind="percent">` |
| `data-provenance` | `"true"` — the dotted underline and the hover card are live |

Cross-check: 7,756,589.15 ÷ 52,764,717.79 = **14.70%**. The equity figure
is `expected/gateway_facts.json`'s `equity_cents: 775658915`.

> **Finding F3 — a level rendered by a delta formatter.** That `+` is
> wrong. `FigureValue` sends every `unit === "percent"` fact to
> `<Amount kind="percent">`, which calls `formatPercentDelta`
> (`frontend/lib/amountFormat.ts:140`) — a DELTA formatter that always
> prefixes `+` or `−`. An equity ratio is a level, not a movement.
> Measured on the same surface: equity ratio `+14.7%`, EBITDA margin
> `+10.9%`, net margin `+0.4%`. Three for three: it is the class, not a
> case. "+0.4% net margin" reads as "net margin improved 0.4 points"
> when it means "0.4% of revenue was profit."

---

## 5 · THE PROVENANCE JUMP — BOTH ENDS, AND WHY ONE OF THEM IS EMPTY

The dot renders, it is targeted correctly, and it navigates. It arrives
at the wrong statement.

**What the dot knows** (read off its own attributes):

```html
data-testid="capsule-provenance-dot"
data-traceable-source-statement="bs"
data-traceable-source-bucket="totalAssets"
```

**Where the click goes** (frame `5a-landed-SHIPPED`):

```
/dashboard?period=…&tab=bs&highlight=totalAssets
→ heading:  "P&L — Scandia Food SRL — 2025-12-31 (RON)"
→ [data-traceable-target="totalAssets"]  … not on the page
→ ?highlight= still in the URL              (the hook gave up, silently)
```

**Where it should have gone** (frame `5b-landed-CORRECTED-URL`, the same
trace with one parameter VALUE changed):

```
/dashboard?period=…&tab=balance_sheet&highlight=totalAssets
→ heading:  "Balance Sheet Map"
→ row:      TOTAL ASSETS   52.764.717,79   52.764.717,79   0
→ in viewport, pulsed
```

### The root cause

`CommandPalette.jumpToSource` (`frontend/components/instrument/shell/CommandPalette.tsx:543`):

```ts
next.set("tab", source.statement === "pl" ? "pnl" : source.statement);
```

That writes `bs`, `pnl` or `cf`. The dashboard's tab ids, from
`frontend/lib/financialStatementTabs.ts` `TAB_SPECS`, are `pl`,
`balance_sheet`, `cash_flow`, `ratios`, `valuation`, `risks`, `export`.
`bs`, `pnl` and `cf` are in neither `TAB_SPECS` nor `LEGACY_TAB_MAP`, so
`resolveActiveTab()` falls to its `requested = "pl"` default — **for all
three**.

Measured directly, one page load per value, on the real surface:

| `?tab=` | lands on | `totalAssets` row present |
|---|---|---|
| `bs` — what the dot emits | **P&L** | no |
| `balance_sheet` — the real id | Balance Sheet | **yes** |
| `cf` — what the dot emits | **P&L** | no |
| `cash_flow` — the real id | Cash Flow | n/a |
| `pnl` — what the dot emits | P&L | n/a |
| `pl` — the real id | P&L | n/a |

So: **a P&L number's dot works by accident** — the fallback happens to be
P&L. **A Balance Sheet or Cash Flow number's dot lands on the wrong
statement**, and `useHighlightFromUrl` is documented to *"silently give
up after 1s ... a missing pulse is preferable to a dismissable error
toast."* That choice is right for a stale shared link. It is what makes
this defect invisible: nothing anywhere reports it.

**This is why frame 5b exists and why it is named `CORRECTED-URL`.** The
ask was to show both ends of the jump in one capture. The shipped click
never reaches the far end, so the far end is captured by driving the URL
the dot *should* have written. It is labelled in the filename so it can
never be mistaken for shipped behaviour, and the driver exits non-zero
on this every run rather than reporting a clean pass.

### The one-line fix (not applied — the frontend is read-only for this lane)

`jumpToSource` should map the taxonomy to the tab ids:

```ts
const TAB_FOR: Record<Statement, TabId> =
  { pl: "pl", bs: "balance_sheet", cf: "cash_flow" };
next.set("tab", TAB_FOR[source.statement]);
```

And the mapping wants a gate that asserts every `Statement` resolves to
a member of `TAB_SPECS`, because the two vocabularies live in files that
do not import each other, which is exactly how they drifted.

---

## 6 · THE FRAMES

`design_review/capsule/grounded-r2/`, `--1440--light.png` and
`--1440--dark.png` for each. Verified byte-distinct per theme — see the
autonomous-decisions report for why that check exists.

| Frame | What it shows |
|---|---|
| `1-pill` | The header capsule at rest, real period loaded |
| `2-typed` | The question typed; the Tier-0 preview already resolved, before Enter |
| `3-answered` | **52.764.717,79 RON**, the dot, the citation footer, "no model call" |
| `4-dot-hover` | The pointer on the dot, its label showing |
| `5a-landed-SHIPPED` | Where the click actually goes: the P&L tab |
| `5b-landed-CORRECTED-URL` | Where it should go: the pulsed `TOTAL ASSETS` row |
| `6-amount` | The `<Amount>`-rendered `+14.7%` with its provenance affordance |

No screen recording. Playwright's video capture writes `.webm`, which
does not render in a Markdown review and would have to be transcoded to
be useful; the numbered sequence was the specified alternative and it
carries something a recording does not — a machine-readable receipt per
frame, asserted by the driver.

---

## 7 · SPEND, ON THIS DEMO

`0` model-seam requests, both themes, for the whole sequence — two
questions asked, two answers given, nothing billed. Counted by URL
against the same two seams K10 names (`/api/capsule/tools/` and
`functions/v1/chat-llm`), recorded from the browser's own request
stream, and asserted by the driver.
