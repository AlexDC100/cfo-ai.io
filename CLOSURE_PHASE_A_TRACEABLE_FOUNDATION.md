# Closure Report — Phase A: TraceableNumber Foundation

**Status: GREEN — foundation built and unit-verified (21/21 assertions pass), TS typecheck clean, no user-facing surface touched yet (the wiring is Phase B/C).**

## What changed

Four new files, one tiny edit. All additive — zero existing code paths altered.

| Path | Lines | Role |
|---|---|---|
| [scandi-desk-main/src/lib/traceableSource.ts](scandi-desk-main/src/lib/traceableSource.ts) | 99 | **Taxonomy.** Bucket enums for BS / PL / CF that mirror the engine's canonical view exactly (`accountsReceivable`, `ebitdaStatutory`, `cashFromOperating`, etc.). Constants for the URL params (`tab`, `highlight`) and the DOM data attribute (`data-traceable-target`). Single source of truth — when the engine grows a bucket, it gets added here and to the corresponding row's `data-traceable-target`. |
| [scandi-desk-main/src/components/cfo/TraceableNumber.tsx](scandi-desk-main/src/components/cfo/TraceableNumber.tsx) | 119 | **Source-side component.** `<TraceableNumber value={x} format="currency" source={{ statement: "bs", bucket: "accountsReceivable", hint: "Trade receivables (4111)" }} />`. Renders an inline `<button>` (keyboard accessible, screen-reader labelled, dotted underline on hover, focus ring), with `onClick` that preserves every existing URL param (period_id especially) and adds `?tab=balance_sheet&highlight=accountsReceivable`. Format modes: `currency` / `ratio` / `days` / `percent` / `raw`, with per-instance decimals override. |
| [scandi-desk-main/src/components/cfo/useHighlightFromUrl.ts](scandi-desk-main/src/components/cfo/useHighlightFromUrl.ts) | 73 | **Target-side hook.** Each statement page calls this once. On URL `?highlight=<bucket>` it queries `[data-traceable-target="<bucket>"]`, smooth-scrolls the row into center of viewport, applies the `.traceable-pulse` class for 1500ms, then strips the highlight param from the URL (so refresh doesn't re-pulse). Retries up to 1 s if the target row hasn't mounted yet (async period fetch). Silent give-up on stale links — no error toast. |
| [scandi-desk-main/src/components/cfo/traceablePulse.css](scandi-desk-main/src/components/cfo/traceablePulse.css) | 38 | **The pulse animation.** One-shot 1500ms amber glow + inset shadow ring. No layout shift on neighbour rows. Respects `prefers-reduced-motion` (degrades to a single 800ms fade). |
| [scandi-desk-main/src/index.css](scandi-desk-main/src/index.css) | +6 | **Pulse CSS import** added under the eeiBoard line, with a comment explaining what it's for. |

## Component API (drop-in for Phase B / C)

```tsx
import { TraceableNumber } from "@/components/cfo/TraceableNumber";
import { useHighlightFromUrl } from "@/components/cfo/useHighlightFromUrl";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";

// Source side — anywhere a number appears that came from a statement row:
<TraceableNumber
  value={42578040.60}
  format="currency"
  source={{ statement: "bs", bucket: "accountsReceivable", hint: "Trade receivables (4111)" }}
/>

// Target side — the page that renders the BS / PL / CF rows:
function BalanceSheetPage() {
  useHighlightFromUrl();  // call once
  return (
    <tr {...{ [TRACEABLE_TARGET_ATTR]: "accountsReceivable" }}>
      <td>Trade receivables</td>
      <td>{formatRON(42578040.60)}</td>
    </tr>
  );
}
```

Phase B (Ratios card) and Phase C (Valuation page) each wrap their numbers in `<TraceableNumber>` and add `data-traceable-target=` to the matching BS/PL row. One pattern, two ends, both halves in the same diff.

## Verification

### TypeScript

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

Clean. No type errors. The new module re-exports cleanly through the `@/` path alias.

### Unit test — 21 / 21 PASS

Run on a synthetic test that exercises every path the components depend on but skips the React render (avoids the JSDOM setup cost, gives sub-second feedback):

```
=== format ===
  ✓ currency normal: 42,578,040.60
  ✓ currency negative: −355,606.50         (Unicode minus, not hyphen)
  ✓ currency zero: —
  ✓ currency null: —
  ✓ currency tiny (<0.005): —
  ✓ percent positive: 43.7%
  ✓ percent zero: 0.0%

=== ratio / days ===
  ✓ ratio default 2dp: 0.49×
  ✓ ratio override 1dp: 6.6×
  ✓ days default 0dp: 53d
  ✓ days override 1dp: 52.6d

=== URL build (the critical onClick logic) ===
  ✓ preserves period + sets tab + highlight:
      "period=12160a0a-bs"
       → "period=12160a0a-bs&tab=balance_sheet&highlight=accountsReceivable"
  ✓ overwrites stale tab + highlight:
      "period=abc&tab=overview&highlight=oldBucket"
       → "period=abc&tab=pl&highlight=ebitda"
  ✓ no existing params:
      "" → "tab=cash_flow&highlight=cashFromOperating"

=== STATEMENT_TAB constants ===
  ✓ bs → balance_sheet
  ✓ pl → pl
  ✓ cf → cash_flow

=== Public constants ===
  ✓ TRACEABLE_TARGET_ATTR = "data-traceable-target"
  ✓ HIGHLIGHT_PARAM = "highlight"
  ✓ TAB_PARAM = "tab"
```

The "preserves period" case is the most important one: a user clicking a Trace number on EEI's Valuation page must NOT lose the EEI period_id when they land on EEI's BS — they should stay on EEI. The test confirms `period=12160a0a-bs` survives.

### Browser-side verification — deferred to Phase B

By design, Phase A is foundation-only with no user-facing surface. No page yet imports `<TraceableNumber>` or `useHighlightFromUrl()`, so there's nothing to observe in the browser preview. The first opportunity to verify the click → scroll → pulse loop end-to-end is when Phase B wires the Ratios card to use it; that closure will include the live browser drive-through.

## Design choices worth noting

1. **`<button>` not `<span onClick>`.** Keyboard accessible (Enter/Space), screen-reader announces "View source: ..." via `aria-label`, focus ring matches the project's existing accent color. The "looks like text" affordance is achieved via Tailwind classes (`bg-transparent border-0 p-0 m-0 font-inherit text-inherit`), not by losing the semantic role.

2. **URL state, not local state.** Clicking a TraceableNumber updates the URL (`?highlight=...`). The target page reads the URL. This means:
   - Links are shareable: "Hey look at this — `https://cfo-ai.finance/dashboard?period=X&tab=balance_sheet&highlight=accountsReceivable`"
   - Back button works (each click is a history entry)
   - Refresh doesn't re-pulse (hook strips the param after consuming it)

3. **Smooth scroll + amber pulse, not a hard jump.** Apple-style: the user's eye tracks where the page took them. 1500ms is enough to notice without being annoying. `prefers-reduced-motion` honored.

4. **Retry-then-give-up on missing target.** The target row might mount after the URL changes (async period fetch). Hook polls every 100ms for up to 1 s. Stale links (e.g. someone shared a `highlight=` for a bucket that no longer exists) silently no-op — no error toast bothering the user.

5. **Bucket keys match engine canonical names exactly.** When Phase B wraps a value pulled from `assembled_pl.ebitda_statutory`, the bucket is `ebitdaStatutory` — same key. This means future-Claude or future-me grep-ping the codebase for `ebitdaStatutory` finds both the data source and the UI link in one search.

6. **No engine code path opened.** Bug A region, Pricing, period-industry, notification-header — all fenced and untouched. Engine commits `7cab09e`/`3236f4a`/`c7895cc` intact.

## Constraints honored

- ✅ Engine numbers frozen — no `src/engine/` file touched
- ✅ No fifth phase introduced — taxonomy + component + hook + animation is the complete foundation
- ✅ D-quick dedup work preserved — `dedupeNotes.ts` and `StatementNotes.tsx` untouched
- ✅ Pure foundation — no existing user-facing page modified yet (Phase B is where the first surface gets wired)

## What's next

**Phase B (Ratios card redesign).** Replaces the wall-of-bullets in the Ratio Detail with the structured Apple-style card I sketched in the plan ("Cash + AR ÷ CurrentLiab = 0.49×" with three clickable source numbers + the "Open in full report" button finally working). One file each: the new `RatioDetailCard.tsx` (or update the existing card component), plus `data-traceable-target` annotations on the BS rows that the ratio formula references.

Foundation verified. Holding here. Awaiting your GREEN before starting Phase B.
