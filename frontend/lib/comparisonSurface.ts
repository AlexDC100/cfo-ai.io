// comparisonSurface.ts — WHAT THE DASHBOARD SHOWS ABOUT THE COMPARISON,
// COMPOSED ONCE.
//
// The dashboard page used to compose this inline: which tabs carry the
// controls, when the two notes show, what share column a tab can paint, what
// each statement's provider is handed. The gate (singleYearShare.test.tsx)
// rendered a harness that RE-IMPLEMENTED that composition, so a defect
// planted in the page itself — the outcome note never rendered, no controls
// for a one-period company, the share column switched off whenever there was
// no document — left every law green (the pre-deploy review, 2026-10-04:
// five such plants, 100 tests passed each time).
//
// The composition lives here now, and in components/cfo/ComparisonSurface.tsx
// for the three pieces of markup. THE PAGE AND THE GATE RENDER THE SAME CODE:
// the page hands it what it fetched, the gate hands it the engine's committed
// bytes. What is left in the page is three elements and one call, each held
// to its exact text by the gate's source laws.
//
// Pure. Nothing is computed here: no amount is divided, multiplied or
// rounded (the gate reads this file's syntax tree).

import { readCommonSize, shareOfferOf, type CommonSizeBlock, type ShareOffer } from "@/lib/commonSize";
import {
  missingPreviousYearEnd,
  noPriorStateOf,
  type ComparativesResponse,
  type NoPriorState,
} from "@/lib/comparatives";
import {
  comparisonNoteOf,
  comparisonSaidByPage,
  priorIsEarlier,
  type ComparisonNote,
} from "@/lib/comparisonState";
import type { OrgPeriod } from "@/lib/orgPeriods";
import type { ExportComparisonState } from "@/lib/reportComparatives";
import type { ComparativeColumns } from "@/stores/comparativesView";

/** The tabs that carry the comparison controls and the two notes. */
export const COMPARISON_TABS: readonly string[] = ["overview", "pl", "balance_sheet", "cash_flow", "ratios"];

/** The tabs that list what improved / deteriorated — the movers on the P&L
 *  and the balance sheet, the band movements on Ratios. Under a comparison
 *  that reads backwards the note there says no such verdict is given. */
export const VERDICT_TABS: readonly string[] = ["pl", "balance_sheet", "ratios"];

/** The statement tabs that wrap their view in the comparison provider. */
export type StatementTab = "pl" | "balance_sheet" | "cash_flow";

export interface ComparisonSurfaceInput {
  /** The tab on screen. */
  tab: string;
  /** The served statements of the period on screen; null with none loaded. */
  statements: { currency: string } | null;
  /** The balance-sheet tab renders the canonical statement (line items are
   *  loaded and the period carries `canonical_bs`). */
  rendersCanonicalBs: boolean;
  /** The company's analysed periods (`comparisonChoiceOf`); empty while they
   *  are not known. */
  periods: readonly OrgPeriod[];
  currentId: string | null;
  currentEnd: string | null;
  autoPick: OrgPeriod | null;
  /** The prior the page compares with, or null. */
  priorId: string | null;
  /** The reader's stored choice: a period id, null (AUTO) or "none". */
  stored: string | null | "none";
  /** The reader's stored columns — read, never written. */
  columns: ComparativeColumns;
  /** The served comparison, and the request's outcome (lib/useRatioSurfaces). */
  doc: ComparativesResponse | null;
  outcome: ExportComparisonState;
}

export interface ComparisonSurface extends ComparisonSurfaceInput {
  /** The period's own share block (`statements.common_size`), or null. */
  commonSize: CommonSizeBlock | null;
  /** The share column the tab on screen can paint from it; null on a tab
   *  with no share column of its own. */
  shareOffer: ShareOffer | null;
  /** The one sentence about the request's outcome, or null. */
  note: ComparisonNote | null;
  /** The comparison is on and compares nothing — what the notice speaks for. */
  noPrior: NoPriorState | null;
  /** The controls render: a comparison tab with a period loaded. NOT gated on
   *  the company's period list — the share box must be there to switch the
   *  column off even while that list is loading, or never arrives. */
  controlsShown: boolean;
  /** The two notes render: the same, and the company has another period —
   *  with one period nothing claims a comparison. */
  notesShown: boolean;
  /** The page already says why nothing is compared. */
  saidByPage: boolean;
  /** The engine says the comparison period is the earlier one. */
  priorIsEarlier: boolean;
  /** The tab on screen lists verdicts (`VERDICT_TABS`). */
  verdictsOnTab: boolean;
  /** The previous-year close the company has no balance for, or null. */
  missingPriorEnd: string | null;
}

export function comparisonSurfaceOf(input: ComparisonSurfaceInput): ComparisonSurface {
  const loaded = input.statements !== null;
  const onComparisonTab = COMPARISON_TABS.includes(input.tab);
  const commonSize = readCommonSize(input.statements);
  const note = comparisonNoteOf(input.outcome, input.doc);
  const hasOtherPeriods = input.periods.length > 1;
  const noPrior = hasOtherPeriods
    ? noPriorStateOf({
        periods: input.periods,
        currentId: input.currentId,
        currentEnd: input.currentEnd,
        stored: input.stored,
        priorId: input.priorId,
      })
    : null;
  return {
    ...input,
    commonSize,
    shareOffer: shareOfferOf(input.tab, commonSize, input.rendersCanonicalBs),
    note,
    noPrior,
    controlsShown: loaded && onComparisonTab,
    notesShown: loaded && onComparisonTab && hasOtherPeriods,
    saidByPage: comparisonSaidByPage(noPrior !== null, note),
    priorIsEarlier: priorIsEarlier(input.doc),
    verdictsOnTab: VERDICT_TABS.includes(input.tab),
    missingPriorEnd: missingPreviousYearEnd(input.periods, input.currentId, input.currentEnd),
  };
}

/** What one statement tab's comparison provider is handed. */
export interface StatementComparisonProps {
  doc: ComparativesResponse | null;
  columns: ComparativeColumns;
  statement: "PL" | "BS";
  commonSize: CommonSizeBlock | null;
}

/**
 * THE SHARE COLUMN OF A STATEMENT TAB EXISTS ONLY WHERE THE PERIOD'S OWN
 * BLOCK CAN PAINT IT. A tab whose offer is not served — a payload with no
 * block, a legacy balance sheet with no canonical rows — is handed no block
 * and no share column, with a comparison or without: the box says why
 * (`columnBoxesOf`), and no column of blank cells is painted under it. The
 * cash flow has no share column of its own: its provider is handed no block
 * and the reader's columns as they are.
 */
export function statementComparisonOf(surface: ComparisonSurface, tab: StatementTab): StatementComparisonProps {
  const offer = shareOfferOf(tab, surface.commonSize, surface.rendersCanonicalBs);
  const served = offer !== null && offer.served;
  return {
    doc: surface.doc,
    columns: offer !== null && !served ? { ...surface.columns, share: false } : surface.columns,
    statement: tab === "balance_sheet" ? "BS" : "PL",
    commonSize: served ? surface.commonSize : null,
  };
}

/**
 * A comparison document that came off the disk from an engine older than the
 * one answering now: it carries no `direction`, so the page could not say
 * which way time runs. Asked of the engine once more (the page's effect), as
 * a period payload without its share block is.
 */
export function documentPredatesDirection(doc: ComparativesResponse | null | undefined): boolean {
  return !!doc && (doc.direction === undefined || doc.direction === null);
}
