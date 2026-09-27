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
  return periodDashboardHref(orgId, latestPeriodId(years));
}

/** A company's newest analysed year, from ITS OWN years list. */
function latestPeriodId(
  years: ReadonlyArray<{ period_id: string; year: number }> | null | undefined,
): string | null {
  let latest: { period_id: string; year: number } | null = null;
  for (const y of years ?? []) if (!latest || y.year >= latest.year) latest = y;
  return latest?.period_id ?? null;
}

/**
 * Where "switch to <company>" lands (the command bar's action): that
 * company's OWN screen, never the screen on display — a screen that pins
 * another company (`?org=`, one of its periods, /workspace/<id>) holds for
 * it and switches the active company straight back (lib/companyOnScreen).
 *
 *   redesign on   `companyDashboardHref` — its newest year's dashboard, or
 *                 its company page; that screen's hold makes the switch.
 *   redesign off  there is no company page and no hold: the caller switches
 *                 in the same tick, and this is the company's newest year —
 *                 or the dashboard, which opens the active company's state.
 */
export function companySwitchHref(
  orgId: string,
  years: ReadonlyArray<{ period_id: string; year: number }> | null | undefined,
  workspaceV2: boolean,
): string {
  if (workspaceV2) return companyDashboardHref(orgId, years);
  const periodId = latestPeriodId(years);
  return periodId ? periodDashboardHref(orgId, periodId) : "/dashboard";
}
