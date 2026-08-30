# THE CAPSULE — BEFORE / AFTER

> Measured on one machine, one viewport (1440×900), one workspace
> (`demo-meridian`), on 2026-08-30. **Before** is the surface as it stood
> at commit `529e278`, captured before any lane in this wave had landed.
> **After** is the surface at the end of the wave, with three gates still
> red (named at the bottom, and in `GATES.md`).
>
> Screenshots: `ask-first-before/` and `ask-first-after/`, both themes.

---

## THE ONE-LINE VERSION

The Capsule went from **a search box that could also answer** to **an
answer box that can also navigate** — and the evidence that the change is
real is that the empty state lost 12 of its 16 rows and 4 of its 5 zones
while the answer got *faster to trust* and only 108 ms slower to appear.

---

## WHAT THE OWNER REPORTED, AND WHAT EACH ITEM MEASURES AT NOW

| # | Owner's words | Before, measured | After, measured | Gate | State |
|---|---|---|---|---|---|
| 1 | placeholder reads "Search pages, actions, periods, companies…" — the verb is SEARCH when it must be ASK | `"Search pages, actions, periods, companies…"` | `"Ask anything — or jump anywhere"` | K1-a, K1-c | **fixed** |
| 1b | *(not reported — found by a plant)* the trigger's accessible name | `aria-label="Search"` | `aria-label="Search"` | K1-d | **RED** |
| 2 | the empty state stacks FIVE sections = 18 rows | **5 zones / 16 rows** | **1 zone / 4 rows** | K2 | **fixed** |
| 3 | "Ask a question" is a LIST ROW among navigation items | row 2 of 16, between two `PAGES` groups | no ask row; Enter answers | K1-b, K1-e | **fixed** |
| 4 | the overlay renders as a detached flat panel BELOW the capsule, no morph, large dead space | centre drift **35.7 px**, gap **67.5 px** | centre drift **28.0 px**, gap **23.5 px** | K6 | **RED** (gap fixed, centre not) |
| 5 | answers are perceived as slow | open 68 ms · first answer 300 ms · **no instant tier** | open 34 ms · first figure 408 ms · **instant answer 16 ms** | K3, K5 | **fixed** (see below) |
| 6 | SIMPLE/PRO still occupies the header: 5 elements vs the H1 budget of 4 | **5 controls** | **4 controls** | K8 | **fixed** |

---

## 1 · THE VERB

**Before** — `frontend/components/instrument/shell/shellStrings.json`:

```
en: "Search pages, actions, periods, companies…"
ro: "Caută pagini, acțiuni, perioade, companii…"
```

**After** — the live `placeholder` attribute:

```
"Ask anything — or jump anywhere"
```

The old key is still in the strings file but **nothing renders it**. The
static gate reports it as dead copy rather than as a violation, and names
it so it gets deleted before somebody wires it back up.

**Still red:** the trigger's `aria-label` is `"Search"`. A sighted user
reads *"Ask anything"*; a blind user is told *"Search"*. Same control,
two different products. Found by the K8 plant's inventory line, not by
design — see `GATES.md` §K1-d.

---

## 2 · THE EMPTY STATE

**Before** (census taken off the live DOM, /dashboard):

```
5 zones · 16 rows
  Context zone      · Period · not verified
  PAGES             · Dashboard
                    · Ask a question          ← the ask row, buried at #2
  PAGES  (again)    · Workspaces, Scenarios, Benchmark, Products,
                      Budget vs Actual vs LY, Public Companies,
                      Ask CFO AI, Settings
  ACTIONS           · Upload a document, Export statements,
                      Switch to Terminal theme, Ask CFO AI,
                      Toggle sidebar
  LEARN             · Browse glossary
```

Two zones both labelled `PAGES`, with the ask row wedged between them.
Two separate rows called *Ask CFO AI*.

**After:**

```
1 zone · 4 rows
  (context line)    · Period not dated · Not verified
  JUMP TO…          · Dashboard, Workspaces, Scenarios, Benchmark
  (footer)          · Type to ask, or to jump anywhere
```

**16 rows → 4. 5 zones → 1.** Budget is ≤8 rows and ≤3 zones; the surface
came in at half the row budget and a third of the zone budget.

The counting rules are in `GATES.md` §K2 and are written to survive the
obvious evasions: an uppercase `<div>` is still a heading, a `<button>`
in a list is still a row, a `<li><button>` is one row and not two.

---

## 3 · ASKING IS NO LONGER A MENU ITEM

The clearest evidence is not in the product — it is in the **test
harness**. The pre-wave helper every gate used to ask a question:

```ts
await input.fill(question);
await input.press("Tab");     // reach the Ask row
await input.press("Enter");
```

That `Tab` is the defect, written down. Enter alone ran whatever row
happened to be selected — row 0, the first navigation destination. The
helper now reads:

```ts
await input.fill(question);
await input.press("Enter");
```

If the surface regresses, every gate that asks a question fails at once.

---

## 4 · THE MORPH

