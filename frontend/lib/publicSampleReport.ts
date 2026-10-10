// The public sample's report — the product's own export, built from the
// served documents exactly as the dashboard's Export tab builds it.
//
// `public/sample/sample_report_fy2025.html` is NOT a hand-made page. It is
// `buildReportHtml(statementsForExport ?? statements, creditEnvelopes)` —
// the call FinancialStatements.tsx makes when a signed-in user clicks
// "Download HTML report" — over the three documents the engine served for
// the fictional book (GET /api/period for each year and the comparatives
// document for the pair), joined by `ratioSurfacesOf`, the same function
// the page's hook runs. Nothing is computed here.
//
// WHAT THE SAMPLE SAYS ABOUT ITSELF (2026-10-02). The report is the
// product's export, but two things a customer's own download prints are
// false on a file published for anyone, and one thing it does not print is
// needed here:
//   · "Confidential — for internal use only" — turned off;
//   · nothing said the company does not exist (the PDF is the file most
//     likely to travel without the /sample page) — the cover, the body, the
//     footer and the foot of every printed page now carry the notice below,
//     in English and Romanian;
//   · the prepared-on day is the sample's `as_of`, printed as that calendar
//     day on every machine.
//   · what the report is known to get wrong on this book — a "Known issues
//     in this report" box before the executive summary and a line on the
//     cover, in English and Romanian (lib/publicSampleKnownIssues; the
//     figures are public/sample/known_issues_fy2025.json's).
// These are `ReportOptions` — inputs about the document, not figures in it.
//
// Two readers: `scripts/build_public_sample_report.mjs` (writes the file)
// and `frontend/lib/__tests__/publicSample.test.tsx` (reds when the
// committed file is not what this function returns for the committed
// served documents).

import type { ComparativesResponse } from "@/lib/comparatives";
import { buildReportHtml } from "@/lib/financialExports";
import type { ReportKnownIssues, ReportOptions, Statements } from "@/lib/financialReport";
import { knownIssuesCoverLine, knownIssuesText, type KnownIssue } from "@/lib/publicSampleKnownIssues";
import { ratioSurfacesOf } from "@/lib/useRatioSurfaces";

/** The fields of a `GET /api/period/{id}` body this module reads. */
export interface ServedPeriodBody {
  period: { id: string; period_end?: string | null };
  statements: Statements;
  metrics: Array<{ name: string; value: number | null }>;
  assembled_metrics: unknown;
}

export function metricsByNameOf(body: ServedPeriodBody): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of body.metrics) out[m.name] = typeof m.value === "number" ? m.value : null;
  return out;
}

/** What the Export tab hands the report builder for `current`, compared
 *  with `prior` through the served `comparatives` document. */
export function exportInputsOf(
  current: ServedPeriodBody,
  prior: ServedPeriodBody,
  comparatives: ComparativesResponse,
) {
  const surfaces = ratioSurfacesOf({
    assembledMetrics: current.assembled_metrics,
    statements: current.statements,
    metricsByName: metricsByNameOf(current),
    currentLabel: current.statements.periodLabel ?? "",
    periodId: current.period.id,
    priorId: prior.period.id,
    comparatives: { data: { kind: "ok", data: comparatives }, isError: false },
    sector: null,
  });
  return {
    statements: (surfaces.statementsForExport ?? current.statements) as Statements,
    envelopes: surfaces.creditEnvelopes,
  };
}

/** The notice every copy of the sample report carries. The report is
 *  English by contract; the notice is in both languages because it is the
 *  one line a reader of either must not miss. */
export const SAMPLE_REPORT_NOTICE = {
  long:
    "Fictional company — this is a generated sample, not a real entity; every figure is invented. " +
    "Companie fictivă — acesta este un exemplu generat, nu o entitate reală; toate cifrele sunt inventate.",
  short: "Fictional company — generated sample · Companie fictivă — exemplu generat",
} as const;

/** The "Known issues in this report" box, in English then Romanian — the
 *  report is English by contract, and this is the one block (with the
 *  notice) a reader of either language must not miss. `issues` is the list
 *  of public/sample/known_issues_fy2025.json. */
export function sampleKnownIssues(issues: readonly KnownIssue[]): ReportKnownIssues {
  return {
    blocks: [knownIssuesText(issues, "en"), knownIssuesText(issues, "ro")],
    coverLine: knownIssuesCoverLine(issues.length),
  };
}

/** What the sample says about the document: not confidential, fictional,
 *  prepared on the sample's as-of day, and what it is known to get wrong. */
export function sampleReportOptions(asOf: string, issues: readonly KnownIssue[]): ReportOptions {
  return {
    confidential: false,
    notice: SAMPLE_REPORT_NOTICE,
    generatedOn: asOf,
    knownIssues: sampleKnownIssues(issues),
  };
}

/** The whole report document, as the Export tab writes it to disk, with
 *  the sample's own notice. `asOf` is scripts/public_sample_config.json's. */
export function sampleReportHtml(
  current: ServedPeriodBody,
  prior: ServedPeriodBody,
  comparatives: ComparativesResponse,
  asOf: string,
  issues: readonly KnownIssue[],
): string {
  const { statements, envelopes } = exportInputsOf(current, prior, comparatives);
  return buildReportHtml(statements, envelopes, sampleReportOptions(asOf, issues));
}
