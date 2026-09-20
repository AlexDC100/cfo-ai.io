// THE DASHBOARD HEADLINE FIGURES — what each one can honestly say about
// where it came from.
//
// `pages/cfo/FinancialStatements` computes six numbers once (revenue,
// EBITDA, net profit, cash, total debt, net debt) and hands them to three
// surfaces that must stay cent-identical (gate M1): the Pro KeyMetricsRow,
// Simple's StoryOverview and the first-upload journey. Each of those
// rendered the figure and DROPPED its origin at the prop boundary — the
// census filed all three as HAS_MISSING.
//
// This module is the ONE mapping, built beside the figures from the same
// inputs, so the three surfaces cannot disagree about a figure's origin
// any more than they can about its value.
//
// ── THE RULE ──────────────────────────────────────────────────────────
//
// A field goes on the card only when the PAYLOAD says it. Every claim
// below is either read from a served object or verified against one to
// the cent before it is made:
//
//   · revenue    the P&L builder's "Total operating revenue" subtotal. Its
//                section lists the account codes it summed — those are
//                the accounts, but ONLY on the line-item path: the
//                aggregates builder assigns codes to buckets as labels,
//                and a label is not a code that was read.
//   · EBITDA     `assembled_pl.ebitda_statutory` when the engine served
//                it, else the builder's subtotal. The field path IS the
//                source; a reader with the /api/period JSON can open it.
//   · profit     `assembled_pl.net_income_statutory` when the engine
//                served it, else `calculated_metrics.net_income_statutory`
//                — the same rung order `headlineFigures` picks the
//                VALUE with. Account 121
//                is claimed ONLY when the envelope's own
//                `source_anchor.closing_result` names the codes AND its
//                cents equal the figure — the anchor is the payload's
//                statement, not this module's belief about ct.121.
//   · cash       `balanceSheet.cash`, matched against the canonical
//                balance sheet's cash rows. The row account codes, the
//                sheet, the extraction method and the mapping pack are
//                claimed ONLY when those rows sum to the figure exactly.
//                A mismatch renders plain: pointing at rows that do not
//                add up to the number on screen is a jump landing nowhere.
//   · totalDebt  derived (short-term + long-term debt). Names its
//   · netDebt    derivation and NO source — same law the balance-sheet
//                subtotals follow: an aggregate is in no cell.
//
// The uploaded document's filename is the source for figures that were
// READ (revenue's accounts, the engine fields); derived figures name only
// their derivation. A period label rides in `period`, never in `source`.

import { provenanceOf, type AmountProvenance } from "@/components/instrument/Provenance";
import type { PeriodMetric } from "@/lib/activePeriod";
import type { PLStatement } from "@/lib/plStructure";
import type { CanonicalBs, Statements } from "@/lib/financialReport";

export interface HeadlineValues {
  revenue: number;
  ebitda: number;
  profit: number;
  cash: number;
  totalDebt: number;
  netDebt: number;
}

export interface HeadlineProvenanceInput {
  statements: Statements | null | undefined;
  /** The P&L the overview actually rendered (`pickPLBuilder` output). */
  pl: PLStatement | null | undefined;
  /** True when `pl` was built from per-account line items — the only
   *  path on which a section's account codes were READ rather than
   *  assigned. */
  fromLineItems: boolean;
  /** Engine calculated_metrics rows for the period. */
  metrics: readonly PeriodMetric[];
  /** Filename of the uploaded document behind the period, or null. */
  sourceDocumentFilename: string | null;
  periodLabel: string | null;
  /** The six figures as the page computed them — each mapping verifies
   *  its claim against these before making it. */
  values: HeadlineValues;
}

export type HeadlineProvenance = Record<keyof HeadlineValues, AmountProvenance | null>;

/** Cent tolerance for "this served row IS the figure on screen". */
const CENT = 0.005;

function sameCents(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= CENT;
}

function joinSource(...parts: Array<string | null | undefined>): string | undefined {
  const s = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return s.length ? s.join(" · ") : undefined;
}

// ── revenue ────────────────────────────────────────────────────────────

function revenueProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { pl, statements, values, fromLineItems, sourceDocumentFilename, periodLabel } = input;
  const section = pl?.sections[0];
  if (section && sameCents(section.subtotalAmount, values.revenue)) {
    const codes = fromLineItems
      ? section.lines
          .map((l) => l.accountCode)
          .filter((c): c is string => typeof c === "string" && c.length > 0)
      : [];
    return provenanceOf({
      source: sourceDocumentFilename ?? undefined,
      accounts: codes.length ? codes.join(", ") : undefined,
      method: codes.length
        ? `subtotal of the listed accounts · ${section.subtotalLabel}`
        : `P&L builder subtotal · ${section.subtotalLabel}`,
      period: periodLabel ?? undefined,
    });
  }
  if (statements && sameCents(statements.incomeStatement.revenue, values.revenue)) {
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, "statements.incomeStatement.revenue"),
      period: periodLabel ?? undefined,
    });
  }
  return null;
}

// ── EBITDA ─────────────────────────────────────────────────────────────

function ebitdaProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { pl, statements, values, sourceDocumentFilename, periodLabel } = input;
  const served = statements?.assembled_pl?.ebitda_statutory;
  if (typeof served === "number" && sameCents(served, values.ebitda)) {
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, "assembled_pl.ebitda_statutory"),
      period: periodLabel ?? undefined,
    });
  }
  if (pl && sameCents(pl.ebitda, values.ebitda)) {
    return provenanceOf({
      method: "P&L builder · operating revenue − operating expenses (cash)",
      period: periodLabel ?? undefined,
    });
  }
  return null;
}

// ── net profit ─────────────────────────────────────────────────────────

/** The envelope's own closing-result anchor: the codes it closed the
 *  result on, and the cents it read there. Null unless both are served. */
function closingAnchor(cbs: CanonicalBs | undefined): { codes: string[]; cents: number } | null {
  const anchor = (cbs as { source_anchor?: { closing_result?: unknown } } | undefined)?.source_anchor
    ?.closing_result;
  if (!anchor || typeof anchor !== "object") return null;
  const a = anchor as { codes?: unknown; p121_cents?: unknown };
  const codes = Array.isArray(a.codes) ? a.codes.filter((c): c is string => typeof c === "string") : [];
  if (codes.length === 0 || typeof a.p121_cents !== "number") return null;
  return { codes, cents: a.p121_cents };
}

function profitProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { pl, statements, metrics, values, sourceDocumentFilename, periodLabel } = input;
  // The envelope's own anchored figure, FIRST — the same rung order
  // `headlineFigures.resolveHeadlineNetProfit` picks the VALUE with, so
  // the card cannot print a figure this module then fails to place.
  // Account 121 is still claimed only when the envelope's own
  // `source_anchor.closing_result` names the codes AND its cents equal
  // the figure; the field path alone is claimed otherwise.
  const served = statements?.assembled_pl?.net_income_statutory;
  if (typeof served === "number" && sameCents(served, values.profit)) {
    const a = closingAnchor(statements?.canonical_bs);
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, "assembled_pl.net_income_statutory"),
      accounts: a && sameCents(a.cents / 100, values.profit) ? a.codes.join(", ") : undefined,
      period: periodLabel ?? undefined,
    });
  }
  const row = metrics.find((m) => m.name === "net_income_statutory");
  if (row && typeof row.value === "number" && sameCents(row.value, values.profit)) {
    const anchor = closingAnchor(statements?.canonical_bs);
    const anchored = anchor && sameCents(anchor.cents / 100, values.profit);
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, "calculated_metrics.net_income_statutory"),
      accounts: anchored ? anchor.codes.join(", ") : undefined,
      period: periodLabel ?? undefined,
    });
  }
  if (pl && typeof pl.netProfitStatutory === "number" && sameCents(pl.netProfitStatutory, values.profit)) {
    return provenanceOf({
      method: "P&L builder · statutory net profit (operational + 722)",
      period: periodLabel ?? undefined,
    });
  }
  if (pl && sameCents(pl.netProfit, values.profit)) {
    return provenanceOf({
      method: "P&L builder · operational net profit (excl. 722)",
      period: periodLabel ?? undefined,
    });
  }
  return null;
}

