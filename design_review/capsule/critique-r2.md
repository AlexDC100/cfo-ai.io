# Capsule r2 — honest critique

Shots: `design_review/capsule/capsule-r2/`. Tool reads stubbed, model real.
Two of this round's findings came from a LIVE DOM PROBE rather than a
screenshot, and neither was visible in a picture. That is recorded below
because it is the useful part of the round.

## First: r1's critique was WRONG, and here is the correction

`critique-r1.md` §1 said the placeholder failed to name the period
because it read the wrong field, and cited the header's "Aug 2026" as
proof the month was available. **That was a bad diagnosis.** Probed live:

```
url    /dashboard?period=demo-meridian
header "Aug 2026"
strip  period: null
```

The demo period genuinely carries no `period_end`. The header's
"Aug 2026" is *its own current-month fallback* — today is 2026-08-30 —
not this period's month. So r1's surface was RIGHT to say nothing, and
copying the header would have made the Capsule assert a date the data
does not support. The r0 defect was a company name in the month slot;
copying the header would have been a *calendar* in the month slot. Same
error, different costume.

What was actually wrong was smaller: the strip read a bare "· Not
verified" with no subject. r2 says **"Period not dated · Not verified"** —
true, and it explains itself. The placeholder still reads "Ask anything —
or jump anywhere" when there is no month, and that is now a deliberate
refusal rather than an accident. The `selectedMonth` read was kept: it is
`formatPeriodMonth` of the *selected period row*, so it yields a month or
null and can never yield a company or a calendar fallback.

## Fixed this round

| r1 defect | r2 |
|---|---|
| magnifying glass beside an "Ask" placeholder | icon states the verb — Sparkles for ask, magnifier only when Enter navigates |
| question chip looked like a disabled input | hugs its text |
| provenance dot 400px from its number | sits beside it |
| figure list reprinted the fact card | headline is excluded from the list; the list hides when empty |
| two hints saying "type to search" | zone-3 hint deleted |

## Found by live probe, invisible in a screenshot

### 1. A raw i18n placeholder on screen
Typing `cont 5121` rendered, verbatim:

> No figure for **{{metric}}** in this period — it is missing, not zero.

`capsuleTier0.note.absent` interpolates `{{metric}}`, and that refusal
arrived without the param. Braces on screen are the renderer admitting it
did not finish — the same defect class as a half-arrived `{{money:…}}`,
which the answer lane already refuses to paint. `resolveNote` now drops
any note that still contains `{{` after interpolation, and resolves the
metric param through `metricLabel` so the refusal says "No figure for
**Revenue**" rather than "for **net_result**".

### 2. Four resolver notes had no copy at all
`capsuleTier0.ts` emits ten note keys; this lane had registered six.
`definition`, `findings`, `imbalance` and `noBreakdown` resolved to
nothing and were silently swallowed by the guard above. Now written, with
two deliberate choices: `imbalance` and `findings` render the PERIOD only
and drop the `status` / `diagnosis` params, because those are engine codes
(`MATERIAL_IMBALANCE`) and pointing an identifier at a reader is the same
mistake as `net_result`; and `definition` FRAMES the glossary's own
reviewed sentence via `plainFor(id, lang)` instead of restating it, since
`lib/glossary` already owns that copy in both languages.

The coverage is now asserted (`capsuleTier0Preview.test.tsx`), so the next
note the resolver adds fails a test instead of rendering as a blank row.

### 3. Typing a ticker in full still aimed Enter at the model
`TLV` put the Banca Transilvania row on screen and the footer still said
"Enter answers your question". The exact-match test compared against a
row's LABEL, and that row's label is the company's name while the thing
the reader typed was its ticker. Rows now carry `exactTokens`; the footer
reads "Enter opens Banca Transilvania S.A.".

## Measured, not claimed: AA contrast

The brief says AA on all text, and reduce the glass until it passes. So it
was **measured** in the running app — every text node in the panel,
composited through the real stack (scrim → panel → row), in both themes.

Paper, before: **10 of 16 text nodes failed** 4.5:1.

The cause was not the glass. The panel composites to `rgb(253,253,252)`;
making it more opaque changes almost nothing. The cause was the token:

| token | ratio on this panel |
|---|---|
| `text-ink` | 19.01 |
| `text-ink-soft` | **5.82** |
| `text-ink-mute` | **3.53** ← every failure |

So the fix is the one the evidence supports: 50 `text-ink-mute` usages
across this lane moved to `text-ink-soft`. Re-measured:

```
search state · Paper   15 nodes, 0 fail
search state · Terminal 15 nodes, 0 fail
answer canvas · Terminal 16 nodes, 0 fail
```

**The cost, stated:** the surface lost its third text tier. Hierarchy now
comes from size and case (10px caps labels vs 13px rows) rather than from
a third grey. That is the trade the brief asked for, taken deliberately.
`aria-hidden` separators keep the lighter tone and are excluded from the
audit as decorative.

## Still open

1. The fact card's provenance dot renders immediately after "RON" and at
   5px can read as a full stop until hovered.
2. `capsuleTier0`'s own K3 coverage gate fails at 46.7% (floor 60%) —
   **the speed lane's resolver, not this surface**. It means fewer Tier-0
   previews paint than intended; nothing here is wrong when one does.
3. Not yet verified in a picture: the RO surface, and the reduced-motion
   path.

## Round 3 targets

1. Give the provenance dot breathing room so it cannot read as punctuation.
2. Capture RO, and confirm no clipping at the longer strings.
3. Confirm both themes still read after the token sweep — the shots are
   the check on the numbers above.
