# Capsule answer surface — critique r1

Shots: `design_review/capsule/capsule-r1/` — 7 beats × {1440, 390} × {light, dark}.
Stack: vite :5173 + engine :8000 (PUBLIC_TEST_MODE), live Anthropic call.

## What r1 proved

The pipeline is real end to end. Beat 5 shows a live model answer that:

- contains **no numeral** anywhere;
- states precisely what is missing ("No revenue figures were retrieved for
  this question, so a month-over-month comparison isn't possible right now")
  and offers the fix — with the engine's `/api/capsule/tools/*` returning 404;
- renders the typed gap under **WHAT IS MISSING** with no raw payload;
- carries the citation footer, the four actions and a focused follow-up.

That is the invariant set working under the worst input available: an
engine that will not answer.

## Defects found

### D1 — CRITICAL: the Ask row split a group and produced duplicate React keys

The Ask row is wedged at index 1, which lands it *inside* the first group.
`grouped` runs contiguously, so "Pages" became two runs and the list
rendered two `<div key="Pages">`. React then stopped reconciling that list:

```
OPTION COUNT 3 · every row data-idx="0" · every row aria-selected="true"
footer items.length = 1
```

Rows from earlier keystrokes survived on screen, the highlight sat on all of
them, and arrow-key navigation addressed rows that were not there.

**Fix:** the top rows (best match + Ask) render as an unheaded band and
headings resume below it; group keys carry the run index. Keyboard indices
are untouched, so visual order and keyboard order still agree row for row.
Verified: 16 rows for the empty query, Ask at index 1; 1 row for a question,
Ask at index 0.

### D2 — the citation footer called a company name a period

`Period · Meridian Industries SRL`. `activePeriod.label` is the friendly
WORKSPACE label; in most workspaces that is the company. The retrieval trace
had the same bug ("Reading revenue · Meridian Industries SRL").

**Fix:** one `periodMonth` derived from `activePeriod.periodEnd`, used by both
the citation and the plan context. Null when the period has no month —
the trace then reads "Reading revenue" and the footer falls back to the
evidence's own period labels.

### D3 — the absence was stated three times

The model's sentence, then "No figures were retrieved for this question.",
then **WHAT IS MISSING**. Three restatements of one fact reads as a stutter.

**Fix:** the generic line renders only when nothing else already said it —
no prose, no gaps, not degraded.

### D4 — two exact renderings of one figure disagreed

Prose `413.727.560,00 RON` beside the figure list's `413,727,560 RON`. Both
renderers are correct and sanctioned; they simply follow different rules
(`money.ts` formats by the CURRENCY's locale, `<Amount>` by the active UI
locale). One number, one panel, two spellings reads as a disagreement about
the number itself.

**Fix (r4):** money rows in the figure list render the same
`{{money:FACT}}` placeholder the prose does, so the receipt and the sentence
are byte-identical by construction. Dimensionless rows keep `<Amount>`,
which is the renderer that knows how to print a ratio or a percent.
An intermediate attempt to differentiate by magnitude instead
(`AmountGroup`) was reverted: `<Amount>` joins the magnitude suffix to the
currency with no separator, so a 3-letter code renders "413.7 MRON".
Left as a cross-lane note rather than worked around in a shared component.

## Carried forward

- The local engine predates the ground lane's `server.py` mount and 404s on
  `/api/capsule/tools/*`. From r2 the capture script takes `--stub-tools 1`,
  which fulfils the READ layer from fixtures while the model call stays live.
  Every shot from r2 on is labelled accordingly.
