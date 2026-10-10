// usePeriodVerdictKeeper — what a browser remembers as "this company's
// period" is a period the reader was actually SERVED for this company.
//
// THE DEFECT (production, 2026-10-04). lib/dataPresence remembers, per user
// and company, the period a bare URL should open. useActivePeriodFallback
// wrote that memory from the URL alone — "a uuid in the URL is proof the
// company has this period". It is not: a link to a period the reader cannot
// read (deleted since; another account's; a colleague's link) was remembered
// for the ACTIVE company, and from then on every bare /dashboard, /chat and
// /benchmark of that company was sent to it, answered 404, and painted
// "nothing analysed here yet" over a company with its analyses intact. The
// chat called itself grounded on it and the assistant told the reader the
// period was a row id.
//
// THE RULE. Mounted once, by the shell:
//   · the period in the URL is remembered for the active company only when
//     its payload LANDED and names that company;
//   · a period the engine answers "not found" is forgotten wherever it is
//     remembered, and the reader is taken to the same page WITHOUT it — the
//     page then opens the company's own period — and told so, once;
//   · that recovery happens at most once per period (and a few times per
//     page life): a second "not found" for the same id is left to the page.
//
// It reads the query cache's OWN entry for the URL's period, never the
// placeholder useActivePeriod may be handed from the previous period
// (lib/queryClient keeps previous data while a new key loads) — a period
// still loading is neither served nor missing.
import { useEffect, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { getActiveOrgId, subscribeActiveOrg } from "@/lib/activeOrg";
import { periodQueryKey, useActivePeriod, type PeriodFetchResult } from "@/lib/activePeriod";
import { useAuth } from "@/lib/auth";
import { forgetPeriodVerdictFor, writePeriodVerdict } from "@/lib/dataPresence";

/** Automatic recoveries in one page life — a backstop, never reached by one
 *  stale link. */
export const PERIOD_RECOVERY_BUDGET = 3;

const recovered = new Set<string>();

/** Test seam: a new page life. */
export function resetPeriodRecoveries(): void {
  recovered.clear();
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function usePeriodVerdictKeeper(): void {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const orgId = useSyncExternalStore(subscribeActiveOrg, () => getActiveOrgId(uid), () => null);
  const urlPeriod = params.get("period");
  // Subscribes this hook to the period query: the effect below re-runs when
  // the URL period's answer arrives.
  const period = useActivePeriod();

  useEffect(() => {
    if (!urlPeriod || !isUuid(urlPeriod)) return;
    const answer = queryClient.getQueryData<PeriodFetchResult>(periodQueryKey(urlPeriod));
    if (!answer) return; // still loading, or never asked: neither served nor missing

    if (answer.kind === "ok") {
      const company = answer.data.organization?.id ?? null;
      if (uid && orgId && company === orgId) writePeriodVerdict(uid, urlPeriod, orgId);
      return;
    }
    if (answer.kind !== "not_found") return; // a transport error says nothing about the period

    // Not this reader's to open: stop remembering it, for any company.
    forgetPeriodVerdictFor(urlPeriod);
    if (recovered.has(urlPeriod) || recovered.size >= PERIOD_RECOVERY_BUDGET) return;
    recovered.add(urlPeriod);
    const next = new URLSearchParams(location.search);
    next.delete("period");
    next.delete("org");
    const search = next.toString();
    toast.info(t("period.unavailableTitle"), { description: t("period.unavailableBody") });
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true });
    // The cached "not found" is left as it is (it expires with the query
    // client's own staleness rule): dropping it here races the page's next
    // navigation and asks the engine for the same period again.
    // `period` is a dependency on purpose: it changes when the answer lands.
  }, [urlPeriod, period, uid, orgId, queryClient, navigate, location.pathname, location.search, location.hash, t]);
}
