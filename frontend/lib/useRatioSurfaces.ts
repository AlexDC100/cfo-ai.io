// What the dashboard page feeds its ratio surfaces, decided in ONE place.
//
// FinancialStatements.tsx hands four RatioCompareCtx providers (the Ratios
// tab, both hero footers, the Risks tab), the credit readers and the
// exports their inputs. Those inputs used to be four memos inline in the
// page, where nothing but tsc read them: the provider could be handed
// null, the view built from nothing, or the export handed no served
// document, with every ratio gate green (the complete-and-unreachable
// class). They live here so the join is a function a test runs over the
// served fixture (ratioCompareTab.test.tsx, G9), and the page's use of it
// is held by a source gate in the same file.
//
// Nothing is computed: the served comparatives fetch is sorted into a
// document, a refusal, a failure or a pending request, and each served
// block is handed on as served.

import { useMemo } from "react";

import type { ExportComparisonState, Statements } from "@/lib/financialReport";
import {
  statementsForExportOf,
  type ComparativesFetch,
  type ComparativesResponse,
  type StatementsForExport,
} from "@/lib/comparatives";
import {
  buildRatioCompareView,
  readRatioTable,
  servedCreditEnvelopes,
  type RatioCompareView,
  type ServedCreditEnvelopes,
} from "@/lib/ratioCompareView";

/** The fields of the comparatives query result this module reads (a
 *  @tanstack/react-query `useQuery` result satisfies it). */
export interface ComparativesQueryState {
  data?: ComparativesFetch | undefined;
  isError?: boolean;
}

export interface RatioSurfaceInputs {
  /** GET /api/period `assembled_metrics`, verbatim. */
  assembledMetrics: unknown;
  statements: Statements | null;
  /** The served sector benchmark document, or null/absent. */
  sector?: unknown;
  metricsByName: Record<string, number | null>;
  /** The current period's own label, for a view no comparison names. */
  currentLabel: string;
  /** The period the comparison is FOR, and the prior requested for it
   *  (null: comparatives off or no earlier period). */
  periodId: string | null;
  priorId: string | null;
  comparatives: ComparativesQueryState;
}

export interface RatioSurfaces {
  /** The served comparatives document, or null. */
  cmpDoc: ComparativesResponse | null;
  /** The engine's refusal of the comparison — its CODE only (the sentence
   *  is the code's, lib/comparisonRefusal.ts), or null. */
  cmpRefused: { code: string } | null;
  /** THE COMPARISON REQUEST'S OUTCOME, said once: none asked, pending,
   *  refused (its code), failed (its status) or served. The column boxes,
   *  the note under the tab bar, the Ratios tab and the exports all read
   *  THIS — none of them sorts the fetch again (lib/comparisonState.ts). */
  comparison: ExportComparisonState;
  /** The view every RatioCompareCtx provider on the page is handed. */
  ratioCompareView: RatioCompareView | null;
  /** What the Export tab hands the report and the workbook. */
  statementsForExport: StatementsForExport | null;
  /** The credit envelopes the hero, the Risks tab and the exports read. */
  creditEnvelopes: ServedCreditEnvelopes;
}

/** The served sector document rides to the exports on the same
 *  statements object the comparatives ride on; absent stays absent. */
function withSector(s: StatementsForExport | null, sector: unknown): StatementsForExport | null {
  return s && sector ? { ...s, sectorBenchmark: sector } : s;
}

export function ratioSurfacesOf(input: RatioSurfaceInputs): RatioSurfaces {
  const data = input.comparatives.data;
  const requested = input.priorId !== null && input.periodId !== null && input.priorId !== input.periodId;
  // THE DOCUMENT ON SCREEN IS THE ONE FOR THE PAIR ON SCREEN. A result held
  // over from another request — the period before this one, or a prior the
  // reader has since changed or switched off — is not this comparison: no
  // request, or a document naming other periods, is no document (and no
  // refusal). `useComparatives` hands no placeholder across keys; this is
  // the same rule where the answer is turned into what the page paints.
  const cmpDoc =
    requested && data?.kind === "ok"
      && data.data.current?.period_id === input.periodId
      && data.data.prior?.period_id === input.priorId
      ? data.data
      : null;
  // The engine's message is its diagnostic line and can carry a raw period
  // id: it goes no further than this line. Only the code travels on.
  const cmpRefused = requested && data?.kind === "refused" ? { code: data.code } : null;
  const failure =
    !requested
      ? null
      : data?.kind === "error"
        ? { status: data.status }
        : data === undefined && input.comparatives.isError === true
          ? { status: 0 }
          : null;
  // The outcome the exports are built under, when no document is served:
  // the refusal, the failure, or a request not yet answered. The report
  // and the workbook print it in every prior-dependent cell (never "no
  // prior period was supplied" while the tab states the refusal).
  const comparisonOutcome: ExportComparisonState | null = cmpRefused
    ? { kind: "refused", code: cmpRefused.code }
    : failure
      ? { kind: "failed", status: failure.status }
      : requested && data === undefined
        ? { kind: "pending" }
        : null;
  const comparison: ExportComparisonState = cmpDoc
    ? { kind: "served" }
    : comparisonOutcome ?? { kind: "none" };
  const ratioCompareView = buildRatioCompareView({
    periodTable: readRatioTable(input.assembledMetrics),
    comparativesDoc: cmpDoc,
    refusal: cmpRefused ? { code: cmpRefused.code } : null,
    requested,
    failure,
    currentLabel: input.currentLabel,
  });
  return {
    cmpDoc,
    cmpRefused,
    comparison,
    ratioCompareView,
    statementsForExport: withSector(
      statementsForExportOf(input.statements, cmpDoc, comparisonOutcome), input.sector),
    creditEnvelopes: servedCreditEnvelopes(input.assembledMetrics, input.statements, input.metricsByName),
  };
}

export function useRatioSurfaces(input: RatioSurfaceInputs): RatioSurfaces {
  const { assembledMetrics, statements, metricsByName, currentLabel, periodId, priorId, sector } = input;
  const data = input.comparatives.data;
  const isError = input.comparatives.isError === true;
  return useMemo(
    () =>
      ratioSurfacesOf({
        assembledMetrics,
        statements,
        sector,
        metricsByName,
        currentLabel,
        periodId,
        priorId,
        comparatives: { data, isError },
      }),
    [assembledMetrics, statements, sector, metricsByName, currentLabel, periodId, priorId, data, isError],
  );
}
