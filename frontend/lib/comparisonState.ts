// comparisonState.ts — WHAT THE COMPARISON ON SCREEN IS, DECIDED IN ONE PLACE.
//
// The page asks the engine to compare the period on screen with a prior, and
// one of five things is true: nothing was asked (no prior resolves, or the
// reader chose "No comparison"), the answer is on its way, the engine
// refused, the request failed, or a document is served. The column boxes,
// the note under the tab bar and the Ratios tab each used to read a piece of
// that for themselves — and two of them said nothing at all:
//   · an engine REFUSAL printed its sentence on the P&L and the balance sheet
//     only; the Overview and the cash flow showed one column and no word;
//   · a FAILED request (401, 5xx, no network) was said on the Ratios tab only.
// The same class as the incident of 2026-10-04: the comparison is ON, nothing
// is compared, nothing is said.
//
// The outcome itself is decided once, where the fetch is sorted
// (lib/useRatioSurfaces.ts `comparison`); everything here is a pure reading
// of it. Nothing is computed: no amount is touched in this module.

import type { ComparativesResponse, ComparisonOrder } from "@/lib/comparatives";
import type { ShareOffer } from "@/lib/commonSize";
import type { ExportComparisonState } from "@/lib/reportComparatives";
import type { ComparativeColumns } from "@/stores/comparativesView";

/** Why the Prior / Δ / Δ % columns are not on screen — or null when they
 *  are, or are about to be (a request in flight). */
export type ComparisonBlock =
  /** The reader chose "No comparison", or the company has one period. */
  | "off"
  /** The comparison is on and no prior resolves. */
  | "no_prior"
  /** The engine refused the comparison. */
  | "refused"
  /** The request failed. */
  | "failed";

export function comparisonBlockOf(input: {
  /** The reader's stored choice: a period id, null (AUTO) or "none". */
  stored: string | null | "none";
  /** The prior the page requests — null when nothing resolves. */
  priorId: string | null;
  /** The request's outcome (lib/useRatioSurfaces.ts). */
  outcome: ExportComparisonState | null | undefined;
  /** The company has another period to compare with. */
  hasOtherPeriods: boolean;
}): ComparisonBlock | null {
  if (!input.hasOtherPeriods || input.stored === "none") return "off";
  if (!input.priorId) return "no_prior";
  if (input.outcome?.kind === "refused") return "refused";
  if (input.outcome?.kind === "failed") return "failed";
  return null;
}

/** Why a box is off. `no_prior` is said by the no-prior notice, `no_document`
 *  by the outcome note; `share_not_served` is said beside the box itself. */
export type ColumnBoxReason = "no_prior" | "no_document" | "share_not_served";

export interface ColumnBox {
  key: keyof ComparativeColumns;
  enabled: boolean;
  /** What the box shows — the reader's stored column while it is enabled,
   *  unticked while it is off. The stored choice itself is never written. */
  checked: boolean;
  reason: ColumnBoxReason | null;
}

const COMPARISON_COLUMNS: readonly (keyof ComparativeColumns)[] = ["prior", "delta", "deltaPct"];

/**
 * THE COLUMN BOXES. The share column is no longer a comparison column
 * (owner ruling 2026-10-04): the Prior / Δ / Δ % boxes follow the comparison,
 * the share box follows what the TAB can paint —
 *   · a comparison on screen (or on its way): all four, as the reader stored
 *     them;
 *   · the comparison on and nothing compared (no prior, refused, failed): the
 *     three comparison boxes off; the share box the reader's own on a tab
 *     that can paint the period's own shares (P&L, balance sheet), off with
 *     the others elsewhere (cash flow, ratios — no share column there);
 *   · "No comparison", or a company with one period: the share box alone, on
 *     a tab that offers it — off, with the reason, when the payload carries
 *     no share block; no box at all elsewhere.
 * Pure. The reader's stored columns are read, never written.
 */
