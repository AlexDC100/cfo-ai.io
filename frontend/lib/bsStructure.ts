// Reference-format Balance Sheet structure.
//
// Same shape philosophy as the P&L renderer (plStructure.ts): a structured
// list of sections, each with line items and an optional subtotal. The
// difference is the BS shows TWO periods side-by-side (opening + closing)
// with a delta column, and contra-asset rows (accumulated depreciation)
// render in parentheses.

export type BSLineStyle = "item" | "subtotal" | "total" | "contra" | "note";

export interface BSLine {
  /** Romanian account code(s), e.g. "215", "1621", "5121+5124+5311" */
  accountCode?: string;
  /** Description, e.g. "Investment property" */
  label: string;
  /** Opening balance (01.01.<year>) */
  opening?: number;
  /** Closing balance (31.12.<year>) */
  closing?: number;
  /** Delta — when undefined, the renderer computes closing − opening */
  delta?: number;
  style: BSLineStyle;
  /** Contra-asset (accumulated depreciation) — render in parens, treat as negative */
  isContra?: boolean;
  indent?: number;
  /** Stable Traceable bucket key — populated for rows that any ratio,
   *  valuation tile, or KPI on another tab might link back to. The
   *  BSStatementView renderer emits this as `data-traceable-target=`
   *  on the row so `useHighlightFromUrl()` can scroll+pulse it when
   *  a `<TraceableNumber>` click lands here. See
   *  src/lib/traceableSource.ts for the bucket taxonomy. */
  bucket?: string;
  /** RECONCILIATION FLOW (canonical_bs path only) — true on the synthetic
   *  "Diferențe de reconciliere" adjusting row. The renderer shows a small
   *  visible marker so the row can never pass as a source figure. */
  synthetic?: boolean;
  /** Tooltip for the synthetic marker: reconciliation rationale · origin
   *  · timestamp, prebuilt by the canonical builder. */
  syntheticNote?: string;
}

/**
 * closing − opening, or `undefined` when either side is ABSENT.
 *
 * THE POINT OF THIS FUNCTION IS THE `undefined`. A comparative column
 * the filing did not carry has no delta: "Δ 0" is a claim that the
 * figure did not move, and nothing was measured to say that. Reading
 * an absent opening as 0 is worse still — the delta column then paints
 * the whole closing balance as this year's change.
 *
 * Every delta on the Balance Sheet — row, subtotal and grand total —
 * goes through here so no caller can quietly reintroduce the `?? 0`.
 */
export function bsDelta(
  opening: number | null | undefined,
  closing: number | null | undefined,
): number | undefined {
  if (typeof opening !== "number" || !Number.isFinite(opening)) return undefined;
  if (typeof closing !== "number" || !Number.isFinite(closing)) return undefined;
  return closing - opening;
}

/** A served figure normalised to `number | null`.
 *
 *  `undefined` (key absent), JSON `null` (key present, no value) and
 *  `NaN` are the SAME fact — nothing was measured — and every one of
 *  them must reach a consumer as `null` rather than as a `?? 0`. Kept
 *  beside `bsDelta` because both exist to stop the same substitution
 *  from re-entering the balance sheet through a different door. */
export function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface BSSection {
  /** Section header, e.g. "NON-CURRENT" or "EQUITY" */
  header: string;
  lines: BSLine[];
  subtotalLabel?: string;
  /** Opening subtotal. ABSENT (undefined) when the served object carried
   *  no comparative for this section — never the closing subtotal
   *  mirrored across, which would paint a fabricated Δ 0. */
  subtotalOpening?: number;
  subtotalClosing?: number;
  /** closing − opening. ABSENT when either side is. Build it with
   *  `bsDelta`, never with `?? 0`. */
  subtotalDelta?: number;
  /** Stable Traceable bucket key for the section subtotal row — e.g.
   *  "totalCurrentAssets", "totalCurrentLiabilities". Renderer emits
   *  this on the subtotal row so cross-page TraceableNumber clicks
   *  can land here. */
  subtotalBucket?: string;
}

/** A two-period figure. `opening` and `delta` are ABSENT when the source
 *  carried no comparative — see `bsDelta`.
 *
 *  `closing` is ABSENT-CAPABLE too. It used to be `number` while the
 *  canonical builder assigned `toDisplay(core.totalAssetsCents)` and the
 *  public adapter assigned `totalAssets.closing ?? 0` — both of which
 *  turn an unserved grand total into a reported zero. A grand total the
 *  envelope did not carry is not a zero balance sheet. */
export interface BSTotalPair {
  opening?: number;
  closing: number | null;
  delta?: number;
}

export interface BSStatement {
  entity: string;
  /** Date string for closing column, e.g. "31.12.2025" */
  asOf: string;
  /** Header for the opening column, e.g. "01.01.2025" or "Opening".
   *  ABSENT when the source served no comparative figures at all: a
   *  column header naming a date is a claim that figures under it were
   *  measured on that date, and there are none. The view then states
   *  the absence instead of labelling an empty column. */
  comparativeDate?: string;
  currency: string;
  /** Asset side — typically [NON-CURRENT, CURRENT] */
  assetSections: BSSection[];
  totalAssets: BSTotalPair;
  /** Equity & liabilities side — typically [EQUITY, NON-CURRENT LIAB, CURRENT LIAB] */
  equityLiabSections: BSSection[];
  totalEquityLiab: BSTotalPair;
  /** closing total assets − closing total E&L; should be ~0.
   *
   *  ⚠ NULL when either side is absent. This field was typed `number`
   *  while `buildBsStatement` assigned `toDisplay(core.differenceCents)`
   *  and `differenceCents` is `number | null` — `null / 100` is `0` in
   *  JavaScript, so an unstateable drift arrived here as a PERFECT
   *  BALANCE. Unreachable in the UI only because `BSStatementView`
   *  happens to guard the warning on `!statement.canonical`; the value
   *  itself was wrong for every other reader (exports, tests, any future
   *  caller). `strictNullChecks` is off for the frontend project, which
   *  is why the assignment compiled — `scripts/check_null_boundaries.mjs`
   *  is the gate that now sees it. */
  balanceCheck: number | null;
  /** Optional note shown beneath the BS, e.g. dividends declared-but-not-paid */
  note?: string;
}
