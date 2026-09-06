# Provenance — the affordance everywhere the payload supports it, critique r1

**Captures:** `design_review/provenance/r1/` — 48 frames: four surfaces
(dashboard, balance sheet, findings, public-companies overview) × 1440 and
390 × Paper and Terminal × rest / hover / focus. Produced by
`e2e/design/provenance-screens.spec.ts` against the live test-mode stack
with the real-engine Carniprod period served from the browser (the fixture
`e2e/fixtures/provenance/carniprod_period.json`, another lane's; read here
as data, written nowhere). Counted on every frame, identically in all four
passes:

| surface | affordances on screen | base (f1e5824) |
|---|---|---|
| dashboard key-metric row | 4 | 0 |
| balance sheet | 94 | 94 |
| findings cards | 24 | 18 |
| public-companies overview | 73 | 0 |

Hover opened the card on every surface and focus opened it on every
surface, in both themes and at both widths (`"hover":true,"focus":true`
on all 16 surface×pass readings). That is the claim this lane was asked
to make and it is measured, not assumed.

What follows is what the frames show that the counts do not.

---

## 1. The card on the leftmost dashboard tile is cut off by the sidebar

`dashboard-desk-{light,dark}-hover.png`, `dashboard-desk-dark-focus.png`.
The revenue tile's card opens centred on the figure, ~300 px wide, and its
left 35 px sit BEHIND the sidebar: the frame reads `217,270.73 RON`,
`rce input.xlsx`, `riod FY2025`, `thod P&L builder subtotal · …`. The
exact figure — the one line the card exists to give — loses its leading
digits.

Measured cause: `ui/tooltip.tsx` paints the content at `z-50`;
`Sidebar.tsx` is `fixed … z-30`. So it is NOT a stacking defect — z-50
sits above z-30. What clips it is the popper's collision handling: Radix
avoids the VIEWPORT edge, not the sidebar, so the card is free to extend
under a fixed rail whose background is opaque … except that at z-50 it
should paint over that rail. The frame says otherwise, so one of those
two facts is wrong on this page; the sidebar in AppShell may sit in a
later stacking context. **Not resolved in this round.** The honest fix is
either a `collisionBoundary` on the tooltip content (a `Provenance.tsx`
change, which this lane must not make) or `side="right"` on the first
tile — but `<Amount>` does not forward `side`, so the tile cannot ask.
Recorded as the first defect for the affordance's owner, with the frame.

At 390 px the same card is fine (`dashboard-phone-light-hover.png`): no
sidebar, and the card sits above the tile, fully inside the viewport.

## 2. A long parameter path is clipped in the findings card

`findings-desk-light-hover.png`, `findings-phone-dark-hover.png`. The
limit's card reads `Source profiles.yaml#detectors.data_quality_bs_im` and
stops. The path has no break opportunity, the card is `max-w-[300px]`
with `overflow-hidden` from the tooltip primitive, so the tail of the
one string that makes the limit checkable is gone. The visible source
line under the meter (`Parameter from profiles.yaml#…`) already truncates
with a title attribute, which is the same compromise one line lower.

This is a `Provenance.tsx` concern (`break-all` on the mono source, or a
wider card for paths) and is left for its owner. What this lane did NOT
do is shorten the source in the payload to make it fit — a trimmed path
that looks whole is a fabrication one step removed.

## 3. The dashboard card names a file the header says does not exist

`dashboard-*-hover.png`: the card says `Source input.xlsx`; the header
three inches above says `SOURCE No source file yet`. Both are reading the
served period honestly — the card reads `period.source_document.filename`
(present in the fixture), the header reads the documents list (empty in
the fixture). On a real upload the two agree. On this fixture they do
not, and a reader who compares them will believe the header and doubt
the card. That is a fixture inconsistency, not a product one, but it is
on the frame and it stays on the record.

Same family: the overview badge says **Imbalanced · extraction drift
7.39%** while the balance sheet says **Balance check passed —
engine-verified**. The fixture pairs a BALANCED canonical envelope with
a data-quality finding at 7.4% drift; a served period cannot do that.

