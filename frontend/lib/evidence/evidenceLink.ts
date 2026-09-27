// evidenceLink.ts — THE URL every "open its evidence" link is built with,
// and the parameters the receivers read (design C4).
//
// Four receivers, one vocabulary:
//
//   ?tab=ratios&ratio=<ratio_table key>   the ratio's detail drawer, or its
//                                         row in the ratio table (RatiosTab)
//   /benchmark?row=<sector row key>       the sector row, highlighted
//   ?tab=<statement>&account=<code>       the account view — the served
//                                         leaves of that code, with period,
//                                         document and provenance
//                                         (components/cfo/evidence/
//                                         EvidenceDrawer)
//   ?tab=<statement>&line=<line key>      the same view for a statement line
//                                         (a comparatives line key such as
//                                         `pl.revenue`): its served figure
//                                         and the accounts that feed it
//
// Statement tabs are the dashboard's REAL tab ids. The provenance jump used
// to send "bs" / "cf" / "pnl" / "p_and_l", slugs the dashboard resolves to
// the P&L, so every balance-sheet link landed on the wrong tab.

import type { TabId } from "@/lib/financialStatementTabs";

export const EVIDENCE_ACCOUNT_PARAM = "account";
export const EVIDENCE_LINE_PARAM = "line";
export const EVIDENCE_RATIO_PARAM = "ratio";
export const EVIDENCE_ROW_PARAM = "row";
/** A finding's id and the served measure it heads with: the account view
 *  prints THAT measure first (statements.insights), then the accounts it
 *  cites — so a "Ce contează acum" item lands under its own number. */
export const EVIDENCE_FINDING_PARAM = "finding";
export const EVIDENCE_MEASURE_PARAM = "measure";

export type StatementTab = Extract<TabId, "pl" | "balance_sheet" | "cash_flow">;

/** Every spelling a producer has used for a statement → its real tab id.
 *  Null for anything that is not a statement. */
export function realStatementTab(s: string | null | undefined): StatementTab | null {
  switch ((s ?? "").toLowerCase()) {
    case "pl": case "pnl": case "p_and_l": case "p&l": case "profit_loss": return "pl";
    case "bs": case "balance_sheet": case "balance-sheet": case "bilant": return "balance_sheet";
    case "cf": case "cash_flow": case "cash-flow": return "cash_flow";
    default: return null;
  }
}

/** The statement an account code lives on: classes 6 and 7 are the P&L,
 *  everything else the balance sheet (RAS class structure). */
export function accountStatementTab(code: string): StatementTab {
  return /^[67]/.test(code.trim()) ? "pl" : "balance_sheet";
}

export type HrefParam = string | readonly string[] | null | undefined;

/** `/dashboard?period=…&org=…&<params>` — a repeated parameter for an array
 *  (several accounts), nothing for null / empty. */
export function dashboardEvidenceHref(
  scope: { periodId: string | null | undefined; orgId: string | null | undefined },
  params: Record<string, HrefParam>,
): string {
  const sp = new URLSearchParams();
  if (scope.periodId) sp.set("period", scope.periodId);
  if (scope.orgId) sp.set("org", scope.orgId);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const one of v) if (one) sp.append(k, one);
    } else if (typeof v === "string" && v) {
      sp.set(k, v);
    }
  }
  return `/dashboard?${sp.toString()}`;
}

/** The account view for one or more codes, on the statement the first code
 *  lives on. */
export function accountEvidenceHref(
  scope: { periodId: string | null | undefined; orgId: string | null | undefined },
  codes: readonly string[],
): string {
  const clean = codes.map((c) => c.trim()).filter((c) => c.length > 0);
  const tab = clean.length > 0 ? accountStatementTab(clean[0]) : "balance_sheet";
  return dashboardEvidenceHref(scope, { tab, [EVIDENCE_ACCOUNT_PARAM]: clean });
}

/** A finding's receiver: the accounts it cites, under the finding's own
 *  served measure (EvidenceDrawer's finding block). */
export function findingEvidenceHref(
  scope: { periodId: string | null | undefined; orgId: string | null | undefined },
  codes: readonly string[],
  finding: string,
  measure: string,
): string {
  const clean = codes.map((c) => c.trim()).filter((c) => c.length > 0);
  const tab = clean.length > 0 ? accountStatementTab(clean[0]) : "balance_sheet";
  return dashboardEvidenceHref(scope, {
    tab,
    [EVIDENCE_ACCOUNT_PARAM]: clean,
    [EVIDENCE_FINDING_PARAM]: finding,
    [EVIDENCE_MEASURE_PARAM]: measure,
  });
}

/** The line view: a statement line's served figure and the accounts that
 *  feed it — or, with `accounts`, the accounts a finding cited for it. */
export function lineEvidenceHref(
  scope: { periodId: string | null | undefined; orgId: string | null | undefined },
  line: string,
  tab: string | null | undefined,
  accounts: readonly string[] = [],
): string {
  const real = realStatementTab(tab) ?? (line.startsWith("bs.") ? "balance_sheet" : "pl");
  return dashboardEvidenceHref(scope, {
    tab: real,
    [EVIDENCE_LINE_PARAM]: line,
    [EVIDENCE_ACCOUNT_PARAM]: accounts,
  });
}

/** A ratio's receiver on the ratios tab. */
export function ratioEvidenceHref(
  scope: { periodId: string | null | undefined; orgId: string | null | undefined },
  key: string,
): string {
  return dashboardEvidenceHref(scope, { tab: "ratios", [EVIDENCE_RATIO_PARAM]: key });
}

/** A sector row's receiver on the benchmark page (the page reads its
 *  period from `?period=`; the company follows the period). */
export function sectorRowEvidenceHref(
  scope: { periodId: string | null | undefined },
  route: string,
  row: string,
): string {
  const sp = new URLSearchParams();
  if (scope.periodId) sp.set("period", scope.periodId);
  sp.set(EVIDENCE_ROW_PARAM, row);
  return `${route || "/benchmark"}?${sp.toString()}`;
}
