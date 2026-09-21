// THE COMPANY ON SCREEN — what the Forecast and Scenarios pages stand on.
//
// One company per workspace (the workspace redesign's model): the company on
// screen is the ACTIVE workspace, and the header already names it (the
// TopHeader capsule prints the workspace name beside the period). These two
// pages always work on that company and on its analysed year:
//
//   · `ready`      — a period of the company on screen is open; the engine
//                    projects from it (or refuses in its own words);
//   · `no_year`    — the company on screen has no analysed year: one
//                    sentence, and the user's other companies to pick from;
//   · `no_company` — the user has no company at all: one sentence;
//   · `loading`    — the workspace list or the period is still resolving.
//
// A period the URL names but that turns out to be an EMPTY container (a month
// with no analysed file) is `no_year`, not a projection over nothing. The page
// never offers an upload control: the company page owns that.
//
// NOT lib/companyOnScreen.ts. The workspace redesign (feat/workspace-redesign)
// adds a module of that name with a different job — holding a company page
// until the header names its company. This one only answers "which company and
// year do Forecast and Scenarios stand on", so it carries its own name and the
// two merge without an add/add collision.

import { useActivePeriod, type ActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { useActiveOrg, type Organization } from "@/lib/org";

export type PageCompany =
  | { readonly status: "loading"; readonly company: Organization | null }
  | { readonly status: "no_company"; readonly company: null }
  | { readonly status: "no_year"; readonly company: Organization | null }
  | {
      readonly status: "ready";
      readonly company: Organization | null;
      readonly period: ActivePeriod;
    };

export function usePageCompany(): PageCompany {
  const { org, orgs, loading } = useActiveOrg();
  const fallback = useActivePeriodFallback();
  const period = useActivePeriod();

  if (period.id) {
    // Only a READ empty container is "no year": the payload came back, named
    // its month, and carried no analysed statements. A period still on its
    // way, a transport error or a 404 is NOT — the engine is asked and its
    // own sentence is shown (strict comparisons: a caller that knows none of
    // these fields is treated as ready).
    const emptyContainer =
      period.isLoaded === false &&
      period.isLoading === false &&
      period.notFound !== true &&
      typeof period.periodEnd === "string" &&
      period.periodEnd.length > 0;
    if (emptyContainer) {
      return { status: "no_year", company: org };
    }
    return { status: "ready", company: org, period };
  }
  if (loading || fallback.status === "resolving") {
    return { status: "loading", company: org };
  }
  if (!org && orgs.length === 0) return { status: "no_company", company: null };
  return { status: "no_year", company: org };
}