export function columnBoxesOf(input: {
  block: ComparisonBlock | null;
  /** What the tab on screen can paint from the period's own block; null on
   *  a tab with no share column of its own. */
  share: ShareOffer | null;
  columns: ComparativeColumns;
}): ColumnBox[] {
  const { block, share, columns } = input;
  const boxes: ColumnBox[] = [];
  const comparisonShown = block !== "off";
  const blockedBy: ColumnBoxReason | null =
    block === "no_prior" ? "no_prior" : block === "refused" || block === "failed" ? "no_document" : null;
  if (comparisonShown) {
    for (const key of COMPARISON_COLUMNS) {
      boxes.push({ key, enabled: block === null, checked: block === null && columns[key], reason: blockedBy });
    }
  }
  if (block === null || share?.served) {
    boxes.push({ key: "share", enabled: true, checked: columns.share, reason: null });
  } else if (comparisonShown) {
    boxes.push({ key: "share", enabled: false, checked: false, reason: blockedBy });
  } else if (share) {
    boxes.push({ key: "share", enabled: false, checked: false, reason: "share_not_served" });
  }
  return boxes;
}

// ── Which way time runs ───────────────────────────────────────────────

const ORDERS: readonly ComparisonOrder[] = ["prior_is_earlier", "prior_is_later", "same_close", "unknown"];

/** The order the ENGINE read off the two closes, or null on a document that
 *  carries none (an engine that predates the field) — the page then says
 *  nothing about the order, as before. Never derived from the dates here. */
export function comparisonOrderOf(doc: ComparativesResponse | null | undefined): ComparisonOrder | null {
  const order = doc?.direction?.order;
  return ORDERS.includes(order as ComparisonOrder) ? (order as ComparisonOrder) : null;
}

/**
 * A comparison that READS BACKWARDS (2026-10-04, the pre-deploy review): the
 * picker lets a reader compare with a period that closes AFTER the one on
 * screen, the document's Δ is then current − later, and the engine serves no
 * improved / deteriorated verdict for it — nor when it cannot read the order.
 */
export function comparisonBackwardsOf(
  doc: ComparativesResponse | null | undefined,
): "prior_is_later" | "unknown" | null {
  const order = comparisonOrderOf(doc);
  return order === "prior_is_later" || order === "unknown" ? order : null;
}

/** The bridge's two end rows name the periods "prior" and "current" only
 *  when the engine says the comparison period is the EARLIER one. */
export function priorIsEarlier(doc: ComparativesResponse | null | undefined): boolean {
  const order = comparisonOrderOf(doc);
  return order === null || order === "prior_is_earlier";
}

/**
 * THE WORD FOR A LINE ONE PERIOD LACKS. "New" and "no longer present" say
 * which way time ran: under a comparison period that is NOT the earlier one
 * a line the later period lacks would read "new". There the word only says
 * WHERE the line is — in the period on screen, or in the comparison.
 */
export function absentLineWordKey(side: "absent_prior" | "absent_current", ordered: boolean): string {
  if (side === "absent_prior") return ordered ? "statements.cmp.new" : "statements.cmp.onlyCurrent";
  return ordered ? "statements.cmp.gone" : "statements.cmp.onlyComparison";
}

// ── The one note under the tab bar ────────────────────────────────────

export type ComparisonNote =
  | { kind: "refused"; code: string }
  | { kind: "failed"; status: number }
  | { kind: "pending" }
  | { kind: "backwards"; order: "prior_is_later" | "unknown" };

/** What the outcome note says, or null: nothing was asked (the no-prior
 *  notice speaks for that), or a document is served and reads forwards. */
export function comparisonNoteOf(
  outcome: ExportComparisonState | null | undefined,
  doc: ComparativesResponse | null | undefined,
): ComparisonNote | null {
  if (outcome?.kind === "refused") return { kind: "refused", code: outcome.code };
  if (outcome?.kind === "failed") return { kind: "failed", status: outcome.status };
  if (outcome?.kind === "pending") return { kind: "pending" };
  const backwards = comparisonBackwardsOf(doc);
  return backwards ? { kind: "backwards", order: backwards } : null;
}

/**
 * The page already says why nothing is compared (the no-prior notice, or the
 * outcome note for a refused / failed / pending request), so the Ratios tab
 * does not say it again in its own words.
 */
export function comparisonSaidByPage(noPrior: boolean, note: ComparisonNote | null): boolean {
  return noPrior || note?.kind === "refused" || note?.kind === "failed" || note?.kind === "pending";
}