| | Before | After | Law |
|---|---:|---:|---|
| Capsule box | x 486.7 · w 538 · bottom 44.5 | x 423 · w 538 · bottom 45 | — |
| Overlay box | x 420 · w 600 · top 112 | x 360 · w 720 · top 68 | — |
| Capsule centre | 755.7 | 692 | — |
| Overlay centre | 720 | 720 | — |
| **Centre drift** | **35.7 px** | **28.0 px** | ≤24 px |
| **Vertical gap** | **67.5 px** | **23.5 px** | ≤24 px |
| Scale vs capsule | 1.12× | 1.34× | ≤2× |
| CLS open / close / stream | not measured | **0 / 0 / 0** | <0.01 |

**The gap closed; the centre did not.** In both columns the overlay's
centre sits at **720 px — exactly half of a 1440 px viewport.** The panel
is `left-1/2`. The capsule is not centred in the header, so a
viewport-centred panel cannot be the thing the capsule became.

The gate says so in one line:

```
K6: the overlay's centre is 28.0px from the capsule's and 0.0px from the VIEWPORT's.
```

Mid-wave this gate went green and then red again on its own — run A
measured 1.2 px drift, run B measured 28.0 px, minutes apart, with no
test change. **The product planted this one.**

---

## 5 · SPEED

Full table in `LATENCY.md`. The honest summary:

| | Before | After | |
|---|---:|---:|---|
| Surface open (p50) | 68 ms | **34 ms** | 2.0× faster |
| Keystroke → rows (p50) | 8 ms | **70 ms** | **9× slower** |
| Question → first painted answer | 300 ms | **408 ms** | 1.4× slower |
| **Instant answer, zero model spend** | **did not exist** | **16 ms** | new |
| Steps from question to answer | type · Tab · Enter | type · Enter | one fewer |
| Tier-0 coverage of the 30-question corpus | 0% (no tier) | **56.7%** | new |

**Two numbers got worse and both are left in.**

*Keystroke → rows, 8 → 70 ms.* The old palette filtered a static list.
The new surface also resolves an answer off the fact index on every
keystroke. 70 ms is inside the ~100 ms at which typing stops feeling
direct — a good trade, but a trade, and now a gated number.

*Question → first figure, 300 → 408 ms.* The answer now assembles a
provenanced fact card **before** any prose renders (K4). The reader waits
~108 ms longer and gets a checkable number instead of a sentence they
would have to trust.

**Neither regression would have been caught before this wave, because
before this wave nobody measured either path.**

And the thing that actually addresses *"answers are perceived as slow"*
is none of the above. It is that **"total assets" now answers in 16 ms
with zero model calls, while you are still typing** — visible in
`ask-first-after/3-tier0-instant--1440--dark.png`:

```
TOTAL ASSETS
249.372.520 RON                                    ENTER
```

The old surface had no tier below the model. Every question, however
trivial, was a round trip.

---

## 6 · THE HEADER

**Before — 5:** brand · SIMPLE|PRO · capsule · bell · avatar
**After — 4:** brand · capsule · bell · avatar

```
[K8 /dashboard] 4 controls
[K8 /chat] 4 controls
```

The header lane also strengthened its own law mid-wave, from a scalar
ceiling (`HEADER_BUDGET = 5`) to an exact sanctioned set
(`SANCTIONED_DESKTOP`, 4 identities) — strictly stronger, since a bare
count would let brand and bell swap silently. Both gates now pin the same
number from opposite sides, so neither lane can move it alone.

---

## THE SCREENSHOTS

| | Before | After |
|---|---|---|
| Capsule at rest | `ask-first-before/1-capsule-rest--desktop-1440--{dark,light}.png` | `ask-first-after/1-capsule-rest--1440--{dark,light}.png` |
| Empty state | `ask-first-before/2-palette-search--desktop-1440--{dark,light}.png` | `ask-first-after/2-empty-state--1440--{dark,light}.png` |
| Asking | `ask-first-before/3-palette-ask-row--desktop-1440--{dark,light}.png` | `ask-first-after/3-tier0-instant--1440--{dark,light}.png` |

Before images are recovered from git at commit `529e278`; after images
were captured against the live stack at the end of the wave. Both themes,
same viewport, same workspace.

**What to look at, in one glance each:**

* *Before, empty state* — the placeholder says **Search**; `PAGES` appears
  twice with `ASK · Ask a question` wedged between them; sixteen rows;
  `SIMPLE | PRO` in the header.
* *After, empty state* — the placeholder says **Ask anything**; one
  context line; one `JUMP TO…` group of four; the footer states the
  contract (*"Type to ask, or to jump anywhere"*); no dial in the header.
* *After, asking* — the answer is **already on screen while the question
  is still being typed**, with `ENTER` offered as the escalation rather
  than the only path.

---

## WHAT IS STILL RED

Three, all real, none made green by moving a threshold:

1. **K1-d** — the capsule trigger's `aria-label` is still `"Search"`.
   *Header/shell lane.*
2. **K6** — the overlay is centred on the viewport (0.0 px) rather than
   on the capsule (28.0 px). *Morph lane.*
3. **K3** — Tier-0 coverage is 56.7% against a 60% floor: one question
   short, and that question (*"how do i export the balance sheet"*) is
   arguably an action rather than a lookup. *Speed lane.*

Full detail, plant diffs and verbatim gate output: `GATES.md`.