// ── cash ───────────────────────────────────────────────────────────────

/** The canonical rows whose id names cash. Returned only when they exist
 *  AND sum to the figure on screen — the arithmetic is the proof. */
function matchingCashRows(cbs: CanonicalBs | undefined, cash: number) {
  if (!cbs?.rows) return null;
  const rows = cbs.rows.filter((r) => r.id.startsWith("cash") && !r.synthetic);
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => acc + r.amount, 0);
  if (!sameCents(sum, cash)) return null;
  return rows;
}

function cashProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { statements, values, sourceDocumentFilename, periodLabel } = input;
  if (!statements) return null;
  const cbs = statements.canonical_bs;
  const rows = matchingCashRows(cbs, values.cash);
  if (cbs && rows) {
    const codes = [...new Set(rows.flatMap((r) => r.account_codes ?? []))];
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, cbs.extraction?.sheet),
      accounts: codes.length ? codes.join(", ") : undefined,
      method: cbs.extraction?.method,
      pack: cbs.mapping_version,
      period: periodLabel ?? undefined,
    });
  }
  if (sameCents(statements.balanceSheet.cash, values.cash)) {
    return provenanceOf({
      source: joinSource(sourceDocumentFilename, "statements.balanceSheet.cash"),
      period: periodLabel ?? undefined,
    });
  }
  return null;
}

// ── the derived pair ───────────────────────────────────────────────────

function totalDebtProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { statements, values, periodLabel } = input;
  if (!statements) return null;
  const bs = statements.balanceSheet;
  if (!sameCents(bs.shortTermDebt + bs.longTermDebt, values.totalDebt)) return null;
  return provenanceOf({
    method: "derived · short-term debt + long-term debt",
    period: periodLabel ?? undefined,
  });
}

function netDebtProvenance(input: HeadlineProvenanceInput): AmountProvenance | null {
  const { values, periodLabel } = input;
  if (!sameCents(values.totalDebt - values.cash, values.netDebt)) return null;
  return provenanceOf({
    method: "derived · total debt − cash",
    period: periodLabel ?? undefined,
  });
}

// ── the one entry point ────────────────────────────────────────────────

export function buildHeadlineProvenance(input: HeadlineProvenanceInput): HeadlineProvenance {
  return {
    revenue: revenueProvenance(input),
    ebitda: ebitdaProvenance(input),
    profit: profitProvenance(input),
    cash: cashProvenance(input),
    totalDebt: totalDebtProvenance(input),
    netDebt: netDebtProvenance(input),
  };
}

/** Every key mapped to null — what a surface renders before the period
 *  has loaded, and what a caller passes when it holds no payload. */
export const NO_HEADLINE_PROVENANCE: HeadlineProvenance = {
  revenue: null,
  ebitda: null,
  profit: null,
  cash: null,
  totalDebt: null,
  netDebt: null,
};

// ── which P&L builder the page used ────────────────────────────────────

/** A period line item, as `pickPLBuilder` sees it. Structural on purpose:
 *  the page hands over `remotePeriod.lineItems`, whose shape this file
 *  must not have to re-import. */
import { plUsesLineItems } from "./buildPlStatement";

export interface PlLineItemLike {
  statement: string;
  ro_account_code?: string | null;
}

/**
 * ASKS `buildPlStatement.plUsesLineItems`. It does not mirror it.
 *
 * This held a SECOND COPY of the routing rule until 2026-09-09, and
 * `__tests__/headlineProvenance.test.ts` existed to catch the two drifting
 * apart. It caught it: the rule became a COVERAGE test after a condensed
 * 4-digit balanță served three expense lines out of seventy, and this copy
 * still said the old thing — which would have made the provenance card
 * claim figures were "read from line items" when the aggregates were
 * serving them.
 *
 * Two copies of one decision IS the defect; the test watching them was a
 * smoke alarm, not a fix. Delegating leaves nothing to drift.
 *
 * `statements` is required because coverage is measured against the
 * engine's assembled operating expense.
 */
export function plBuiltFromLineItems(
  lineItems: readonly PlLineItemLike[],
  statements: unknown,
): boolean {
  return plUsesLineItems(lineItems, statements);
}