## 4. `computedAt` is a raw microsecond timestamp

`public-companies-*-hover.png`: `computed 2026-09-03T18:14:05.309973+00:00`.
True, and unreadable. The card prints the payload verbatim, which is the
rule; the payload's `lastUpdated` carries microseconds. A date-only
render would be a `Provenance.tsx` formatting decision (with the full
stamp kept somewhere), not a payload change.

## 5. `Source seed_bvb` and `Source demo` are honest and look odd

The BVB universe rows name `seed_bvb` as their source — a static seed,
which is exactly what they are. A reader will not know what `seed_bvb`
means. It is still the right thing to print: the alternative was a
prettier word the payload never said. The gloss belongs beside the
universe's own "as of" caption, not in the card.

## 6. What the receipt's autofocus did, measured

Opening the trust receipt moved focus to its first tabbable element,
which — now that the difference figure wears the affordance — was the
figure, and focus opens the card. `headerLaw.test.tsx H3b` went red with
the mapping pack found twice: once in the Mapping row, once in a card
nobody asked for. Fixed in `TrustChip.tsx` by sending the sheet's initial
focus to its title (`onOpenAutoFocus` → a `tabIndex={-1}` title), so the
dialog still takes focus and the first card opens only when a reader
tabs to it. The test was NOT loosened; it is the measurement.

## 7. Two harnesses rendered without the provider App.tsx mounts

`headerLaw.test.tsx` and `multiYearHistory.smoke.test.tsx` rendered
their surfaces with no `TooltipProvider`. They went red the moment those
surfaces grew the affordance — the same signal `findingCard.test.tsx`
recorded on 2026-09-02 — and were fixed by mounting the provider, with
the reason written in each file. No assertion was removed.

## 8. What was NOT done, by name

- **BenchmarkingPanel** stays HAS_MISSING. Every figure sits inside a
  `<button aria-pressed>` tile; the affordance is a focusable span and
  cannot live inside a button. The tile needs the stretched-sibling
  restructure MetricCard and CompanyCard use. The census names it.
- **KpiVarianceStrip / VarianceTable** stay HAS_MISSING. The row payload
  carries nothing; the page that holds the dataset label and the
  canonical anchors (`pages/cfo/Variance.tsx`) is not this lane's file.
  The census names the exact props the page must pass and why the
  last-year column must stay plain until the page says where it came
  from.
- Figures inside `LearnableNumber` / `LearnableMetricCard` (a button) on
  ComprehensiveReport, MultiYearHistory, PublicCompanyDashboard's
  overview and the balance sheet's known gap stay plain, for the same
  nesting reason.
- `PercentLevel` and `CappedMultiple` carry no `provenance` prop, so
  every percent ratio and capped multiple that renders through them
  stays plain even where its origin is known (PublicCompanyDashboard
  ratios, ComprehensiveReport ratio tables).

## 9. Exports — which formats can carry the note

- **XLSX** can: the Cover sheet now carries a PROVENANCE block (source
  sheet, extraction method, parser, mapping pack) read from the served
  envelope, rows omitted when the field is absent. Cells hold notes
  natively.
- **HTML** can: the "Basis of preparation" aside gains one sentence with
  the same three fields, only when the envelope carries them.
- **CSV** cannot: RFC 4180 has no comment syntax. The Products export's
  existing `# FX provider …` lines are a convention consumers may choke
  on, and no provenance line was added to it — a note in a format that
  cannot carry one is a fake note.
- **PDF** is rendered server-side by WeasyPrint from the engine; out of
  this lane.

## 10. Verdict

The affordance now lands on the four named surfaces and opens the same
card by pointer and by keyboard in both themes at both widths, and every
figure it lands on names something the reader can check: an account
code, a sheet, a field path in the served JSON, a parameter file, a
snapshot id, a derivation. Two visible defects belong to the card
itself (clipping at the sidebar edge; an unbreakable path) and are
handed to its owner with frames rather than papered over here.
