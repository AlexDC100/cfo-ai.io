// dashboardHref.ts — where a company's analysis opens. Pure, dependency-free:
// the upload flow's host, the company page's year tiles and the sidebar's
// Dashboard row (lib/companyOnScreen) all build the SAME link here, so the
// company a link pins and the period it opens can never disagree.

/** Where an analysed (or already-uploaded) period opens. `org` rides along so
 *  a reload or a shared link re-selects the right company before painting;
 *  without a period, the company page itself. */
export function periodDashboardHref(orgId: string, periodId: string | null): string {
  return periodId
    ? `/dashboard?period=${encodeURIComponent(periodId)}&org=${encodeURIComponent(orgId)}`
    : `/workspace/${encodeURIComponent(orgId)}`;
}

/**
 * The Dashboard link for a company page — THAT company's latest analysed
 * year, or, with none (or the years not read yet), the company page itself,
 * whose one-line state says there is no analysis. Never a period of another
 * company (G6).
 */
export function companyDashboardHref(
  orgId: string,
  years: ReadonlyArray<{ period_id: string; year: number }> | null | undefined,
): string {
  let latest: { period_id: string; year: number } | null = null;
  for (const y of years ?? []) if (!latest || y.year >= latest.year) latest = y;
  return periodDashboardHref(orgId, latest?.period_id ?? null);
}
